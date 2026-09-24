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
    RegionPlanResponse,
    SkyPolygon,
    TileRecord,
)
from app.profiles import TilingProfile, load_profile
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


def compact_plan(response: RegionPlanResponse) -> dict:
    """Record ordered scientific planner outputs without repeating source rows.

    Parameters
    ----------
    response : RegionPlanResponse
        Python proposal for one ICRS polygon and its input pointings.

    Returns
    -------
    dict
        Ordered ICRS centers in degrees, discrete inference decisions, and
        sampled coverage metrics in fractions and square degrees.
    """
    return {
        "solution": response.solution,
        "generation_method": response.generation_method,
        "proposal_centers": [[tile.ra_deg, tile.dec_deg] for tile in response.tiles],
        "candidate_centers": [
            [center.ra_deg, center.dec_deg] for center in response.candidate_centers
        ],
        "inference": response.inference.model_dump(mode="json"),
        "diagnostics": response.diagnostics,
        "metrics": response.metrics.model_dump(mode="json"),
    }


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
    historical_cases = []
    for case_id, names, anchor_name in (
        ("splus_b_single", ("SPLUS-b076",), None),
        ("splus_b_three_holes", ("SPLUS-b075", "SPLUS-b076", "SPLUS-b077"), None),
        ("splus_b_adjacent_rows", tuple(holdout_names), None),
        ("splus_n_north", ("SPLUS-n13s49", "SPLUS-n13s50"), None),
        ("splus_b_row_edge", ("SPLUS-b041", "SPLUS-b042"), None),
        ("splus_d_south", ("SPLUS-d513", "SPLUS-d514"), None),
        ("splus_b_one_anchor", ("SPLUS-b076",), "SPLUS-b075"),
    ):
        hidden_tiles = [by_name[name] for name in names]
        median_dec = median(tile.dec_deg for tile in hidden_tiles)
        median_ra = median(tile.ra_deg for tile in hidden_tiles)
        margin = 0.72 / math.cos(math.radians(median_dec))
        region = polygon(
            [
                (
                    min(tile.ra_deg for tile in hidden_tiles) - margin,
                    min(tile.dec_deg for tile in hidden_tiles) - 0.72,
                ),
                (
                    max(tile.ra_deg for tile in hidden_tiles) + margin,
                    min(tile.dec_deg for tile in hidden_tiles) - 0.72,
                ),
                (
                    max(tile.ra_deg for tile in hidden_tiles) + margin,
                    max(tile.dec_deg for tile in hidden_tiles) + 0.72,
                ),
                (
                    min(tile.ra_deg for tile in hidden_tiles) - margin,
                    max(tile.dec_deg for tile in hidden_tiles) + 0.72,
                ),
            ]
        )
        nearby = (
            [by_name[anchor_name]]
            if anchor_name
            else [
                tile
                for tile in reference["tiles"]
                if tile.metadata.get("PID") == "SPLUS"
                and abs(tile.dec_deg - median_dec) < 5
                and abs(tile.ra_deg - median_ra) * math.cos(math.radians(median_dec))
                < 8
                and tile.name not in names
            ]
        )
        historical_cases.append(
            {
                "id": case_id,
                "hidden_names": names,
                "existing_names": [tile.name for tile in nearby],
                "polygon": region.model_dump(mode="json"),
                **compact_plan(
                    plan_region(
                        RegionPlanRequest(polygon=region, existing_tiles=nearby)
                    )
                ),
            }
        )

    custom_profile = TilingProfile.model_validate(
        {
            **load_profile().model_dump(),
            "id": "custom",
            "display_name": "Custom",
            "algorithm": "RECT_GRID_V1",
            "tile_width_deg": 2.25,
            "tile_height_deg": 1.75,
            "effective_overlap_arcsec": 90,
        }
    )
    synthetic_regions = [
        (
            "empty_rectangle",
            polygon([(150, -31), (154, -31), (154, -27), (150, -27)]),
            [],
            None,
        ),
        ("wrapped_rectangle", wrap_polygon, [], None),
        ("triangle", polygon([(150, -31), (154, -31), (150, -27)]), [], None),
        (
            "concave",
            polygon(
                [(150, -31), (156, -31), (156, -29), (152, -29), (152, -25), (150, -25)]
            ),
            [],
            None,
        ),
        (
            "tiny_triangle",
            polygon([(150, -30), (150.03, -30), (150, -29.97)]),
            [],
            None,
        ),
        (
            "custom_rectangle",
            polygon([(10, -1), (16, -1), (16, 4), (10, 4)]),
            [],
            custom_profile,
        ),
    ]
    planner_cases = []
    for case_id, region, existing, active_profile in synthetic_regions:
        result = plan_region(
            RegionPlanRequest(polygon=region, existing_tiles=existing), active_profile
        )
        planner_cases.append(
            {
                "id": case_id,
                "polygon": region.model_dump(mode="json"),
                "existing_tiles": [tile.model_dump(mode="json") for tile in existing],
                "profile": active_profile.model_dump(mode="json")
                if active_profile
                else None,
                **compact_plan(result),
            }
        )

    coverage_polygon = polygon([(150, -31), (154, -31), (154, -27), (150, -27)])
    existing_tile = TileRecord(
        id="coverage-original",
        ra_deg=151,
        dec_deg=-30,
        source="original",
        original_values={"RA": "151", "DEC": "-30"},
    )
    proposed_tile = TileRecord(
        id="coverage-proposed",
        ra_deg=151.7,
        dec_deg=-30,
        source="proposed",
        generation_method="manual",
    )
    coverage_inputs = [
        ("zero", coverage_polygon, [], []),
        ("partial", coverage_polygon, [], [proposed_tile]),
        (
            "disabled",
            coverage_polygon,
            [],
            [proposed_tile.model_copy(update={"enabled": False})],
        ),
        ("overlap", coverage_polygon, [existing_tile], [proposed_tile]),
        (
            "full_existing",
            polygon([(150.8, -30.2), (151.2, -30.2), (151.2, -29.8), (150.8, -29.8)]),
            [existing_tile],
            [],
        ),
        (
            "wrapped_partial",
            wrap_polygon,
            [],
            [
                proposed_tile.model_copy(
                    update={
                        "ra_deg": 359.5,
                        "dec_deg": -29,
                    }
                )
            ],
        ),
    ]
    coverage_cases = []
    for case_id, region, existing, proposed in coverage_inputs:
        metrics = measure_active_coverage(
            CoverageRequest(
                polygon=region,
                existing_tiles=existing,
                proposed_tiles=proposed,
            )
        )
        coverage_cases.append(
            {
                "id": case_id,
                "polygon": region.model_dump(mode="json"),
                "existing_tiles": [tile.model_dump(mode="json") for tile in existing],
                "proposed_tiles": [tile.model_dump(mode="json") for tile in proposed],
                "metrics": metrics.model_dump(mode="json"),
            }
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
        "rounding": [
            {"value": value, "digits": digits, "result": round(value, digits)}
            for value, digits in (
                (2.675, 2),
                (1.005, 2),
                (0.000005, 5),
                (1.25, 1),
                (-1.25, 1),
                (-0.0, 5),
            )
        ],
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
        "historical_cases": historical_cases,
        "planner_cases": planner_cases,
        "coverage_cases": coverage_cases,
    }
    path = ROOT / "frontend" / "src" / "data" / "golden.json"
    path.write_text(
        json.dumps(fixture, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
