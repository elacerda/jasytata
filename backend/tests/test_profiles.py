"""Profile loading and alternate geometry checks."""

from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from app.models import RegionPlanRequest, SkyPolygon
from app.profiles import TilingProfile, load_profile
from app.science.planner import plan_region


def test_default_profile_preserves_reference_geometry() -> None:
    """The installed S-PLUS profile exposes physical overlap and legacy mode."""
    profile = load_profile()
    assert profile.algorithm == "SPLUS_LEGACY_GRID_V1"
    assert profile.tile_width_deg == profile.tile_height_deg == 1.4
    assert profile.effective_overlap_arcsec == 120
    assert profile.export_epoch_default == "2000"
    assert profile.export_epoch_options == ["2000"]
    assert profile.ra_spacing_deg == pytest.approx(1.4 - 120 / 3600)


def test_synthetic_profile_changes_generated_spacing() -> None:
    """A second instrument uses its own rectangular dimensions and overlap."""
    profile = TilingProfile(
        id="synthetic",
        display_name="Synthetic camera",
        tile_width_deg=2,
        tile_height_deg=1,
        effective_overlap_arcsec=360,
        algorithm="RECT_GRID_V1",
    )
    response = plan_region(
        RegionPlanRequest(
            polygon=SkyPolygon(vertices=[
                {"ra_deg": 10, "dec_deg": -1}, {"ra_deg": 15, "dec_deg": -1},
                {"ra_deg": 15, "dec_deg": 3}, {"ra_deg": 10, "dec_deg": 3},
            ]),
            existing_tiles=[],
        ),
        profile,
    )
    assert response.candidate_centers
    first_dec = response.candidate_centers[0].dec_deg
    assert response.candidate_centers[1].ra_deg - response.candidate_centers[
        0
    ].ra_deg == pytest.approx(profile.ra_spacing_deg / math.cos(math.radians(first_dec)))


@pytest.mark.parametrize(
    "changes",
    [
        {"effective_overlap_arcsec": 3600},
        {"algorithm": "unknown"},
        {"coordinate_frame": "galactic"},
        {"export_epoch_default": "2050"},
        {"tile_width_deg": -1},
    ],
)
def test_invalid_profile_fails_clearly(changes: dict) -> None:
    """Unsupported or nonphysical profile values produce validation errors."""
    data = dict(
        id="synthetic",
        display_name="Synthetic",
        tile_width_deg=2,
        tile_height_deg=1,
        effective_overlap_arcsec=60,
        algorithm="RECT_GRID_V1",
    )
    data.update(changes)
    with pytest.raises(ValidationError):
        TilingProfile(**data)
