"""Polygon validation and sampled sky selection tests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models import RegionPlanRequest, SkyPolygon
from app.science.planner import plan_region


def polygon(points: list[tuple[float, float]]) -> SkyPolygon:
    """Build an ICRS decimal-degree polygon from compact test coordinates."""
    return SkyPolygon(vertices=[{"ra_deg": ra, "dec_deg": dec} for ra, dec in points])


def test_polygon_validation_and_wrap() -> None:
    """Wrapped RA remains a narrow interval; malformed polygons fail clearly."""
    wrapped = polygon([(359.2, -30), (0.8, -30), (0.8, -28), (359.2, -28)])
    assert wrapped.bounds.ra_start_deg == pytest.approx(359.2)
    assert wrapped.bounds.ra_end_deg == pytest.approx(0.8)
    assert wrapped.bounds.ra_span_deg == pytest.approx(1.6)
    for points in [
        [(1, 0), (2, 0)],
        [(1, 0), (1, 0), (2, 1)],
        [(1, 0), (2, 0), (3, 0)],
        [(0, 0), (2, 2), (0, 2), (2, 0)],
    ]:
        with pytest.raises(ValidationError):
            polygon(points)


def test_polygon_area_is_not_bounding_box_area() -> None:
    """Triangle and concave sky selections score only their selected interior."""
    rectangle = plan_region(RegionPlanRequest(existing_tiles=[], polygon=polygon([
        (150, -31), (154, -31), (154, -27), (150, -27)
    ])))
    triangle = plan_region(RegionPlanRequest(existing_tiles=[], polygon=polygon([
        (150, -31), (154, -31), (150, -27)
    ])))
    concave = plan_region(RegionPlanRequest(existing_tiles=[], polygon=polygon([
        (150, -31), (154, -31), (154, -29), (152, -29), (152, -27), (150, -27)
    ])))
    rectangle_area = rectangle.metrics.selected_region_area_deg2
    assert triangle.metrics.selected_region_area_deg2 < rectangle_area * 0.6
    assert 0 < concave.metrics.selected_region_area_deg2 < rectangle_area
