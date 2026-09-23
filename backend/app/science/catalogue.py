"""Catalogue and pasted-center parsing with source-value preservation."""

from __future__ import annotations

import csv
import io
import re

from app.models import CenterInput, GenerationMethod, TileRecord, TileSource
from app.science.coordinates import parse_dec_degrees, parse_ra_degrees

RA_ALIASES = {
    "ra", "ra_deg", "radeg", "ra_hours", "ra_icrs", "raj2000",
    "right_ascension", "rightascension",
}
DEC_ALIASES = {"dec", "dec_deg", "decdeg", "dec_icrs", "dej2000", "declination"}


def parse_catalogue_csv(
    contents: bytes,
    filename: str = "catalogue.csv",
    ra_column: str | None = None,
    dec_column: str | None = None,
    ra_unit: str = "auto",
) -> dict:
    """Parse a CSV of ICRS pointings while retaining arbitrary source fields.

    Parameters
    ----------
    contents : bytes
        UTF-8 CSV file contents, optionally with a byte-order mark.
    filename : str, default="catalogue.csv"
        Filename retained in the API response.
    ra_column, dec_column : str, optional
        Explicit header names chosen when discovery is ambiguous.
    ra_unit : {"auto", "degrees", "hours"}
        RA input convention. In auto mode, colon-separated sexagesimal values
        are hours and decimal values are degrees. ``ra_hours`` declares hours.

    Returns
    -------
    dict
        Catalogue response with canonical coordinates and untouched source
        fields, or ``needs_mapping`` and available columns when safe automatic
        discovery is impossible.

    Raises
    ------
    ValueError
        If a selected column, unit, or individual row is invalid.
    """
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("CSV must be UTF-8 encoded") from exc
    reader = csv.DictReader(io.StringIO(text, newline=""))
    headers = [(header or "").strip() for header in (reader.fieldnames or [])]
    if not headers or any(not header for header in headers) or len(set(headers)) != len(headers):
        raise ValueError("CSV must have unique, non-empty column headers")
    if ra_unit not in {"auto", "degrees", "hours"}:
        raise ValueError("RA unit must be auto, degrees, or hours")
    if (ra_column is None) != (dec_column is None):
        raise ValueError("Choose both RA and DEC columns")
    if ra_column is None:
        ra_matches = [
            header for header in headers if header.lower().replace(" ", "_") in RA_ALIASES
        ]
        dec_matches = [
            header for header in headers if header.lower().replace(" ", "_") in DEC_ALIASES
        ]
        if len(ra_matches) != 1 or len(dec_matches) != 1:
            return {
                "filename": filename,
                "row_count": 0,
                "tiles": [],
                "warnings": [],
                "columns": headers,
                "ra_column": None,
                "dec_column": None,
                "needs_mapping": True,
            }
        ra_column, dec_column = ra_matches[0], dec_matches[0]
    if ra_column not in headers or dec_column not in headers or ra_column == dec_column:
        raise ValueError("Selected RA and DEC columns must be distinct CSV headers")
    if ra_unit == "auto" and ra_column.lower().replace(" ", "_") == "ra_hours":
        ra_unit = "hours"

    tiles: list[TileRecord] = []
    for row_number, raw_row in enumerate(reader, start=2):
        if raw_row is None or all(not (value or "").strip() for value in raw_row.values()):
            continue
        if None in raw_row:
            raise ValueError(f"Row {row_number}: too many CSV values")
        row = {
            str(key).strip(): value if value is not None else "" for key, value in raw_row.items()
        }
        missing_values = [key for key in (ra_column, dec_column) if not row.get(key, "").strip()]
        if missing_values:
            raise ValueError(
                f"Row {row_number}: empty required value in {', '.join(missing_values)}"
            )
        try:
            ra_deg = parse_ra_degrees(row[ra_column], unit=ra_unit)
            dec_deg = parse_dec_degrees(row[dec_column])
            tiles.append(
                TileRecord(
                    id=f"original-{row_number - 1}",
                    name=row.get("NAME", f"Row {row_number - 1}"),
                    ra_deg=ra_deg,
                    dec_deg=dec_deg,
                    source=TileSource.ORIGINAL,
                    dataset_id=filename,
                    group_id=f"{filename}:{row.get('PID', '')}",
                    ra_column=ra_column,
                    dec_column=dec_column,
                    original_values=row,
                    metadata={
                        key: value
                        for key, value in row.items()
                        if key not in (ra_column, dec_column)
                    },
                )
            )
        except ValueError as exc:
            raise ValueError(f"Row {row_number}: {exc}") from exc
    if not tiles:
        raise ValueError("Catalogue contains no tile rows")
    return {
        "filename": filename,
        "row_count": len(tiles),
        "tiles": tiles,
        "warnings": [],
        "columns": headers,
        "ra_column": ra_column,
        "dec_column": dec_column,
        "needs_mapping": False,
    }


def parse_center_text(text: str) -> list[CenterInput]:
    """Parse one RA/DEC pair per line for import preview.

    Lines may use comma, semicolon, or whitespace separators. Sexagesimal
    coordinates may use colons or whitespace fields; RA uses hours and DEC
    uses degrees. Decimal RA and DEC are both degrees.

    Parameters
    ----------
    text : str
        Pasted list of coordinate pairs.

    Returns
    -------
    list[CenterInput]
        Parsed centers in decimal degrees, preserving one-based line labels.

    Raises
    ------
    ValueError
        If a non-empty line does not contain exactly two valid coordinates.
    """
    centers: list[CenterInput] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        normalized = stripped.replace(";", ",")
        if "," in normalized:
            fields = [field.strip() for field in normalized.split(",")]
        else:
            fields = re.split(r"\s+", normalized)
            if len(fields) == 6:
                fields = [":".join(fields[:3]), ":".join(fields[3:])]
            elif len(fields) == 4 and fields[1].startswith(("+", "-")):
                fields = [fields[0], ":".join(fields[1:])]
            elif len(fields) == 4 and ":" in fields[0]:
                fields = [fields[0], ":".join(fields[1:])]
            elif len(fields) == 4:
                fields = [":".join(fields[:3]), fields[3]]
        if len(fields) == 2 and fields[0].upper() in {"RA", "RA_DEG", "RA(HMS)"}:
            continue
        if len(fields) != 2:
            raise ValueError(f"Line {line_number}: expected exactly two values (RA and DEC)")
        try:
            centers.append(
                CenterInput(
                    ra_deg=parse_ra_degrees(fields[0]),
                    dec_deg=parse_dec_degrees(fields[1]),
                    label=f"Line {line_number}",
                )
            )
        except ValueError as exc:
            raise ValueError(f"Line {line_number}: {exc}") from exc
    if not centers:
        raise ValueError("No coordinate pairs found")
    return centers


def make_center_proposals(
    centers: list[CenterInput], generation_method: GenerationMethod
) -> list[TileRecord]:
    """Create deterministic, provisional tile records from parsed centers.

    Parameters
    ----------
    centers : list[CenterInput]
        Validated decimal-degree centers.
    generation_method : GenerationMethod
        Manual or imported-center origin of the proposals.

    Returns
    -------
    list[TileRecord]
        Proposed positions with stable session-local identifiers and origin.
    """
    return [
        TileRecord(
            id=f"proposal-{generation_method.value}-{index:04d}",
            ra_deg=center.ra_deg,
            dec_deg=center.dec_deg,
            source=TileSource.PROPOSED,
            generation_method=generation_method,
            metadata={"label": center.label or ""},
        )
        for index, center in enumerate(centers, start=1)
    ]
