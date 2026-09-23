"""Golden equivalence and edge-case tests for legacy tile geometry."""

from __future__ import annotations

import contextlib
import importlib.util
import io
from pathlib import Path

import numpy as np
import pytest
from astropy import units as u

from app.science.geometry import CENTER_SPACING_DEG, legacy_grid_centers


def reference_centers(ra_bounds: tuple[float, float], dec_bounds: tuple[float, float]):
    """Execute the checked-in legacy builder and return decimal-degree centers."""
    path = Path(__file__).resolve().parents[2] / "reference" / "create_tiles.py"
    spec = importlib.util.spec_from_file_location("legacy_create_tiles", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with contextlib.redirect_stdout(io.StringIO()):
        ras, decs = module.build_big_square_of_tiles_lon_lat(
            np.asarray(ra_bounds) * u.deg,
            np.asarray(dec_bounds) * u.deg,
            tile_size=1.4,
            overlap=30,
        )
    return [(float(ra.degree), float(dec.degree)) for ra, dec in zip(ras, decs, strict=True)]


def angular_ra_error(left: float, right: float) -> float:
    """Shortest absolute RA difference in degrees."""
    return abs((left - right + 180) % 360 - 180)


def test_golden_matches_reference_for_t80_south_example() -> None:
    """Compatibility output agrees with the reference below 1e-10 degrees."""
    expected = reference_centers((143, 151), (-40, -20))
    actual = legacy_grid_centers((143, 151), (-40, -20))
    assert len(actual) == len(expected)
    assert len(actual) > 50
    for actual_center, expected_center in zip(actual, expected, strict=True):
        assert angular_ra_error(actual_center[0], expected_center[0]) < 1e-10
        assert abs(actual_center[1] - expected_center[1]) < 1e-10


def test_ra_step_uses_declination_correction() -> None:
    """Physical RA separation is the legacy 1.3667 degrees at each row."""
    centers = legacy_grid_centers((143, 151), (-40, -20))
    rows: dict[float, list[float]] = {}
    for ra, dec in centers:
        rows.setdefault(dec, []).append(ra)
    lower_row = min(rows)
    upper_row = max(rows)
    lower_step = angular_ra_error(rows[lower_row][1], rows[lower_row][0]) * np.cos(
        np.deg2rad(lower_row)
    )
    upper_step = angular_ra_error(rows[upper_row][1], rows[upper_row][0]) * np.cos(
        np.deg2rad(upper_row)
    )
    assert lower_step == pytest.approx(CENTER_SPACING_DEG, abs=1e-10)
    assert upper_step == pytest.approx(CENTER_SPACING_DEG, abs=1e-10)
    assert rows[lower_row][1] - rows[lower_row][0] > rows[upper_row][1] - rows[upper_row][0]


def test_reversed_bounds_are_normalized() -> None:
    """Reversing either rectangle axis produces the same center ordering."""
    baseline = legacy_grid_centers((143, 151), (-40, -20))
    assert legacy_grid_centers((151, 143), (-40, -20)) == baseline
    assert legacy_grid_centers((143, 151), (-20, -40)) == baseline
    assert legacy_grid_centers((151, 143), (-20, -40)) == baseline


def test_ra_wrap_interval_crosses_zero_without_creating_a_long_arc() -> None:
    """Explicit wrap bounds only traverse the small eastward interval."""
    centers = legacy_grid_centers((359, 2), (-1, 1), wraps_ra=True)
    assert centers
    assert all(ra > 359 or ra < 2.1 for ra, _ in centers)
    assert any(ra > 359 for ra, _ in centers)
    assert any(ra < 2.1 for ra, _ in centers)
