"""ASGI integration checks for catalogue loading, parsing, and export reload."""

from __future__ import annotations

import asyncio
import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from app.main import app


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


def test_health_reference_upload_and_updated_export_reload() -> None:
    """The real reference catalogue can be exported and parsed over the API."""
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
        "pid": "PROPOSED",
        "name": "PROPOSED_0001",
        "ra_deg": center["ra_deg"],
        "dec_deg": center["dec_deg"],
        "epoch": "2000",
        "status": "-5",
        "source": "proposed",
        "generation_method": "imported_centers",
        "original_values": None,
        "metadata": {},
    }
    export_config = {
        "pid": "SPLUS",
        "name_prefix": "SPLUS_NEW",
        "initial_sequence": 8,
        "epoch": "2000",
        "status": "-5",
    }
    new_only = client.post(
        "/api/export",
        json_body={
            "kind": "new",
            "original_tiles": source_tiles,
            "proposed_tiles": [proposal],
            "config": export_config,
        },
    )
    assert new_only.status_code == 200
    assert "new_tiles.csv" in new_only.headers["content-disposition"]
    new_rows = list(csv.DictReader(new_only.text.splitlines()))
    assert len(new_rows) == 1
    assert list(new_rows[0]) == ["PID", "NAME", "RA", "DEC", "EPOC", "STATUS"]

    exported = client.post(
        "/api/export",
        json_body={
            "kind": "updated",
            "original_tiles": source_tiles,
            "proposed_tiles": [proposal],
            "config": export_config,
        },
    )
    assert exported.status_code == 200
    assert "tiles_nc_updated.csv" in exported.headers["content-disposition"]
    rows = list(csv.DictReader(exported.text.splitlines()))
    assert list(rows[0]) == ["PID", "NAME", "RA", "DEC", "EPOC", "STATUS"]
    assert rows[-1]["NAME"] == "SPLUS_NEW_0008"
    reloaded = client.post(
        "/api/catalogue/parse",
        files={"file": ("tiles_nc_updated.csv", exported.content, "text/csv")},
    )
    assert reloaded.status_code == 200
    reloaded_catalogue = reloaded.json()
    assert reloaded_catalogue["row_count"] == 4775
    assert (
        reloaded_catalogue["tiles"][0]["original_values"]
        == parsed_catalogue["tiles"][0]["original_values"]
    )


def test_real_catalogue_region_automatic_and_exact_fixed_n_api_workflow() -> None:
    """A real overlap-region request infers anchors and honors changing fixed N."""
    catalogue = client.get("/api/catalogue/reference").json()
    payload = {
        "bounds": {
            "ra_start_deg": 120,
            "ra_end_deg": 135,
            "dec_min_deg": -61,
            "dec_max_deg": -57,
        },
        "existing_tiles": catalogue["tiles"],
    }
    automatic = client.post("/api/plan/region", json_body={**payload, "mode": "automatic"})
    assert automatic.status_code == 200, automatic.text[:500]
    automatic_body = automatic.json()
    assert automatic_body["solution"] == "extended_existing_grid"
    assert automatic_body["anchor_tile_ids"]
    assert automatic_body["tiles"]
    assert automatic_body["metrics"]["existing_tiles_contributing"] > 0

    fixed_four = client.post(
        "/api/plan/region",
        json_body={**payload, "mode": "fixed", "count": 4},
    )
    fixed_five = client.post(
        "/api/plan/region",
        json_body={**payload, "mode": "fixed", "count": 5},
    )
    assert fixed_four.status_code == fixed_five.status_code == 200
    assert fixed_four.json()["metrics"]["new_tiles"] == 4
    assert fixed_five.json()["metrics"]["new_tiles"] == 5
    over_limit = client.post(
        "/api/plan/region",
        json_body={**payload, "mode": "fixed", "count": 100},
    )
    assert over_limit.status_code == 422
    assert "only" in over_limit.json()["detail"]


def test_built_frontend_and_client_route_are_served_when_available() -> None:
    """The production ASGI app serves Vite assets and SPA fallback directly."""
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if not dist.is_dir():
        pytest.skip("Run the frontend production build to exercise static serving")

    home = client.get("/")
    assert home.status_code == 200
    assert "T80 Tile Planner" in home.text
    match = re.search(r'(?:src|href)="([^"]+\.(?:js|css))"', home.text)
    assert match, "Built HTML should reference a JS or CSS asset"
    asset = client.get(match.group(1))
    assert asset.status_code == 200
    assert asset.content

    deep_link = client.get("/planner/session")
    assert deep_link.status_code == 200
    assert "T80 Tile Planner" in deep_link.text
