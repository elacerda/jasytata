"""Typed API models for catalogue, proposal, planning, and export operations."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field, field_validator, model_validator

from app.profiles import DEFAULT_PROFILE_ID


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
    """A canonical ICRS pointing with optional legacy display and export fields.

    Coordinates are ICRS RA/DEC decimal degrees. ``metadata`` stores arbitrary
    non-coordinate CSV columns; ``original_values`` stores every source field
    verbatim for display or compatible export. Neither metadata nor legacy
    display fields participate in geometric calculations.
    """

    id: str
    pid: str = ""
    name: str = ""
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    epoch: str = ""
    status: str = ""
    source: TileSource
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


class PlanningMode(StrEnum):
    """Automatic coverage planning or exact-count planning."""

    AUTOMATIC = "automatic"
    FIXED = "fixed"


class RegionPlanRequest(BaseModel):
    """Input for planning additional tiles in a selected sky rectangle."""

    bounds: RegionBounds
    profile_id: str = DEFAULT_PROFILE_ID
    existing_tiles: list[TileRecord] = Field(max_length=20_000)
    mode: PlanningMode = PlanningMode.AUTOMATIC
    count: int | None = Field(default=None, ge=1, le=500)

    @model_validator(mode="after")
    def validate_mode_count(self) -> RegionPlanRequest:
        """Require a fixed count exactly when fixed planning is requested."""
        if self.mode == PlanningMode.FIXED and self.count is None:
            raise ValueError("A positive tile count is required in fixed mode")
        if self.mode == PlanningMode.AUTOMATIC and self.count is not None:
            raise ValueError("Do not provide a tile count in automatic mode")
        return self


class PlanMetrics(BaseModel):
    """Coverage and inference measurements for a region proposal."""

    existing_tiles_contributing: int
    anchor_tiles_used: int
    candidates_available: int
    new_tiles: int
    selected_region_area_deg2: float
    selected_region_coverage: float
    incremental_coverage: float
    redundant_coverage: float
    outside_region_coverage_deg2: float
    sample_step_deg: float


class RegionPlanResponse(BaseModel):
    """Preview solution from the deterministic region planner."""

    solution: str
    generation_method: GenerationMethod
    tiles: list[TileRecord]
    candidate_centers: list[CenterInput]
    anchor_tile_ids: list[str]
    diagnostics: list[str]
    metrics: PlanMetrics


class ExportConfig(BaseModel):
    """Metadata to assign to accepted proposal rows during CSV export."""

    pid: str = Field(min_length=1, max_length=64)
    name_prefix: str = Field(min_length=1, max_length=64)
    initial_sequence: int = Field(default=1, ge=0, le=99_999_999)
    epoch: str = Field(default="2000", min_length=1, max_length=32)
    status: str = Field(default="-5", min_length=1, max_length=32)

    @field_validator("pid", "name_prefix", "epoch", "status")
    @classmethod
    def require_nonblank_metadata(cls, value: str) -> str:
        """Trim export metadata and reject empty or newline-only values.

        Parameters
        ----------
        value : str
            New-row metadata supplied by the user.

        Returns
        -------
        str
            The trimmed field value.

        Raises
        ------
        ValueError
            If a required metadata value is blank or contains line breaks.
        """
        normalized = value.strip()
        if not normalized or "\n" in normalized or "\r" in normalized:
            raise ValueError("Export metadata must be non-empty and contain no line breaks")
        return normalized


class ExportRequest(BaseModel):
    """Rows and naming controls for one of the two CSV download variants."""

    original_tiles: list[TileRecord] = Field(max_length=20_000)
    proposed_tiles: list[TileRecord] = Field(max_length=500)
    config: ExportConfig
    kind: str = Field(pattern="^(new|updated)$")
