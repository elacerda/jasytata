import { measureResolvedCoverage } from "../science/test-support/resolved-coverage";
import { describe, expect, it } from "vitest";
import type { Footprint, SkyPolygon, TileRecord } from "../types";
import { planRegion } from "../science/planner";
import { parseProfileJsonV2, serializeProfile, validateProfileDocumentV2 } from "./document";
import { ProfileError } from "./errors";
import { outputFootprintForProfile } from "./footprints";
import { resolvePlanningProfile } from "./planning";
import { createBundledProfileRegistry, ProfileRegistry } from "./registry";
import bundledJson from "./splus-t80-south.json";
import smallJson from "./fixtures/small-camera.json";

const region: SkyPolygon = { vertices: [
  { ra_deg: 149.8, dec_deg: -30.2 }, { ra_deg: 150.2, dec_deg: -30.2 },
  { ra_deg: 150.2, dec_deg: -29.8 }, { ra_deg: 149.8, dec_deg: -29.8 },
] };

function errorCode(value: unknown): string {
  try { parseProfileJsonV2(typeof value === "string" ? value : JSON.stringify(value)); }
  catch (error) {
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message.length).toBeGreaterThan(10);
    return (error as ProfileError).code;
  }
  throw new Error("Expected an import error");
}

function importedRegistry(value: unknown): ProfileRegistry {
  const registry = new ProfileRegistry();
  registry.registerProfileDocument(parseProfileJsonV2(JSON.stringify(value)));
  return registry;
}

describe("Schema v2 profile file lifecycle", () => {
  it("accepts the bundled T80 document through the shared v2 validators", () => {
    expect(parseProfileJsonV2(JSON.stringify(bundledJson))).toEqual(validateProfileDocumentV2(bundledJson));
    expect(errorCode("{oops")).toBe("invalid_json");
  });

  it("accepts a generic non-T80 document without applying bundled defaults", () => {
    expect(parseProfileJsonV2(JSON.stringify(smallJson))).toEqual(smallJson);
  });

  it.each([
    ["document", "unexpected_document_field", { ...smallJson, unexpected_document_field: true }],
    ["instrument", "allow_rotaton", { ...smallJson, instrument: { ...smallJson.instrument, allow_rotaton: true } }],
    ["footprint", "min_covergae", { ...smallJson, instrument: { ...smallJson.instrument, footprint: { ...smallJson.instrument.footprint, min_covergae: 0.995 } } }],
    ["compound child", "allow_rotaton", { ...smallJson, instrument: { ...smallJson.instrument, footprint: {
      type: "compound", components: [{ offset_deg: [0, 0], footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.1 }, allow_rotaton: true }],
    } } }],
    ["survey", "min_covergae", { ...smallJson, survey: { ...smallJson.survey, min_covergae: 0.995 } }],
    ["inference", "allow_rotaton", { ...smallJson, survey: { ...smallJson.survey, inference: { ...smallJson.survey.inference, allow_rotaton: false } } }],
    ["coverage", "min_covergae", { ...smallJson, survey: { ...smallJson.survey, coverage: { ...smallJson.survey.coverage, min_covergae: 0.995 } } }],
    ["coverage sampling", "target_samples_per_footprint_axix", { ...smallJson, survey: { ...smallJson.survey, coverage: { ...smallJson.survey.coverage, sampling: { ...smallJson.survey.coverage.sampling, target_samples_per_footprint_axix: 140 } } } }],
    ["Efficient policy", "min_covergae", { ...smallJson, survey: { ...smallJson.survey, coverage: { ...smallJson.survey.coverage, efficient: { ...smallJson.survey.coverage.efficient, min_covergae: 0.995 } } } }],
    ["tiling", "unexpected_tiling_field", { ...smallJson, survey: { ...smallJson.survey, tiling: { ...smallJson.survey.tiling, unexpected_tiling_field: true } } }],
    ["lattice origin", "unexpected_origin_field", { ...smallJson, survey: { ...smallJson.survey, tiling: { ...smallJson.survey.tiling, origin: { ...smallJson.survey.tiling.origin, unexpected_origin_field: true } } } }],
    ["export", "coordinate_formatt", { ...smallJson, survey: { ...smallJson.survey, export: { ...smallJson.survey.export, coordinate_formatt: "decimal" } } }],
    ["export epoch", "default_epoch", { ...smallJson, survey: { ...smallJson.survey, export: { ...smallJson.survey.export, epoch: { ...smallJson.survey.export.epoch, default_epoch: "2000" } } } }],
  ] as const)("rejects the unknown %s field", (_location, field, value) => {
    const validate = () => parseProfileJsonV2(JSON.stringify(value));
    expect(validate).toThrow(/unsupported field/i);
    expect(validate).toThrow(new RegExp(field));
  });

  it.each([3, 1, undefined, "2"])("rejects unsupported/absent schema_version %s", (schema_version) => {
    expect(errorCode({ ...smallJson, instrument: { ...smallJson.instrument, schema_version } })).toBe("unsupported_schema");
    expect(errorCode({ ...smallJson, survey: { ...smallJson.survey, schema_version } })).toBe("unsupported_schema");
  });

  it.each([null, [], 42, {}, smallJson.instrument, { instrument: smallJson.instrument }])("rejects wrong document structure %j", (value) => {
    expect(errorCode(value)).toBe("invalid_structure");
  });

  it.each([
    { type: "rectangle", width_deg: 0, height_deg: 1 },
    { type: "rectangle", width_deg: "1", height_deg: 1 },
    { type: "circle", radius_deg: -1 },
    { type: "polygon", vertices_deg: [[0, 0], [1, 0], [2, 0]] },
    { type: "compound", components: [] },
  ])("rejects invalid geometry %j", (footprint) => {
    expect(errorCode({ ...smallJson, instrument: { ...smallJson.instrument, footprint } })).toBe("invalid_geometry");
  });

  it.each([
    { type: "lattice", basis_deg: [[1, 0], [2, 0]], origin: { type: "region_center" } },
    { type: "lattice", basis_deg: [[0, 0], [0, 1]], origin: { type: "region_center" } },
    { ...smallJson.survey.tiling, origin: { type: "fixed_anchor", ra_deg: 360, dec_deg: 0 } },
    { type: "legacy_splus", grid_extent_deg: [1, 1], effective_overlap_arcsec: 3600 },
  ])("rejects invalid tiling %j", (tiling) => {
    expect(errorCode({ ...smallJson, survey: { ...smallJson.survey, tiling } })).toBe("invalid_tiling");
  });

  it.each([
    { coverage: { sampling: { target_samples_per_footprint_axis: 0, max_samples: 100 } } },
    { coverage: { ...smallJson.survey.coverage, efficient: { min_coverage: 2, min_marginal_efficiency: 0.1 } } },
    { inference: { ...smallJson.survey.inference, spacing_tolerance_fraction: -1 } },
    { export: { ...smallJson.survey.export, dec_column: "RA" } },
  ])("rejects invalid policy %j", (patch) => {
    expect(errorCode({ ...smallJson, survey: { ...smallJson.survey, ...patch } })).toBe("invalid_policy");
  });

  it("rejects unresolved document references and a legacy sampling budget below its minimum", () => {
    expect(errorCode({ ...smallJson, survey: { ...smallJson.survey, instrument_id: "missing" } })).toBe("unresolved_reference");
    expect(errorCode({ ...bundledJson, survey: { ...bundledJson.survey, coverage: { sampling: { target_samples_per_footprint_axis: 140, max_samples: 1 } } } })).toBe("invalid_policy");
  });

  it("rejects duplicate instruments/surveys atomically, without overwrites or partial entries", () => {
    const registry = createBundledProfileRegistry();
    const before = registry.resolveProfileDocument(bundledJson.survey.id);
    expect(() => registry.registerProfileDocument(bundledJson)).toThrow(/already registered/);
    const conflictingSurvey = {
      instrument: { ...smallJson.instrument, id: "new-camera" },
      survey: { ...smallJson.survey, id: bundledJson.survey.id, instrument_id: "new-camera" },
    };
    expect(() => registry.registerProfileDocument(conflictingSurvey)).toThrow(/Survey profile ID.*already registered/);
    expect(() => registry.resolveInstrumentProfile("new-camera")).toThrow(/Unknown/);
    const conflictingInstrument = { instrument: bundledJson.instrument, survey: { ...smallJson.survey, instrument_id: bundledJson.instrument.id } };
    expect(() => registry.registerProfileDocument(conflictingInstrument)).toThrow(/Instrument profile ID.*already registered/);
    expect(registry.findSurveyProfile(smallJson.survey.id)).toBeUndefined();
    expect(registry.resolveProfileDocument(bundledJson.survey.id)).toEqual(before);
    expect(() => registry.registerProfileDocument({ ...smallJson, survey: { ...smallJson.survey, inference: {} } })).toThrow();
    expect(() => registry.resolveInstrumentProfile(smallJson.instrument.id)).toThrow(/Unknown/);
  });

  it("fails on absent surveys even when the ID matches the bundled default", () => {
    const empty = new ProfileRegistry();
    expect(() => resolvePlanningProfile("splus-t80-south", undefined, empty)).toThrow(/Unknown survey profile ID/);
    expect(() => planRegion(region, [], "splus-t80-south", undefined, "complete", empty)).toThrow(/Unknown survey profile ID/);
    expect(() => measureResolvedCoverage(region, [], [], "splus-t80-south", undefined, empty)).toThrow(/Unknown survey profile ID/);
  });

  it("preserves defensive copies and deterministic listing for imported profiles", () => {
    const registry = importedRegistry(smallJson);
    const registered = registry.resolveProfileDocument(smallJson.survey.id);
    registered.instrument.footprint = { type: "circle", radius_deg: 80 };
    expect(registry.resolveProfileDocument(smallJson.survey.id)).toEqual(validateProfileDocumentV2(smallJson));
    registry.registerProfileDocument(bundledJson);
    expect(registry.listSurveyProfiles().map(({ id }) => id)).toEqual(["small-survey", "splus-t80-south"]);
  });

  it.each<Footprint>([
    { type: "rectangle", width_deg: 0.2, height_deg: 0.1, position_angle_deg: 20 },
    { type: "circle", radius_deg: 0.12 },
    { type: "polygon", vertices_deg: [[-0.1, -0.1], [0.1, -0.1], [0, 0.1]], position_angle_deg: -10 },
    { type: "compound", position_angle_deg: 30, components: [
      { offset_deg: [-0.1, 0], footprint: { type: "rectangle", width_deg: 0.08, height_deg: 0.2 } },
      { offset_deg: [0.1, 0], rotation_deg: 20, footprint: { type: "circle", radius_deg: 0.05 } },
    ] },
  ])("round-trips supported $type geometry and its planning/coverage behavior", (footprint) => {
    const original = validateProfileDocumentV2({ ...smallJson, instrument: { ...smallJson.instrument, footprint },
      survey: { ...smallJson.survey, coverage: { ...smallJson.survey.coverage, sampling: { ...smallJson.survey.coverage.sampling, max_samples: 100_000 } } } });
    const text = serializeProfile(original);
    const reimported = parseProfileJsonV2(text);
    expect(reimported).toEqual(original);
    expect(serializeProfile(reimported)).toBe(text);
    const before = importedRegistry(original);
    const after = importedRegistry(reimported);
    const planned = planRegion(region, [], original.survey.id, undefined, "complete", before);
    expect(planned.tiles.length).toBeGreaterThan(0);
    expect(planRegion(region, [], original.survey.id, undefined, "complete", after)).toEqual(planned);
    expect(measureResolvedCoverage(region, [], planned.tiles, original.survey.id, undefined, after))
      .toEqual(measureResolvedCoverage(region, [], planned.tiles, original.survey.id, undefined, before));
  });

  it("keeps registered and inline science distinct even when their profile IDs match", () => {
    const registry = importedRegistry({ ...smallJson, survey: { ...smallJson.survey, id: "custom" } });
    const inline = { ...resolvePlanningProfile("splus-t80-south", undefined, createBundledProfileRegistry()).profile,
      id: "custom", algorithm: "RECT_GRID_V1", tile_width_deg: 0.3, tile_height_deg: 0.2, effective_overlap_arcsec: 0 };
    const inlineProfile = resolvePlanningProfile("custom", inline, registry).profile;
    expect(outputFootprintForProfile(inlineProfile, registry)).toEqual({ type: "rectangle", width_deg: 0.3, height_deg: 0.2 });
    const normal = planRegion(region, [], "custom", inline, "complete", new ProfileRegistry());
    expect(planRegion(region, [], "custom", inline, "complete", registry)).toEqual(normal);
    expect(measureResolvedCoverage(region, [], normal.tiles, "custom", inline, registry))
      .toEqual(measureResolvedCoverage(region, [], normal.tiles, "custom", inline, new ProfileRegistry()));
    expect(outputFootprintForProfile(resolvePlanningProfile("custom", undefined, registry).profile, registry)).toEqual(smallJson.instrument.footprint);
  });

  it("preserves free-form export constant fields and canonically reimports exported configuration", () => {
    const document = validateProfileDocumentV2({
      ...smallJson,
      survey: { ...smallJson.survey, export: { ...smallJson.survey.export, constant_fields: { Z: 2, A: "x" } } },
    });
    const text = serializeProfile(document);
    expect(parseProfileJsonV2(text)).toEqual(document);
    expect(serializeProfile(parseProfileJsonV2(text))).toBe(text);
    const a = validateProfileDocumentV2({ ...smallJson, survey: { ...smallJson.survey, export: { ...smallJson.survey.export, constant_fields: { Z: 2, A: "x" } } } });
    const b = structuredClone(a);
    b.survey.export.constant_fields = { A: "x", Z: 2 };
    expect(serializeProfile(a)).toBe(serializeProfile(b));
  });

  it("imports a materially different camera/lattice and consumes its policy without T80 defaults", () => {
    const registry = importedRegistry(smallJson);
    const document = registry.resolveProfileDocument("small-survey");
    expect(document.instrument.footprint).toEqual({ type: "circle", radius_deg: 0.12 });
    const resolved = resolvePlanningProfile("small-survey", undefined, registry);
    expect(resolved.tiling).toEqual(document.survey.tiling);
    expect(outputFootprintForProfile(resolved.profile, registry)).toEqual(document.instrument.footprint);
    const result = planRegion(region, [], "small-survey", undefined, "efficient", registry);
    expect(result.solution).toBe("declared_lattice");
    expect(result.metrics.sampling?.max_samples).toBe(20000);
    expect(measureResolvedCoverage(region, [], result.tiles, "small-survey", undefined, registry).selected_region_coverage).toBeGreaterThan(0.9);
  });
});

const t80Region: SkyPolygon = { vertices: [
  { ra_deg: 149, dec_deg: -31 }, { ra_deg: 154, dec_deg: -31 },
  { ra_deg: 154, dec_deg: -29 }, { ra_deg: 149, dec_deg: -29 },
] };
const anchors: TileRecord[] = Array.from({ length: 3 }, (_, i) => ({
  id: `anchor-${i}`, name: "", ra_deg: 150 + i * (1.4 - 120 / 3600) / Math.cos(Math.PI / 6), dec_deg: -30,
  source: "original", generation_method: null, dataset_id: "reference", group_id: "reference", original_values: null, metadata: {},
}));

describe("bundled/imported T80 scientific equivalence", () => {
  it.each(["complete", "efficient"] as const)("matches resolved science, inferred and fallback plans, and active coverage (%s)", (strategy) => {
    const bundled = createBundledProfileRegistry();
    const text = serializeProfile(bundled.resolveProfileDocument("splus-t80-south"));
    const imported = new ProfileRegistry();
    imported.registerProfileDocument(parseProfileJsonV2(text));
    const reference = bundled.resolveProfileDocument("splus-t80-south");
    const copy = imported.resolveProfileDocument("splus-t80-south");
    expect(copy.survey.tiling).toEqual(reference.survey.tiling);
    expect(copy.survey.inference).toEqual(reference.survey.inference);
    expect(copy.survey.coverage).toEqual(reference.survey.coverage);
    expect(outputFootprintForProfile(resolvePlanningProfile(copy.survey.id, undefined, imported).profile, imported)).toEqual(reference.instrument.footprint);
    for (const tiles of [[], anchors]) {
      const normal = planRegion(t80Region, tiles, reference.survey.id, undefined, strategy, bundled);
      const fromFile = planRegion(t80Region, tiles, copy.survey.id, undefined, strategy, imported);
      expect(fromFile).toEqual(normal);
      expect(fromFile.tiles.length).toBeGreaterThan(0);
      expect(fromFile.solution).toBe(tiles.length ? "extended_existing_grid" : "profile_fallback");
      expect(measureResolvedCoverage(t80Region, tiles, fromFile.tiles, copy.survey.id, undefined, imported))
        .toEqual(measureResolvedCoverage(t80Region, tiles, normal.tiles, reference.survey.id, undefined, bundled));
    }
    expect(serializeProfile(copy)).toBe(text);
  });

  it("dispatches legacy_splus under unrelated profile IDs and consumes changed policies", () => {
    const renamed = validateProfileDocumentV2({
      instrument: { ...bundledJson.instrument, id: "reference-camera" },
      survey: { ...bundledJson.survey, id: "reference-survey", instrument_id: "reference-camera" },
    });
    const registry = importedRegistry(renamed);
    const normal = planRegion(t80Region, anchors, "splus-t80-south", undefined, "complete", createBundledProfileRegistry());
    expect(planRegion(t80Region, anchors, "reference-survey", undefined, "complete", registry)).toEqual(normal);
    const disabled = importedRegistry({ ...renamed, survey: { ...renamed.survey, inference: { ...renamed.survey.inference, enabled: false },
      coverage: { ...renamed.survey.coverage, sampling: { target_samples_per_footprint_axis: 70, max_samples: 5000 } } } });
    const altered = planRegion(t80Region, anchors, "reference-survey", undefined, "complete", disabled);
    expect(altered.solution).toBe("profile_fallback");
    expect(altered.metrics.sample_step_deg).toBeGreaterThan(normal.metrics.sample_step_deg);
  });
});
