import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "./index";
import {
  adaptT80SplusV2ToV1,
  SPLUS_SURVEY_V2,
  T80_SOUTH_INSTRUMENT_V2,
  validateInstrumentProfileV2,
  validateSurveyProfileV2,
} from "./index";

function instrumentWithFootprint(footprint: unknown): unknown {
  return { ...T80_SOUTH_INSTRUMENT_V2, footprint };
}

function surveyWith(patch: Record<string, unknown>): unknown {
  return { ...SPLUS_SURVEY_V2, ...patch };
}

function surveyWithExport(exportPolicy: unknown): unknown {
  return { ...SPLUS_SURVEY_V2, export: exportPolicy };
}

function surveyWithInference(inference: unknown): unknown {
  return { ...SPLUS_SURVEY_V2, inference };
}

function surveyWithCoverage(coverage: unknown): unknown {
  return { ...SPLUS_SURVEY_V2, coverage };
}

describe("Profile Schema v2", () => {
  it("validates the bundled T80 instrument profile", () => {
    expect(validateInstrumentProfileV2(T80_SOUTH_INSTRUMENT_V2)).toEqual(T80_SOUTH_INSTRUMENT_V2);
  });

  it("validates the bundled S-PLUS survey profile", () => {
    expect(validateSurveyProfileV2(SPLUS_SURVEY_V2)).toEqual(SPLUS_SURVEY_V2);
  });

  it("validates profile IDs, display names, and the ICRS instrument frame", () => {
    expect(() => validateInstrumentProfileV2({ ...T80_SOUTH_INSTRUMENT_V2, id: "T80" })).toThrow(/identifier/);
    expect(() => validateSurveyProfileV2({ ...SPLUS_SURVEY_V2, id: "" })).toThrow(/identifier/);
    expect(() => validateInstrumentProfileV2({ ...T80_SOUTH_INSTRUMENT_V2, display_name: "  " })).toThrow(/display name/);
    expect(() => validateInstrumentProfileV2({ ...T80_SOUTH_INSTRUMENT_V2, coordinate_frame: "galactic" })).toThrow(/icrs/);
  });

  it("adapts the bundled v2 pair to the exact current DEFAULT_PROFILE", () => {
    expect(adaptT80SplusV2ToV1(T80_SOUTH_INSTRUMENT_V2, SPLUS_SURVEY_V2)).toEqual(DEFAULT_PROFILE);
    expect(adaptT80SplusV2ToV1(T80_SOUTH_INSTRUMENT_V2, SPLUS_SURVEY_V2)).not.toBe(DEFAULT_PROFILE);
  });

  it("round-trips the instrument and survey through JSON and schema validation", () => {
    const instrument = JSON.parse(JSON.stringify(T80_SOUTH_INSTRUMENT_V2)) as unknown;
    const survey = JSON.parse(JSON.stringify(SPLUS_SURVEY_V2)) as unknown;
    expect(validateInstrumentProfileV2(instrument)).toEqual(T80_SOUTH_INSTRUMENT_V2);
    expect(validateSurveyProfileV2(survey)).toEqual(SPLUS_SURVEY_V2);
  });

  it("validates rectangle dimensions and optional position angle", () => {
    const rectangle = { type: "rectangle", width_deg: 2, height_deg: 1.5, position_angle_deg: -30 };
    expect(validateInstrumentProfileV2(instrumentWithFootprint(rectangle)).footprint).toEqual(rectangle);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ ...rectangle, width_deg: 0 }))).toThrow(/width/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ ...rectangle, height_deg: 181 }))).toThrow(/height/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ ...rectangle, width_deg: Number.POSITIVE_INFINITY }))).toThrow(/finite/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ ...rectangle, position_angle_deg: Number.NaN }))).toThrow(/finite/);
  });

  it("validates circle radius and its angular bound", () => {
    expect(validateInstrumentProfileV2(instrumentWithFootprint({ type: "circle", radius_deg: 0.75 })).footprint)
      .toEqual({ type: "circle", radius_deg: 0.75 });
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "circle", radius_deg: 0 }))).toThrow(/radius/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "circle", radius_deg: 91 }))).toThrow(/radius/);
  });

  it("validates polygon vertices, area, uniqueness, and simple boundaries", () => {
    const square = { type: "polygon", vertices_deg: [[-1, -1], [1, -1], [1, 1], [-1, 1]], position_angle_deg: 10 };
    expect(validateInstrumentProfileV2(instrumentWithFootprint(square)).footprint).toEqual(square);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "polygon", vertices_deg: [[0, 0], [1, 1]] }))).toThrow(/three vertices/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "polygon", vertices_deg: [[0, 0], [1, 0], [2, 0]] }))).toThrow(/area/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "polygon", vertices_deg: [[0, 0], [3, 2], [0, 3], [2, 0]] }))).toThrow(/self-intersect/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "polygon", vertices_deg: [[0, 0], [1, 0], [1, 1], [0, 0]] }))).toThrow(/distinct/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "polygon", vertices_deg: [[0, 0], [1, 0], [0, Number.NaN]] }))).toThrow(/finite/);
  });

  it("validates compound children and rejects empty or nested compounds", () => {
    const mosaic = {
      type: "compound",
      position_angle_deg: 10,
      components: [
        { offset_deg: [-0.5, 0], rotation_deg: 15, footprint: { type: "rectangle", width_deg: 1, height_deg: 1 } },
        { offset_deg: [0.5, 0], footprint: { type: "circle", radius_deg: 0.4 } },
      ],
    };
    expect(validateInstrumentProfileV2(instrumentWithFootprint(mosaic)).footprint).toEqual(mosaic);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ ...mosaic, position_angle_deg: Number.NaN }))).toThrow(/finite/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "compound", components: [] }))).toThrow(/at least one/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({
      type: "compound", components: [{ offset_deg: [0, 0], footprint: { type: "compound", components: [] } }],
    }))).toThrow(/Unknown or unsupported footprint type/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({
      type: "compound", components: [{ offset_deg: [Number.NaN, 0], footprint: { type: "circle", radius_deg: 1 } }],
    }))).toThrow(/finite/);
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({
      type: "compound", components: [{ offset_deg: [0, 0], rotation_deg: Number.NaN, footprint: { type: "circle", radius_deg: 1 } }],
    }))).toThrow(/finite/);
  });

  it("validates independent lattice basis vectors and explicit origins", () => {
    const lattice = {
      type: "lattice", basis_deg: [[1, 0], [0.5, 0.8]], origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: -30 },
    };
    expect(validateSurveyProfileV2(surveyWith({ tiling: lattice })).tiling).toEqual(lattice);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...lattice, basis_deg: [[0, 0], [1, 1]] } }))).toThrow(/non-zero/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...lattice, basis_deg: [[1, 1], [2, 2]] } }))).toThrow(/collinear/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...lattice, basis_deg: [[1, 0], [0, Number.POSITIVE_INFINITY]] } }))).toThrow(/finite/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...lattice, origin: { type: "unknown" } } }))).toThrow(/origin type/);
  });

  it("rejects redundant lattice angle/old origin fields and validates fixed ICRS anchors", () => {
    const lattice = { type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "region_center" } };
    const validate = (tiling: unknown) => validateSurveyProfileV2(surveyWith({ tiling }));
    expect(validate(lattice).tiling).toEqual(lattice);
    expect(() => validate({ ...lattice, position_angle_deg: 0 })).toThrow(/remove position_angle_deg/);
    expect(() => validate({ ...lattice, origin_policy: "region_center" })).toThrow(/origin_policy/);
    expect(() => validate({ ...lattice, origin: undefined })).toThrow(/origin/);
    for (const [ra, dec] of [[-1, 0], [360, 0], [0, -90], [0, 90]]) {
      expect(() => validate({ ...lattice, origin: { type: "fixed_anchor", ra_deg: ra, dec_deg: dec } })).toThrow(/anchor/);
    }
    expect(() => validate({ ...lattice, origin: { type: "fixed_anchor", ra_deg: 0, dec_deg: Number.NaN } })).toThrow(/finite/);
    const fixed = { ...lattice, origin: { type: "fixed_anchor", ra_deg: 0, dec_deg: -89 } };
    expect(validate(JSON.parse(JSON.stringify(fixed))).tiling).toEqual(fixed);
    expect(validate({ type: "manual" }).tiling).toEqual({ type: "manual" });
  });

  it("validates profile-supplied legacy overlap without hidden defaults", () => {
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { type: "legacy_splus" } }))).toThrow(/finite/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { type: "legacy_splus", effective_overlap_arcsec: -1 } }))).toThrow(/non-negative/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { type: "legacy_splus", effective_overlap_arcsec: Infinity } }))).toThrow(/finite/);
    const legacy = { type: "legacy_splus", grid_extent_deg: [1, 2], effective_overlap_arcsec: 0 };
    expect(validateSurveyProfileV2(surveyWith({ tiling: legacy })).tiling).toEqual(legacy);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...legacy, grid_extent_deg: [0, 2] } }))).toThrow(/dimensions/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...legacy, grid_extent_deg: [1, Infinity] } }))).toThrow(/finite/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { ...legacy, effective_overlap_arcsec: 3600 } }))).toThrow(/overlap/);
  });

  it("rejects invalid inference fractions and evidence counts", () => {
    const baseline = SPLUS_SURVEY_V2.inference;
    expect(() => validateSurveyProfileV2(surveyWithInference({ ...baseline, spacing_tolerance_fraction: -0.01 }))).toThrow(/fraction/);
    expect(() => validateSurveyProfileV2(surveyWithInference({ ...baseline, phase_tolerance_fraction: 1.01 }))).toThrow(/fraction/);
    expect(() => validateSurveyProfileV2(surveyWithInference({ ...baseline, occupancy_tolerance_fraction: Number.NaN }))).toThrow(/finite/);
    expect(() => validateSurveyProfileV2(surveyWithInference({ ...baseline, min_anchor_tiles: 0 }))).toThrow(/positive integer/);
    expect(() => validateSurveyProfileV2(surveyWithInference({ ...baseline, min_neighbor_pairs: 1.5 }))).toThrow(/positive integer/);
    expect(() => validateSurveyProfileV2(surveyWithInference({ ...baseline, enabled: "yes" }))).toThrow(/boolean/);
  });

  it("rejects invalid coverage sampling limits and Efficient thresholds", () => {
    const baseline = SPLUS_SURVEY_V2.coverage;
    expect(() => validateSurveyProfileV2(surveyWithCoverage({ ...baseline, sampling: { ...baseline.sampling, target_samples_per_footprint_axis: 0 } }))).toThrow(/positive integer/);
    expect(() => validateSurveyProfileV2(surveyWithCoverage({ ...baseline, sampling: { ...baseline.sampling, max_samples: 0 } }))).toThrow(/positive finite integer/);
    expect(() => validateSurveyProfileV2(surveyWithCoverage({ ...baseline, sampling: { ...baseline.sampling, max_samples: Number.POSITIVE_INFINITY } }))).toThrow(/finite/);
    expect(() => validateSurveyProfileV2(surveyWithCoverage({ ...baseline, efficient: { min_coverage: 1.01, min_marginal_efficiency: 0.03 } }))).toThrow(/minimum coverage/);
    expect(() => validateSurveyProfileV2(surveyWithCoverage({ ...baseline, efficient: { min_coverage: 0.99, min_marginal_efficiency: -0.1 } }))).toThrow(/marginal efficiency/);
  });

  it("rejects export column collisions and invalid epoch defaults", () => {
    const baseline = SPLUS_SURVEY_V2.export;
    expect(() => validateSurveyProfileV2(surveyWithExport({ ...baseline, dec_column: "RA" }))).toThrow(/unique/);
    expect(() => validateSurveyProfileV2(surveyWithExport({ ...baseline, epoch: { ...baseline.epoch!, column: "RA" } }))).toThrow(/unique/);
    expect(() => validateSurveyProfileV2(surveyWithExport({ ...baseline, position_angle_column: "EPOCH" }))).toThrow(/unique/);
    expect(() => validateSurveyProfileV2(surveyWithExport({ ...baseline, constant_fields: { EPOCH: "fixed" } }))).toThrow(/unique/);
    expect(() => validateSurveyProfileV2(surveyWithExport({ ...baseline, epoch: { ...baseline.epoch!, default: "2050" } }))).toThrow(/allowed values/);
    expect(() => validateSurveyProfileV2(surveyWithExport({ ...baseline, ra_column: "  " }))).toThrow(/non-empty/);
  });

  it("rejects schema versions other than 2", () => {
    expect(() => validateInstrumentProfileV2({ ...T80_SOUTH_INSTRUMENT_V2, schema_version: 1 })).toThrow(/schema_version/);
    expect(() => validateSurveyProfileV2({ ...SPLUS_SURVEY_V2, schema_version: 3 })).toThrow(/schema_version/);
  });

  it("rejects unknown footprint and tiling discriminants", () => {
    expect(() => validateInstrumentProfileV2(instrumentWithFootprint({ type: "ellipse", major_deg: 2, minor_deg: 1 }))).toThrow(/Unknown or unsupported footprint type/);
    expect(() => validateSurveyProfileV2(surveyWith({ tiling: { type: "hexagonal" } }))).toThrow(/Unknown tiling model type/);
  });
});
