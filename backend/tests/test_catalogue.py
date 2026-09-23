"""Catalogue parsing, coordinate conversion, and export round-trip tests."""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import ExportRequest, GenerationMethod, TileRecord, TileSource
from app.science.catalogue import parse_catalogue_csv, parse_center_text
from app.science.coordinates import (
    format_dec_degrees,
    format_ra_degrees,
    parse_dec_degrees,
    parse_ra_degrees,
)
from app.science.export import build_export_csv


def original_tile(name: str = "HYDRA_0011") -> TileRecord:
    """Return one source record with raw values that must remain untouched."""
    raw = {
        "PID": "HYDRA",
        "NAME": name,
        "RA": "10:03:05",
        "DEC": "-23:54:31",
        "EPOC": "2000",
        "STATUS": "1",
    }
    return TileRecord(
        id="original-1",
        name=raw["NAME"],
        ra_deg=parse_ra_degrees(raw["RA"]),
        dec_deg=parse_dec_degrees(raw["DEC"]),
        source=TileSource.ORIGINAL,
        original_values=raw,
    )


def proposed_tile() -> TileRecord:
    """Return one proposed record for the exporter."""
    return TileRecord(
        id="proposal-1",
        ra_deg=150.5,
        dec_deg=-24.25,
        source=TileSource.PROPOSED,
        generation_method=GenerationMethod.MANUAL,
    )


def test_supplied_catalogue_loads_with_preserved_values() -> None:
    """The representative 4,774-row catalogue passes the same parser as uploads."""
    source = Path(__file__).resolve().parents[2] / "reference" / "tiles_nc.csv"
    parsed = parse_catalogue_csv(source.read_bytes(), source.name)
    assert parsed["row_count"] == 4774
    assert parsed["tiles"][0].original_values == {
        "PID": "HYDRA_D",
        "NAME": "HYDRA_D_0001",
        "RA": "10:33:25",
        "DEC": "-34:38:06",
        "EPOC": "2000",
        "STATUS": "1",
    }
    assert parsed["tiles"][0].ra_deg == pytest.approx(158.3541666667)


def test_catalogue_schema_and_row_parsing_errors_are_useful() -> None:
    """Optional metadata is accepted and malformed coordinates identify the row."""
    assert (
        parse_catalogue_csv(b"PID,NAME,RA,DEC,EPOC\nP,N,10:00:00,-30:00:00,2000\n")["row_count"]
        == 1
    )
    with pytest.raises(ValueError, match="Row 2: Invalid RA"):
        parse_catalogue_csv(b"PID,NAME,RA,DEC,EPOC,STATUS\nP,N,not-ra,-30:00:00,2000,1\n")


def test_generic_catalogues_preserve_arbitrary_metadata() -> None:
    """Minimal and DR6-style rows need only inferred coordinate columns."""
    minimal = parse_catalogue_csv(b"ra,dec\n150.5,-24.25\n")
    assert minimal["tiles"][0].ra_deg == pytest.approx(150.5)
    assert minimal["tiles"][0].metadata == {}
    dr6 = parse_catalogue_csv(
        b"ra_deg,dec_deg,field_id,quality,release\n150.5,-24.25,DR6_1,good,DR6\n"
    )
    assert dr6["tiles"][0].metadata == {"field_id": "DR6_1", "quality": "good", "release": "DR6"}
    assert dr6["tiles"][0].original_values["field_id"] == "DR6_1"


def test_ambiguous_columns_request_explicit_mapping() -> None:
    """Multiple RA candidates require a user choice before coordinates load."""
    data = b"RA,ra_deg,DEC,label\n10:03:05,150.77,-23:54:31,A\n"
    preview = parse_catalogue_csv(data)
    assert preview["needs_mapping"]
    assert preview["columns"] == ["RA", "ra_deg", "DEC", "label"]
    parsed = parse_catalogue_csv(data, ra_column="RA", dec_column="DEC")
    assert parsed["tiles"][0].ra_deg == pytest.approx(150.7708333333)
    assert parsed["tiles"][0].metadata["ra_deg"] == "150.77"


def test_explicit_hours_column_does_not_guess_decimal_units() -> None:
    """An hours-labelled RA column and explicit user unit preserve meaning."""
    data = b"ra_hours,dec\n10.5,-24\n"
    assert parse_catalogue_csv(data)["tiles"][0].ra_deg == pytest.approx(157.5)
    assert parse_catalogue_csv(data, ra_column="ra_hours", dec_column="dec", ra_unit="degrees")[
        "tiles"
    ][0].ra_deg == pytest.approx(10.5)


def test_sexagesimal_and_decimal_coordinates_convert() -> None:
    """RA hour angle and DEC sexagesimal fields map to canonical degrees."""
    assert parse_ra_degrees("10:03:05") == pytest.approx(150.7708333333)
    assert parse_dec_degrees("-23:54:31") == pytest.approx(-23.9086111111)
    assert parse_ra_degrees("150.5") == pytest.approx(150.5)
    assert parse_ra_degrees("10 03 05") == pytest.approx(150.7708333333)
    assert parse_dec_degrees("-24.25") == pytest.approx(-24.25)
    assert format_ra_degrees(150.7708333333) == "10:03:05"
    assert format_dec_degrees(-23.9086111111) == "-23:54:31"


def test_center_text_accepts_sexagesimal_decimal_and_csv_header() -> None:
    """Center import accepts supported mixed coordinate representations."""
    centers = parse_center_text("RA, DEC\n10:03:05, -23:54:31\n150.5 -24.25")
    assert len(centers) == 2
    assert centers[0].ra_deg == pytest.approx(150.7708333333)
    assert centers[1].dec_deg == pytest.approx(-24.25)
    whitespace_sexagesimal = parse_center_text("10 03 05 -23 54 31\n150 -24 15 00")
    assert whitespace_sexagesimal[0].ra_deg == pytest.approx(150.7708333333)
    assert whitespace_sexagesimal[0].dec_deg == pytest.approx(-23.9086111111)
    assert whitespace_sexagesimal[1].ra_deg == pytest.approx(150.0)
    assert whitespace_sexagesimal[1].dec_deg == pytest.approx(-24.25)
    with pytest.raises(ValueError, match="Line 3"):
        parse_center_text("10:00:00 -30:00:00\n\ninvalid")


def test_generic_decimal_export_round_trips_without_imported_metadata() -> None:
    """RA/DEC/EPOCH rows reload and never inherit source operational columns."""
    contents = build_export_csv(ExportRequest(proposed_tiles=[proposed_tile()]))
    assert next(csv.reader(io.StringIO(contents))) == ["RA", "DEC", "EPOCH"]
    rows = list(csv.DictReader(io.StringIO(contents)))
    assert rows == [{"RA": "150.50000000", "DEC": "-24.25000000", "EPOCH": "2000"}]
    loaded = parse_catalogue_csv(contents.encode("utf-8"))
    assert loaded["row_count"] == 1
    assert loaded["tiles"][0].ra_deg == pytest.approx(150.5)
    assert loaded["tiles"][0].dec_deg == pytest.approx(-24.25)
    assert loaded["tiles"][0].metadata == {"EPOCH": "2000"}


def test_sexagesimal_export_round_trips_and_rejects_invalid_epoch() -> None:
    """Astropy sexagesimal conversion reloads under Gate 3 coordinate rules."""
    contents = build_export_csv(ExportRequest(
        proposed_tiles=[proposed_tile()], coordinate_format="sexagesimal"
    ))
    rows = list(csv.DictReader(io.StringIO(contents)))
    assert rows[0]["RA"].startswith("10:02:00")
    assert rows[0]["DEC"].startswith("-24:15:00")
    loaded = parse_catalogue_csv(contents.encode("utf-8"))
    assert loaded["tiles"][0].ra_deg == pytest.approx(150.5, abs=1e-5)
    with pytest.raises(ValueError, match="not allowed"):
        build_export_csv(ExportRequest(proposed_tiles=[proposed_tile()], epoch="2050"))
    with pytest.raises(ValueError, match="Enable at least one"):
        build_export_csv(ExportRequest(proposed_tiles=[]))
    with pytest.raises(ValidationError, match="coordinate_format"):
        ExportRequest(proposed_tiles=[proposed_tile()], coordinate_format="invalid")
