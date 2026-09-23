"""Catalogue and pasted-center parsing with source-value preservation."""

from __future__ import annotations

import csv
import io
import re

from app.models import CenterInput, GenerationMethod, TileRecord, TileSource
from app.science.coordinates import parse_dec_degrees, parse_ra_degrees

REQUIRED_COLUMNS = ("PID", "NAME", "RA", "DEC", "EPOC", "STATUS")


def parse_catalogue_csv(contents: bytes, filename: str = "catalogue.csv") -> dict:
    """Parse the six-column T80/S-PLUS catalogue schema.

    Parameters
    ----------
    contents : bytes
        UTF-8 CSV file contents, optionally with a byte-order mark.
    filename : str, default="catalogue.csv"
        Filename retained in the API response.

    Returns
    -------
    dict
        Catalogue response data with canonical coordinates and untouched
        source fields for each original row.

    Raises
    ------
    ValueError
        If the schema is incomplete or an individual row has an invalid value.
    """
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("CSV must be UTF-8 encoded") from exc
    reader = csv.DictReader(io.StringIO(text, newline=""))
    headers = tuple((header or "").strip() for header in (reader.fieldnames or []))
    missing = [column for column in REQUIRED_COLUMNS if column not in headers]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")
    if len(headers) != len(REQUIRED_COLUMNS) or set(headers) != set(REQUIRED_COLUMNS):
        extras = [column for column in headers if column not in REQUIRED_COLUMNS]
        if extras:
            raise ValueError(
                f"Unexpected columns: {', '.join(extras)}; expected the six-column schema"
            )
        raise ValueError("The catalogue must contain each required column exactly once")

    tiles: list[TileRecord] = []
    for row_number, raw_row in enumerate(reader, start=2):
        if raw_row is None or all(not (value or "").strip() for value in raw_row.values()):
            continue
        if None in raw_row:
            raise ValueError(f"Row {row_number}: too many CSV values for the six-column schema")
        row = {
            str(key).strip(): value if value is not None else "" for key, value in raw_row.items()
        }
        missing_values = [key for key in REQUIRED_COLUMNS if not row.get(key, "").strip()]
        if missing_values:
            raise ValueError(
                f"Row {row_number}: empty required value in {', '.join(missing_values)}"
            )
        try:
            ra_deg = parse_ra_degrees(row["RA"])
            dec_deg = parse_dec_degrees(row["DEC"])
            tiles.append(
                TileRecord(
                    id=f"original-{row_number - 1}",
                    pid=row["PID"],
                    name=row["NAME"],
                    ra_deg=ra_deg,
                    dec_deg=dec_deg,
                    epoch=row["EPOC"],
                    status=row["STATUS"],
                    source=TileSource.ORIGINAL,
                    original_values={key: row[key] for key in REQUIRED_COLUMNS},
                )
            )
        except ValueError as exc:
            raise ValueError(f"Row {row_number}: {exc}") from exc
    if not tiles:
        raise ValueError("Catalogue contains no tile rows")
    return {"filename": filename, "row_count": len(tiles), "tiles": tiles, "warnings": []}


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
        Proposed records with stable session-local identifiers and provisional
        names. Final PID, NAME, EPOC, and STATUS are assigned at export time.
    """
    return [
        TileRecord(
            id=f"proposal-{generation_method.value}-{index:04d}",
            pid="PROPOSED",
            name=f"PROPOSED_{index:04d}",
            ra_deg=center.ra_deg,
            dec_deg=center.dec_deg,
            epoch="2000",
            status="-5",
            source=TileSource.PROPOSED,
            generation_method=generation_method,
            metadata={"label": center.label or ""},
        )
        for index, center in enumerate(centers, start=1)
    ]
