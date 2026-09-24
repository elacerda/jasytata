"""ASGI integration checks for catalogue loading, parsing, and export reload."""

from __future__ import annotations

import asyncio
import csv
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from app.main import app
from app.profiles import load_profile


@dataclass(frozen=True)
class _Response:
    """Small response surface used by the direct in-process ASGI test client."""

    status_code: int
    headers: dict[str, str]
    content: bytes

    @property
    def text(self) -> str:
        """Decode the response body as UTF-8 text."""
        return self.content.decode("utf-8")

    def json(self) -> Any:
        """Decode a JSON response body."""
        return json.loads(self.content)


class _ASGIClient:
    """Send small HTTP requests through an ASGI app without opening sockets."""

    def get(self, path: str) -> _Response:
        """Request an application route using GET."""
        return self.request("GET", path)

    def post(
        self,
        path: str,
        *,
        json_body: Any = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> _Response:
        """Request an application route using JSON or one multipart file."""
        body = b""
        headers: list[tuple[bytes, bytes]] = []
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            headers.append((b"content-type", b"application/json"))
        if files:
            if len(files) != 1:
                raise ValueError("The test helper supports one uploaded file per request")
            field, (filename, contents, media_type) = next(iter(files.items()))
            boundary = "t80-test-boundary"
            body = (
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
                    f"Content-Type: {media_type}\r\n\r\n"
                ).encode()
                + contents
                + f"\r\n--{boundary}--\r\n".encode()
            )
            headers.append(
                (b"content-type", f"multipart/form-data; boundary={boundary}".encode("ascii"))
            )
        return self.request("POST", path, body=body, headers=headers)

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes = b"",
        headers: list[tuple[bytes, bytes]] | None = None,
    ) -> _Response:
        """Execute one ASGI request and collect the response messages."""
        messages: list[dict[str, Any]] = []
        sent_body = False
        raw_path = path.encode("ascii")
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": raw_path,
            "query_string": b"",
            "root_path": "",
            "headers": headers or [],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }

        async def receive() -> dict[str, Any]:
            nonlocal sent_body
            if sent_body:
                return {"type": "http.disconnect"}
            sent_body = True
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message: dict[str, Any]) -> None:
            messages.append(message)

        asyncio.run(asyncio.wait_for(app(scope, receive, send), timeout=10))
        start = next(message for message in messages if message["type"] == "http.response.start")
        response_body = b"".join(
            message.get("body", b"")
            for message in messages
            if message["type"] == "http.response.body"
        )
        response_headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in start.get("headers", [])
        }
        return _Response(start["status"], response_headers, response_body)


client = _ASGIClient()


def test_custom_profile_geometry_reaches_region_planner() -> None:
    """A session-only canonical profile controls the actual HTTP planning path."""
    profile = load_profile().model_dump()
    profile.update(
        id="custom", display_name="Custom", algorithm="RECT_GRID_V1",
        tile_width_deg=2.25, tile_height_deg=1.75, effective_overlap_arcsec=90,
    )
    validated = client.post("/api/profiles/validate", json_body=profile)
    assert validated.status_code == 200, validated.text
    assert validated.json()["tile_width_deg"] == 2.25
    payload = {
        "polygon": {"vertices": [
            {"ra_deg": 10, "dec_deg": -1}, {"ra_deg": 16, "dec_deg": -1},
            {"ra_deg": 16, "dec_deg": 4}, {"ra_deg": 10, "dec_deg": 4},
        ]},
        "existing_tiles": [],
        "profile_id": "custom",
        "profile": profile,
    }
    response = client.post("/api/plan/region", json_body=payload)
    assert response.status_code == 200, response.text[:500]
    assert response.json()["solution"] == "profile_fallback"
    assert "RECT_GRID_V1" in response.json()["diagnostics"][0]
    centers = response.json()["candidate_centers"]
    assert len(centers) > 1
    first_row = [center for center in centers if center["dec_deg"] == centers[0]["dec_deg"]]
    assert first_row[1]["ra_deg"] - first_row[0]["ra_deg"] == pytest.approx(
        (2.25 - 90 / 3600) / math.cos(math.radians(first_row[0]["dec_deg"]))
    )
    rows = sorted({center["dec_deg"] for center in centers})
    assert rows[1] - rows[0] == pytest.approx(1.75 - 90 / 3600)
    coverage = client.post("/api/coverage/region", json_body={
        **payload, "proposed_tiles": response.json()["tiles"],
    })
    assert coverage.status_code == 200, coverage.text[:500]
    assert coverage.json()["new_tiles"] == len(response.json()["tiles"])
    export = client.post("/api/export", json_body={
        "profile_id": "custom", "profile": profile,
        "proposed_tiles": response.json()["tiles"],
    })
    assert export.status_code == 200, export.text[:500]
    assert "RA,DEC,EPOCH" in export.text


def test_inline_profile_cannot_mutate_installed_splus_preset() -> None:
    """Inline geometry cannot replace the validated S-PLUS algorithm or ID."""
    preset = load_profile().model_dump()
    preset["tile_width_deg"] = 2
    assert client.post("/api/profiles/validate", json_body=preset).status_code == 422
    preset["algorithm"] = "RECT_GRID_V1"
    assert client.post("/api/profiles/validate", json_body=preset).status_code == 422


@pytest.mark.parametrize("field,value", [
    ("tile_width_deg", 0), ("tile_height_deg", -1),
    ("effective_overlap_arcsec", 6000),
])
def test_custom_profile_validation_rejects_nonphysical_geometry(field: str, value: float) -> None:
    """The profile endpoint rejects invalid geometry before it can become active."""
    profile = load_profile().model_dump()
    profile.update(id="custom", display_name="Custom", algorithm="RECT_GRID_V1")
    profile[field] = value
    assert client.post("/api/profiles/validate", json_body=profile).status_code == 422


def test_health_reference_upload_and_generic_export_reload() -> None:
    """Reference and generic CSVs load; enabled new tile export reloads."""
    assert client.get("/api/health").json()["status"] == "ok"
    reference = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    bundled = client.get("/api/catalogue/reference")
    assert bundled.status_code == 200
    assert bundled.json()["row_count"] == 4774

    parsed = client.post(
        "/api/catalogue/parse",
        files={"file": ("tiles_nc.csv", reference.read_bytes(), "text/csv")},
    )
    assert parsed.status_code == 200
    parsed_catalogue = parsed.json()
    source_tiles = parsed_catalogue["tiles"]
    assert len(source_tiles) == 4774
    centers = client.post(
        "/api/centers/parse",
        json_body={"text": "10:03:05, -23:54:31\n150.5 -24.25"},
    )
    assert centers.status_code == 200
    center = centers.json()["centers"][1]
    proposal = {
        "id": "proposal-api-1",
        "ra_deg": center["ra_deg"],
        "dec_deg": center["dec_deg"],
        "source": "proposed",
        "generation_method": "imported_centers",
        "original_values": None,
        "metadata": {},
    }
    new_only = client.post(
        "/api/export",
        json_body={
            "proposed_tiles": [proposal],
            "profile_id": "splus-t80-south",
            "coordinate_format": "decimal",
        },
    )
    assert new_only.status_code == 200
    assert "new_tiles.csv" in new_only.headers["content-disposition"]
    new_rows = list(csv.DictReader(new_only.text.splitlines()))
    assert len(new_rows) == 1
    assert list(new_rows[0]) == ["RA", "DEC", "EPOCH"]
    assert new_rows[0]["EPOCH"] == "2000"
    reloaded = client.post(
        "/api/catalogue/parse",
        files={"file": ("new_tiles.csv", new_only.content, "text/csv")},
    )
    assert reloaded.status_code == 200
    reloaded_catalogue = reloaded.json()
    assert reloaded_catalogue["row_count"] == 1
    assert reloaded_catalogue["tiles"][0]["ra_deg"] == pytest.approx(center["ra_deg"])
    assert parsed_catalogue["tiles"][0]["original_values"] == source_tiles[0]["original_values"]


def test_real_catalogue_polygon_planning_api_workflow() -> None:
    """A real overlap polygon infers anchors and returns sampled area metrics."""
    catalogue = client.get("/api/catalogue/reference").json()
    payload = {
        "polygon": {"vertices": [
            {"ra_deg": 120, "dec_deg": -61},
            {"ra_deg": 135, "dec_deg": -61},
            {"ra_deg": 135, "dec_deg": -57},
            {"ra_deg": 120, "dec_deg": -57},
        ]},
        "existing_tiles": catalogue["tiles"],
    }
    automatic = client.post("/api/plan/region", json_body=payload)
    assert automatic.status_code == 200, automatic.text[:500]
    automatic_body = automatic.json()
    assert automatic_body["solution"] == "extended_existing_grid"
    assert automatic_body["inference"]["anchor_tile_ids"]
    assert automatic_body["tiles"]
    assert automatic_body["metrics"]["existing_tiles_contributing"] > 0
    assert automatic_body["metrics"]["selected_region_coverage"] > 0.9
    assert automatic_body["metrics"]["remaining_uncovered_area_deg2"] >= 0


def test_two_catalogues_polygon_edit_and_export_http_round_trip() -> None:
    """Reference and generic pointings jointly cover a polygon through HTTP."""
    reference = client.get("/api/catalogue/reference").json()["tiles"]
    generic_csv = b"RA,DEC,quality\n125,-59,good\n126.4,-59,good\n125,-57.6,good\n"
    generic_response = client.post(
        "/api/catalogue/parse",
        files={"file": ("second.csv", generic_csv, "text/csv")},
    )
    assert generic_response.status_code == 200
    generic = generic_response.json()["tiles"]
    assert all(tile["metadata"]["quality"] == "good" for tile in generic)
    for tile in generic:
        tile["id"] = f"second:{tile['id']}"
    polygon = {"vertices": [
        {"ra_deg": 120, "dec_deg": -61}, {"ra_deg": 135, "dec_deg": -61},
        {"ra_deg": 135, "dec_deg": -57}, {"ra_deg": 120, "dec_deg": -57},
    ]}
    existing_tiles = reference + generic
    plan = client.post("/api/plan/region", json_body={
        "polygon": polygon, "existing_tiles": existing_tiles,
    })
    assert plan.status_code == 200, plan.text[:500]
    solution = plan.json()
    assert solution["solution"] in {"extended_existing_grid", "profile_fallback"}
    assert solution["metrics"]["existing_tiles_contributing"] > 0
    assert solution["tiles"]
    coverage_payload = {
        "polygon": polygon,
        "existing_tiles": existing_tiles,
        "proposed_tiles": solution["tiles"],
    }
    baseline = client.post("/api/coverage/region", json_body=coverage_payload)
    assert baseline.status_code == 200
    disabled = [dict(tile) for tile in solution["tiles"]]
    disabled[0]["enabled"] = False
    edited = client.post("/api/coverage/region", json_body={
        **coverage_payload, "proposed_tiles": disabled,
    })
    assert edited.status_code == 200
    assert edited.json()["new_tiles"] == len(disabled) - 1
    assert edited.json()["selected_region_coverage"] < baseline.json()["selected_region_coverage"]
    restored = client.post("/api/coverage/region", json_body=coverage_payload)
    assert restored.json()["selected_region_coverage"] == baseline.json()[
        "selected_region_coverage"
    ]
    removed_all = client.post("/api/coverage/region", json_body={
        **coverage_payload,
        "proposed_tiles": [{**tile, "enabled": False} for tile in solution["tiles"]],
    })
    assert removed_all.json()["new_tiles"] == 0
    assert removed_all.json()["selected_region_coverage"] == pytest.approx(
        removed_all.json()["already_covered_fraction"]
    )
    exported = client.post("/api/export", json_body={
        "proposed_tiles": disabled, "coordinate_format": "decimal",
    })
    assert exported.status_code == 200
    rows = list(csv.DictReader(exported.text.splitlines()))
    assert len(rows) == len(disabled) - 1
    assert list(rows[0]) == ["RA", "DEC", "EPOCH"]
    reloaded = client.post("/api/catalogue/parse", files={
        "file": ("new_tiles.csv", exported.content, "text/csv"),
    })
    assert reloaded.status_code == 200
    assert reloaded.json()["row_count"] == len(rows)
    assert "quality" not in rows[0]


def test_built_frontend_and_client_route_are_served_when_available() -> None:
    """The production ASGI app serves Vite assets and SPA fallback directly."""
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if not dist.is_dir():
        pytest.skip("Run the frontend production build to exercise static serving")

    home = client.get("/")
    assert home.status_code == 200
    assert "Jasytata" in home.text
    match = re.search(r'(?:src|href)="([^"]+\.(?:js|css))"', home.text)
    assert match, "Built HTML should reference a JS or CSS asset"
    asset = client.get(match.group(1))
    assert asset.status_code == 200
    assert asset.content

    deep_link = client.get("/planner/session")
    assert deep_link.status_code == 200
    assert "Jasytata" in deep_link.text
