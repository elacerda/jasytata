"""Generic ICRS RA/DEC CSV export for enabled proposed tile centers."""

from __future__ import annotations

import csv
import io

from app.models import ExportRequest, TileSource
from app.profiles import load_profile
from app.science.coordinates import format_dec_degrees, format_ra_degrees


def build_export_csv(request: ExportRequest) -> str:
    """Serialize active proposed ICRS centers to interoperable CSV.

    Parameters
    ----------
    request : ExportRequest
        Proposed RA/DEC centers in degrees, a profile-approved descriptive
        epoch label, and decimal-degree or sexagesimal representation.

    Returns
    -------
    str
        UTF-8-ready CSV with ``RA,DEC,EPOCH``. Decimal coordinates use eight
        fractional degree digits; sexagesimal RA uses hours and DEC degrees.

    Raises
    ------
    ValueError
        If there is no active proposed tile, a non-proposal is supplied, or
        the epoch is not permitted by the active profile.

    Notes
    -----
    The EPOCH value is catalogue metadata. This function does not precess
    coordinates, change frame/equinox, or apply proper motion.
    """
    profile = load_profile(request.profile_id)
    epoch = request.epoch if request.epoch is not None else profile.export_epoch_default
    if epoch not in profile.export_epoch_options:
        raise ValueError(f"Epoch {epoch!r} is not allowed by profile {profile.id}")
    if any(tile.source != TileSource.PROPOSED for tile in request.proposed_tiles):
        raise ValueError("Generic export accepts only proposed tile centers")
    active = [tile for tile in request.proposed_tiles if tile.enabled]
    if not active:
        raise ValueError("Enable at least one proposed tile before downloading")

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=("RA", "DEC", "EPOCH"), lineterminator="\r\n")
    writer.writeheader()
    for tile in active:
        if request.coordinate_format == "decimal":
            ra, dec = f"{tile.ra_deg:.8f}", f"{tile.dec_deg:.8f}"
        else:
            ra = format_ra_degrees(tile.ra_deg, precision=3)
            dec = format_dec_degrees(tile.dec_deg, precision=3)
        writer.writerow({"RA": ra, "DEC": dec, "EPOCH": epoch})
    return output.getvalue()
