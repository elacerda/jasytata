"""Generic axis-aligned rectangular tile center generation."""

from __future__ import annotations

import math

from app.models import RegionBounds
from app.profiles import TilingProfile


def rectangular_grid_centers(
    bounds: RegionBounds, profile: TilingProfile
) -> list[tuple[float, float]]:
    """Seed and step an ICRS rectangular grid using profile dimensions.

    Parameters
    ----------
    bounds : RegionBounds
        Eastward RA and northward DEC limits, in degrees.
    profile : TilingProfile
        Physical tile width, height, and effective overlap. RA steps are
        divided by cosine of each row's declination.

    Returns
    -------
    list[tuple[float, float]]
        Ordered ICRS ``(RA, DEC)`` centers in decimal degrees.
    """
    centers = []
    dec = bounds.dec_min_deg + profile.tile_height_deg / 2
    while dec <= bounds.dec_max_deg + 1e-12:
        cos_dec = math.cos(math.radians(dec))
        if cos_dec <= 1e-6:
            break
        ra_offset = profile.tile_width_deg / (2 * cos_dec)
        ra_step = profile.ra_spacing_deg / cos_dec
        while ra_offset <= bounds.ra_span_deg + 1e-12:
            centers.append(((bounds.ra_start_deg + ra_offset) % 360, dec))
            ra_offset += ra_step
        dec += profile.dec_spacing_deg
    return centers
