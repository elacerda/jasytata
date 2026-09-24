"""Generate compact browser parity fixtures from the unchanged Python reference."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.models import (
    CoverageRequest,
    ExportRequest,
    RegionPlanRequest,
    SkyPolygon,
    TileRecord,
)
from app.profiles import load_profile
from app.science.catalogue import parse_catalogue_csv, parse_center_text
from app.science.coordinates import (
    format_dec_degrees,
    format_ra_degrees,
    parse_dec_degrees,
    parse_ra_degrees,
)
from app.science.export import build_export_csv
from app.science.geometry import legacy_grid_centers
from app.science.planner import measure_active_coverage, plan_region


def polygon(points: list[tuple[float, float]]) -> SkyPolygon:
    """Build an ICRS polygon from ordered decimal-degree RA/DEC pairs.

    Parameters
    ----------
    points : list[tuple[float, float]]
        Ordered ICRS right ascension and declination in degrees.

    Returns
    -------
    SkyPolygon
        Validated reference polygon with implicit closure.
    """
    return SkyPolygon(vertices=[{"ra_deg": ra, "dec_deg": dec} for ra, dec in points])


def main() -> None:
    """Write deterministic Python outputs for browser-side parity checks.

    The only side effect is replacement of frontend/src/data/golden.json.
    Coordinates are ICRS decimal degrees; metric areas are square degrees.
    """
    reference = parse_catalogue_csv(
        (ROOT / "reference" / "tiles_nc.csv").read_bytes(), "tiles_nc.csv"
    )
    by_name = {tile.name: tile for tile in reference["tiles"]}
    coordinate_inputs = [
        ["10:03:05", "-23:54:31", "auto"],
        ["10 03 05", "-24.25", "auto"],
        ["150.5", "+00:00:00", "auto"],
        ["360", "-90", "degrees"],
        ["10.5", "89:59:59", "hours"],
        ["23:59:59.999", "-00:00:01", "auto"],
        ["-01:00:00", "12 30", "auto"],
        ["10h03m05s", "10d03m05s", "auto"],
        ["10d03m05s", "10°03′05″", "hours"],
        ["10m", "10s", "auto"],
    ]
    coordinates = [
        {
            "input": values,
            "ra_deg": parse_ra_degrees(values[0], unit=values[2]),
            "dec_deg": parse_dec_degrees(values[1]),
        }
        for values in coordinate_inputs
    ]
    formatting = [
        {
            "input": [ra, dec, precision],
            "ra": format_ra_degrees(ra, precision=precision),
            "dec": format_dec_degrees(dec, precision=precision),
        }
        for ra, dec, precision in [
            (150.7708333333, -23.9086111111, 0),
            (359.999999, -0.0001, 3),
            (0.0, 0.0, 3),
            (150.5, -24.25, 3),
        ]
    ]
    catalogue_inputs = [
        "ra,dec\n150.5,-24.25\n",
        "ra_deg,dec_deg,field_id,quality\n150.5,-24.25,DR6_1,good\n",
        "RA,ra_deg,DEC,label\n10:03:05,150.77,-23:54:31,A\n",
        'RA,DEC,NAME,comment\n10:03:05,-23:54:31,"Quoted, name","two ""quotes"""\n',
        "ra_hours,dec\n10.5,-24\n",
    ]
    catalogues = []
    for source in catalogue_inputs:
        mapping = (
            {"ra_column": "RA", "dec_column": "DEC"}
            if source.startswith("RA,ra_deg")
            else {}
        )
        parsed = parse_catalogue_csv(source.encode(), "fixture.csv", **mapping)
        catalogues.append(
            {
                "csv": source,
                "mapping": mapping,
                "result": {
                    **parsed,
                    "tiles": [tile.model_dump(mode="json") for tile in parsed["tiles"]],
                },
            }
        )
    centers_text = "RA, DEC\n10:03:05, -23:54:31\n150.5 -24.25\n10 03 05 -23 54 31"
    centers = [
        center.model_dump(mode="json") for center in parse_center_text(centers_text)
    ]
    proposal = TileRecord(
        id="proposal-1",
        ra_deg=150.5,
        dec_deg=-24.25,
        source="proposed",
        generation_method="manual",
    )
    exports = {
        fmt: build_export_csv(
            ExportRequest(proposed_tiles=[proposal], coordinate_format=fmt)
        )
        for fmt in ("decimal", "sexagesimal")
    }
    wrap_polygon = polygon([(359.2, -30), (0.8, -30), (0.8, -28), (359.2, -28)])
    holdout_names = ["SPLUS-b076", "SPLUS-b060", "SPLUS-b077", "SPLUS-b061"]
    hidden = [by_name[name] for name in holdout_names]
    center_dec = median(tile.dec_deg for tile in hidden)
    center_ra = median(tile.ra_deg for tile in hidden)
    surrounding = [
        tile
        for tile in reference["tiles"]
        if tile.metadata.get("PID") == "SPLUS"
        and abs(tile.dec_deg - center_dec) < 5
        and abs(tile.ra_deg - center_ra) * math.cos(math.radians(center_dec)) < 8
        and tile.name not in holdout_names
    ]
    ra_margin = 0.72 / math.cos(math.radians(center_dec))
    holdout_polygon = polygon(
        [
            (
                min(tile.ra_deg for tile in hidden) - ra_margin,
                min(tile.dec_deg for tile in hidden) - 0.72,
            ),
            (
                max(tile.ra_deg for tile in hidden) + ra_margin,
                min(tile.dec_deg for tile in hidden) - 0.72,
            ),
            (
                max(tile.ra_deg for tile in hidden) + ra_margin,
                max(tile.dec_deg for tile in hidden) + 0.72,
            ),
            (
                min(tile.ra_deg for tile in hidden) - ra_margin,
                max(tile.dec_deg for tile in hidden) + 0.72,
            ),
        ]
    )
    holdout = plan_region(
        RegionPlanRequest(polygon=holdout_polygon, existing_tiles=surrounding)
    )
    fallback_center = by_name["SPLUS-b076"]
    fallback_ra_margin = 0.72 / math.cos(math.radians(fallback_center.dec_deg))
    fallback_polygon = polygon(
        [
            (
                fallback_center.ra_deg - fallback_ra_margin,
                fallback_center.dec_deg - 0.72,
            ),
            (
                fallback_center.ra_deg + fallback_ra_margin,
                fallback_center.dec_deg - 0.72,
            ),
            (
                fallback_center.ra_deg + fallback_ra_margin,
                fallback_center.dec_deg + 0.72,
            ),
            (
                fallback_center.ra_deg - fallback_ra_margin,
                fallback_center.dec_deg + 0.72,
            ),
        ]
    )
    fallback = plan_region(
        RegionPlanRequest(
            polygon=fallback_polygon, existing_tiles=[by_name["SPLUS-b075"]]
        )
    )
    overlap_polygon = polygon([(262, -40), (277, -40), (277, -27), (262, -27)])
    overlap = plan_region(
        RegionPlanRequest(polygon=overlap_polygon, existing_tiles=reference["tiles"])
    )
    overlap_existing = measure_active_coverage(
        CoverageRequest(
            polygon=overlap_polygon,
            existing_tiles=reference["tiles"],
            proposed_tiles=[],
        )
    )
    fixture = {
        "source": "backend Python reference at fixture-generation time",
        "coordinates": coordinates,
        "formatting": formatting,
        "catalogues": catalogues,
        "centers": {"text": centers_text, "result": centers},
        "profile": load_profile().model_dump(mode="json"),
        "exports": exports,
        "geometry": {
            "wrapped_bounds": {
                **wrap_polygon.bounds.model_dump(mode="json"),
                "ra_span_deg": wrap_polygon.bounds.ra_span_deg,
            },
            "legacy_wrap_centers": legacy_grid_centers(
                (359, 2), (-1, 1), wraps_ra=True
            ),
        },
        "historical_holdout": {
            "hidden_names": holdout_names,
            "polygon": holdout_polygon.model_dump(mode="json"),
            "surrounding_names": [tile.name for tile in surrounding],
            "solution": holdout.solution,
            "proposal_centers": [[tile.ra_deg, tile.dec_deg] for tile in holdout.tiles],
            "metrics": holdout.metrics.model_dump(mode="json"),
        },
        "historical_fallback": {
            "hidden_name": "SPLUS-b076",
            "anchor_name": "SPLUS-b075",
            "polygon": fallback_polygon.model_dump(mode="json"),
            "solution": fallback.solution,
            "proposal_centers": [
                [tile.ra_deg, tile.dec_deg] for tile in fallback.tiles
            ],
            "metrics": fallback.metrics.model_dump(mode="json"),
        },
        "large_overlap": {
            "polygon": overlap_polygon.model_dump(mode="json"),
            "catalogue": "tiles_nc.csv",
            "solution": overlap.solution,
            "proposal_centers": [[tile.ra_deg, tile.dec_deg] for tile in overlap.tiles],
            "anchor_count": len(overlap.inference.anchor_tile_ids),
            "metrics": overlap.metrics.model_dump(mode="json"),
            "existing_only_metrics": overlap_existing.model_dump(mode="json"),
        },
    }
    path = ROOT / "frontend" / "src" / "data" / "golden.json"
    path.write_text(
        json.dumps(fixture, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
