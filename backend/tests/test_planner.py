"""Existing-grid inference and deterministic coverage selection tests."""

from __future__ import annotations

import math
from itertools import pairwise
from statistics import median

import pytest

from app.models import (
    GenerationMethod,
    RegionBounds,
    RegionPlanRequest,
    SkyPolygon,
    TileRecord,
    TileSource,
)
from app.profiles import load_profile
from app.science.catalogue import parse_catalogue_csv
from app.science.geometry import CENTER_SPACING_DEG
from app.science.planner import (
    INFERENCE_TOLERANCE_DEG,
    _infer_lattice,
    _lattice_candidates,
    _tiles_near_region,
    plan_region,
)


def original(index: int, ra: float, dec: float) -> TileRecord:
    """Create a synthetic immutable tile for focused planner tests."""
    values = {
        "PID": "SPLUS",
        "NAME": f"SPLUS_{index:04d}",
        "RA": "10:00:00",
        "DEC": "-30:00:00",
        "EPOC": "2000",
        "STATUS": "1",
    }
    return TileRecord(
        id=f"original-{index}",
        name=values["NAME"],
        ra_deg=ra,
        dec_deg=dec,
        source=TileSource.ORIGINAL,
        group_id="synthetic-splus",
        original_values=values,
    )


def local_grid() -> list[TileRecord]:
    """Build a three-row, five-column lattice near RA 150 deg, DEC -30 deg."""
    tiles = []
    index = 1
    for row in range(3):
        dec = -31 + row * CENTER_SPACING_DEG
        ra_step = CENTER_SPACING_DEG / math.cos(math.radians(dec))
        for column in range(5):
            tiles.append(original(index, 150.3 + column * ra_step, dec))
            index += 1
    return tiles


def rectangle(ra_start: float, ra_end: float, dec_min: float, dec_max: float) -> SkyPolygon:
    """Represent rectangular regression regions as ordered celestial vertices."""
    return SkyPolygon(vertices=[
        {"ra_deg": ra_start, "dec_deg": dec_min},
        {"ra_deg": ra_end, "dec_deg": dec_min},
        {"ra_deg": ra_end, "dec_deg": dec_max},
        {"ra_deg": ra_start, "dec_deg": dec_max},
    ])


def test_reference_catalogue_inference_tolerance_is_calibrated() -> None:
    """The 0.05-degree tolerance covers measured local S-PLUS spacings."""
    from pathlib import Path

    assert INFERENCE_TOLERANCE_DEG == pytest.approx(0.05)
    assert INFERENCE_TOLERANCE_DEG < 0.1
    reference = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    catalogue = parse_catalogue_csv(reference.read_bytes())
    local_tiles = [
        tile
        for tile in catalogue["tiles"]
        if tile.metadata.get("PID") == "SPLUS" and 118 <= tile.ra_deg <= 138
        and -62 <= tile.dec_deg <= -57
    ]
    row_groups: dict[float, list[TileRecord]] = {}
    for tile in local_tiles:
        row_groups.setdefault(round(tile.dec_deg, 3), []).append(tile)
    horizontal_steps = [
        (right.ra_deg - left.ra_deg) * math.cos(math.radians(dec))
        for dec, row in row_groups.items()
        for left, right in pairwise(sorted(row, key=lambda tile: tile.ra_deg))
    ]
    dec_rows = sorted({tile.dec_deg for tile in local_tiles})
    vertical_steps = [right - left for left, right in pairwise(dec_rows)]
    assert (
        min(abs(step - CENTER_SPACING_DEG) for step in horizontal_steps) < INFERENCE_TOLERANCE_DEG
    )
    assert min(abs(step - CENTER_SPACING_DEG) for step in vertical_steps) < INFERENCE_TOLERANCE_DEG


def test_real_reference_catalogue_extends_a_southern_edge_region() -> None:
    """The supplied catalogue anchors an automatic extension at its south edge."""
    from pathlib import Path

    reference = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    catalogue = parse_catalogue_csv(reference.read_bytes())
    request = RegionPlanRequest(
        polygon=rectangle(120, 135, -61, -57),
        existing_tiles=catalogue["tiles"],
    )
    response = plan_region(request)
    assert response.solution == "extended_existing_grid"
    assert len(response.inference.anchor_tile_ids) >= 4
    assert response.tiles
    assert response.metrics.selected_region_coverage >= 0.95
    assert all(
        tile.generation_method == GenerationMethod.REGION_EXTENDED for tile in response.tiles
    )


def test_splus_b_candidates_preserve_the_observed_local_lattice() -> None:
    """Wide historical rows retain their measured DEC and local RA phases."""
    from pathlib import Path

    reference = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    catalogue = parse_catalogue_csv(reference.read_bytes())
    tiles = [tile for tile in catalogue["tiles"] if tile.name.startswith("SPLUS-b")]
    bounds = RegionBounds(
        ra_start_deg=255,
        ra_end_deg=287,
        dec_min_deg=-44.5,
        dec_max_deg=-18,
    )
    center_ra = (bounds.ra_start_deg + bounds.ra_span_deg / 2) % 360
    center_dec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2
    profile = load_profile()
    anchors = _tiles_near_region(tiles, bounds, center_ra, center_dec, profile)
    lattice = _infer_lattice(anchors, center_ra, center_dec, profile)

    assert lattice is not None
    assert lattice.ra_spacing_deg == pytest.approx(1.405, abs=0.01)
    candidates = _lattice_candidates(bounds, lattice, profile)
    rows: dict[float, list[TileRecord]] = {}
    for tile in anchors:
        rows.setdefault(round(tile.dec_deg, 5), []).append(tile)

    checked_rows = 0
    for dec, row_tiles in rows.items():
        row_candidates = [center for center in candidates if abs(center[1] - dec) < 0.02]
        if not row_candidates:
            continue
        ordered = sorted(row_tiles, key=lambda tile: tile.ra_deg)
        physical_steps = [
            (right.ra_deg - left.ra_deg) * math.cos(math.radians(dec))
            for left, right in pairwise(ordered)
        ]
        observed_steps = [
            step for step in physical_steps if step <= profile.ra_spacing_deg + 0.05
        ]
        if not observed_steps:
            continue
        pitch = median(observed_steps)
        step_ra = pitch / math.cos(math.radians(dec))
        for ra, _candidate_dec in row_candidates:
            residual = min(
                abs((ra - tile.ra_deg + step_ra / 2) % step_ra - step_ra / 2)
                * math.cos(math.radians(dec))
                for tile in ordered
            )
            assert residual <= 2 * INFERENCE_TOLERANCE_DEG
        checked_rows += 1
    assert checked_rows >= 12


def test_existing_grid_is_inferred_from_multiple_anchors() -> None:
    """Neighboring rows and columns extend the known grid into uncovered sky."""
    request = RegionPlanRequest(
        polygon=rectangle(156, 161, -30.8, -27.6),
        existing_tiles=local_grid(),
    )
    response = plan_region(request)
    assert response.solution == "extended_existing_grid"
    assert response.generation_method == GenerationMethod.REGION_EXTENDED
    assert len(response.inference.anchor_tile_ids) >= 6
    assert response.inference.compatible_neighbor_pairs >= 2
    assert len(response.inference.anchor_tile_ids) <= response.inference.nearby_tile_count < len(request.existing_tiles)
    assert response.inference.dec_spacing_deg is not None
    assert response.inference.ra_spacing_deg is not None
    assert "anchor_tiles_used" not in response.metrics.model_dump()
    assert response.tiles
    assert any(tile.id in response.inference.anchor_tile_ids for tile in request.existing_tiles)
    assert response.diagnostics[0].startswith("Extended the local grid")


def test_insufficient_anchors_fall_back_to_legacy_bounds() -> None:
    """A single nearby tile cannot define a phase and therefore is not trusted."""
    request = RegionPlanRequest(
        polygon=rectangle(143, 151, -40, -20),
        existing_tiles=[original(1, 150, -30)],
    )
    response = plan_region(request)
    assert response.solution == "legacy_bounds_fallback"
    assert response.generation_method == GenerationMethod.REGION_LEGACY
    assert response.inference.anchor_tile_ids == []
    assert response.inference.nearby_tile_count == 1
    assert response.inference.compatible_neighbor_pairs == 0
    assert response.inference.dec_spacing_deg is None
    assert response.inference.ra_spacing_deg is None
    assert "anchor_tiles_used" not in response.metrics.model_dump()
    assert response.tiles


def test_existing_centers_are_excluded_from_fallback_candidates() -> None:
    """A candidate already occupied by an existing tile is never proposed."""
    polygon = rectangle(143, 151, -40, -20)
    empty_plan = plan_region(RegionPlanRequest(polygon=polygon, existing_tiles=[]))
    candidate = empty_plan.candidate_centers[0]
    occupied = original(1, candidate.ra_deg, candidate.dec_deg)
    response = plan_region(RegionPlanRequest(polygon=polygon, existing_tiles=[occupied]))
    assert all(
        math.hypot(tile.ra_deg - occupied.ra_deg, tile.dec_deg - occupied.dec_deg) > 0.12
        for tile in response.tiles
    )


def test_automatic_mode_is_deterministic_and_reports_coverage_metrics() -> None:
    """Automatic solutions and all required coverage metrics are stable."""
    request = RegionPlanRequest(
        polygon=rectangle(156, 161, -30.8, -27.6),
        existing_tiles=local_grid(),
    )
    first = plan_region(request)
    second = plan_region(request)
    assert [(tile.ra_deg, tile.dec_deg) for tile in first.tiles] == [
        (tile.ra_deg, tile.dec_deg) for tile in second.tiles
    ]
    assert first.metrics.selected_region_area_deg2 > 0
    assert first.metrics.existing_tiles_contributing > 0
    assert 0 <= first.metrics.selected_region_coverage <= 1
    assert 0 <= first.metrics.incremental_coverage <= 1
    assert first.metrics.outside_region_coverage_deg2 >= 0
    assert first.metrics.already_covered_fraction > 0
    assert first.metrics.remaining_uncovered_fraction == pytest.approx(
        1 - first.metrics.selected_region_coverage, abs=1e-5
    )


def test_multiple_datasets_can_anchor_and_cover_one_polygon() -> None:
    """Distinct catalogue identities together supply anchors and occupied coverage."""
    tiles = local_grid()
    for index, tile in enumerate(tiles):
        tile.dataset_id = "first" if index % 2 else "second"
        tile.group_id = tile.dataset_id
    polygon = rectangle(153, 159, -31, -27)
    response = plan_region(RegionPlanRequest(polygon=polygon, existing_tiles=tiles))
    assert response.solution == "extended_existing_grid"
    assert {tile.dataset_id for tile in tiles if tile.id in response.inference.anchor_tile_ids} == {
        "first", "second"
    }
    assert response.metrics.existing_tiles_contributing > 0


def test_concave_polygon_does_not_fill_empty_bounding_corner() -> None:
    """An L-shaped region excludes candidate positions in its empty corner."""
    polygon = SkyPolygon(vertices=[
        {"ra_deg": ra, "dec_deg": dec}
        for ra, dec in [(150, -31), (156, -31), (156, -29),
                        (152, -29), (152, -25), (150, -25)]
    ])
    response = plan_region(RegionPlanRequest(polygon=polygon, existing_tiles=[]))
    assert response.solution == "legacy_bounds_fallback"
    assert response.tiles
    assert all(not (tile.ra_deg > 153.5 and tile.dec_deg > -27.5) for tile in response.tiles)
    assert response.metrics.selected_region_coverage > 0.9
