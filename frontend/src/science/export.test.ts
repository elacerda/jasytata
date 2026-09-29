import { describe, expect, it } from "vitest";
import type { ExportPolicy, SurveyProfileV2, TileRecord } from "../types";
import { SPLUS_SURVEY_V2 } from "../profiles/v2";
import { parseProfileJson, serializeProfile } from "../profiles/document";
import { ProfileRegistry } from "../profiles/registry";
import smallJson from "../profiles/fixtures/small-camera.json";
import { makeCenterProposals, readCsv } from "./catalogue";
import { parseDecDegrees, parseRaDegrees } from "./coordinates";
import { buildExportCsv, type PointingExposureExport } from "./export";
import { deriveExposurePlacements, type ObservingSequence } from "./exposure-sequence";

const pointing: TileRecord = makeCenterProposals([{ ra_deg: 150.12345678, dec_deg: -24.12345678 }], "manual")[0];
const policy: ExportPolicy = { ra_column: "ALPHA_J2000", dec_column: "DELTA_J2000", coordinate_format: "decimal" };
const survey = (exportPolicy: ExportPolicy = policy): SurveyProfileV2 => ({ ...SPLUS_SURVEY_V2, id: "generic-output", export: exportPolicy });

describe("survey-driven pointing export", () => {
  it("honors coordinate labels and omits undeclared epoch, PA and internal/source fields", () => {
    const tile = { ...pointing, position_angle_deg: 31, group_id: "legacy-PID", metadata: { PID: "secret", lattice_i: 2 } };
    expect(buildExportCsv([tile], survey())).toBe("ALPHA_J2000,DELTA_J2000\r\n150.12345678,-24.12345678\r\n");
  });

  it("uses the declared constant epoch or an explicitly allowed selection without precession", () => {
    const configured = survey({ ...policy, epoch: { column: "EQUINOX", default: "J2016", allowed: ["J2016", "J2000"] } });
    expect(readCsv(buildExportCsv([pointing], configured))).toEqual([["ALPHA_J2000", "DELTA_J2000", "EQUINOX"], ["150.12345678", "-24.12345678", "J2016"]]);
    expect(buildExportCsv([pointing], configured, "J2000")).toContain(",-24.12345678,J2000\r\n");
    expect(() => buildExportCsv([pointing], configured, "2050")).toThrow(/not allowed/);
    expect(() => buildExportCsv([pointing], survey(), "2000")).toThrow(/does not declare/);
  });

  it("outputs declared nonzero camera PA and fails on absent/nonfinite PA without a zero default", () => {
    const configured = survey({ ...policy, position_angle_column: "CAMERA_PA" });
    expect(buildExportCsv([{ ...pointing, position_angle_deg: 37.25 }], configured)).toContain(",-24.12345678,37.25000000\r\n");
    for (const position_angle_deg of [undefined, NaN, Infinity]) {
      expect(() => buildExportCsv([{ ...pointing, position_angle_deg, metadata: { lattice_rotation_deg: 17 } }], configured)).toThrow(/no declared camera position angle/);
    }
  });

  it("uses a caller-resolved absolute PA only when the survey declares a PA column", () => {
    const configured = survey({ ...policy, position_angle_column: "CAMERA_PA" });
    const tile = { ...pointing, position_angle_deg: 12 };
    const resolver = (candidate: TileRecord) => candidate === tile ? 278.5 : undefined;
    expect(readCsv(buildExportCsv([tile], configured, undefined, { resolvePositionAngle: resolver }))[1][2]).toBe("278.50000000");
    expect(() => buildExportCsv([tile], configured, undefined, { resolvePositionAngle: () => undefined })).toThrow(/no declared camera position angle/);
    expect(() => buildExportCsv([tile], configured, undefined, { resolvePositionAngle: () => Infinity })).toThrow(/no declared camera position angle/);
    expect(buildExportCsv([tile], survey(), undefined, { resolvePositionAngle: () => { throw new Error("must not resolve PA"); } }))
      .toBe(buildExportCsv([tile], survey()));
  });

  it.each([
    ["CALIFA", [
      { order: 1, east_arcsec: 0, north_arcsec: 0 },
      { order: 2, east_arcsec: -5.22, north_arcsec: -4.53 },
      { order: 3, east_arcsec: -5.22, north_arcsec: 4.53 },
    ]],
    ["MaNGA", [
      { order: 1, east_arcsec: -1.44 / (2 * Math.sqrt(3)), north_arcsec: 1.44 / 2 },
      { order: 2, east_arcsec: -1.44 / (2 * Math.sqrt(3)), north_arcsec: -1.44 / 2 },
      { order: 3, east_arcsec: 1.44 / Math.sqrt(3), north_arcsec: 0 },
    ]],
  ] as const)("exports ordered %s exposure rows at derived centers without claiming a physical PA", (label, exposureOffsets) => {
    const sequence: ObservingSequence = { id: `${label}-fixture`, exposures: exposureOffsets };
    const tile = { ...pointing, position_angle_deg: undefined };
    const derived = deriveExposurePlacements({
      id: tile.id,
      center: { ra_deg: tile.ra_deg, dec_deg: tile.dec_deg },
      positionAngleDeg: tile.position_angle_deg,
    }, sequence);
    const exposures: PointingExposureExport[] = derived.map((item) => ({
      id: item.id,
      order: item.order,
      ra_deg: item.center[0],
      dec_deg: item.center[1],
      position_angle_deg: item.positionAngleDeg,
    }));
    const configured = survey({ ...policy, identifiers: { id_column: "TARGET" } });
    const tiles = [tile, { ...pointing, id: "second-pointing" }];
    const snapshot = structuredClone(tiles);
    const rows = readCsv(buildExportCsv(tiles, configured, undefined, {
      resolveExposures: (candidate) => candidate === tile ? exposures : exposures.map((exposure) => ({
        ...exposure,
        id: `second:${exposure.id}`,
        ra_deg: exposure.ra_deg + 0.01,
        position_angle_deg: 215,
      })),
    }));

    expect(rows[0]).toEqual(["ALPHA_J2000", "DELTA_J2000", "TARGET"]);
    expect(rows).toHaveLength(7);
    expect(rows.slice(1, 4).map((row) => row[2])).toEqual([
      "PROPOSED_0001_EXP_0001", "PROPOSED_0001_EXP_0002", "PROPOSED_0001_EXP_0003",
    ]);
    expect(rows.slice(4).map((row) => row[2])).toEqual([
      "PROPOSED_0002_EXP_0001", "PROPOSED_0002_EXP_0002", "PROPOSED_0002_EXP_0003",
    ]);
    expect(rows.slice(1, 4).map((row) => row.slice(0, 2))).toEqual(derived.map((exposure) => [
      exposure.center[0].toFixed(8), exposure.center[1].toFixed(8),
    ]));
    expect(rows.slice(1).every((row) => row.length === 3)).toBe(true);
    expect(tiles).toEqual(snapshot);
  });

  it("exports composed PA for a synthetic oriented exposure sequence", () => {
    const sequence: ObservingSequence = {
      id: "synthetic-oriented",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 },
        { order: 2, east_arcsec: 0, north_arcsec: 0, rotation_deg: 90 },
      ],
    };
    const tile = { ...pointing, position_angle_deg: 37 };
    const derived = deriveExposurePlacements({
      id: tile.id,
      center: { ra_deg: tile.ra_deg, dec_deg: tile.dec_deg },
      positionAngleDeg: tile.position_angle_deg,
    }, sequence);
    const configured = survey({
      ...policy,
      position_angle_column: "CAMERA_PA",
      identifiers: { id_column: "TARGET" },
    });
    const csv = buildExportCsv([tile], configured, undefined, {
      resolveExposures: () => derived.map((item) => ({
        id: item.id,
        order: item.order,
        ra_deg: item.center[0],
        dec_deg: item.center[1],
        position_angle_deg: item.positionAngleDeg,
      })),
    });
    const rows = readCsv(csv);
    expect(rows[0]).toEqual(["ALPHA_J2000", "DELTA_J2000", "CAMERA_PA", "TARGET"]);
    expect(rows.slice(1).map((row) => [row[2], row[3]])).toEqual([
      ["37.00000000", "PROPOSED_0001_EXP_0001"],
      ["127.00000000", "PROPOSED_0001_EXP_0002"],
    ]);
  });

  it("allows an offset single exposure without an ID column and preserves the legacy row identity format", () => {
    const csv = buildExportCsv([pointing], survey(), undefined, {
      resolveExposures: () => [{ id: "sequence:1", order: 1, ra_deg: 151, dec_deg: -22 }],
    });
    expect(csv).toBe("ALPHA_J2000,DELTA_J2000\r\n151.00000000,-22.00000000\r\n");
  });

  it("preserves an unsequenced pointing row in a mixed sequence export", () => {
    const unsequenced = { ...pointing, id: "without-sequence", ra_deg: 153 };
    const configured = survey({ ...policy, identifiers: { id_column: "TARGET" } });
    const rows = readCsv(buildExportCsv([pointing, unsequenced], configured, undefined, {
      resolveExposures: (tile) => tile.id === "without-sequence" ? undefined : [
        { id: "sequence:1", order: 1, ra_deg: 151, dec_deg: -22 },
        { id: "sequence:2", order: 2, ra_deg: 152, dec_deg: -21 },
      ],
    }));
    expect(rows.slice(1).map((row) => row[2])).toEqual([
      "PROPOSED_0001_EXP_0001", "PROPOSED_0001_EXP_0002", "PROPOSED_0002",
    ]);
    expect(rows[3].slice(0, 2)).toEqual(["153.00000000", "-24.12345678"]);
  });

  it("validates exposure identities, ordering, coordinates, PA, and required identifiers", () => {
    const withId = survey({ ...policy, identifiers: { id_column: "TARGET" } });
    const exposures: PointingExposureExport[] = [
      { id: "sequence:1", order: 1, ra_deg: 151, dec_deg: -22, position_angle_deg: 14 },
      { id: "sequence:2", order: 2, ra_deg: 152, dec_deg: -21, position_angle_deg: 15 },
    ];
    expect(() => buildExportCsv([pointing], survey(), undefined, { resolveExposures: () => exposures })).toThrow(/ID column is required/);
    const configuredWithId = survey({ ...policy, position_angle_column: "PA", identifiers: { id_column: "TARGET" } });
    expect(() => buildExportCsv([pointing], configuredWithId, undefined, {
      resolveExposures: () => exposures.map((row) => ({
        id: row.id, order: row.order, ra_deg: row.ra_deg, dec_deg: row.dec_deg,
      })),
    })).toThrow(/no declared camera position angle/);
    expect(() => buildExportCsv([pointing], withId, undefined, {
      resolveExposures: () => [{ ...exposures[0], id: " " }],
    })).toThrow(/unique non-empty identities/);
    expect(() => buildExportCsv([pointing], withId, undefined, {
      resolveExposures: () => [exposures[0], { ...exposures[1], id: exposures[0].id }],
    })).toThrow(/unique non-empty identities/);
    expect(() => buildExportCsv([pointing], withId, undefined, {
      resolveExposures: () => [{ ...exposures[0], order: 2 }],
    })).toThrow(/contiguous and 1-based/);
    expect(() => buildExportCsv([pointing], withId, undefined, {
      resolveExposures: () => [{ ...exposures[0], ra_deg: Number.NaN }],
    })).toThrow(/invalid ICRS coordinates/);
    expect(() => buildExportCsv([pointing], withId, undefined, {
      resolveExposures: () => [{ ...exposures[0], position_angle_deg: Number.POSITIVE_INFINITY }],
    })).toThrow(/nonfinite camera position angle/);
  });

  it("sorts primitive constants deterministically and escapes commas, quotes, LF and CR", () => {
    const constants = { z_string: 'pilot,"one"\nnext\rline', a_numeric: 123.5, b_boolean: true, c_false: false };
    const configured = survey({ ...policy, constant_fields: constants });
    const csv = buildExportCsv([pointing, { ...pointing, id: "another" }], configured);
    expect(csv).toContain('123.5,true,false,"pilot,""one""\nnext\rline"\r\n');
    const parsed = readCsv(csv);
    expect(parsed[0]).toEqual(["ALPHA_J2000", "DELTA_J2000", "a_numeric", "b_boolean", "c_false", "z_string"]);
    expect(parsed.slice(1).map((row) => row.slice(2))).toEqual(Array(2).fill(["123.5", "true", "false", constants.z_string]));
    expect(buildExportCsv([pointing, { ...pointing, id: "another" }], survey({ ...policy, constant_fields: Object.fromEntries(Object.entries(constants).reverse()) }))).toBe(csv);
  });

  it("escapes profile column labels as well as values", () => {
    const configured = survey({ ...policy, ra_column: 'alpha,"ICRS"', dec_column: "delta\nICRS" });
    expect(readCsv(buildExportCsv([pointing], configured))[0]).toEqual(['alpha,"ICRS"', "delta\nICRS"]);
  });

  it.each([0, 0.000001, 359.999999, 359.999999999])("round-trips RA=%s across both formats within established precision", (ra_deg) => {
    const tile = { ...pointing, ra_deg };
    const decimal = readCsv(buildExportCsv([tile], survey()))[1];
    const sexagesimal = readCsv(buildExportCsv([tile], survey({ ...policy, coordinate_format: "sexagesimal" })))[1];
    const separation = (left: number, right: number) => Math.min(Math.abs(left - right), 360 - Math.abs(left - right));
    expect(separation(parseRaDegrees(decimal[0]), ra_deg)).toBeLessThanOrEqual(5.1e-9);
    expect(separation(parseRaDegrees(sexagesimal[0]), ra_deg)).toBeLessThanOrEqual(0.0005 * 15 / 3600 + 1e-12);
    expect(Math.abs(parseDecDegrees(decimal[1]) - parseDecDegrees(sexagesimal[1]))).toBeLessThanOrEqual(0.0005 / 3600 + 1e-12);
    expect(decimal).not.toEqual(sexagesimal);
    expect(tile.ra_deg).toBe(ra_deg);
  });

  it.each([0, -0, 24.25, -24.25])("preserves the trusted DEC sign convention for %s", (dec_deg) => {
    const row = readCsv(buildExportCsv([{ ...pointing, dec_deg }], survey({ ...policy, coordinate_format: "sexagesimal" })))[1];
    expect(row[1].startsWith("-")).toBe(dec_deg < 0 || Object.is(dec_deg, -0));
    expect(parseDecDegrees(row[1])).toBe(dec_deg);
  });

  it("maps ID/name/group explicitly without exposing runtime identity or historical grouping", () => {
    const configured = survey({ ...policy, epoch: { column: "EQ", default: "J2000", allowed: ["J2000"] }, position_angle_column: "PA",
      identifiers: { group_column: "COHORT", name_column: "LABEL", id_column: "TARGET" }, constant_fields: { Z: "last" } });
    const tiles = [
      { ...pointing, id: "internal-uuid", name: 'observer,"A"', position_angle_deg: 23, group_id: "PID-secret" },
      { ...pointing, enabled: false },
      { ...pointing, position_angle_deg: -12 },
    ];
    const snapshot = structuredClone(tiles);
    const csv = buildExportCsv(tiles, configured);
    const rows = readCsv(csv);
    expect(rows[0]).toEqual(["ALPHA_J2000", "DELTA_J2000", "EQ", "PA", "TARGET", "LABEL", "COHORT", "Z"]);
    expect(rows[1].slice(4)).toEqual(["PROPOSED_0001", 'observer,"A"', "generic-output", "last"]);
    expect(rows[2].slice(4)).toEqual(["PROPOSED_0003", "PROPOSED_0003", "generic-output", "last"]);
    expect(csv).not.toMatch(/internal-uuid|PID-secret/);
    expect(buildExportCsv(tiles, configured)).toBe(csv);
    expect(tiles).toEqual(snapshot);
  });

  it.each(["id_column", "name_column", "group_column"] as const)("supports %s independently", (column) => {
    const rows = readCsv(buildExportCsv([pointing], survey({ ...policy, identifiers: { [column]: "observer_field" } })));
    expect(rows[0]).toEqual(["ALPHA_J2000", "DELTA_J2000", "observer_field"]);
    expect(rows[1][2]).toBe(column === "group_column" ? "generic-output" : "PROPOSED_0001");
  });

  it("rejects empty/disabled exports, source rows, invalid coordinates and ambiguous policies", () => {
    expect(() => buildExportCsv([], survey())).toThrow(/Enable at least one/);
    expect(() => buildExportCsv([{ ...pointing, enabled: false }], survey())).toThrow(/Enable at least one/);
    expect(() => buildExportCsv([{ ...pointing, source: "original" }], survey())).toThrow(/only proposed/);
    expect(() => buildExportCsv([{ ...pointing, ra_deg: 360 }], survey())).toThrow(/Invalid proposed/);
    expect(() => buildExportCsv([pointing], survey({ ...policy, dec_column: policy.ra_column }))).toThrow(/unique/);
  });

  it("preserves all export settings through strict profile JSON and registration", () => {
    const document = parseProfileJson(JSON.stringify({ ...smallJson, survey: { ...smallJson.survey, export: { ...policy,
      coordinate_format: "sexagesimal", identifiers: { id_column: "target", name_column: "label", group_column: "project" },
      epoch: { column: "equinox", default: "2000", allowed: ["2000"] }, position_angle_column: "pa", constant_fields: { flag: false, number: 42, label_const: 'a,"b"\nc' } } } }));
    const registry = new ProfileRegistry(); registry.registerProfileDocument(parseProfileJson(serializeProfile(document)));
    const tiles = [{ ...pointing, position_angle_deg: 12 }];
    expect(buildExportCsv(tiles, registry.resolveSurveyProfile(document.survey.id))).toBe(buildExportCsv(tiles, document.survey));
    expect(registry.resolveSurveyProfile(document.survey.id).export).toEqual(document.survey.export);
  });
});
