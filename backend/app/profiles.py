"""Validated, file-backed observing and tile geometry profiles."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field, model_validator

PROFILE_DIR = Path(__file__).resolve().parents[1] / "profiles"
DEFAULT_PROFILE_ID = "splus-t80-south"
SUPPORTED_ALGORITHMS = {"SPLUS_LEGACY_GRID_V1", "RECT_GRID_V1"}


class TilingProfile(BaseModel):
    """Physical tile footprint and grid generation convention.

    All widths and heights are on-sky degrees. ``effective_overlap_arcsec``
    is the actual edge overlap in arcseconds on each grid axis; it does not
    expose the legacy source helper's fourfold base-overlap convention.
    Positions are ICRS equatorial RA/DEC decimal degrees at J2000.
    """

    id: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    display_name: str = Field(min_length=1)
    description: str | None = None
    tile_width_deg: float = Field(gt=0, le=180)
    tile_height_deg: float = Field(gt=0, le=180)
    effective_overlap_arcsec: float = Field(ge=0)
    coordinate_frame: str = "icrs"
    epoch: str = "J2000"
    algorithm: str

    @model_validator(mode="after")
    def validate_geometry(self) -> TilingProfile:
        """Reject unsupported frames and overlaps that prevent positive steps.

        Returns
        -------
        TilingProfile
            The validated profile.

        Raises
        ------
        ValueError
            If the algorithm, frame, epoch, or physical spacing is unsupported.
        """
        if self.algorithm not in SUPPORTED_ALGORITHMS:
            raise ValueError(f"Unsupported tiling algorithm: {self.algorithm}")
        if self.coordinate_frame.lower() != "icrs" or self.epoch.upper() != "J2000":
            raise ValueError("Only ICRS/J2000 profiles are currently supported")
        overlap_deg = self.effective_overlap_arcsec / 3600
        if overlap_deg >= min(self.tile_width_deg, self.tile_height_deg):
            raise ValueError("Effective overlap must be smaller than both tile dimensions")
        if self.algorithm == "SPLUS_LEGACY_GRID_V1" and (
            self.tile_width_deg != 1.4
            or self.tile_height_deg != 1.4
            or self.effective_overlap_arcsec != 120
        ):
            raise ValueError("SPLUS_LEGACY_GRID_V1 requires its exact reference geometry")
        return self

    @property
    def ra_spacing_deg(self) -> float:
        """Return east-west physical center spacing in degrees."""
        return self.tile_width_deg - self.effective_overlap_arcsec / 3600

    @property
    def dec_spacing_deg(self) -> float:
        """Return north-south center spacing in degrees."""
        return self.tile_height_deg - self.effective_overlap_arcsec / 3600


def load_profile(
    profile_id: str = DEFAULT_PROFILE_ID, directory: Path = PROFILE_DIR
) -> TilingProfile:
    """Load one YAML profile from an installed directory.

    Parameters
    ----------
    profile_id : str
        Safe profile basename without extension.
    directory : Path
        Directory containing human-readable YAML profile files.

    Returns
    -------
    TilingProfile
        Validated profile with tile dimensions in degrees.

    Raises
    ------
    ValueError
        If the ID or YAML document is invalid or mismatched.
    FileNotFoundError
        If the profile file does not exist.
    """
    if not profile_id or not all(
        char.islower() or char.isdigit() or char == "-" for char in profile_id
    ):
        raise ValueError("Invalid profile identifier")
    path = directory / f"{profile_id}.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Profile {profile_id} must be a YAML mapping")
    profile = TilingProfile.model_validate(data)
    if profile.id != profile_id:
        raise ValueError(f"Profile ID {profile.id!r} does not match filename {profile_id!r}")
    return profile


def list_profiles(directory: Path = PROFILE_DIR) -> list[TilingProfile]:
    """Return installed profiles sorted by identifier.

    Parameters
    ----------
    directory : Path
        Directory containing ``*.yaml`` profile files.

    Returns
    -------
    list[TilingProfile]
        Every installed and validated profile.
    """
    return [load_profile(path.stem, directory) for path in sorted(directory.glob("*.yaml"))]
