import { describe, expect, it } from "vitest";
import { SPLUS_SURVEY_V2 } from "./v2";
import { validateInstrumentProfileV3, validateProfileReferenceV3, validateSurveyProfileV3 } from "./schema-v3";

const source = { references: [{ url: "https://example.org/paper", title: "Instrument paper" }], assumptions: [], limitations: [] };

function instrument() {
  return {
    schema_version: 3,
    id: "test-camera",
    display_name: "Test camera",
    coordinate_frame: "icrs",
    footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.1, position_angle_deg: 0 },
    footprint_semantics: { role: "observed_area", fidelity: "exact" },
    provenance: {
      ...structuredClone(source),
      parameter_sources: [
        { parameter_path: "footprint.width_deg", reference_url: "https://example.org/paper" },
        { parameter_path: "footprint.height_deg", reference_url: "https://example.org/paper" },
        { parameter_path: "footprint.position_angle_deg", reference_url: "https://example.org/paper" },
      ],
    },
    position_angle: { mode: "fixed", required: true },
  };
}

function survey() {
  const legacy = structuredClone(SPLUS_SURVEY_V2);
  return {
    ...legacy,
    schema_version: 3,
    instrument_id: "test-camera",
    coverage: {
      ...legacy.coverage,
      target_samples_per_footprint_axis: legacy.coverage.sampling.target_samples_per_footprint_axis,
    },
    coverage_basis_default: "single_exposure",
    provenance: {
      ...structuredClone(source),
      parameter_sources: [
        { parameter_path: "tiling.grid_extent_deg", reference_url: "https://example.org/paper" },
        { parameter_path: "tiling.effective_overlap_arcsec", reference_url: "https://example.org/paper" },
      ],
    },
  };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected test object");
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected test array");
  return value;
}

describe("strict Schema v3 validators", () => {
  it("validates and copies explicit instrument and survey semantics", () => {
    const rawInstrument = instrument();
    const rawSurvey = survey();
    const checkedInstrument = validateInstrumentProfileV3(rawInstrument);
    const checkedSurvey = validateSurveyProfileV3(rawSurvey);
    expect(checkedInstrument.footprint_semantics).toEqual({ role: "observed_area", fidelity: "exact" });
    expect(checkedInstrument.position_angle).toEqual({ mode: "fixed", required: true });
    expect(checkedSurvey.coverage_basis_default).toBe("single_exposure");
    expect(checkedSurvey.provenance.parameter_sources).toHaveLength(2);
    expect(checkedInstrument).not.toBe(rawInstrument);
    expect(rawInstrument.schema_version).toBe(3);
  });

  it("requires sourced, contiguous exposure geometry and matching coverage density", () => {
    const raw = mutableRecord(structuredClone(survey()));
    raw.coverage_basis_default = "effective_sequence";
    raw.observing_sequence = {
      id: "two-step",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 2 },
        { order: 2, east_arcsec: 1, north_arcsec: 0, rotation_deg: 15 },
      ],
    };
    const provenance = mutableRecord(raw.provenance);
    mutableArray(provenance.parameter_sources).push(
      { parameter_path: "observing_sequence.exposures[0].east_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[0].north_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[1].east_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[1].north_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[1].rotation_deg", reference_url: "https://example.org/paper" },
    );
    expect(validateSurveyProfileV3(raw).observing_sequence?.exposures.map(({ order }) => order)).toEqual([1, 2]);
    const coverage = mutableRecord(raw.coverage);
    coverage.target_samples_per_footprint_axis = Number(coverage.target_samples_per_footprint_axis) + 1;
    expect(() => validateSurveyProfileV3(raw)).toThrow(/must match/);
  });

  it("requires provenance for lattice basis and both origin forms", () => {
    const raw = mutableRecord(structuredClone(survey()));
    raw.tiling = { type: "lattice", basis_deg: [[0.2, 0], [0, 0.1]], origin: { type: "region_center" } };
    const provenance = mutableRecord(raw.provenance);
    provenance.parameter_sources = [
      { parameter_path: "tiling.basis_deg", reference_url: "https://example.org/paper" },
      { parameter_path: "tiling.origin.type", reference_url: "https://example.org/paper" },
    ];
    expect(validateSurveyProfileV3(raw).tiling.type).toBe("lattice");
    mutableRecord(raw.tiling).origin = { type: "fixed_anchor", ra_deg: 12, dec_deg: -3 };
    mutableArray(provenance.parameter_sources).push(
      { parameter_path: "tiling.origin.ra_deg", reference_url: "https://example.org/paper" },
      { parameter_path: "tiling.origin.dec_deg", reference_url: "https://example.org/paper" },
    );
    expect(validateSurveyProfileV3(raw).tiling.type).toBe("lattice");
  });

  it("rejects unknown fields and missing scientific classifications or sources", () => {
    const badInstrument = mutableRecord(structuredClone(instrument()));
    mutableRecord(badInstrument.footprint_semantics).role = "unclassified";
    expect(() => validateInstrumentProfileV3(badInstrument)).toThrow(/footprint role/);
    const unknownSurvey = mutableRecord(structuredClone(survey()));
    mutableRecord(unknownSurvey.provenance).new_field = true;
    expect(() => validateSurveyProfileV3(unknownSurvey)).toThrow(/unsupported field/);
    const uncovered = mutableRecord(structuredClone(instrument()));
    mutableArray(mutableRecord(uncovered.provenance).parameter_sources).pop();
    expect(() => validateInstrumentProfileV3(uncovered)).toThrow(/missing a source/);
  });

  it("validates URL and DOI references without accepting arbitrary keys", () => {
    expect(validateProfileReferenceV3({ doi: "10.1234/Example" })).toEqual({ doi: "10.1234/example" });
    expect(validateProfileReferenceV3({ url: "HTTPS://Example.org:443/reference" })).toEqual({ url: "https://example.org/reference" });
    expect(() => validateProfileReferenceV3({ doi: "not-a-doi" })).toThrow(/DOI/);
    expect(() => validateProfileReferenceV3({ url: "https://example.org", extra: true })).toThrow(/unsupported field/);
    const invalidSource = mutableRecord(structuredClone(instrument()));
    const source = mutableArray(mutableRecord(invalidSource.provenance).parameter_sources)[0];
    mutableRecord(source).unexpected = "discard me";
    expect(() => validateInstrumentProfileV3(invalidSource)).toThrow(/parameter source.*unsupported field/i);
  });

  it("canonicalizes reference locators and orders unordered provenance deterministically", () => {
    const raw = mutableRecord(structuredClone(instrument()));
    const provenance = mutableRecord(raw.provenance);
    provenance.references = [
      { doi: "10.1234/Zulu" },
      { url: "HTTPS://Example.org:443/reference" },
    ];
    provenance.parameter_sources = [
      { parameter_path: "footprint.width_deg", reference_doi: "10.1234/zulu" },
      { parameter_path: "footprint.height_deg", reference_url: "https://example.org/reference" },
      { parameter_path: "footprint.position_angle_deg", reference_url: "https://example.org/reference" },
    ];
    const reversed = structuredClone(raw);
    const reversedProvenance = mutableRecord(reversed.provenance);
    mutableArray(reversedProvenance.references).reverse();
    mutableArray(reversedProvenance.parameter_sources).reverse();

    const first = validateInstrumentProfileV3(raw).provenance;
    const second = validateInstrumentProfileV3(reversed).provenance;
    expect(second).toEqual(first);
    expect(first.references).toEqual([
      { doi: "10.1234/zulu" },
      { url: "https://example.org/reference" },
    ]);
    expect(first.parameter_sources.map(({ parameter_path }) => parameter_path)).toEqual([
      "footprint.height_deg",
      "footprint.position_angle_deg",
      "footprint.width_deg",
    ]);
  });

  it.each([
    ["observed_area", "exact"],
    ["observed_area", "approximate"],
    ["nominal_envelope", "exact"],
    ["nominal_envelope", "approximate"],
    ["target_access", "exact"],
    ["target_access", "approximate"],
  ] as const)("accepts the frozen %s/%s footprint classification", (role, fidelity) => {
    const raw = mutableRecord(structuredClone(instrument()));
    raw.footprint_semantics = {
      role,
      fidelity,
      ...((role !== "observed_area" || fidelity === "approximate")
        ? { approximation_notice: "Declared planning boundary and its scientific limits." }
        : {}),
    };
    if (role !== "observed_area" || fidelity === "approximate") {
      const provenance = mutableRecord(raw.provenance);
      provenance.assumptions = ["The declared profile geometry is used for this planning purpose."];
      provenance.limitations = ["The model does not add unmeasured detector or allocation detail."];
    }
    expect(validateInstrumentProfileV3(raw).footprint_semantics).toMatchObject({ role, fidelity });
  });

  it("accepts all supported PA policies and rejects contradictions and non-finite angles", () => {
    const base = mutableRecord(structuredClone(instrument()));
    expect(validateInstrumentProfileV3({
      ...base,
      position_angle: { mode: "fixed", required: true },
    }).position_angle.mode).toBe("fixed");
    expect(validateInstrumentProfileV3({
      ...base,
      position_angle: { mode: "per_pointing", required: true },
    }).position_angle.mode).toBe("per_pointing");
    expect(validateInstrumentProfileV3({
      ...base,
      position_angle: { mode: "user_selected", required: true },
    }).position_angle.mode).toBe("user_selected");

    const circle = {
      ...base,
      footprint: { type: "circle", radius_deg: 0.1 },
      provenance: {
        ...structuredClone(source),
        parameter_sources: [{ parameter_path: "footprint.radius_deg", reference_url: "https://example.org/paper" }],
      },
      position_angle: { mode: "not_applicable", required: false },
    };
    expect(validateInstrumentProfileV3(circle).position_angle.mode).toBe("not_applicable");
    expect(() => validateInstrumentProfileV3({ ...base, position_angle: { mode: "fixed", required: false } })).toThrow(/Fixed position-angle policy/);
    expect(() => validateInstrumentProfileV3({ ...base, position_angle: { mode: "per_pointing", required: "yes" } })).toThrow(/required must be a boolean/);
    expect(() => validateInstrumentProfileV3({ ...base, position_angle: { mode: "unknown", required: false } })).toThrow(/Invalid position-angle mode/);
    expect(() => validateInstrumentProfileV3({ ...base, footprint: { ...mutableRecord(base.footprint), position_angle_deg: Number.NaN } })).toThrow(/finite/);
    expect(() => validateInstrumentProfileV3({ ...circle, position_angle: { mode: "not_applicable", required: true } })).toThrow(/forbids profile PA and required=true/);
  });

  it("requires finite sequence geometry and contiguous deterministic order", () => {
    const raw = mutableRecord(structuredClone(survey()));
    const sequence = {
      id: "two-step",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 1 },
        { order: 2, east_arcsec: 2, north_arcsec: 0, rotation_deg: 15 },
      ],
    };
    raw.coverage_basis_default = "effective_sequence";
    raw.observing_sequence = sequence;
    const provenance = mutableRecord(raw.provenance);
    provenance.parameter_sources = [
      { parameter_path: "tiling.grid_extent_deg", reference_url: "https://example.org/paper" },
      { parameter_path: "tiling.effective_overlap_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[0].east_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[0].north_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[1].east_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[1].north_arcsec", reference_url: "https://example.org/paper" },
      { parameter_path: "observing_sequence.exposures[1].rotation_deg", reference_url: "https://example.org/paper" },
    ];
    expect(validateSurveyProfileV3(raw).observing_sequence?.exposures).toEqual(sequence.exposures);

    const nonFiniteOffset = structuredClone(raw);
    mutableRecord(mutableArray(mutableRecord(nonFiniteOffset.observing_sequence).exposures)[0]).east_arcsec = Number.NaN;
    expect(() => validateSurveyProfileV3(nonFiniteOffset)).toThrow(/east offset must be finite/);
    const nonFiniteRotation = structuredClone(raw);
    mutableRecord(mutableArray(mutableRecord(nonFiniteRotation.observing_sequence).exposures)[1]).rotation_deg = Number.POSITIVE_INFINITY;
    expect(() => validateSurveyProfileV3(nonFiniteRotation)).toThrow(/relative rotation must be finite/);
    const duplicateOrder = structuredClone(raw);
    mutableRecord(mutableArray(mutableRecord(duplicateOrder.observing_sequence).exposures)[1]).order = 1;
    expect(() => validateSurveyProfileV3(duplicateOrder)).toThrow(/contiguous, and 1-based/);
  });

  it("requires explicit approximation disclosures and PA semantics", () => {
    const unsupportedAbsent = mutableRecord(structuredClone(instrument()));
    mutableRecord(unsupportedAbsent.footprint).position_angle_deg = undefined;
    mutableArray(mutableRecord(unsupportedAbsent.provenance).parameter_sources).pop();
    unsupportedAbsent.position_angle = { mode: "not_applicable", required: false };
    expect(() => validateInstrumentProfileV3(unsupportedAbsent)).toThrow(/rotationally invariant geometry/);

    const raw = mutableRecord(structuredClone(instrument()));
    raw.footprint_semantics = { role: "nominal_envelope", fidelity: "approximate" };
    expect(() => validateInstrumentProfileV3(raw)).toThrow(/approximation_notice/);
    mutableRecord(raw.footprint_semantics).approximation_notice = "A nominal boundary that includes inactive detector regions and omits physical camera orientation.";
    expect(() => validateInstrumentProfileV3(raw)).toThrow(/assumptions and limitations/);
    const provenance = mutableRecord(raw.provenance);
    provenance.assumptions = ["Nominal envelope is used for layout."];
    provenance.limitations = ["Not an active area measurement."];
    mutableRecord(raw.footprint).position_angle_deg = undefined;
    mutableArray(provenance.parameter_sources).pop();
    raw.position_angle = { mode: "not_applicable", required: false };
    expect(validateInstrumentProfileV3(raw).position_angle).toEqual({ mode: "not_applicable", required: false });
  });
});
