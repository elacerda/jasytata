import { describe, expect, it } from "vitest";
import golden from "../data/golden.json";
import referenceCsv from "../../public/data/tiles_nc.csv?raw";
import { makeCenterProposals, parseCatalogueCsv, parseCenterText } from "./catalogue";
import { formatDecDegrees, formatRaDegrees, normalizeRa, parseDecDegrees, parseRaDegrees, type RaUnit } from "./coordinates";
import { buildExportCsv } from "./export";
import { polygonBounds } from "./geometry";
import { loadProfile, validateProfile } from "../profiles";
import type { CatalogueResponse, TilingProfile } from "../types";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Compare IEEE-754 degree outputs at a tolerance well below input precision. */
function closeDegrees(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-10);
}

describe("v0.2.0 T80-South compatibility: Python coordinate references", () => {
  it("matches decimal, sexagesimal, hours, and RA wrap outputs", () => {
    for (const row of golden.coordinates) {
      closeDegrees(parseRaDegrees(row.input[0], row.input[2] as RaUnit), row.ra_deg);
      closeDegrees(parseDecDegrees(row.input[1]), row.dec_deg);
    }
    expect(normalizeRa(-1)).toBe(359);
    expect(normalizeRa(720)).toBe(0);
    expect(() => parseRaDegrees("360.1")).toThrow(/between 0 and 360/);
    expect(() => parseRaDegrees("10:00:00", "degrees")).toThrow(/conflict/);
    expect(() => parseDecDegrees("91")).toThrow(/between -90 and 90/);
    expect(() => parseDecDegrees("10h03m05s")).toThrow(/between -90 and 90/);
  });

  it("matches exact Python sexagesimal strings and carry at RA wrap", () => {
    for (const row of golden.formatting) {
      expect(formatRaDegrees(row.input[0], row.input[2])).toBe(row.ra);
      expect(formatDecDegrees(row.input[1], row.input[2])).toBe(row.dec);
    }
  });
});

describe("v0.2.0 T80-South compatibility: catalogue and profile references", () => {
  it("parses all 4,774 bundled reference rows without a backend", () => {
    const result = parseCatalogueCsv(bytes(referenceCsv), "tiles_nc.csv");
    expect(result.row_count).toBe(4774);
    expect(result.tiles[0].original_values).toEqual({
      PID: "HYDRA_D", NAME: "HYDRA_D_0001", RA: "10:33:25",
      DEC: "-34:38:06", EPOC: "2000", STATUS: "1",
    });
    closeDegrees(result.tiles[0].ra_deg, 158.3541666667);
  });

  it("preserves columns, metadata, provenance, quoted cells and mapped coordinates", () => {
    for (const item of golden.catalogues) {
      const mapping = item.mapping as { ra_column?: string; dec_column?: string };
      const actual = parseCatalogueCsv(bytes(item.csv), "fixture.csv", mapping.ra_column, mapping.dec_column);
      const expected = item.result as CatalogueResponse;
      expect({ ...actual, tiles: [] }).toEqual({ ...expected, tiles: [] });
      expect(actual.tiles).toHaveLength(expected.tiles.length);
      for (const [index, tile] of actual.tiles.entries()) {
        const reference = expected.tiles[index];
        closeDegrees(tile.ra_deg, reference.ra_deg);
        closeDegrees(tile.dec_deg, reference.dec_deg);
        expect({ ...tile, ra_deg: 0, dec_deg: 0 }).toEqual({ ...reference, ra_deg: 0, dec_deg: 0 });
      }
    }
    const ambiguous = parseCatalogueCsv(bytes(golden.catalogues[2].csv));
    expect(ambiguous.needs_mapping).toBe(true);
    expect(ambiguous.columns).toEqual(["RA", "ra_deg", "DEC", "label"]);
    expect(() => parseCatalogueCsv(bytes("RA,DEC\nnot-ra,-20\n"))).toThrow(/Row 2: Invalid RA/);
    expect(() => parseCatalogueCsv(bytes("RA,DEC\n150,-20,extra\n"))).toThrow(/Row 2: too many/);
    expect(() => parseCatalogueCsv(new Uint8Array([255]))).toThrow(/UTF-8/);
  });

  it("matches center labels and proposal records", () => {
    const actual = parseCenterText(golden.centers.text);
    expect(actual).toHaveLength(golden.centers.result.length);
    actual.forEach((center, index) => {
      const expected = golden.centers.result[index];
      closeDegrees(center.ra_deg, expected.ra_deg);
      closeDegrees(center.dec_deg, expected.dec_deg);
      expect(center.label).toBe(expected.label);
    });
    const proposals = makeCenterProposals(actual, "imported_centers");
    expect(proposals[0].id).toBe("proposal-imported_centers-0001");
    expect(proposals[0].metadata.label).toBe("Line 2");
    expect(() => parseCenterText("10:00:00 -30:00:00\n\ninvalid")).toThrow(/Line 3/);
  });

  it("matches the installed profile and rejects invalid custom geometry", () => {
    expect(loadProfile()).toEqual(golden.profile);
    const custom: TilingProfile = { ...loadProfile(), id: "custom", display_name: "Custom", algorithm: "RECT_GRID_V1", tile_width_deg: 2.25, tile_height_deg: 1.75, effective_overlap_arcsec: 90 };
    expect(validateProfile(custom)).toEqual(custom);
    expect(() => validateProfile({ ...custom, effective_overlap_arcsec: 6300 })).toThrow(/overlap/);
    expect(() => validateProfile({ ...custom, coordinate_frame: "galactic" })).toThrow(/ICRS/);
    expect(() => validateProfile({ ...custom, export_epoch_default: "2050" })).toThrow(/epoch/);
    expect(() => validateProfile({ ...loadProfile(), id: "custom" })).toThrow(/RECT_GRID_V1/);
  });
});

describe("v0.2.0 T80-South compatibility: decimal and sexagesimal exports", () => {
  const proposal = { id: "proposal-1", name: "", ra_deg: 150.5, dec_deg: -24.25, source: "proposed" as const, enabled: true, generation_method: "manual" as const, original_values: null, metadata: {} };
  it("matches exact CRLF, fields, digits and sexagesimal formatting", () => {
    expect(buildExportCsv([proposal], "splus-t80-south", undefined, "decimal")).toBe(golden.exports.decimal);
    expect(buildExportCsv([proposal], "splus-t80-south", undefined, "sexagesimal")).toBe(golden.exports.sexagesimal);
    const loaded = parseCatalogueCsv(bytes(golden.exports.decimal));
    expect(loaded.tiles[0].metadata).toEqual({ EPOCH: "2000" });
    expect(loaded.tiles[0].ra_deg).toBe(150.5);
  });
  it("rejects invalid epoch, source and empty active set", () => {
    expect(() => buildExportCsv([proposal], "splus-t80-south", "2050")).toThrow(/not allowed/);
    expect(() => buildExportCsv([{ ...proposal, enabled: false }])).toThrow(/Enable at least one/);
    expect(() => buildExportCsv([{ ...proposal, source: "original" }])).toThrow(/only proposed/);
  });
});

describe("v0.2.0 T80-South compatibility: coordinate geometry", () => {
  it("matches Python bounds across RA zero exactly within floating-point tolerance", () => {
    const bounds = polygonBounds({ vertices: [
      { ra_deg: 359.2, dec_deg: -30 }, { ra_deg: 0.8, dec_deg: -30 },
      { ra_deg: 0.8, dec_deg: -28 }, { ra_deg: 359.2, dec_deg: -28 },
    ] });
    for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
      closeDegrees(bounds[key], golden.geometry.wrapped_bounds[key]);
    }
  });

  it("keeps compact holdout and overlap inputs tied to the static reference catalogue", () => {
    const names = new Set(parseCatalogueCsv(bytes(referenceCsv)).tiles.map((tile) => tile.name));
    expect(golden.historical_holdout.hidden_names.every((name) => names.has(name))).toBe(true);
    expect(golden.historical_holdout.surrounding_names.every((name) => names.has(name))).toBe(true);
    expect(names.has(golden.historical_fallback.anchor_name)).toBe(true);
    expect(golden.historical_holdout.solution).toBe("extended_existing_grid");
    expect(golden.historical_fallback.solution).toBe("profile_fallback");
    expect(golden.large_overlap.solution).toBe("extended_existing_grid");
    expect(golden.large_overlap.metrics.existing_tiles_contributing).toBe(88);
  });
});
