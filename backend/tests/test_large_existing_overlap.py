"""Independent large-region checks for actual catalogue coverage and occupancy."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord

from app.models import CoverageRequest, RegionPlanRequest, SkyPolygon, TileRecord, TileSource
from app.profiles import load_profile
from app.science.catalogue import parse_catalogue_csv
from app.science.planner import (
    OCCUPIED_CENTER_TOLERANCE_DEG,
    _contributing_tile_count,
    _exclude_occupied,
    measure_active_coverage,
    plan_region,
)

REFERENCE = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
RA_MIN, RA_MAX = 262.0, 277.0
DEC_MIN, DEC_MAX = -40.0, -27.0


def _catalogue() -> list[TileRecord]:
    """Load all 4,774 real ICRS catalogue centers in decimal degrees."""
    return parse_catalogue_csv(REFERENCE.read_bytes())["tiles"]


def _polygon() -> SkyPolygon:
    """Return a deterministic ICRS rectangle overlapping many SPLUS-b rows."""
    return SkyPolygon(vertices=[
        {"ra_deg": RA_MIN, "dec_deg": DEC_MIN},
        {"ra_deg": RA_MAX, "dec_deg": DEC_MIN},
        {"ra_deg": RA_MAX, "dec_deg": DEC_MAX},
        {"ra_deg": RA_MIN, "dec_deg": DEC_MAX},
    ])


def _intersects_rectangle(tile: TileRecord) -> bool:
    """Check positive overlap using actual tile RA/DEC rectangle extents.

    Parameters
    ----------
    tile : TileRecord
        Actual ICRS center in degrees.

    Returns
    -------
    bool
        Whether its configured footprint has positive area inside the test
        rectangle, independently of lattice inference and sampled masks.
    """
    profile = load_profile()
    half_ra = profile.tile_width_deg / (2 * math.cos(math.radians(tile.dec_deg)))
    half_dec = profile.tile_height_deg / 2
    return (
        tile.ra_deg + half_ra > RA_MIN
        and tile.ra_deg - half_ra < RA_MAX
        and tile.dec_deg + half_dec > DEC_MIN
        and tile.dec_deg - half_dec < DEC_MAX
    )


def _independent_existing_fraction(tiles: list[TileRecord]) -> float:
    """Integrate real footprints on an independent fine ICRS sample grid.

    Parameters
    ----------
    tiles : list[TileRecord]
        Loaded historical pointings in decimal degrees. Only footprints
        intersecting the fixed rectangle are evaluated.

    Returns
    -------
    float
        Existing selected-area coverage fraction, weighted by cos(DEC),
        sampled at 0.04-degree pitch rather than the planner's 0.12 degrees.
    """
    profile = load_profile()
    ra = RA_MIN + (np.arange(375) + 0.5) * (RA_MAX - RA_MIN) / 375
    dec = DEC_MIN + (np.arange(325) + 0.5) * (DEC_MAX - DEC_MIN) / 325
    ra_grid, dec_grid = np.meshgrid(ra, dec)
    covered = np.zeros(ra_grid.shape, dtype=bool)
    for tile in tiles:
        if not _intersects_rectangle(tile):
            continue
        half_ra = profile.tile_width_deg / (2 * math.cos(math.radians(tile.dec_deg)))
        covered |= (
            (np.abs(ra_grid - tile.ra_deg) <= half_ra)
            & (np.abs(dec_grid - tile.dec_deg) <= profile.tile_height_deg / 2)
        )
    weights = np.cos(np.deg2rad(dec_grid))
    return float(weights[covered].sum() / weights.sum())


def _minimum_separation_deg(centers: list[TileRecord], tiles: list[TileRecord]) -> float:
    """Find the minimum true spherical separation from centers to loaded tiles.

    Parameters
    ----------
    centers, tiles : list[TileRecord]
        ICRS RA/DEC pointings in decimal degrees.

    Returns
    -------
    float
        Smallest great-circle angular separation in degrees.
    """
    proposed = SkyCoord(
        [tile.ra_deg for tile in centers] * u.deg,
        [tile.dec_deg for tile in centers] * u.deg,
        frame="icrs",
    )
    existing = SkyCoord(
        [tile.ra_deg for tile in tiles] * u.deg,
        [tile.dec_deg for tile in tiles] * u.deg,
        frame="icrs",
    )
    separation = proposed[:, np.newaxis].separation(existing[np.newaxis, :])
    return float(np.min(separation.deg))


def test_large_splus_b_overlap_uses_actual_existing_footprints() -> None:
    """Protect coverage, occupancy, and candidate selection on a real mosaic.

    The full loaded reference catalogue is used. Center containment and tile
    intersection are measured independently for a 162-degree-squared ICRS
    region, and a finer cos(DEC)-weighted grid checks the already-covered
    fraction. SkyCoord supplies true spherical occupancy distances.
    """
    tiles = _catalogue()
    polygon = _polygon()
    profile = load_profile()
    inside = [
        tile for tile in tiles
        if RA_MIN < tile.ra_deg < RA_MAX and DEC_MIN < tile.dec_deg < DEC_MAX
    ]
    geometric_contributors = sum(_intersects_rectangle(tile) for tile in tiles)
    independent_fraction = _independent_existing_fraction(tiles)
    response = plan_region(RegionPlanRequest(polygon=polygon, existing_tiles=tiles))
    metrics = response.metrics
    direct = measure_active_coverage(CoverageRequest(
        polygon=polygon, existing_tiles=tiles, proposed_tiles=[]
    ))

    assert len(inside) == 64
    assert geometric_contributors == 88
    assert all(_contributing_tile_count(polygon, [tile], profile) == 1 for tile in inside)
    assert metrics.existing_tiles_contributing == geometric_contributors
    assert metrics.existing_tiles_contributing >= len(inside)
    assert metrics.already_covered_fraction > 0.75
    assert abs(metrics.already_covered_fraction - independent_fraction) < 0.015
    assert metrics.already_covered_fraction == direct.already_covered_fraction
    assert metrics.existing_tiles_contributing == direct.existing_tiles_contributing

    assert response.solution == "extended_existing_grid"
    assert response.tiles
    candidate_positions = {
        (candidate.ra_deg, candidate.dec_deg) for candidate in response.candidate_centers
    }
    assert all((tile.ra_deg, tile.dec_deg) in candidate_positions for tile in response.tiles)
    candidates_as_tiles = [
        response.tiles[0].model_copy(update={"ra_deg": center.ra_deg, "dec_deg": center.dec_deg})
        for center in response.candidate_centers
    ]
    assert _minimum_separation_deg(candidates_as_tiles, tiles) > OCCUPIED_CENTER_TOLERANCE_DEG
    assert _minimum_separation_deg(response.tiles, tiles) > OCCUPIED_CENTER_TOLERANCE_DEG
    assert metrics.redundant_coverage < 0.1
    assert metrics.selected_region_coverage >= 0.99
    print(
        f"inside={len(inside)} contributors={metrics.existing_tiles_contributing} "
        f"already={metrics.already_covered_fraction:.5f} "
        f"independent={independent_fraction:.5f} proposals={len(response.tiles)} "
        f"min_separation_deg={_minimum_separation_deg(response.tiles, tiles):.5f} "
        f"redundant={metrics.redundant_coverage:.5f} "
        f"final={metrics.selected_region_coverage:.5f}"
    )


def test_occupancy_uses_great_circle_distance_to_actual_center() -> None:
    """Reject a polar near duplicate that a local RA/DEC tangent misses.

    At DEC 89.95 degrees, pointings separated by 180 degrees in RA are only
    0.10 degree apart on the sphere. The old ``delta_RA * cos(DEC)`` estimate
    is about 0.157 degree and would leave this candidate unoccupied.
    """
    existing = TileRecord(
        id="actual-polar-center", ra_deg=0.0, dec_deg=89.95,
        source=TileSource.ORIGINAL, original_values={"RA": "0", "DEC": "89.95"},
    )
    candidate = (180.0, 89.95)
    assert _exclude_occupied([candidate], [existing]) == []


def test_existing_contributor_counts_a_narrow_real_footprint_intersection() -> None:
    """Count a positive footprint sliver smaller than a coverage sample cell."""
    profile = load_profile()
    center_ra, center_dec = 150.0, -30.0
    half_ra = profile.tile_width_deg / (2 * math.cos(math.radians(center_dec)))
    tile = TileRecord(
        id="actual-edge-center", ra_deg=center_ra, dec_deg=center_dec,
        source=TileSource.ORIGINAL, original_values={"RA": "150", "DEC": "-30"},
    )
    ra_start = center_ra + half_ra - 0.0005
    ra_end = center_ra + half_ra + 0.2
    polygon = SkyPolygon(vertices=[
        {"ra_deg": ra_start, "dec_deg": -30.2},
        {"ra_deg": ra_end, "dec_deg": -30.2},
        {"ra_deg": ra_end, "dec_deg": -29.8},
        {"ra_deg": ra_start, "dec_deg": -29.8},
    ])
    assert _contributing_tile_count(polygon, [tile], profile) == 1
