"""Deterministic existing-aware tile lattice inference and coverage selection."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from app.models import (
    CenterInput,
    CoverageRequest,
    GenerationMethod,
    InferenceDiagnostics,
    PlanMetrics,
    RegionBounds,
    RegionPlanRequest,
    RegionPlanResponse,
    SkyPolygon,
    TileRecord,
    TileSource,
)
from app.profiles import TilingProfile, load_profile
from app.science.geometry import legacy_grid_centers
from app.science.grid import rectangular_grid_centers

# Calibrated against nearest-neighbor spacings in reference/tiles_nc.csv:
# SPLUS rows cluster near 1.354–1.359 deg, while the compatibility step is
# 1.3667 deg. A 0.05 deg (3 arcmin) tolerance includes the observed variation
# without treating unrelated sub-degree or 1.4+ degree layouts as anchors.
INFERENCE_TOLERANCE_DEG = 0.05
OCCUPIED_CENTER_TOLERANCE_DEG = 0.12
SAMPLE_STEP_DEG = 0.12
MAX_CANDIDATES = 1200
MAX_REGION_SAMPLES = 90_000
MIN_POLYGON_SAMPLES_PER_AXIS = 8
# Sampling cells cannot certify exact geometric completeness. The planner
# stops at 99.5% selected-cell coverage or when no candidate adds 0.05%.
AUTOMATIC_COVERAGE_TARGET = 0.995
MIN_INCREMENTAL_GAIN = 0.0005


@dataclass(frozen=True)
class _Lattice:
    """Locally inferred axis-aligned lattice parameters and its anchors."""

    dec_spacing_deg: float
    ra_spacing_deg: float
    row_dec_deg: dict[int, float]
    row_ra_phase_fraction: dict[int, float]
    anchor_ids: tuple[str, ...]
    pair_count: int


@dataclass(frozen=True)
class _CoverageGrid:
    """Sample points and area weights over the selected sky region."""

    ra_deg: np.ndarray
    dec_deg: np.ndarray
    weights: np.ndarray
    total_weight: float
    step_deg: float
    center_ra_deg: float
    center_dec_deg: float
    ra_span_deg: float
    dec_min_deg: float
    dec_max_deg: float
    cell_area_deg2: float


class CoverageEngine(Protocol):
    """Replaceable selected-region sampling contract for the planner."""

    def sample(self, polygon: SkyPolygon) -> _CoverageGrid:
        """Represent the ordered ICRS polygon as weighted on-sky sample cells."""


class SamplingCoverageEngine:
    """Deterministic declination-weighted polygon coverage sampler."""

    def sample(self, polygon: SkyPolygon) -> _CoverageGrid:
        """Sample an ICRS polygon in degrees using a local RA/DEC grid."""
        return _sample_region(polygon.bounds, polygon)


def _expanded_bounds(bounds: RegionBounds, profile: TilingProfile) -> RegionBounds:
    """Expand a polygon's acceleration bounds by half a profile footprint."""
    center_dec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2
    ra_margin = profile.tile_width_deg / (2 * max(math.cos(math.radians(center_dec)), 0.01))
    if bounds.ra_span_deg + 2 * ra_margin > 180:
        raise ValueError("Polygon plus tile margin spans more than 180 degrees in RA")
    return RegionBounds(
        ra_start_deg=(bounds.ra_start_deg - ra_margin) % 360,
        ra_end_deg=(bounds.ra_end_deg + ra_margin) % 360,
        dec_min_deg=max(-89.999, bounds.dec_min_deg - profile.tile_height_deg / 2),
        dec_max_deg=min(89.999, bounds.dec_max_deg + profile.tile_height_deg / 2),
    )


def plan_region(
    request: RegionPlanRequest, profile: TilingProfile | None = None
) -> RegionPlanResponse:
    """Infer or fall back to a lattice, then select useful tile centers.

    Parameters
    ----------
    request : RegionPlanRequest
        Ordered ICRS polygon vertices and all relevant existing pointings.
    profile : TilingProfile, optional
        Validated footprint and grid algorithm. Defaults to the installed
        profile identified by ``request.profile_id``.

    Returns
    -------
    RegionPlanResponse
        Deterministic proposal centers, lattice candidates, anchor audit trail,
        and sampled coverage metrics.

    Raises
    ------
    ValueError
        If the selected region produces too many candidates or samples.
    """
    profile = profile or load_profile(request.profile_id)
    bounds = request.polygon.bounds
    region_center_ra = (bounds.ra_start_deg + bounds.ra_span_deg / 2) % 360
    region_center_dec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2
    local_tiles = _tiles_near_region(
        request.existing_tiles, bounds, region_center_ra, region_center_dec, profile
    )
    lattice = _infer_lattice(local_tiles, region_center_ra, region_center_dec, profile)
    if lattice is None:
        solution = "legacy_bounds_fallback"
        method = GenerationMethod.REGION_LEGACY
        fallback_bounds = _expanded_bounds(bounds, profile)
        if profile.algorithm == "SPLUS_LEGACY_GRID_V1":
            raw_candidates = legacy_grid_centers(
                (fallback_bounds.ra_start_deg, fallback_bounds.ra_end_deg),
                (fallback_bounds.dec_min_deg, fallback_bounds.dec_max_deg),
                wraps_ra=fallback_bounds.ra_start_deg > fallback_bounds.ra_end_deg,
            )
        else:
            raw_candidates = rectangular_grid_centers(fallback_bounds, profile)
        anchors: tuple[str, ...] = ()
        diagnostics = [
            f"No reliable local lattice was found from {len(local_tiles)} nearby tiles; "
            f"used {profile.algorithm} around the selected polygon."
        ]
    else:
        solution = "extended_existing_grid"
        method = GenerationMethod.REGION_EXTENDED
        raw_candidates = _lattice_candidates(bounds, lattice, profile)
        anchors = lattice.anchor_ids
        diagnostics = [
            f"Extended the local grid using {lattice.pair_count} compatible neighbor pairs "
            f"and {len(anchors)} anchor tiles.",
            f"Median DEC spacing {lattice.dec_spacing_deg:.4f} deg and "
            f"inferred physical RA spacing "
            f"{lattice.ra_spacing_deg:.4f} deg; compatibility tolerance is "
            f"{INFERENCE_TOLERANCE_DEG:.2f} deg.",
        ]

    if len(raw_candidates) > MAX_CANDIDATES:
        raise ValueError(
            f"This region produces {len(raw_candidates)} lattice candidates; reduce the selected "
            f"area to at most {MAX_CANDIDATES}."
        )
    unique_candidates = _exclude_occupied(raw_candidates, request.existing_tiles)
    grid = SamplingCoverageEngine().sample(request.polygon)
    existing_mask = _covered_mask(grid, request.existing_tiles, profile)
    contributing_count = _contributing_tile_count(grid, request.existing_tiles, profile)
    candidate_masks = [_tile_mask(grid, ra, dec, profile) for ra, dec in unique_candidates]
    useful: list[tuple[tuple[float, float], np.ndarray]] = []
    for center, mask in zip(unique_candidates, candidate_masks, strict=True):
        if np.any(mask & ~existing_mask):
            useful.append((center, mask))

    chosen = _greedy_choose(
        useful,
        existing_mask,
        grid,
        profile=profile,
        max_count=len(useful),
        automatic_target=AUTOMATIC_COVERAGE_TARGET,
    )

    proposed = [
        TileRecord(
            id=f"proposal-region-{index:04d}",
            ra_deg=ra,
            dec_deg=dec,
            source=TileSource.PROPOSED,
            generation_method=method,
            metadata={"solution": solution},
        )
        for index, (ra, dec, _) in enumerate(chosen, start=1)
    ]
    candidate_centers = [CenterInput(ra_deg=ra, dec_deg=dec) for ra, dec in unique_candidates]
    metrics = _measure_metrics(
        chosen,
        existing_mask,
        grid,
        contributing_count,
        profile,
    )
    if not proposed and metrics.selected_region_coverage >= AUTOMATIC_COVERAGE_TARGET:
        diagnostics.append(
            "Existing tiles already meet the 99.5% sampled coverage target."
        )
    elif not proposed:
        diagnostics.append("No unoccupied lattice centers add sampled coverage to this region.")
    return RegionPlanResponse(
        solution=solution,
        generation_method=method,
        tiles=proposed,
        candidate_centers=candidate_centers,
        inference=InferenceDiagnostics(
            nearby_tile_count=len(local_tiles),
            anchor_tile_ids=list(anchors),
            compatible_neighbor_pairs=lattice.pair_count if lattice else 0,
            dec_spacing_deg=lattice.dec_spacing_deg if lattice else None,
            ra_spacing_deg=lattice.ra_spacing_deg if lattice else None,
        ),
        diagnostics=diagnostics,
        metrics=metrics,
    )


def measure_active_coverage(request: CoverageRequest) -> PlanMetrics:
    """Measure enabled proposal coverage without generating replacement tiles.

    Parameters
    ----------
    request : CoverageRequest
        ICRS polygon, all loaded immutable pointings, and proposed centers in
        decimal degrees. Disabled proposal centers are ignored.

    Returns
    -------
    PlanMetrics
        Sampled area, existing contribution, incremental active coverage,
        and remaining area. Lattice evidence belongs to region planning.

    Raises
    ------
    ValueError
        If a non-proposal record is supplied as an editable tile.
    """
    if any(tile.source != TileSource.PROPOSED for tile in request.proposed_tiles):
        raise ValueError("Coverage edits may contain only proposed tiles")
    profile = load_profile(request.profile_id)
    grid = SamplingCoverageEngine().sample(request.polygon)
    existing_mask = _covered_mask(grid, request.existing_tiles, profile)
    enabled = [tile for tile in request.proposed_tiles if tile.enabled]
    selected = [
        (tile.ra_deg, tile.dec_deg, _tile_mask(grid, tile.ra_deg, tile.dec_deg, profile))
        for tile in enabled
    ]
    return _measure_metrics(
        selected,
        existing_mask,
        grid,
        _contributing_tile_count(grid, request.existing_tiles, profile),
        profile,
    )


def _tiles_near_region(
    tiles: list[TileRecord],
    bounds: RegionBounds,
    center_ra: float,
    center_dec: float,
    profile: TilingProfile,
) -> list[TileRecord]:
    """Filter tiles to the region plus the configured physical search margin."""
    region_half_height = (bounds.dec_max_deg - bounds.dec_min_deg) / 2
    result: list[TileRecord] = []
    for tile in tiles:
        ra_margin = 3 * profile.tile_width_deg / max(
            math.cos(math.radians(tile.dec_deg)), 0.01
        )
        ra_delta = _wrapped_ra_delta(tile.ra_deg, center_ra)
        dy = tile.dec_deg - center_dec
        if (
            abs(ra_delta) <= bounds.ra_span_deg / 2 + ra_margin
            and abs(dy) <= region_half_height + 3 * profile.tile_height_deg
        ):
            result.append(tile)
    return result


def _infer_lattice(
    tiles: list[TileRecord], center_ra: float, center_dec: float, profile: TilingProfile
) -> _Lattice | None:
    """Infer the strongest locally consistent catalogue-group lattice."""
    groups: dict[str, list[TileRecord]] = {}
    for tile in tiles:
        if tile.source == TileSource.ORIGINAL:
            group = f"original:{tile.group_id or tile.dataset_id or tile.id}"
        else:
            group = f"proposed:{tile.generation_method}"
        groups.setdefault(group, []).append(tile)
    if len(groups) > 1:
        groups["all-visible-pointings"] = list(tiles)
    candidates = [
        lattice
        for group_tiles in groups.values()
        if (lattice := _infer_lattice_group(group_tiles, center_ra, center_dec, profile))
        is not None
    ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda lattice: (
            lattice.pair_count,
            len(lattice.anchor_ids),
            -abs(lattice.dec_spacing_deg - profile.dec_spacing_deg)
            - abs(lattice.ra_spacing_deg - profile.ra_spacing_deg),
            lattice.anchor_ids,
        ),
    )


def _infer_lattice_group(
    tiles: list[TileRecord], center_ra: float, center_dec: float, profile: TilingProfile
) -> _Lattice | None:
    """Infer one grid phase from several neighbor relationships in one PID."""
    if len(tiles) < 3:
        return None
    points = sorted(
        [
            (tile.dec_deg, _wrapped_ra_delta(tile.ra_deg, center_ra), tile)
            for tile in tiles
        ],
        key=lambda point: (point[0], point[1], point[2].id),
    )
    horizontal_steps: list[float] = []
    vertical_steps: list[float] = []
    pair_ids: set[tuple[str, str]] = set()
    anchor_ids: set[str] = set()
    for i, (dec_i, _ra_offset_i, tile_i) in enumerate(points):
        for dec_j, _ra_offset_j, tile_j in points[i + 1 :]:
            dy = abs(dec_j - dec_i)
            if dy > profile.dec_spacing_deg + INFERENCE_TOLERANCE_DEG:
                break
            mean_dec = (dec_i + dec_j) / 2
            ra_delta = abs(_wrapped_ra_delta(tile_j.ra_deg, tile_i.ra_deg))
            dx = ra_delta * math.cos(math.radians(mean_dec))
            if dx > 1.6 * profile.ra_spacing_deg:
                continue
            if (
                dy <= INFERENCE_TOLERANCE_DEG
                and abs(dx - profile.ra_spacing_deg) <= INFERENCE_TOLERANCE_DEG
            ):
                horizontal_steps.append(dx)
                pair_ids.add(tuple(sorted((tile_i.id, tile_j.id))))
            elif (
                abs(dy - profile.dec_spacing_deg) <= INFERENCE_TOLERANCE_DEG
                and dx <= 0.75 * profile.ra_spacing_deg
            ):
                vertical_steps.append(dy)
                pair_ids.add(tuple(sorted((tile_i.id, tile_j.id))))
    for left_id, right_id in pair_ids:
        anchor_ids.update((left_id, right_id))
    if len(pair_ids) < 2 or len(anchor_ids) < 3 or len(horizontal_steps) < 2:
        return None

    dec_spacing = float(np.median(vertical_steps)) if vertical_steps else profile.dec_spacing_deg
    ra_spacing = float(np.median(horizontal_steps))
    if (
        abs(dec_spacing - profile.dec_spacing_deg) > INFERENCE_TOLERANCE_DEG
        or abs(ra_spacing - profile.ra_spacing_deg) > INFERENCE_TOLERANCE_DEG
    ):
        return None
    anchors = [tile for tile in tiles if tile.id in anchor_ids]
    row_groups = _group_anchor_rows(anchors)
    row_dec_deg: dict[int, float] = {}
    row_indices: dict[int, list[TileRecord]] = {}
    row_index = 0
    previous_dec: float | None = None
    for row_tiles in row_groups:
        row_dec = float(np.median([tile.dec_deg for tile in row_tiles]))
        if previous_dec is not None:
            row_index += max(1, round((row_dec - previous_dec) / dec_spacing))
        row_dec_deg[row_index] = row_dec
        row_indices[row_index] = row_tiles
        previous_dec = row_dec

    row_phases: dict[int, float] = {}
    ra_phase_residuals: list[float] = []
    for row, row_tiles in row_indices.items():
        fractions = []
        for tile in row_tiles:
            step_ra = ra_spacing / max(math.cos(math.radians(tile.dec_deg)), 1e-6)
            unwrapped_ra = tile.ra_deg + 360 * round((center_ra - tile.ra_deg) / 360)
            fractions.append((unwrapped_ra % step_ra) / step_ra)
        row_phase = _circular_phase(fractions, 1.0)
        row_phases[row] = row_phase
        ra_phase_residuals.extend(
            _modular_distance(fraction, row_phase, 1.0) * ra_spacing
            for fraction in fractions
        )
    if (
        np.median(ra_phase_residuals) > INFERENCE_TOLERANCE_DEG
        or max(ra_phase_residuals) > 2 * INFERENCE_TOLERANCE_DEG
    ):
        return None
    return _Lattice(
        dec_spacing_deg=dec_spacing,
        ra_spacing_deg=ra_spacing,
        row_dec_deg=row_dec_deg,
        row_ra_phase_fraction=row_phases,
        anchor_ids=tuple(sorted(anchor_ids)),
        pair_count=len(pair_ids),
    )


def _lattice_candidates(
    bounds: RegionBounds, lattice: _Lattice, profile: TilingProfile
) -> list[tuple[float, float]]:
    """Continue the inferred axis-aligned lattice across the region margin."""
    dec_min = bounds.dec_min_deg - profile.tile_height_deg / 2
    dec_max = bounds.dec_max_deg + profile.tile_height_deg / 2
    known_rows = sorted(lattice.row_dec_deg)
    first_row = known_rows[0]
    while _row_dec_at(first_row - 1, lattice) >= dec_min:
        first_row -= 1
    while _row_dec_at(first_row, lattice) < dec_min:
        first_row += 1
    last_row = first_row
    while _row_dec_at(last_row + 1, lattice) <= dec_max:
        last_row += 1
    ra_start = bounds.ra_start_deg
    ra_end = ra_start + bounds.ra_span_deg
    center_ra = ra_start + bounds.ra_span_deg / 2
    known_phase_rows = sorted(lattice.row_ra_phase_fraction)
    candidates: list[tuple[float, float]] = []
    for row in range(first_row, last_row + 1):
        dec = _row_dec_at(row, lattice)
        if not -90 < dec < 90:
            continue
        phase_fraction = _interpolate_phase(
            lattice.row_ra_phase_fraction, row, known_phase_rows
        )
        step_ra = lattice.ra_spacing_deg / math.cos(math.radians(dec))
        phase_ra = phase_fraction * step_ra
        margin_ra = profile.tile_width_deg / 2 / max(math.cos(math.radians(dec)), 1e-6)
        first_col = math.ceil((ra_start - margin_ra - phase_ra) / step_ra)
        last_col = math.floor((ra_end + margin_ra - phase_ra) / step_ra)
        for col in range(first_col, last_col + 1):
            unwrapped_ra = phase_ra + col * step_ra
            if abs(
                _wrapped_ra_delta(unwrapped_ra % 360, center_ra % 360) * math.cos(math.radians(dec))
            ) <= (
                bounds.ra_span_deg * math.cos(math.radians(dec)) / 2 + profile.tile_width_deg / 2
            ):
                candidates.append((unwrapped_ra % 360, dec))
    return sorted(set(candidates), key=lambda point: (point[1], point[0]))


def _group_anchor_rows(tiles: list[TileRecord]) -> list[list[TileRecord]]:
    """Cluster anchor pointings that share a declination row."""
    rows: list[list[TileRecord]] = []
    for tile in sorted(tiles, key=lambda item: (item.dec_deg, item.ra_deg, item.id)):
        row_center = float(np.median([item.dec_deg for item in rows[-1]])) if rows else None
        if row_center is None or tile.dec_deg - row_center > INFERENCE_TOLERANCE_DEG:
            rows.append([tile])
        else:
            rows[-1].append(tile)
    return rows


def _row_dec_at(row: int, lattice: _Lattice) -> float:
    """Interpolate observed row declinations and locally extrapolate the edges."""
    row_decs = lattice.row_dec_deg
    if row in row_decs:
        return row_decs[row]
    known_rows = sorted(row_decs)
    lower = [known for known in known_rows if known < row]
    upper = [known for known in known_rows if known > row]
    if lower and upper:
        left = max(lower)
        right = min(upper)
        fraction = (row - left) / (right - left)
        return row_decs[left] + fraction * (row_decs[right] - row_decs[left])
    if lower:
        left, right = known_rows[-2:] if len(known_rows) >= 2 else (known_rows[-1], None)
        if right is None:
            spacing = lattice.dec_spacing_deg
        else:
            spacing = (row_decs[right] - row_decs[left]) / (right - left)
        return row_decs[left] + (row - left) * spacing
    right = known_rows[0]
    if len(known_rows) >= 2:
        next_row = known_rows[1]
        spacing = (row_decs[next_row] - row_decs[right]) / (next_row - right)
    else:
        spacing = lattice.dec_spacing_deg
    return row_decs[right] + (row - right) * spacing


def _interpolate_phase(phases: dict[int, float], row: int, known_rows: list[int]) -> float:
    """Interpolate or locally extrapolate the cyclic RA phase between rows."""
    if row in phases:
        return phases[row]
    lower = [value for value in known_rows if value < row]
    upper = [value for value in known_rows if value > row]
    if lower and upper:
        left = max(lower)
        right = min(upper)
    elif len(known_rows) >= 2 and not lower:
        left, right = known_rows[:2]
    elif len(known_rows) >= 2:
        left, right = known_rows[-2:]
    else:
        return phases[known_rows[0]]
    fraction = (row - left) / (right - left)
    delta = ((phases[right] - phases[left] + 0.5) % 1.0) - 0.5
    return (phases[left] + fraction * delta) % 1.0


def _exclude_occupied(
    centers: list[tuple[float, float]], tiles: list[TileRecord]
) -> list[tuple[float, float]]:
    """Remove centers already represented by a nearby catalogue tile."""
    kept: list[tuple[float, float]] = []
    for ra, dec in sorted(set(centers), key=lambda point: (point[1], point[0])):
        duplicate = any(
            math.hypot(
                _wrapped_ra_delta(ra, tile.ra_deg)
                * math.cos(math.radians((dec + tile.dec_deg) / 2)),
                dec - tile.dec_deg,
            )
            < OCCUPIED_CENTER_TOLERANCE_DEG
            for tile in tiles
        )
        if not duplicate:
            kept.append((float(ra % 360), float(dec)))
    return kept


def _sample_region(bounds: RegionBounds, polygon: SkyPolygon | None = None) -> _CoverageGrid:
    """Create a declination-weighted sample grid clipped to a sky polygon.

    The rectangular bounds are used only to lay out samples. For polygon
    requests, ray casting in locally unwrapped RA zeroes every outside weight.
    Each weight represents a cell of RA/DEC area times ``cos(DEC)``.
    """
    center_dec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2
    width_deg = bounds.ra_span_deg * max(math.cos(math.radians(center_dec)), 0.01)
    height_deg = bounds.dec_max_deg - bounds.dec_min_deg
    step = max(
        SAMPLE_STEP_DEG,
        math.sqrt(max(width_deg * height_deg, SAMPLE_STEP_DEG**2) / MAX_REGION_SAMPLES),
    )
    rows = max(1, math.ceil(height_deg / step))
    cols = max(1, math.ceil(bounds.ra_span_deg / step))
    if rows * cols > MAX_REGION_SAMPLES:
        scale = math.sqrt(rows * cols / MAX_REGION_SAMPLES)
        step *= scale
        rows = max(1, math.ceil(height_deg / step))
        cols = max(1, math.ceil(bounds.ra_span_deg / step))
    if polygon is not None:
        # Keep narrow but valid polygons measurable even below the nominal
        # 0.12-degree pitch; the bbox still only accelerates ray casting.
        rows = max(rows, MIN_POLYGON_SAMPLES_PER_AXIS)
        cols = max(cols, MIN_POLYGON_SAMPLES_PER_AXIS)
        while rows * cols > MAX_REGION_SAMPLES:
            if rows >= cols:
                rows -= 1
            else:
                cols -= 1
    step = max(height_deg / rows, bounds.ra_span_deg / cols)
    dec_values = bounds.dec_min_deg + (np.arange(rows) + 0.5) * height_deg / rows
    ra_offsets = (np.arange(cols) + 0.5) * bounds.ra_span_deg / cols
    ra_grid = (bounds.ra_start_deg + ra_offsets[None, :]) % 360
    ra_values = np.broadcast_to(ra_grid, (rows, cols)).ravel().copy()
    dec_grid = np.broadcast_to(dec_values[:, None], (rows, cols)).ravel().copy()
    weights = np.broadcast_to(np.cos(np.radians(dec_values))[:, None], (rows, cols)).ravel().copy()
    if polygon is not None:
        x = (ra_values - bounds.ra_start_deg) % 360
        y = dec_grid
        polygon_x = np.array(
            [(vertex.ra_deg - bounds.ra_start_deg) % 360 for vertex in polygon.vertices]
        )
        polygon_y = np.array([vertex.dec_deg for vertex in polygon.vertices])
        inside = np.zeros(len(x), dtype=bool)
        for index in range(len(polygon_x)):
            next_index = (index + 1) % len(polygon_x)
            x1, y1 = polygon_x[index], polygon_y[index]
            x2, y2 = polygon_x[next_index], polygon_y[next_index]
            crossing = ((y1 > y) != (y2 > y)) & (
                x < (x2 - x1) * (y - y1) / (y2 - y1 if y2 != y1 else 1) + x1
            )
            inside ^= crossing
        weights *= inside
        if not np.any(inside):
            raise ValueError("Polygon is too small for the coverage sample resolution")
    return _CoverageGrid(
        ra_values,
        dec_grid,
        weights,
        float(weights.sum()),
        step,
        (bounds.ra_start_deg + bounds.ra_span_deg / 2) % 360,
        center_dec,
        bounds.ra_span_deg,
        bounds.dec_min_deg,
        bounds.dec_max_deg,
        (bounds.ra_span_deg / cols) * (height_deg / rows),
    )


def _tile_mask(
    grid: _CoverageGrid, ra_deg: float, dec_deg: float, profile: TilingProfile
) -> np.ndarray:
    """Return sampled points inside the profile's rectangular footprint."""
    dec_inside = np.abs(grid.dec_deg - dec_deg) <= profile.tile_height_deg / 2
    ra_physical = np.abs(_wrapped_ra_array(grid.ra_deg, ra_deg)) * math.cos(math.radians(dec_deg))
    return (grid.weights > 0) & dec_inside & (ra_physical <= profile.tile_width_deg / 2)


def _covered_mask(
    grid: _CoverageGrid, tiles: list[TileRecord], profile: TilingProfile
) -> np.ndarray:
    """Union all existing tile footprints over the region sample grid."""
    covered = np.zeros(len(grid.ra_deg), dtype=bool)
    for tile in tiles:
        covered |= _tile_mask(grid, tile.ra_deg, tile.dec_deg, profile)
        if covered.all():
            break
    return covered


def _contributing_tile_count(
    grid: _CoverageGrid, tiles: list[TileRecord], profile: TilingProfile
) -> int:
    """Count existing tiles whose footprints overlap any sampled region point."""
    return sum(bool(np.any(_tile_mask(grid, tile.ra_deg, tile.dec_deg, profile))) for tile in tiles)


def _greedy_choose(
    candidates: list[tuple[tuple[float, float], np.ndarray]],
    existing_mask: np.ndarray,
    grid: _CoverageGrid,
    max_count: int,
    profile: TilingProfile,
    automatic_target: float | None = None,
) -> list[tuple[float, float, np.ndarray]]:
    """Greedily maximize incremental coverage with deterministic tie breaks."""
    uncovered = ~existing_mask.copy()
    total_weight = grid.total_weight
    selected: list[tuple[float, float, np.ndarray]] = []
    remaining = list(candidates)
    while remaining and len(selected) < max_count:
        current_coverage = 1 - float(grid.weights[uncovered].sum()) / max(total_weight, 1e-12)
        if automatic_target is not None and current_coverage >= automatic_target:
            break
        scored: list[tuple[float, float, float, float, float, int]] = []
        for index, ((ra, dec), mask) in enumerate(remaining):
            gain = float(grid.weights[mask & uncovered].sum())
            overlap = float(grid.weights[mask & ~uncovered].sum())
            inside = max(float(grid.weights[mask].sum()), 1e-12)
            outside_area = _outside_tile_area(mask, grid, profile)
            scored.append((gain, -overlap / inside, -outside_area, -dec, -ra, index))
        best_score = max(scored)
        best_index = best_score[-1]
        (ra, dec), mask = remaining.pop(best_index)
        gain = float(grid.weights[mask & uncovered].sum())
        if gain / max(total_weight, 1e-12) < MIN_INCREMENTAL_GAIN:
            if automatic_target is not None:
                break
            break
        selected.append((ra, dec, mask))
        uncovered &= ~mask
    return selected


def _outside_tile_area(mask: np.ndarray, grid: _CoverageGrid, profile: TilingProfile) -> float:
    """Estimate one footprint's area outside the actual selected polygon."""
    selected_area = float(grid.weights[mask].sum()) * grid.cell_area_deg2
    return max(0.0, profile.tile_width_deg * profile.tile_height_deg - selected_area)


def _measure_metrics(
    selected: list[tuple[float, float, np.ndarray]],
    existing_mask: np.ndarray,
    grid: _CoverageGrid,
    contributing: int,
    profile: TilingProfile,
) -> PlanMetrics:
    """Measure final region coverage and proposal overlap from sampled masks."""
    covered = existing_mask.copy()
    new_covered = np.zeros(len(grid.ra_deg), dtype=bool)
    proposed_sample_weight = 0.0
    redundant_sample_weight = 0.0
    outside_area = 0.0
    for _ra, _dec, mask in selected:
        redundant_sample_weight += float(grid.weights[mask & covered].sum())
        proposed_sample_weight += float(grid.weights[mask].sum())
        new_covered |= mask & ~covered
        covered |= mask
        outside_area += _outside_tile_area(mask, grid, profile)
    total = max(grid.total_weight, 1e-12)
    total_coverage = float(grid.weights[covered].sum()) / total
    already_covered = float(grid.weights[existing_mask].sum()) / total
    incremental = float(grid.weights[new_covered].sum()) / total
    redundant = redundant_sample_weight / max(proposed_sample_weight, 1e-12) if selected else 0.0
    area_deg2 = grid.total_weight * grid.cell_area_deg2
    return PlanMetrics(
        existing_tiles_contributing=contributing,
        new_tiles=len(selected),
        selected_region_area_deg2=round(area_deg2, 4),
        already_covered_fraction=round(already_covered, 5),
        selected_region_coverage=round(total_coverage, 5),
        incremental_coverage=round(incremental, 5),
        remaining_uncovered_fraction=round(max(0, 1 - total_coverage), 5),
        remaining_uncovered_area_deg2=round(max(0, 1 - total_coverage) * area_deg2, 4),
        redundant_coverage=round(redundant, 5),
        outside_region_coverage_deg2=round(outside_area, 4),
        sample_step_deg=round(grid.step_deg, 4),
    )


def _circular_phase(values: list[float], period: float) -> float:
    """Calculate a deterministic circular mean modulo ``period``."""
    angles = np.asarray(values, dtype=float) * (2 * math.pi / period)
    mean = np.mean(np.exp(1j * angles))
    phase = math.atan2(float(mean.imag), float(mean.real)) % (2 * math.pi)
    return phase * period / (2 * math.pi)


def _modular_distance(value: float, phase: float, period: float) -> float:
    """Return shortest absolute difference modulo a positive period."""
    return abs((value - phase + period / 2) % period - period / 2)


def _wrapped_ra_delta(ra: float, reference: float) -> float:
    """Return the signed shortest RA difference in degrees."""
    return (ra - reference + 180) % 360 - 180


def _wrapped_ra_array(ra: np.ndarray, reference: float) -> np.ndarray:
    """Vectorized signed shortest RA difference in degrees."""
    return (ra - reference + 180) % 360 - 180
