"""Existing-grid inference and deterministic coverage selection tests."""

from __future__ import annotations

import math
from itertools import pairwise

import pytest

from app.models import (
    GenerationMethod,
    PlanningMode,
    RegionBounds,
    RegionPlanRequest,
    TileRecord,
    TileSource,
)
from app.science.catalogue import parse_catalogue_csv
from app.science.geometry import CENTER_SPACING_DEG, legacy_grid_centers
from app.science.planner import INFERENCE_TOLERANCE_DEG, plan_region


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
        pid="SPLUS",
        name=values["NAME"],
        ra_deg=ra,
        dec_deg=dec,
        epoch="2000",
        status="1",
        source=TileSource.ORIGINAL,
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
        if tile.pid == "SPLUS" and 118 <= tile.ra_deg <= 138 and -62 <= tile.dec_deg <= -57
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
        bounds=RegionBounds(ra_start_deg=120, ra_end_deg=135, dec_min_deg=-61, dec_max_deg=-57),
        existing_tiles=catalogue["tiles"],
        mode=PlanningMode.AUTOMATIC,
    )
    response = plan_region(request)
    assert response.solution == "extended_existing_grid"
    assert len(response.anchor_tile_ids) >= 4
    assert response.tiles
    assert response.metrics.selected_region_coverage >= 0.95
    assert all(
        tile.generation_method == GenerationMethod.REGION_EXTENDED for tile in response.tiles
    )


def test_fixed_n_against_reference_catalogue_returns_exact_new_count() -> None:
    """Fixed-N remains exact when planning against the real supplied rows."""
    from pathlib import Path

    reference = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    catalogue = parse_catalogue_csv(reference.read_bytes())
    bounds = RegionBounds(ra_start_deg=120, ra_end_deg=135, dec_min_deg=-61, dec_max_deg=-57)
    first = plan_region(
        RegionPlanRequest(
            bounds=bounds,
            existing_tiles=catalogue["tiles"],
            mode=PlanningMode.FIXED,
            count=4,
        )
    )
    second = plan_region(
        RegionPlanRequest(
            bounds=bounds,
            existing_tiles=catalogue["tiles"],
            mode=PlanningMode.FIXED,
            count=5,
        )
    )
    assert len(first.tiles) == 4
    assert len(second.tiles) == 5
    assert [(tile.ra_deg, tile.dec_deg) for tile in first.tiles] == [
        (tile.ra_deg, tile.dec_deg)
        for tile in plan_region(
            RegionPlanRequest(
                bounds=bounds,
                existing_tiles=catalogue["tiles"],
                mode=PlanningMode.FIXED,
                count=4,
            )
        ).tiles
    ]


def test_existing_grid_is_inferred_from_multiple_anchors() -> None:
    """Neighboring rows and columns extend the known grid into uncovered sky."""
    request = RegionPlanRequest(
        bounds=RegionBounds(ra_start_deg=156, ra_end_deg=161, dec_min_deg=-30.8, dec_max_deg=-27.6),
        existing_tiles=local_grid(),
        mode=PlanningMode.AUTOMATIC,
    )
    response = plan_region(request)
    assert response.solution == "extended_existing_grid"
    assert response.generation_method == GenerationMethod.REGION_EXTENDED
    assert len(response.anchor_tile_ids) >= 6
    assert response.metrics.anchor_tiles_used == len(response.anchor_tile_ids)
    assert response.tiles
    assert any(tile.id in response.anchor_tile_ids for tile in request.existing_tiles)
    assert response.diagnostics[0].startswith("Extended the local grid")


def test_insufficient_anchors_fall_back_to_legacy_bounds() -> None:
    """A single nearby tile cannot define a phase and therefore is not trusted."""
    request = RegionPlanRequest(
        bounds=RegionBounds(ra_start_deg=143, ra_end_deg=151, dec_min_deg=-40, dec_max_deg=-20),
        existing_tiles=[original(1, 150, -30)],
        mode=PlanningMode.AUTOMATIC,
    )
    response = plan_region(request)
    assert response.solution == "legacy_bounds_fallback"
    assert response.generation_method == GenerationMethod.REGION_LEGACY
    assert response.anchor_tile_ids == []
    assert response.tiles


def test_existing_centers_are_excluded_from_fallback_candidates() -> None:
    """A candidate already occupied by an existing tile is never proposed."""
    bounds = RegionBounds(ra_start_deg=143, ra_end_deg=151, dec_min_deg=-40, dec_max_deg=-20)
    first_legacy = legacy_grid_centers((143, 151), (-40, -20))[0]
    occupied = original(1, *first_legacy)
    response = plan_region(RegionPlanRequest(bounds=bounds, existing_tiles=[occupied]))
    assert all(
        math.hypot(tile.ra_deg - occupied.ra_deg, tile.dec_deg - occupied.dec_deg) > 0.12
        for tile in response.tiles
    )


def test_fixed_n_is_exact_and_deterministic() -> None:
    """Repeated fixed-N requests return exactly N centers in the same order."""
    request = RegionPlanRequest(
        bounds=RegionBounds(ra_start_deg=156, ra_end_deg=161, dec_min_deg=-30.8, dec_max_deg=-27.6),
        existing_tiles=local_grid(),
        mode=PlanningMode.FIXED,
        count=3,
    )
    first = plan_region(request)
    second = plan_region(request)
    assert len(first.tiles) == 3
    assert first.metrics.new_tiles == 3
    assert [(tile.ra_deg, tile.dec_deg) for tile in first.tiles] == [
        (tile.ra_deg, tile.dec_deg) for tile in second.tiles
    ]
    assert first.metrics.selected_region_coverage == second.metrics.selected_region_coverage


def test_fixed_n_rejects_count_above_available_lattice_positions() -> None:
    """The planner reports useful candidate capacity instead of inventing centers."""
    request = RegionPlanRequest(
        bounds=RegionBounds(ra_start_deg=156, ra_end_deg=157, dec_min_deg=-30.8, dec_max_deg=-30.1),
        existing_tiles=local_grid(),
        mode=PlanningMode.FIXED,
        count=20,
    )
    with pytest.raises(ValueError, match="only .* lattice centers add coverage"):
        plan_region(request)


def test_automatic_mode_is_deterministic_and_reports_coverage_metrics() -> None:
    """Automatic solutions and all required coverage metrics are stable."""
    request = RegionPlanRequest(
        bounds=RegionBounds(ra_start_deg=156, ra_end_deg=161, dec_min_deg=-30.8, dec_max_deg=-27.6),
        existing_tiles=local_grid(),
        mode=PlanningMode.AUTOMATIC,
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
