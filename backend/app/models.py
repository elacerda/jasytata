"""Typed API models for catalogue, proposal, planning, and export operations."""

from __future__ import annotations

import math
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.profiles import DEFAULT_PROFILE_ID, TilingProfile


class GenerationMethod(StrEnum):
    """Supported ways of creating proposed tile centers."""

    MANUAL = "manual"
    IMPORTED_CENTERS = "imported_centers"
    REGION_LEGACY = "region_legacy"
    REGION_EXTENDED = "region_extended"


class TileSource(StrEnum):
    """Whether a catalogue tile came from the uploaded source or a proposal."""

    ORIGINAL = "original"
    PROPOSED = "proposed"


class TileRecord(BaseModel):
    """A canonical ICRS pointing with source provenance and display fields.

    Coordinates are ICRS RA/DEC decimal degrees. ``metadata`` stores arbitrary
    non-coordinate CSV columns; ``original_values`` stores every source field
    verbatim for display. Neither metadata nor source
    display fields participate in geometric calculations.
    """

    id: str
    name: str = ""
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    source: TileSource
    enabled: bool = True
    dataset_id: str | None = None
    group_id: str | None = None
    ra_column: str | None = None
    dec_column: str | None = None
    generation_method: GenerationMethod | None = None
    original_values: dict[str, str] | None = None
    metadata: dict[str, str | float | int | bool] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_source_values(self) -> TileRecord:
        """Require retained CSV values for originals and a method for proposals.

        Returns
        -------
        TileRecord
            The validated record itself.

        Raises
        ------
        ValueError
            If source-specific required fields are missing.
        """
        if self.source == TileSource.ORIGINAL and self.original_values is None:
            raise ValueError("Original tiles must retain their original CSV values")
        if self.source == TileSource.ORIGINAL and not self.enabled:
            raise ValueError("Original catalogue tiles cannot be disabled")
        if self.source == TileSource.PROPOSED and self.generation_method is None:
            raise ValueError("Proposed tiles must specify a generation method")
        return self


class CatalogueResponse(BaseModel):
    """Parsed catalogue or a coordinate-column mapping request."""

    filename: str
    row_count: int
    tiles: list[TileRecord]
    warnings: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    ra_column: str | None = None
    dec_column: str | None = None
    needs_mapping: bool = False


class CenterInput(BaseModel):
    """A typed ICRS center, with RA and DEC represented in decimal degrees."""

    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    label: str | None = None


class CenterParseRequest(BaseModel):
    """Text block containing one RA/DEC pair on each non-empty line."""

    text: str = Field(min_length=1, max_length=500_000)


class CenterParseResponse(BaseModel):
    """Parsed center list returned as an import preview."""

    centers: list[CenterInput]
    line_count: int


class CenterProposalRequest(BaseModel):
    """Convert accepted coordinate centers into proposed tile records."""

    centers: list[CenterInput] = Field(min_length=1, max_length=500)
    generation_method: GenerationMethod = GenerationMethod.IMPORTED_CENTERS


class CenterProposalResponse(BaseModel):
    """Proposed tile records created from accepted center coordinates."""

    tiles: list[TileRecord]


class RegionBounds(BaseModel):
    """Small ICRS RA/DEC rectangle, traversing RA eastward across wrap.

    RA and DEC bounds are in degrees. RA start greater than RA end denotes an
    interval crossing zero; the positive eastward span may not exceed 180°.
    """

    ra_start_deg: float = Field(ge=0, lt=360)
    ra_end_deg: float = Field(ge=0, lt=360)
    dec_min_deg: float = Field(ge=-90, le=90)
    dec_max_deg: float = Field(ge=-90, le=90)

    @model_validator(mode="after")
    def validate_extent(self) -> RegionBounds:
        """Reject empty or implausibly large selections."""
        if self.dec_min_deg >= self.dec_max_deg:
            raise ValueError("DEC bounds must have positive height")
        if self.ra_start_deg == self.ra_end_deg:
            raise ValueError("RA bounds must have positive width")
        if self.ra_span_deg > 180:
            raise ValueError("Selected RA width must be 180 degrees or less")
        return self

    @property
    def ra_span_deg(self) -> float:
        """Return the eastward RA span, including wrap across zero."""
        return (self.ra_end_deg - self.ra_start_deg) % 360


class SkyPolygon(BaseModel):
    """Ordered ICRS RA/DEC vertices in degrees; closure is implicit.

    The polygon spans at most 180 degrees of RA and avoids the poles so a
    local declination-aware projection remains well defined.
    """

    vertices: list[CenterInput] = Field(min_length=3, max_length=200)

    @model_validator(mode="after")
    def validate_polygon(self) -> SkyPolygon:
        """Reject repeated vertices, crossing edges, and negligible area."""
        vertices = self.vertices
        if any(abs(vertex.dec_deg) >= 90 for vertex in vertices):
            raise ValueError("Polygon vertices must lie away from the poles")
        ra = [vertices[0].ra_deg]
        for previous, current in zip(vertices, vertices[1:], strict=False):
            ra.append(ra[-1] + (current.ra_deg - previous.ra_deg + 180) % 360 - 180)
        if max(ra) - min(ra) > 180:
            raise ValueError("Polygon RA span must be 180 degrees or less")
        dec = [vertex.dec_deg for vertex in vertices]
        for index, (x, y) in enumerate(zip(ra, dec, strict=True)):
            if any(math.hypot(x - ra[other], y - dec[other]) < 1e-6 for other in range(index)):
                raise ValueError("Polygon vertices must be distinct")
        cosine = math.cos(math.radians(sum(dec) / len(dec)))
        points = [(x * cosine, y) for x, y in zip(ra, dec, strict=True)]
        twice_area = sum(
            x * points[(index + 1) % len(points)][1]
            - points[(index + 1) % len(points)][0] * y
            for index, (x, y) in enumerate(points)
        )
        if abs(twice_area) / 2 < 1e-5:
            raise ValueError("Polygon has effectively zero area")

        def cross(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
            return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

        for first in range(len(points)):
            for second in range(first + 1, len(points)):
                if second == first + 1 or (first == 0 and second == len(points) - 1):
                    continue
                a, b = points[first], points[(first + 1) % len(points)]
                c, d = points[second], points[(second + 1) % len(points)]
                if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
                    raise ValueError("Polygon edges cross")
        return self

    @property
    def bounds(self) -> RegionBounds:
        """Return the minimal local RA/DEC bounds for candidate acceleration."""
        ra = [self.vertices[0].ra_deg]
        for previous, current in zip(self.vertices, self.vertices[1:], strict=False):
            ra.append(ra[-1] + (current.ra_deg - previous.ra_deg + 180) % 360 - 180)
        dec = [vertex.dec_deg for vertex in self.vertices]
        return RegionBounds(
            ra_start_deg=min(ra) % 360,
            ra_end_deg=max(ra) % 360,
            dec_min_deg=min(dec),
            dec_max_deg=max(dec),
        )


class RegionPlanRequest(BaseModel):
    """ICRS polygon and pointings with installed or inline tile geometry.

    ``profile`` is the canonical session-only custom profile when supplied;
    its width and height are degrees and edge overlap is arcseconds.
    """

    model_config = ConfigDict(extra="forbid")

    polygon: SkyPolygon
    profile_id: str = DEFAULT_PROFILE_ID
    profile: TilingProfile | None = None
    existing_tiles: list[TileRecord] = Field(max_length=20_000)


class PlanMetrics(BaseModel):
    """Sampled coverage measurements, independent of lattice inference."""

    existing_tiles_contributing: int
    new_tiles: int
    selected_region_area_deg2: float
    already_covered_fraction: float
    selected_region_coverage: float
    incremental_coverage: float
    remaining_uncovered_fraction: float
    remaining_uncovered_area_deg2: float
    redundant_coverage: float
    outside_region_coverage_deg2: float
    sample_step_deg: float


class InferenceDiagnostics(BaseModel):
    """Evidence for extending an ICRS lattice from nearby catalogue centers.

    ``nearby_tile_count`` counts centers within the search margin before
    pair matching. ``anchor_tile_ids`` identifies centers belonging to at
    least one compatible neighbor pair in the chosen fit. Spacings are in
    physical RA and declination degrees and are absent on fallback.
    """

    nearby_tile_count: int
    anchor_tile_ids: list[str]
    compatible_neighbor_pairs: int
    dec_spacing_deg: float | None
    ra_spacing_deg: float | None


class RegionPlanResponse(BaseModel):
    """Preview solution with separate inference evidence and coverage metrics."""

    solution: str
    generation_method: GenerationMethod
    tiles: list[TileRecord]
    candidate_centers: list[CenterInput]
    inference: InferenceDiagnostics
    diagnostics: list[str]
    metrics: PlanMetrics


class CoverageRequest(BaseModel):
    """Recompute sampled ICRS polygon coverage using active profile geometry."""

    polygon: SkyPolygon
    profile_id: str = DEFAULT_PROFILE_ID
    profile: TilingProfile | None = None
    existing_tiles: list[TileRecord] = Field(max_length=20_000)
    proposed_tiles: list[TileRecord] = Field(max_length=500)


class ExportRequest(BaseModel):
    """Active ICRS proposal positions and profile-driven generic CSV settings."""

    model_config = ConfigDict(extra="forbid")

    proposed_tiles: list[TileRecord] = Field(max_length=500)
    profile_id: str = DEFAULT_PROFILE_ID
    profile: TilingProfile | None = None
    epoch: str | None = None
    coordinate_format: str = Field(default="decimal", pattern="^(decimal|sexagesimal)$")
