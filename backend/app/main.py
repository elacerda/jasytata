"""FastAPI application for Tile Planner."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from app.models import (
    CatalogueResponse,
    CenterParseRequest,
    CenterParseResponse,
    CenterProposalRequest,
    CenterProposalResponse,
    ExportRequest,
    RegionPlanRequest,
    RegionPlanResponse,
)
from app.profiles import DEFAULT_PROFILE_ID, list_profiles
from app.science.catalogue import make_center_proposals, parse_catalogue_csv, parse_center_text
from app.science.export import build_export_csv
from app.science.planner import plan_region

app = FastAPI(
    title="Tile Planner API",
    version="0.1.0",
    description="Catalogue parsing, configurable tile geometry, region planning, and CSV export.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/profiles")
async def profiles() -> dict:
    """Expose installed validated profiles and the active default.

    Returns
    -------
    dict
        Default profile identifier and installed profile records.
    """
    return {"default_profile_id": DEFAULT_PROFILE_ID, "profiles": [
        profile.model_dump() for profile in list_profiles()
    ]}


@app.get("/api/health")
async def health() -> dict[str, str]:
    """Return a lightweight process health response.

    Returns
    -------
    dict[str, str]
        Service status and application identifier.
    """
    return {"status": "ok", "service": "tile-planner"}


@app.post("/api/catalogue/parse", response_model=CatalogueResponse)
async def parse_catalogue(file: Annotated[UploadFile, File()]) -> CatalogueResponse:
    """Validate and parse a six-column T80/S-PLUS CSV upload.

    Parameters
    ----------
    file : UploadFile
        UTF-8 CSV upload whose fields use the original T80 column names.

    Returns
    -------
    CatalogueResponse
        Canonical decimal-degree coordinates plus the preserved source values.

    Raises
    ------
    HTTPException
        HTTP 422 for a non-CSV filename, incomplete schema, or invalid row.
    """
    if file.filename and not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=422, detail="Upload a CSV file")
    contents = await file.read()
    try:
        return CatalogueResponse(**parse_catalogue_csv(contents, file.filename or "catalogue.csv"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/catalogue/reference", response_model=CatalogueResponse)
async def load_reference_catalogue() -> CatalogueResponse:
    """Load the supplied representative catalogue for a quick first session.

    Returns
    -------
    CatalogueResponse
        Parsed rows from ``reference/tiles_nc.csv``.

    Raises
    ------
    HTTPException
        HTTP 404 if the supplied file is missing, or 500 if it is invalid.
    """
    path = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    if not path.is_file():
        raise HTTPException(
            status_code=404, detail="The supplied reference catalogue is not installed"
        )
    try:
        return CatalogueResponse(**parse_catalogue_csv(path.read_bytes(), path.name))
    except ValueError as exc:
        raise HTTPException(
            status_code=500, detail=f"Bundled reference catalogue is invalid: {exc}"
        ) from exc


@app.post("/api/centers/parse", response_model=CenterParseResponse)
async def parse_centers(request: CenterParseRequest) -> CenterParseResponse:
    """Parse pasted coordinate pairs for an import preview.

    Parameters
    ----------
    request : CenterParseRequest
        Text with one RA/DEC pair per line; sexagesimal RA uses hours and
        decimal RA uses degrees.

    Returns
    -------
    CenterParseResponse
        Parsed center coordinates in decimal degrees.

    Raises
    ------
    HTTPException
        HTTP 422 when any non-empty line is malformed.
    """
    try:
        centers = parse_center_text(request.text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return CenterParseResponse(centers=centers, line_count=len(centers))


@app.post("/api/proposals/centers", response_model=CenterProposalResponse)
async def propose_centers(request: CenterProposalRequest) -> CenterProposalResponse:
    """Create preview records for manual or imported coordinate centers.

    Parameters
    ----------
    request : CenterProposalRequest
        Up to 500 centers and their generation method.

    Returns
    -------
    CenterProposalResponse
        Provisional tile records, still separate from any original catalogue.
    """
    return CenterProposalResponse(
        tiles=make_center_proposals(request.centers, request.generation_method)
    )


@app.post("/api/plan/region", response_model=RegionPlanResponse)
async def plan_selected_region(request: RegionPlanRequest) -> RegionPlanResponse:
    """Generate an auditable, coverage-aware region proposal preview.

    Parameters
    ----------
    request : RegionPlanRequest
        Eastward RA/DEC bounds, all current tile centers, and planning mode.

    Returns
    -------
    RegionPlanResponse
        Ranked deterministic center choice, candidate centers, anchor IDs,
        diagnostics, and sampled coverage metrics.

    Raises
    ------
    HTTPException
        HTTP 422 for a region too large to plan or an unavailable fixed count.
    """
    try:
        return plan_region(request)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/export")
async def export_catalogue(request: ExportRequest) -> Response:
    """Return a new-only or complete updated six-column CSV download.

    Parameters
    ----------
    request : ExportRequest
        Original source values, accepted proposal records, and naming controls.

    Returns
    -------
    Response
        UTF-8 CSV response with a download filename and the exact six-column
        source schema.

    Raises
    ------
    HTTPException
        HTTP 422 for invalid rows or generated NAME collisions.
    """
    try:
        contents = build_export_csv(
            request.original_tiles,
            request.proposed_tiles,
            request.config,
            request.kind,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    filename = "new_tiles.csv" if request.kind == "new" else "tiles_nc_updated.csv"
    return Response(
        content=contents.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@app.get("/{frontend_path:path}", include_in_schema=False)
async def serve_frontend(frontend_path: str) -> Response:
    """Serve the production SPA bundle and resolve client-side routes.

    Parameters
    ----------
    frontend_path : str
        Requested path below ``frontend/dist``. Empty paths and missing files
        resolve to ``index.html`` for React Router-style client navigation.

    Returns
    -------
    Response
        Static asset bytes with a guessed media type.

    Raises
    ------
    HTTPException
        HTTP 404 if the build is unavailable or a path escapes the bundle.
    """
    root = frontend_dist.resolve()
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Production frontend is not built")

    requested = root / (frontend_path or "index.html")
    resolved = requested.resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=404, detail="Frontend asset not found")
    if resolved.is_dir():
        resolved = (resolved / "index.html").resolve()
    if not resolved.is_file():
        resolved = root / "index.html"
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Production frontend is not built")

    media_type, _ = mimetypes.guess_type(resolved.name)
    return Response(
        content=resolved.read_bytes(),
        media_type=media_type or "application/octet-stream",
    )
