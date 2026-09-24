"""Coverage and export behavior for reversible proposal edits."""

from __future__ import annotations

import csv
import io

import pytest
from pydantic import ValidationError

from app.models import CoverageRequest, ExportRequest, SkyPolygon, TileRecord, TileSource
from app.science.export import build_export_csv
from app.science.planner import measure_active_coverage


def test_disable_and_restore_same_center_updates_coverage() -> None:
    """Inactive centers remain stable but stop contributing selected sky area."""
    region = SkyPolygon(vertices=[
        {"ra_deg": 150, "dec_deg": -31}, {"ra_deg": 154, "dec_deg": -31},
        {"ra_deg": 154, "dec_deg": -27}, {"ra_deg": 150, "dec_deg": -27},
    ])
    tile = TileRecord(
        id="proposal-1", ra_deg=151, dec_deg=-30,
        source=TileSource.PROPOSED, generation_method="region_legacy",
    )
    request = CoverageRequest(polygon=region, existing_tiles=[], proposed_tiles=[tile])
    enabled = measure_active_coverage(request)
    tile.enabled = False
    removed = measure_active_coverage(request)
    assert removed.new_tiles == 0
    assert removed.selected_region_coverage == 0
    assert enabled.selected_region_coverage > removed.selected_region_coverage
    assert tile.id == "proposal-1"
    tile.enabled = True
    restored = measure_active_coverage(request)
    assert restored.selected_region_coverage == enabled.selected_region_coverage


def test_disabled_tiles_are_excluded_from_export_and_originals_are_immutable() -> None:
    """Only active proposed positions serialize; imported rows cannot be disabled."""
    first = TileRecord(
        id="p1", ra_deg=150, dec_deg=-30,
        source=TileSource.PROPOSED, generation_method="manual",
    )
    second = TileRecord(
        id="p2", ra_deg=151, dec_deg=-30,
        source=TileSource.PROPOSED, generation_method="manual", enabled=False,
    )
    text = build_export_csv(ExportRequest(proposed_tiles=[first, second]))
    rows = list(csv.DictReader(io.StringIO(text)))
    assert len(rows) == 1
    with pytest.raises(ValidationError, match="cannot be disabled"):
        TileRecord(
            id="original", ra_deg=150, dec_deg=-30, source=TileSource.ORIGINAL,
            original_values={"RA": "150", "DEC": "-30"}, enabled=False,
        )


def test_disabled_existing_proposal_does_not_count_as_historical_coverage() -> None:
    """An inactive accepted pointing cannot occupy sky in direct coverage."""
    region = SkyPolygon(vertices=[
        {"ra_deg": 150, "dec_deg": -31}, {"ra_deg": 154, "dec_deg": -31},
        {"ra_deg": 154, "dec_deg": -27}, {"ra_deg": 150, "dec_deg": -27},
    ])
    disabled = TileRecord(
        id="accepted-disabled", ra_deg=151, dec_deg=-30,
        source=TileSource.PROPOSED, generation_method="region_extended", enabled=False,
    )
    metrics = measure_active_coverage(CoverageRequest(
        polygon=region, existing_tiles=[disabled], proposed_tiles=[]
    ))
    assert metrics.existing_tiles_contributing == 0
    assert metrics.already_covered_fraction == 0
