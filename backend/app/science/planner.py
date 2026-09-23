"""Deterministic existing-aware tile lattice inference and coverage selection."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.models import (
    CenterInput,
    GenerationMethod,
    PlanMetrics,
    PlanningMode,
    RegionBounds,
    RegionPlanRequest,
    RegionPlanResponse,
    TileRecord,
    TileSource,
)
from app.science.geometry import (
    CENTER_SPACING_DEG,
    LEGACY_ALGORITHM,
    TILE_SIZE_DEG,
    legacy_grid_centers,
)

# Calibrated against nearest-neighbor spacings in reference/tiles_nc.csv:
# SPLUS rows cluster near 1.354–1.359 deg, while the compatibility step is
# 1.3667 deg. A 0.05 deg (3 arcmin) tolerance includes the observed variation
# without treating unrelated sub-degree or 1.4+ degree layouts as anchors.
INFERENCE_TOLERANCE_DEG = 0.05
SEARCH_MARGIN_DEG = 3 * TILE_SIZE_DEG
CANDIDATE_MARGIN_DEG = TILE_SIZE_DEG / 2
OCCUPIED_CENTER_TOLERANCE_DEG = 0.12
SAMPLE_STEP_DEG = 0.12
MAX_CANDIDATES = 1200
MAX_REGION_SAMPLES = 90_000
AUTOMATIC_COVERAGE_TARGET = 0.95
MIN_INCREMENTAL_GAIN = 0.0005


@dataclass(frozen=True)
class _Lattice:
    """Locally inferred axis-aligned lattice parameters and its anchors."""

    dec_phase_deg: float
    dec_spacing_deg: float
    ra_spacing_deg: float
    row_ra_phase_fraction: dict[int, float]
    anchor_ids: tuple[str, ...]
    pair_count: int


@dataclass(frozen=True)
class _CoverageGrid:
    """Sample points and area weights over the selected RA/DEC rectangle."""

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


def plan_region(request: RegionPlanRequest) -> RegionPlanResponse:
    """Infer or fall back to a lattice, then select useful tile centers.

    Parameters
    ----------
    request : RegionPlanRequest
        Selected sky bounds, existing catalogue tiles, and planning mode.

    Returns
    -------
    RegionPlanResponse
        Deterministic proposal centers, lattice candidates, anchor audit trail,
        and sampled coverage metrics.

    Raises
    ------
    ValueError
        If the region is too large to plan safely or fixed N exceeds the
        number of centers that can add selected-region coverage.
    """
    bounds = request.bounds
    region_center_ra = (bounds.ra_start_deg + bounds.ra_span_deg / 2) % 360
    region_center_dec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2
    local_tiles = _tiles_near_region(
        request.existing_tiles, bounds, region_center_ra, region_center_dec
    )
    lattice = _infer_lattice(local_tiles, region_center_ra, region_center_dec)
    if lattice is None:
        solution = "legacy_bounds_fallback"
        method = GenerationMethod.REGION_LEGACY
        raw_candidates = legacy_grid_centers(
            (bounds.ra_start_deg, bounds.ra_end_deg),
            (bounds.dec_min_deg, bounds.dec_max_deg),
            wraps_ra=bounds.ra_start_deg > bounds.ra_end_deg,
        )
        anchors: tuple[str, ...] = ()
        diagnostics = [
            f"No reliable local lattice was found from {len(local_tiles)} nearby tiles; "
            f"used {LEGACY_ALGORITHM} on the selected bounds."
        ]
    else:
        solution = "extended_existing_grid"
        method = GenerationMethod.REGION_EXTENDED
        raw_candidates = _lattice_candidates(bounds, lattice)
        anchors = lattice.anchor_ids
        diagnostics = [
            f"Extended the local grid using {lattice.pair_count} compatible neighbor pairs "
            f"and {len(anchors)} anchor tiles.",
            f"Inferred DEC spacing {lattice.dec_spacing_deg:.4f} deg and physical RA spacing "
            f"{lattice.ra_spacing_deg:.4f} deg; compatibility tolerance is "
            f"{INFERENCE_TOLERANCE_DEG:.2f} deg.",
        ]

    if len(raw_candidates) > MAX_CANDIDATES:
        raise ValueError(
            f"This region produces {len(raw_candidates)} lattice candidates; reduce the selected "
            f"area to at most {MAX_CANDIDATES}."
        )
    unique_candidates = _exclude_occupied(raw_candidates, request.existing_tiles, region_center_dec)
    grid = _sample_region(bounds)
    existing_mask = _covered_mask(grid, request.existing_tiles)
    contributing_count = _contributing_tile_count(grid, request.existing_tiles)
    candidate_masks = [_tile_mask(grid, ra, dec) for ra, dec in unique_candidates]
    useful: list[tuple[tuple[float, float], np.ndarray]] = []
    for center, mask in zip(unique_candidates, candidate_masks, strict=True):
        if np.any(mask & ~existing_mask):
            useful.append((center, mask))

    if request.mode == PlanningMode.FIXED:
        count = request.count or 0
        if count > len(useful):
            raise ValueError(
                f"Requested {count} new tiles, but only {len(useful)} non-occupied lattice centers "
                "add coverage to the selected region."
            )
        chosen = _greedy_choose(useful, existing_mask, grid, count)
        if len(chosen) != count:
            raise ValueError(
                f"Requested {count} new tiles, but only {len(chosen)} centers add distinct "
                "incremental coverage."
            )
    else:
        chosen = _greedy_choose(
            useful,
            existing_mask,
            grid,
            max_count=len(useful),
            automatic_target=AUTOMATIC_COVERAGE_TARGET,
        )

    proposed = [
        TileRecord(
            id=f"proposal-region-{index:04d}",
            pid="PROPOSED",
            name=f"PROPOSED_{index:04d}",
            ra_deg=ra,
            dec_deg=dec,
            epoch="2000",
            status="-5",
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
        len(anchors),
        len(useful),
    )
    if not proposed and metrics.selected_region_coverage >= AUTOMATIC_COVERAGE_TARGET:
        diagnostics.append(
            "Existing tiles already meet the automatic 95% selected-region coverage target."
        )
    elif not proposed:
        diagnostics.append("No unoccupied lattice centers add sampled coverage to this region.")
    return RegionPlanResponse(
        solution=solution,
        generation_method=method,
        tiles=proposed,
        candidate_centers=candidate_centers,
        anchor_tile_ids=list(anchors),
        diagnostics=diagnostics,
        metrics=metrics,
    )


def _tiles_near_region(
    tiles: list[TileRecord], bounds: RegionBounds, center_ra: float, center_dec: float
) -> list[TileRecord]:
    """Filter tiles to the region plus the configured physical search margin."""
    region_half_width = bounds.ra_span_deg * math.cos(math.radians(center_dec)) / 2
    region_half_height = (bounds.dec_max_deg - bounds.dec_min_deg) / 2
    result: list[TileRecord] = []
    for tile in tiles:
        dx = _wrapped_ra_delta(tile.ra_deg, center_ra) * math.cos(math.radians(center_dec))
        dy = tile.dec_deg - center_dec
        if (
            abs(dx) <= region_half_width + SEARCH_MARGIN_DEG
            and abs(dy) <= region_half_height + SEARCH_MARGIN_DEG
        ):
            result.append(tile)
    return result


def _infer_lattice(tiles: list[TileRecord], center_ra: float, center_dec: float) -> _Lattice | None:
    """Infer the strongest locally consistent catalogue-group lattice."""
    groups: dict[str, list[TileRecord]] = {}
    for tile in tiles:
        if tile.source == TileSource.ORIGINAL:
            group = f"original:{tile.pid}"
        else:
            group = f"proposed:{tile.generation_method}"
        groups.setdefault(group, []).append(tile)
    candidates = [
        lattice
        for group_tiles in groups.values()
        if (lattice := _infer_lattice_group(group_tiles, center_ra, center_dec)) is not None
    ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda lattice: (
            lattice.pair_count,
            len(lattice.anchor_ids),
            -abs(lattice.dec_spacing_deg - CENTER_SPACING_DEG)
            - abs(lattice.ra_spacing_deg - CENTER_SPACING_DEG),
            lattice.anchor_ids,
        ),
    )


def _infer_lattice_group(
    tiles: list[TileRecord], center_ra: float, center_dec: float
) -> _Lattice | None:
    """Infer one grid phase from several neighbor relationships in one PID."""
    if len(tiles) < 3:
        return None
    cos_dec = math.cos(math.radians(center_dec))
    points = sorted(
        [
            (tile.dec_deg, _wrapped_ra_delta(tile.ra_deg, center_ra) * cos_dec, tile)
            for tile in tiles
        ],
        key=lambda point: (point[0], point[1], point[2].id),
    )
    horizontal_steps: list[float] = []
    vertical_steps: list[float] = []
    pair_ids: set[tuple[str, str]] = set()
    anchor_ids: set[str] = set()
    for i, (dec_i, x_i, tile_i) in enumerate(points):
        for dec_j, x_j, tile_j in points[i + 1 :]:
            dy = abs(dec_j - dec_i)
            if dy > CENTER_SPACING_DEG + INFERENCE_TOLERANCE_DEG:
                break
            dx = abs(x_j - x_i)
            if dx > 1.6 * CENTER_SPACING_DEG:
                continue
            if (
                dy <= INFERENCE_TOLERANCE_DEG
                and abs(dx - CENTER_SPACING_DEG) <= INFERENCE_TOLERANCE_DEG
            ):
                horizontal_steps.append(dx)
                pair_ids.add(tuple(sorted((tile_i.id, tile_j.id))))
            elif (
                abs(dy - CENTER_SPACING_DEG) <= INFERENCE_TOLERANCE_DEG
                and dx <= 0.75 * CENTER_SPACING_DEG
            ):
                vertical_steps.append(dy)
                pair_ids.add(tuple(sorted((tile_i.id, tile_j.id))))
    for left_id, right_id in pair_ids:
        anchor_ids.update((left_id, right_id))
    if len(pair_ids) < 2 or len(anchor_ids) < 3:
        return None

    dec_spacing = float(np.median(vertical_steps or horizontal_steps))
    ra_spacing = float(np.median(horizontal_steps or vertical_steps))
    if (
        abs(dec_spacing - CENTER_SPACING_DEG) > INFERENCE_TOLERANCE_DEG
        or abs(ra_spacing - CENTER_SPACING_DEG) > INFERENCE_TOLERANCE_DEG
    ):
        return None
    anchors = [tile for tile in tiles if tile.id in anchor_ids]
    dec_phase = _circular_phase([tile.dec_deg for tile in anchors], dec_spacing)
    dec_residuals = [_modular_distance(tile.dec_deg, dec_phase, dec_spacing) for tile in anchors]
    if (
        np.median(dec_residuals) > INFERENCE_TOLERANCE_DEG
        or max(dec_residuals) > 2 * INFERENCE_TOLERANCE_DEG
    ):
        return None

    row_indices: dict[int, list[TileRecord]] = {}
    for tile in anchors:
        row = round((tile.dec_deg - dec_phase) / dec_spacing)
        row_indices.setdefault(row, []).append(tile)
    row_phases: dict[int, float] = {}
    for row, row_tiles in row_indices.items():
        fractions = []
        for tile in row_tiles:
            step_ra = ra_spacing / max(math.cos(math.radians(tile.dec_deg)), 1e-6)
            unwrapped_ra = tile.ra_deg + 360 * round((center_ra - tile.ra_deg) / 360)
            fractions.append((unwrapped_ra % step_ra) / step_ra)
        row_phases[row] = _circular_phase(fractions, 1.0)
    return _Lattice(
        dec_phase_deg=dec_phase,
        dec_spacing_deg=dec_spacing,
        ra_spacing_deg=ra_spacing,
        row_ra_phase_fraction=row_phases,
        anchor_ids=tuple(sorted(anchor_ids)),
        pair_count=len(pair_ids),
    )


def _lattice_candidates(bounds: RegionBounds, lattice: _Lattice) -> list[tuple[float, float]]:
    """Continue the inferred axis-aligned lattice across the region margin."""
    dec_min = bounds.dec_min_deg - CANDIDATE_MARGIN_DEG
    dec_max = bounds.dec_max_deg + CANDIDATE_MARGIN_DEG
    first_row = math.ceil((dec_min - lattice.dec_phase_deg) / lattice.dec_spacing_deg)
    last_row = math.floor((dec_max - lattice.dec_phase_deg) / lattice.dec_spacing_deg)
    ra_start = bounds.ra_start_deg
    ra_end = ra_start + bounds.ra_span_deg
    center_ra = ra_start + bounds.ra_span_deg / 2
    known_rows = sorted(lattice.row_ra_phase_fraction)
    candidates: list[tuple[float, float]] = []
    for row in range(first_row, last_row + 1):
        dec = lattice.dec_phase_deg + row * lattice.dec_spacing_deg
        if not -90 < dec < 90:
            continue
        phase_fraction = _interpolate_phase(lattice.row_ra_phase_fraction, row, known_rows)
        step_ra = lattice.ra_spacing_deg / math.cos(math.radians(dec))
        phase_ra = phase_fraction * step_ra
        margin_ra = CANDIDATE_MARGIN_DEG / max(math.cos(math.radians(dec)), 1e-6)
        first_col = math.ceil((ra_start - margin_ra - phase_ra) / step_ra)
        last_col = math.floor((ra_end + margin_ra - phase_ra) / step_ra)
        for col in range(first_col, last_col + 1):
            unwrapped_ra = phase_ra + col * step_ra
            if abs(
                _wrapped_ra_delta(unwrapped_ra % 360, center_ra % 360) * math.cos(math.radians(dec))
            ) <= (bounds.ra_span_deg * math.cos(math.radians(dec)) / 2 + CANDIDATE_MARGIN_DEG):
                candidates.append((unwrapped_ra % 360, dec))
    return sorted(set(candidates), key=lambda point: (point[1], point[0]))


def _interpolate_phase(phases: dict[int, float], row: int, known_rows: list[int]) -> float:
    """Interpolate the cyclic RA phase between anchor rows."""
    if row in phases:
        return phases[row]
    lower = [value for value in known_rows if value < row]
    upper = [value for value in known_rows if value > row]
    if lower and upper:
        left = max(lower)
        right = min(upper)
        fraction = (row - left) / (right - left)
        delta = ((phases[right] - phases[left] + 0.5) % 1.0) - 0.5
        return (phases[left] + fraction * delta) % 1.0
    nearest = min(known_rows, key=lambda known: (abs(known - row), known))
    return phases[nearest]


def _exclude_occupied(
    centers: list[tuple[float, float]], tiles: list[TileRecord], reference_dec: float
) -> list[tuple[float, float]]:
    """Remove centers already represented by a nearby catalogue tile."""
    kept: list[tuple[float, float]] = []
    cos_dec = math.cos(math.radians(reference_dec))
    for ra, dec in sorted(set(centers), key=lambda point: (point[1], point[0])):
        duplicate = any(
            math.hypot(
                _wrapped_ra_delta(ra, tile.ra_deg) * cos_dec,
                dec - tile.dec_deg,
            )
            < OCCUPIED_CENTER_TOLERANCE_DEG
            for tile in tiles
        )
        if not duplicate:
            kept.append((float(ra % 360), float(dec)))
    return kept


def _sample_region(bounds: RegionBounds) -> _CoverageGrid:
    """Create a weighted rectangular sample grid capped for interactive use."""
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
    dec_values = bounds.dec_min_deg + (np.arange(rows) + 0.5) * height_deg / rows
    ra_offsets = (np.arange(cols) + 0.5) * bounds.ra_span_deg / cols
    ra_grid = (bounds.ra_start_deg + ra_offsets[None, :]) % 360
    ra_values = np.broadcast_to(ra_grid, (rows, cols)).ravel().copy()
    dec_grid = np.broadcast_to(dec_values[:, None], (rows, cols)).ravel().copy()
    weights = np.broadcast_to(np.cos(np.radians(dec_values))[:, None], (rows, cols)).ravel().copy()
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
    )


def _tile_mask(grid: _CoverageGrid, ra_deg: float, dec_deg: float) -> np.ndarray:
    """Return sampled sky points covered by an approximate 1.4-degree tile."""
    dec_inside = np.abs(grid.dec_deg - dec_deg) <= TILE_SIZE_DEG / 2
    ra_physical = np.abs(_wrapped_ra_array(grid.ra_deg, ra_deg)) * math.cos(math.radians(dec_deg))
    return dec_inside & (ra_physical <= TILE_SIZE_DEG / 2)


def _covered_mask(grid: _CoverageGrid, tiles: list[TileRecord]) -> np.ndarray:
    """Union all existing tile footprints over the region sample grid."""
    covered = np.zeros(len(grid.ra_deg), dtype=bool)
    for tile in tiles:
        covered |= _tile_mask(grid, tile.ra_deg, tile.dec_deg)
        if covered.all():
            break
    return covered


def _contributing_tile_count(grid: _CoverageGrid, tiles: list[TileRecord]) -> int:
    """Count existing tiles whose footprints overlap any sampled region point."""
    return sum(bool(np.any(_tile_mask(grid, tile.ra_deg, tile.dec_deg))) for tile in tiles)


def _greedy_choose(
    candidates: list[tuple[tuple[float, float], np.ndarray]],
    existing_mask: np.ndarray,
    grid: _CoverageGrid,
    max_count: int,
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
            outside_area = _outside_tile_area(ra, dec, grid)
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


def _outside_tile_area(ra: float, dec: float, grid: _CoverageGrid) -> float:
    """Estimate new tile area outside the selected rectangle in square degrees."""
    half = TILE_SIZE_DEG / 2
    ref_ra = grid.center_ra_deg
    ref_dec = grid.center_dec_deg
    center_x = _wrapped_ra_delta(ra, ref_ra) * math.cos(math.radians(ref_dec))
    region_x_min = -grid.ra_span_deg * math.cos(math.radians(ref_dec)) / 2
    region_x_max = -region_x_min
    region_y_min = grid.dec_min_deg
    region_y_max = grid.dec_max_deg
    inside_x = max(0.0, min(center_x + half, region_x_max) - max(center_x - half, region_x_min))
    inside_y = max(0.0, min(dec + half, region_y_max) - max(dec - half, region_y_min))
    return max(0.0, TILE_SIZE_DEG**2 - inside_x * inside_y)


def _measure_metrics(
    selected: list[tuple[float, float, np.ndarray]],
    existing_mask: np.ndarray,
    grid: _CoverageGrid,
    contributing: int,
    anchor_count: int,
    candidates_available: int,
) -> PlanMetrics:
    """Measure final region coverage and proposal overlap from sampled masks."""
    covered = existing_mask.copy()
    new_covered = np.zeros(len(grid.ra_deg), dtype=bool)
    proposed_sample_weight = 0.0
    redundant_sample_weight = 0.0
    outside_area = 0.0
    for ra, dec, mask in selected:
        redundant_sample_weight += float(grid.weights[mask & covered].sum())
        proposed_sample_weight += float(grid.weights[mask].sum())
        new_covered |= mask & ~covered
        covered |= mask
        outside_area += _outside_tile_area(ra, dec, grid)
    total = max(grid.total_weight, 1e-12)
    total_coverage = float(grid.weights[covered].sum()) / total
    incremental = float(grid.weights[new_covered].sum()) / total
    redundant = redundant_sample_weight / max(proposed_sample_weight, 1e-12) if selected else 0.0
    area_deg2 = (
        math.radians(grid.ra_span_deg)
        * (math.sin(math.radians(grid.dec_max_deg)) - math.sin(math.radians(grid.dec_min_deg)))
        * (180 / math.pi) ** 2
    )
    return PlanMetrics(
        existing_tiles_contributing=contributing,
        anchor_tiles_used=anchor_count,
        candidates_available=candidates_available,
        new_tiles=len(selected),
        selected_region_area_deg2=round(area_deg2, 4),
        selected_region_coverage=round(total_coverage, 5),
        incremental_coverage=round(incremental, 5),
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
