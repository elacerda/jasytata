"""Legacy-compatible S-PLUS tile-center geometry.

This module intentionally contains no HTTP, CSV, or frontend dependencies.
"""

from __future__ import annotations

import math

import numpy as np
from astropy import units as u
from astropy.coordinates import Latitude, Longitude

TILE_SIZE_DEG = 1.4
BASE_OVERLAP_ARCSEC = 30.0
EFFECTIVE_OVERLAP_ARCSEC = 4 * BASE_OVERLAP_ARCSEC
CENTER_SPACING_DEG = TILE_SIZE_DEG - EFFECTIVE_OVERLAP_ARCSEC / 3600
LEGACY_ALGORITHM = "SPLUS_LEGACY_GRID_V1"


def legacy_grid_centers(
    ra_bounds_deg: tuple[float, float],
    dec_bounds_deg: tuple[float, float],
    *,
    wraps_ra: bool = False,
) -> list[tuple[float, float]]:
    """Generate centers using the half-tile seeding rule from the legacy code.

    Parameters
    ----------
    ra_bounds_deg : tuple[float, float]
        RA endpoints in degrees. Bounds are sorted ascending unless
        ``wraps_ra`` is true, in which case the interval progresses eastward
        across 0 degrees.
    dec_bounds_deg : tuple[float, float]
        Declination bounds in degrees. Reversed endpoints are normalized.
    wraps_ra : bool, default=False
        Interpret ``(ra_start, ra_end)`` as an eastward wrap interval.

    Returns
    -------
    list[tuple[float, float]]
        Ordered ``(ra_deg, dec_deg)`` centers by ascending declination, then RA.

    Notes
    -----
    The first non-degenerate center is offset half a tile from the lower RA
    and DEC bounds. Subsequent rows and columns advance by 1.366666... degrees;
    each row's RA increment is divided by ``cos(dec)`` as in the source helper.
    Astropy ``Longitude`` and ``Latitude`` preserve the source angular units.

    Raises
    ------
    ValueError
        If bounds are not finite or declination bounds exceed the sphere.
    """
    ra_a, ra_b = map(float, ra_bounds_deg)
    dec_a, dec_b = map(float, dec_bounds_deg)
    if not all(map(math.isfinite, (ra_a, ra_b, dec_a, dec_b))):
        raise ValueError("Bounds must be finite")
    if not -90 <= dec_a <= 90 or not -90 <= dec_b <= 90:
        raise ValueError("Declination bounds must be between -90 and 90 degrees")

    if wraps_ra:
        ra_start = ra_a % 360
        ra_span = (ra_b - ra_a) % 360
    else:
        ra_start, ra_end = sorted((ra_a % 360, ra_b % 360))
        ra_span = ra_end - ra_start
    dec_low, dec_high = sorted((dec_a, dec_b))
    ra_is_fixed = not wraps_ra and ra_span == 0
    dec_is_fixed = dec_low == dec_high

    ra_start_angle = Longitude(ra_start * u.deg)
    dec_start_angle = Latitude(dec_low * u.deg)
    if ra_is_fixed:
        first_ra_offset = 0.0
    else:
        ra_offset = Longitude(0.5 * TILE_SIZE_DEG * u.deg) / np.cos(dec_start_angle)
        first_ra_offset = float(ra_offset.to_value(u.deg))
    first_dec = (
        dec_low
        if dec_is_fixed
        else float((dec_start_angle + Latitude(0.5 * TILE_SIZE_DEG * u.deg)).to_value(u.deg))
    )
    last_ra_offset = ra_span

    centers: list[tuple[float, float]] = []
    dec_value = first_dec
    row_limit = max(1, int(math.ceil((dec_high - dec_low) / CENTER_SPACING_DEG)) + 2)
    col_limit = max(1, int(math.ceil(max(ra_span, 0.01) / CENTER_SPACING_DEG * 2)) + 4)
    for _row in range(row_limit):
        if dec_value > dec_high + 1e-12:
            break
        step_angle = Longitude(CENTER_SPACING_DEG * u.deg) / np.cos(dec_value * u.deg)
        row_step = float(step_angle.to_value(u.deg))
        offset = first_ra_offset
        if ra_is_fixed:
            centers.append((float(ra_start_angle.to_value(u.deg)), float(dec_value)))
        else:
            for _col in range(col_limit):
                if offset > last_ra_offset + 1e-12:
                    break
                centers.append((float((ra_start + offset) % 360), float(dec_value)))
                offset += row_step
        if dec_is_fixed:
            break
        dec_value = float(
            (Latitude(dec_value * u.deg) + Latitude(CENTER_SPACING_DEG * u.deg)).to_value(u.deg)
        )
    return centers
