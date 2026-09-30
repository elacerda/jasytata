import { describe, expect, it } from "vitest";
import type { InstrumentProfileV3, ObservingSequenceV3, SurveyProfileV3, TileRecord } from "../types";
import { footprintForTile } from "./footprints";
import { parseProfileJson, serializeProfile, validateProfileDocument } from "./document";
import { ProfileError } from "./errors";
import { ProfileRegistry } from "./registry";
import { deriveEffectiveSequenceFootprint } from "../science/exposure-sequence";
import { DEFAULT_PROFILE } from "./index";
import smallJson from "./fixtures/small-camera.json";
import bundledJson from "./splus-t80-south.json";

const provenance = {
  references: [{ url: "https://example.org/instrument", title: "Instrument specification" }],
  parameter_sources: [{ parameter_path: "footprint.radius_deg", reference_url: "https://example.org/instrument" }],
  assumptions: [],
  limitations: [],
};
const strategyProvenance = {
  references: [{ url: "https://example.org/instrument", title: "Instrument specification" }],
  parameter_sources: [],
  assumptions: [],
  limitations: [],
};

function instrumentV3(patch: Partial<InstrumentProfileV3> = {}): InstrumentProfileV3 {
  return {
    schema_version: 3,
    id: "test-camera-v3",
    display_name: "Test camera v3",
    coordinate_frame: "icrs",
    footprint: { type: "circle", radius_deg: 0.12 },
    footprint_semantics: { role: "observed_area", fidelity: "exact" },
    provenance,
    position_angle: { mode: "not_applicable", required: false },
    ...patch,
  };
}

function surveyV3(patch: Partial<SurveyProfileV3> = {}): SurveyProfileV3 {
  return {
    schema_version: 3,
    id: "test-survey-v3",
    display_name: "Test strategy v3",
    instrument_id: "test-camera-v3",
    tiling: { type: "manual" },
    inference: {
      enabled: false,
      allow_rotation: false,
      spacing_tolerance_fraction: 0.02,
      phase_tolerance_fraction: 0.04,
      occupancy_tolerance_fraction: 0.06,
      min_anchor_tiles: 4,
      min_neighbor_pairs: 3,
    },
    coverage: {
      sampling: { target_samples_per_footprint_axis: 40, max_samples: 20000 },
      efficient: { min_coverage: 0.95, min_marginal_efficiency: 0.01 },
      target_samples_per_footprint_axis: 40,
    },
    coverage_basis_default: "single_exposure",
    export: {
      ra_column: "RA", dec_column: "DEC", coordinate_format: "decimal",
      epoch: { column: "EPOCH", default: "2000", allowed: ["2000"] },
    },
    provenance: strategyProvenance,
    ...patch,
  };
}

const v3InstrumentDocument = { instrument: instrumentV3() };
const v3SurveyDocument = { survey: surveyV3() };
const v3PairDocument = { instrument: instrumentV3(), survey: surveyV3() };

function codeFor(value: unknown): string {
  try {
    validateProfileDocument(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileError);
    return (error as ProfileError).code;
  }
  throw new Error("Expected the profile document to fail validation");
}

describe("selective Schema v3 profile documents", () => {
  it("keeps v2 pair parsing, strict v2 validation, and canonical output unchanged", () => {
    const validated = validateProfileDocument(bundledJson);
    expect(validated).toEqual({ instrument: bundledJson.instrument, survey: bundledJson.survey });
    expect(validated.instrument).not.toHaveProperty("footprint_semantics");
    expect(validated.instrument).not.toHaveProperty("provenance");
    const text = serializeProfile(validated);
    expect(parseProfileJson(text)).toEqual(validated);
    expect(serializeProfile(parseProfileJson(text))).toBe(text);
    expect(codeFor({
      ...smallJson,
      instrument: { ...smallJson.instrument, footprint_semantics: { role: "observed_area", fidelity: "exact" } },
    })).toBe("invalid_structure");
  });

  it("dispatches valid standalone and matching v3 documents without mutating input", () => {
    const raw = structuredClone(v3PairDocument);
    expect(validateProfileDocument(raw)).toEqual(raw);
    expect(raw).toEqual(v3PairDocument);
    expect(validateProfileDocument(v3InstrumentDocument)).toEqual(v3InstrumentDocument);
    expect(validateProfileDocument(v3SurveyDocument)).toEqual(v3SurveyDocument);
    expect(parseProfileJson(serializeProfile(v3InstrumentDocument))).toEqual(v3InstrumentDocument);
    expect(parseProfileJson(serializeProfile(v3SurveyDocument))).toEqual(v3SurveyDocument);
  });

  it("round-trips target-access without assigning it an observed-area default", () => {
    const profile = instrumentV3({
      footprint_semantics: {
        role: "target_access",
        fidelity: "approximate",
        approximation_notice: "Nominal access envelope; it does not represent assigned or observed area.",
      },
      provenance: {
        ...provenance,
        assumptions: ["The envelope is used only to locate potential targets."],
        limitations: ["No fibre assignment or patrol reachability is modeled."],
      },
    });
    const reimported = parseProfileJson(serializeProfile(validateProfileDocument({ instrument: profile })));
    if (!("instrument" in reimported && reimported.instrument?.schema_version === 3)) {
      throw new Error("Expected a standalone Schema v3 instrument document");
    }
    expect(reimported.instrument.footprint_semantics.role).toBe("target_access");
  });

  it("preserves Gate 5 derived exposure geometry through a v3 sequence round trip", () => {
    const instrument = instrumentV3({
      footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.1, position_angle_deg: 30 },
      position_angle: { mode: "fixed", required: true },
      provenance: {
        ...provenance,
        parameter_sources: [
          { parameter_path: "footprint.width_deg", reference_url: "https://example.org/instrument" },
          { parameter_path: "footprint.height_deg", reference_url: "https://example.org/instrument" },
          { parameter_path: "footprint.position_angle_deg", reference_url: "https://example.org/instrument" },
        ],
      },
    });
    const observingSequence: ObservingSequenceV3 = {
      id: "two-step",
      exposures: [
        { order: 1, east_arcsec: -2, north_arcsec: 0, rotation_deg: 0 },
        { order: 2, east_arcsec: 2, north_arcsec: 1, rotation_deg: 15 },
      ],
    };
    const survey = surveyV3({
      coverage_basis_default: "effective_sequence",
      observing_sequence: observingSequence,
      provenance: {
        ...strategyProvenance,
        parameter_sources: observingSequence.exposures.flatMap((_, index) => [
          { parameter_path: `observing_sequence.exposures[${index}].east_arcsec`, reference_url: "https://example.org/instrument" },
          { parameter_path: `observing_sequence.exposures[${index}].north_arcsec`, reference_url: "https://example.org/instrument" },
          { parameter_path: `observing_sequence.exposures[${index}].rotation_deg`, reference_url: "https://example.org/instrument" },
        ]),
      },
    });
    const document = { instrument, survey };
    const validated = validateProfileDocument(document);
    const serialized = serializeProfile(validated);
    const reimported = parseProfileJson(serialized);
    if (!("instrument" in reimported && reimported.instrument?.schema_version === 3 &&
      "survey" in reimported && reimported.survey?.schema_version === 3)) {
      throw new Error("Expected a matching Schema v3 document pair");
    }
    const pointing = { id: "pointing-1", center: { ra_deg: 150, dec_deg: -30 }, positionAngleDeg: 30 };
    const before = deriveEffectiveSequenceFootprint(pointing, instrument.footprint, observingSequence);
    const after = deriveEffectiveSequenceFootprint(pointing, reimported.instrument.footprint, reimported.survey.observing_sequence);
    expect(reimported.survey.observing_sequence).toEqual(observingSequence);
    expect(after).toEqual(before);
    expect(serializeProfile(reimported)).toBe(serialized);
  });

  it("rejects unknown versions, incomplete v2 documents, mixed pairs, and dangling pair IDs", () => {
    expect(codeFor({ instrument: { ...instrumentV3(), schema_version: 4 } })).toBe("unsupported_schema");
    expect(codeFor({ instrument: smallJson.instrument })).toBe("invalid_structure");
    expect(codeFor({ instrument: instrumentV3(), survey: smallJson.survey })).toBe("invalid_structure");
    expect(codeFor({ instrument: instrumentV3(), survey: surveyV3({ instrument_id: "other-camera" }) })).toBe("unresolved_reference");
    expect(codeFor({ instrument: instrumentV3(), survey: surveyV3(), unexpected: true })).toBe("invalid_structure");
  });

  it("rejects unknown fields inside v3 profiles and their new nested structures", () => {
    expect(codeFor({ instrument: { ...instrumentV3(), unknown_field: true } })).toBe("invalid_structure");
    expect(codeFor({ instrument: { ...instrumentV3(), provenance: { ...provenance, unknown_field: true } } })).toBe("invalid_structure");
    expect(codeFor({ instrument: { ...instrumentV3(), footprint_semantics: { role: "observed_area", fidelity: "exact", unknown_field: true } } })).toBe("invalid_structure");
    expect(codeFor({ instrument: { ...instrumentV3(), position_angle: { mode: "not_applicable", required: false, angle_deg: 0 } } })).toBe("invalid_structure");
    expect(codeFor({ survey: { ...surveyV3(), unknown_field: true } })).toBe("invalid_structure");
    expect(codeFor({ survey: { ...surveyV3(), observing_sequence: { id: "dither", exposures: [{ order: 1, east_arcsec: 0, north_arcsec: 0 }], unknown_field: true } } })).toBe("invalid_structure");
  });
});

describe("Schema v3 profile registry lifecycle", () => {
  it("round-trips an instrument-only profile through registration, retrieval, and export", () => {
    const registry = new ProfileRegistry();
    registry.registerProfileDocument(parseProfileJson(JSON.stringify(v3InstrumentDocument)));
    expect(registry.resolveAnyInstrumentProfile("test-camera-v3")).toEqual(instrumentV3());
    expect(registry.listAnyInstrumentProfiles()).toEqual([instrumentV3()]);
    const retrieved = registry.resolveInstrumentProfileDocument("test-camera-v3");
    const text = serializeProfile(retrieved);
    expect(parseProfileJson(text)).toEqual(v3InstrumentDocument);

    const sourceTile: TileRecord = {
      id: "source", name: "Source", ra_deg: 150, dec_deg: -30, source: "original",
      generation_method: null, original_values: null, metadata: {}, instrument_profile_id: "test-camera-v3",
    };
    expect(footprintForTile(sourceTile, DEFAULT_PROFILE, registry)).toEqual(instrumentV3().footprint);
  });

  it("registers survey-only v3 documents only after a referenced instrument exists", () => {
    const registry = new ProfileRegistry();
    expect(() => registry.registerProfileDocument(v3SurveyDocument)).toThrow(/Unknown instrument profile ID/);
    expect(registry.listAnySurveyProfiles()).toEqual([]);
    registry.registerProfileDocument(v3InstrumentDocument);
    registry.registerProfileDocument(v3SurveyDocument);
    expect(registry.resolveSurveyProfileDocument("test-survey-v3")).toEqual(v3SurveyDocument);
    expect(parseProfileJson(serializeProfile(registry.resolveAnyProfileDocument("test-survey-v3")))).toEqual(v3PairDocument);
  });

  it("keeps survey-only export when a v3 survey references an existing legacy instrument", () => {
    const registry = new ProfileRegistry();
    registry.registerInstrumentProfile(smallJson.instrument);
    registry.registerProfileDocument({ survey: surveyV3({ instrument_id: "small-camera" }) });
    expect(registry.resolveAnyProfileDocument("test-survey-v3")).toEqual({ survey: surveyV3({ instrument_id: "small-camera" }) });
    expect(serializeProfile(registry.resolveAnyProfileDocument("test-survey-v3"))).toContain('"schema_version": 3');
  });

  it("rejects v2 survey to v3 instrument relationships and performs duplicate checks atomically", () => {
    const registry = new ProfileRegistry();
    registry.registerProfileDocument(v3InstrumentDocument);
    const v2Survey = { ...smallJson.survey, instrument_id: "test-camera-v3" };
    expect(() => registry.registerSurveyProfile(v2Survey)).toThrow(/Schema v2 survey/);
    expect(registry.listSurveyProfiles()).toEqual([]);
    expect(() => registry.registerProfileDocument({ instrument: instrumentV3(), survey: surveyV3() })).toThrow(/already registered/);
    expect(registry.listAnySurveyProfiles()).toEqual([]);
  });

  it("rejects nonzero relative rotation with a not_applicable instrument PA policy", () => {
    const registry = new ProfileRegistry();
    const sequence = { id: "rotated", exposures: [
      { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 15 },
    ] };
    registry.registerProfileDocument(v3InstrumentDocument);
    expect(() => registry.registerSurveyProfileV3(surveyV3({
      observing_sequence: sequence,
      coverage_basis_default: "effective_sequence",
      provenance: {
        ...strategyProvenance,
        parameter_sources: [
          { parameter_path: "observing_sequence.exposures[0].east_arcsec", reference_url: "https://example.org/instrument" },
          { parameter_path: "observing_sequence.exposures[0].north_arcsec", reference_url: "https://example.org/instrument" },
          { parameter_path: "observing_sequence.exposures[0].rotation_deg", reference_url: "https://example.org/instrument" },
        ],
      },
    }))).toThrow(/requires a declared pointing PA/);
  });
});
