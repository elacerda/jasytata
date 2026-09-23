"""Coordinate parsing and serialization using Astropy's angle conventions."""

from __future__ import annotations

import math

from astropy import units as u
from astropy.coordinates import Angle, Longitude


def parse_ra_degrees(value: str) -> float:
    """Parse a sexagesimal hour or decimal-degree right ascension.

    Parameters
    ----------
    value : str
        Right ascension as ``HH:MM:SS`` or ``HH MM SS`` (hours), or decimal
        degrees.

    Returns
    -------
    float
        Right ascension in degrees, normalized to [0, 360).

    Raises
    ------
    ValueError
        If the value is malformed, non-finite, or outside its valid range.
    """
    text = value.strip()
    sexagesimal = ":" in text or len(text.split()) == 3
    try:
        angle = Angle(text, unit=u.hourangle if sexagesimal else u.deg)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid RA {value!r}; use sexagesimal hours or decimal degrees") from exc
    degrees = Longitude(angle).wrap_at(360 * u.deg).degree
    if not math.isfinite(degrees):
        raise ValueError(f"Invalid RA {value!r}; coordinate must be finite")
    if not sexagesimal and not 0 <= angle.degree <= 360:
        raise ValueError(f"Invalid RA {value!r}; decimal degrees must be between 0 and 360")
    return float(degrees % 360)


def parse_dec_degrees(value: str) -> float:
    """Parse sexagesimal or decimal declination in degrees.

    Parameters
    ----------
    value : str
        Declination as signed ``DD:MM:SS`` or decimal degrees.

    Returns
    -------
    float
        Declination in degrees in the ICRS equatorial coordinate frame.

    Raises
    ------
    ValueError
        If the value is malformed, non-finite, or outside [-90, 90].
    """
    text = value.strip()
    try:
        degrees = Angle(text, unit=u.deg).degree
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"Invalid DEC {value!r}; use sexagesimal degrees or decimal degrees"
        ) from exc
    if not math.isfinite(degrees) or not -90 <= degrees <= 90:
        raise ValueError(f"Invalid DEC {value!r}; degrees must be between -90 and 90")
    return float(degrees)


def format_ra_degrees(ra_deg: float) -> str:
    """Format RA as sexagesimal hours with integer-second precision.

    Parameters
    ----------
    ra_deg : float
        Right ascension in decimal degrees.

    Returns
    -------
    str
        ``HH:MM:SS`` formatted RA, rounded by Astropy to the nearest second.
    """
    return Longitude(ra_deg * u.deg).to_string(
        unit=u.hourangle,
        sep=":",
        fields=3,
        precision=0,
        pad=True,
    )


def format_dec_degrees(dec_deg: float) -> str:
    """Format DEC as sexagesimal degrees with integer-second precision.

    Parameters
    ----------
    dec_deg : float
        Declination in decimal degrees.

    Returns
    -------
    str
        ``[+|-]DD:MM:SS`` formatted DEC, rounded to the nearest second.
    """
    return Angle(dec_deg * u.deg).to_string(
        unit=u.deg,
        sep=":",
        fields=3,
        precision=0,
        pad=True,
    )
