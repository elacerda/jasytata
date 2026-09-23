"""Six-column CSV export preserving source rows and assigning proposal names."""

from __future__ import annotations

import csv
import io

from app.models import ExportConfig, TileRecord, TileSource
from app.science.catalogue import REQUIRED_COLUMNS
from app.science.coordinates import format_dec_degrees, format_ra_degrees


def build_export_csv(
    original_tiles: list[TileRecord],
    proposed_tiles: list[TileRecord],
    config: ExportConfig,
    kind: str,
) -> str:
    """Serialize new-only or complete catalogue CSV.

    Parameters
    ----------
    original_tiles : list[TileRecord]
        Immutable original rows returned by catalogue parsing.
    proposed_tiles : list[TileRecord]
        Accepted proposed rows in their visible application order.
    config : ExportConfig
        New-row PID, name sequence, epoch, and status controls.
    kind : str
        Either ``"new"`` for only proposals or ``"updated"`` for originals
        followed by proposals.

    Returns
    -------
    str
        CSV with exactly ``PID,NAME,RA,DEC,EPOC,STATUS`` as its header.

    Raises
    ------
    ValueError
        If a generated proposal name collides with an original or another new
        row, or if a source tile cannot be preserved.
    """
    if kind not in {"new", "updated"}:
        raise ValueError("Export kind must be 'new' or 'updated'")
    for tile in original_tiles:
        values = tile.original_values
        if tile.source != TileSource.ORIGINAL or values is None:
            raise ValueError(
                "Updated export requires original catalogue rows with preserved source values"
            )
        missing = [key for key in REQUIRED_COLUMNS if key not in values or not values[key].strip()]
        if missing:
            raise ValueError(
                f"Original tile {tile.id!r} is missing required source values: {', '.join(missing)}"
            )
    if any(tile.source != TileSource.PROPOSED for tile in proposed_tiles):
        raise ValueError("Only proposed tiles can be included in the new catalogue rows")

    occupied_names = {tile.original_values["NAME"] for tile in original_tiles}
    proposed_rows: list[dict[str, str]] = []
    for offset, tile in enumerate(proposed_tiles):
        sequence = config.initial_sequence + offset
        name = f"{config.name_prefix}_{sequence:04d}"
        if name in occupied_names:
            raise ValueError(f"NAME collision: {name!r} already exists in the catalogue")
        occupied_names.add(name)
        proposed_rows.append(
            {
                "PID": config.pid,
                "NAME": name,
                "RA": format_ra_degrees(tile.ra_deg),
                "DEC": format_dec_degrees(tile.dec_deg),
                "EPOC": config.epoch,
                "STATUS": config.status,
            }
        )

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=REQUIRED_COLUMNS, lineterminator="\r\n")
    writer.writeheader()
    if kind == "updated":
        for tile in original_tiles:
            writer.writerow({key: tile.original_values[key] for key in REQUIRED_COLUMNS})
    for row in proposed_rows:
        writer.writerow(row)
    return output.getvalue()
