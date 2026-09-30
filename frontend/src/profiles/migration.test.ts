import { describe, expect, it } from "vitest";
import type {
  FootprintSemanticsV3,
  ObservingSequenceV3,
  PersistedPositionAnglePolicyV3,
  ProfileProvenanceV3,
} from "../types";
import { SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "./v2";
import { migrateV2InstrumentToV3, migrateV2SurveyToV3 } from "./migration";
import { validatePlacementProvenance, placementProvenanceFromV2 } from "./placement-provenance";

const instrumentV2 = {
  schema_version: 2,
  id: "test-camera",
  display_name: "Test camera",
  coordinate_frame: "icrs",
  footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.1 },
} as const;

const surveyV2 = {
  schema_version: 2,
  id: "test-strategy",
  display_name: "Test strategy",
  instrument_id: "test-camera",
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
  coverage: { sampling: { target_samples_per_footprint_axis: 40, max_samples: 20000 } },
  export: { ra_column: "RA", dec_column: "DEC", coordinate_format: "decimal" },
} as const;

const instrumentSemantics: FootprintSemanticsV3 = { role: "observed_area", fidelity: "exact" };
const anglePolicy: PersistedPositionAnglePolicyV3 = { mode: "per_pointing", required: true };
const references = [{ url: "https://example.org/instrument", title: "Test instrument reference" }];
const instrumentEvidence: ProfileProvenanceV3 = {
  references,
  parameter_sources: [{ parameter_path: "footprint.width_deg", reference_url: references[0].url }, { parameter_path: "footprint.height_deg", reference_url: references[0].url }],
  assumptions: [],
  limitations: [],
};
const surveyEvidence: ProfileProvenanceV3 = {
  references: [{ url: "https://example.org/strategy", title: "Test strategy reference" }],
  parameter_sources: [],
  assumptions: [],
  limitations: [],
};
const sequencedSurveyEvidence: ProfileProvenanceV3 = {
  ...surveyEvidence,
  parameter_sources: [
    { parameter_path: "observing_sequence.exposures[0].east_arcsec", reference_url: "https://example.org/strategy" },
    { parameter_path: "observing_sequence.exposures[0].north_arcsec", reference_url: "https://example.org/strategy" },
    { parameter_path: "observing_sequence.exposures[1].east_arcsec", reference_url: "https://example.org/strategy" },
    { parameter_path: "observing_sequence.exposures[1].north_arcsec", reference_url: "https://example.org/strategy" },
    { parameter_path: "observing_sequence.exposures[1].rotation_deg", reference_url: "https://example.org/strategy" },
  ],
};

describe("explicit v2 to v3 migration", () => {
  it("reports missing instrument semantics without guessing from v2 fields", () => {
    const result = migrateV2InstrumentToV3(instrumentV2);
    expect(result).toEqual({
      status: "incomplete",
      missing: ["footprint_semantics (role and fidelity)", "provenance", "position_angle policy"],
    });
  });

  it("leaves canonical S-PLUS inputs as v2 unless explicit migration is requested", () => {
    const instrumentBefore = JSON.stringify(T80_SOUTH_INSTRUMENT_V2);
    const surveyBefore = JSON.stringify(SPLUS_SURVEY_V2);
    expect(T80_SOUTH_INSTRUMENT_V2.schema_version).toBe(2);
    expect(SPLUS_SURVEY_V2.schema_version).toBe(2);
    expect(migrateV2InstrumentToV3(T80_SOUTH_INSTRUMENT_V2).status).toBe("incomplete");
    expect(migrateV2SurveyToV3(SPLUS_SURVEY_V2).status).toBe("incomplete");
    expect(JSON.stringify(T80_SOUTH_INSTRUMENT_V2)).toBe(instrumentBefore);
    expect(JSON.stringify(SPLUS_SURVEY_V2)).toBe(surveyBefore);
  });

  it("structurally copies footprint values only after semantic choices are provided", () => {
    const result = migrateV2InstrumentToV3(instrumentV2, {
      footprint_semantics: instrumentSemantics,
      provenance: instrumentEvidence,
      position_angle: anglePolicy,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.profile.schema_version).toBe(3);
    expect(result.profile.footprint).toEqual(instrumentV2.footprint);
    expect(result.profile.footprint_semantics).toEqual(instrumentSemantics);
    expect(instrumentV2.schema_version).toBe(2);
  });

  it("requires explicit survey basis, provenance, and sequence presence or absence", () => {
    expect(migrateV2SurveyToV3(surveyV2)).toEqual({
      status: "incomplete",
      missing: ["provenance", "coverage_basis_default", "observing_sequence (supply a sequence or null)"],
    });
  });

  it("lifts unchanged survey policy and preserves the explicit no-sequence decision", () => {
    const result = migrateV2SurveyToV3(surveyV2, {
      provenance: surveyEvidence,
      coverage_basis_default: "single_exposure",
      observing_sequence: null,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.profile.tiling).toEqual(surveyV2.tiling);
    expect(result.profile.inference).toEqual(surveyV2.inference);
    expect(result.profile.export).toEqual(surveyV2.export);
    expect(result.profile.coverage.sampling).toEqual(surveyV2.coverage.sampling);
    expect(result.profile.observing_sequence).toBeUndefined();
  });

  it("keeps a supplied ordered sequence and rejects malformed v2 input", () => {
    const observingSequence: ObservingSequenceV3 = {
      id: "two-step",
      exposures: [
        { order: 1, east_arcsec: -1, north_arcsec: 0 },
        { order: 2, east_arcsec: 1, north_arcsec: 0, rotation_deg: 12 },
      ],
    };
    const result = migrateV2SurveyToV3(surveyV2, {
      provenance: sequencedSurveyEvidence,
      coverage_basis_default: "effective_sequence",
      observing_sequence: observingSequence,
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.profile.observing_sequence).toEqual(observingSequence);
    expect(() => migrateV2InstrumentToV3({ ...instrumentV2, unknown: true }, {
      footprint_semantics: instrumentSemantics,
      provenance: instrumentEvidence,
      position_angle: anglePolicy,
    })).toThrow(/unsupported field/i);
  });
});

describe("pointing placement provenance", () => {
  it.each(["manual", "imported_unverified", "declared_profile_lattice", "local_inference"] as const)(
    "validates %s without fabricating a source reference",
    (origin) => expect(validatePlacementProvenance({ origin })).toEqual({ origin }),
  );

  it("requires and validates an authoritative import source", () => {
    expect(() => validatePlacementProvenance({ origin: "authoritative_import" })).toThrow(/requires source_reference/);
    expect(validatePlacementProvenance({
      origin: "authoritative_import",
      source_reference: { doi: "10.1234/example", title: "Survey data release" },
    })).toEqual({ origin: "authoritative_import", source_reference: { doi: "10.1234/example", title: "Survey data release" } });
    expect(() => validatePlacementProvenance({
      origin: "authoritative_import", source_reference: { doi: "bad" },
    })).toThrow();
  });

  it("rejects authority references for other origins and never classifies v2 implicitly", () => {
    expect(() => validatePlacementProvenance({ origin: "imported_unverified", source_reference: { url: "https://example.org" } })).toThrow(/must not declare/);
    expect(() => validatePlacementProvenance({ origin: "from_filename" })).toThrow(/Unsupported placement origin/);
    expect(placementProvenanceFromV2({ generation_method: "imported_centers" })).toBeUndefined();
  });

  it("rejects unknown placement provenance fields", () => {
    expect(() => validatePlacementProvenance({ origin: "manual", inferred_from_grid: true })).toThrow(/unsupported field/);
  });
});
