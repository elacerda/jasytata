"""Reconstruct withheld centers from coherent patches of the real T80 catalogue."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median

import numpy as np
import pytest
from astropy import units as u
from astropy.coordinates import SkyCoord

from app.models import RegionPlanRequest, SkyPolygon, TileRecord
from app.science.catalogue import parse_catalogue_csv
from app.science.planner import plan_region

REFERENCE = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"


@dataclass(frozen=True)
class HoldoutCase:
    """Historical centers hidden from one locally bounded ICRS planning patch."""

    region: str
    hidden_names: tuple[str, ...]
    anchor_name: str | None = None


CASES = (
    HoldoutCase("SPLUS-b interior single", ("SPLUS-b076",)),
    HoldoutCase("SPLUS-b three row holes", ("SPLUS-b075", "SPLUS-b076", "SPLUS-b077")),
    HoldoutCase(
        "SPLUS-b adjacent rows",
        ("SPLUS-b076", "SPLUS-b060", "SPLUS-b077", "SPLUS-b061"),
    ),
    HoldoutCase("SPLUS-n northern regime", ("SPLUS-n13s49", "SPLUS-n13s50")),
    HoldoutCase("SPLUS-b row edge", ("SPLUS-b041", "SPLUS-b042")),
    HoldoutCase("SPLUS-d southern regime", ("SPLUS-d513", "SPLUS-d514")),
    HoldoutCase("SPLUS-b insufficient anchors", ("SPLUS-b076",), "SPLUS-b075"),
)


def _reference_tiles() -> list[TileRecord]:
    """Load immutable ICRS tile centers from the real CSV.

    Returns
    -------
    list[TileRecord]
        Historical pointings with RA and DEC in decimal degrees.
    """
    return parse_catalogue_csv(REFERENCE.read_bytes())["tiles"]


def _angular_separation_arcsec(first: TileRecord, second: TileRecord) -> float:
    """Return true great-circle separation of two ICRS centers.

    Parameters
    ----------
    first, second : TileRecord
        ICRS centers with RA and DEC in decimal degrees.

    Returns
    -------
    float
        Spherical angular separation in arcseconds.
    """
    a = SkyCoord(first.ra_deg * u.deg, first.dec_deg * u.deg, frame="icrs")
    b = SkyCoord(second.ra_deg * u.deg, second.dec_deg * u.deg, frame="icrs")
    return float(a.separation(b).arcsecond)


def _lattice_scatter_arcsec(tiles: list[TileRecord]) -> float:
    """Measure the 95th percentile of real row midpoint residuals in arcseconds.

    Each uninterrupted three-center run predicts its middle ICRS position
    from the two neighbors. Only SPLUS-b/n/d rows with 0.9–1.5 physical
    degree east-west steps contribute, excluding genuine catalogue holes.
    The resulting scatter includes source sexagesimal rounding.

    Parameters
    ----------
    tiles : list[TileRecord]
        Historical ICRS catalogue centers in decimal degrees.

    Returns
    -------
    float
        95th-percentile spherical midpoint residual in arcseconds.
    """
    rows: dict[tuple[str, float], list[TileRecord]] = {}
    for tile in tiles:
        if tile.metadata.get("PID") != "SPLUS":
            continue
        family = tile.name.split("-")[-1][:1]
        if family not in {"b", "n", "d"}:
            continue
        rows.setdefault((family, round(tile.dec_deg, 3)), []).append(tile)
    residuals = []
    for (_family, dec), row in rows.items():
        ordered = sorted(row, key=lambda tile: tile.ra_deg)
        for left, middle, right in zip(ordered, ordered[1:], ordered[2:], strict=False):
            west = (middle.ra_deg - left.ra_deg) * math.cos(math.radians(dec))
            east = (right.ra_deg - middle.ra_deg) * math.cos(math.radians(dec))
            if not (0.9 < west < 1.5 and 0.9 < east < 1.5):
                continue
            midpoint = middle.model_copy(
                update={"ra_deg": (left.ra_deg + right.ra_deg) / 2,
                        "dec_deg": (left.dec_deg + right.dec_deg) / 2}
            )
            residuals.append(_angular_separation_arcsec(middle, midpoint))
    assert len(residuals) > 1000
    return float(np.percentile(residuals, 95))


def _holdout_polygon(hidden: list[TileRecord]) -> SkyPolygon:
    """Bound hidden ICRS centers by a physical footprint margin.

    Parameters
    ----------
    hidden : list[TileRecord]
        Historical centers with RA and DEC in decimal degrees.

    Returns
    -------
    SkyPolygon
        ICRS rectangle extending 0.72 physical degrees on both axes.
    """
    center_dec = median(tile.dec_deg for tile in hidden)
    ra_margin = 0.72 / math.cos(math.radians(center_dec))
    ra_min = min(tile.ra_deg for tile in hidden) - ra_margin
    ra_max = max(tile.ra_deg for tile in hidden) + ra_margin
    dec_min = min(tile.dec_deg for tile in hidden) - 0.72
    dec_max = max(tile.dec_deg for tile in hidden) + 0.72
    return SkyPolygon(vertices=[
        {"ra_deg": ra_min, "dec_deg": dec_min},
        {"ra_deg": ra_max, "dec_deg": dec_min},
        {"ra_deg": ra_max, "dec_deg": dec_max},
        {"ra_deg": ra_min, "dec_deg": dec_max},
    ])


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.region)
def test_reconstruct_real_historical_holdouts(case: HoldoutCase) -> None:
    """Recover real ICRS centers within twice measured lattice scatter.

    Inputs are coherent SPLUS catalogue patches in decimal degrees. The
    fallback case retains one real neighbor; other cases retain all SPLUS
    pointings within five DEC degrees and eight physical RA degrees. A
    one-to-one great-circle match counts recovery, and unmatched proposals
    count as unnecessary extras. The diagnostic line is the acceptance table.
    """
    catalogue = _reference_tiles()
    by_name = {tile.name: tile for tile in catalogue}
    hidden = [by_name[name] for name in case.hidden_names]
    center_dec = median(tile.dec_deg for tile in hidden)
    center_ra = median(tile.ra_deg for tile in hidden)
    if case.anchor_name:
        surrounding = [by_name[case.anchor_name]]
    else:
        surrounding = [
            tile for tile in catalogue
            if tile.metadata.get("PID") == "SPLUS"
            and abs(tile.dec_deg - center_dec) < 5
            and abs(tile.ra_deg - center_ra) * math.cos(math.radians(center_dec)) < 8
            and tile.name not in case.hidden_names
        ]
    response = plan_region(RegionPlanRequest(
        polygon=_holdout_polygon(hidden), existing_tiles=surrounding
    ))
    scatter = _lattice_scatter_arcsec(catalogue)
    tolerance = 2 * scatter
    assert 6 < scatter < 9
    assert tolerance < 18
    pair_distances = sorted(
        (_angular_separation_arcsec(historical, proposed), hidden_index, proposal_index)
        for hidden_index, historical in enumerate(hidden)
        for proposal_index, proposed in enumerate(response.tiles)
    )
    matches: list[float] = []
    matched_hidden: set[int] = set()
    matched_proposals: set[int] = set()
    for residual, hidden_index, proposal_index in pair_distances:
        if residual > tolerance:
            break
        if hidden_index not in matched_hidden and proposal_index not in matched_proposals:
            matches.append(residual)
            matched_hidden.add(hidden_index)
            matched_proposals.add(proposal_index)
    extras = len(response.tiles) - len(matches)
    median_residual = median(matches) if matches else None
    max_residual = max(matches) if matches else None
    recovery_fraction = len(matches) / len(hidden)
    print(
        f"{case.region} | {len(hidden)} | {len(matches)} | {recovery_fraction:.0%} | "
        f"{f'{median_residual:.1f} arcsec' if median_residual is not None else '—'} | "
        f"{f'{max_residual:.1f} arcsec' if max_residual is not None else '—'} | "
        f"{extras} | {response.solution}"
    )
    if case.anchor_name:
        assert response.solution == "profile_fallback"
        assert response.inference.nearby_tile_count == 1
        assert response.inference.anchor_tile_ids == []
    else:
        assert response.solution == "extended_existing_grid"
        assert len(matches) == len(hidden)
        assert extras == 0
        assert max_residual is not None and max_residual <= tolerance


def test_broad_splus_b_region_preserves_solution_quality() -> None:
    """Check a deterministic SPLUS-b rectangle without fixing its proposal count.

    The ICRS bounds cover the historical SPLUS-b declination regime in the
    reference catalogue. This measures broad-region coverage and redundancy
    while allowing the browser polygon to differ from these vertices.
    """
    tiles = [tile for tile in _reference_tiles() if tile.name.startswith("SPLUS-b")]
    polygon = SkyPolygon(vertices=[
        {"ra_deg": 255, "dec_deg": -44.5},
        {"ra_deg": 287, "dec_deg": -44.5},
        {"ra_deg": 287, "dec_deg": -18},
        {"ra_deg": 255, "dec_deg": -18},
    ])
    response = plan_region(RegionPlanRequest(polygon=polygon, existing_tiles=tiles))
    assert response.solution == "extended_existing_grid"
    assert len(response.inference.anchor_tile_ids) >= 150
    assert response.tiles
    assert response.metrics.selected_region_coverage >= 0.99
    assert response.metrics.redundant_coverage < 0.1
