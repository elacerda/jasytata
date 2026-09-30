import { describe, expect, it } from "vitest";
import type { Footprint, FootprintSemanticsV3, SkyPolygon, TileRecord } from "../types";
import { createBundledProfileRegistry, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { CoverageUnavailableError, coveredMask, greedyChoose, measureActiveCoverage, measureMetrics, prepareCoverageGrid, sampleRegion, tileMask } from "./coverage";
import { resolvePlanningProfile } from "../profiles/planning";
import { footprintCharacteristicScale } from "./footprint-engine";
import { planRegion } from "./planner";
import { requireResolvedCoverage } from "./test-support/resolved-coverage";
import type { PointingGeometryContext } from "./pointing-geometry";

const source = "https://example.org/synthetic-math";
const large: Footprint = { type: "rectangle", width_deg: 1.4, height_deg: 1.4 };
const small: Footprint = { type: "rectangle", width_deg: 8.4 / 3600, height_deg: 20.4 / 3600 };
const policy = { sampling: { target_samples_per_footprint_axis: 8, max_samples: 100_000 } };

function box(width: number, height = width, ra = 150, dec = 0): SkyPolygon {
  const c = Math.max(Math.cos(dec * Math.PI / 180), 0.01);
  return { vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
    ra_deg: ((ra + x * width / 2 / c) % 360 + 360) % 360, dec_deg: dec + y * height / 2,
  })) };
}

function tile(id: string, instrument_profile_id: string, ra_deg = 150, dec_deg = 0): TileRecord {
  return { id, name: id, source: "original", enabled: true, instrument_profile_id, ra_deg, dec_deg, metadata: {}, generation_method: null, original_values: null };
}

function paths(footprint: Footprint, path = "footprint"): string[] {
  const result = footprint.type === "rectangle" ? [`${path}.width_deg`, `${path}.height_deg`]
    : footprint.type === "circle" ? [`${path}.radius_deg`]
    : footprint.type === "polygon" ? [`${path}.vertices_deg`]
    : footprint.components.flatMap((child, i) => [`${path}.components[${i}].offset_deg`, ...paths(child.footprint, `${path}.components[${i}].footprint`), ...(child.rotation_deg === undefined ? [] : [`${path}.components[${i}].rotation_deg`])]);
  if (footprint.type !== "circle" && footprint.position_angle_deg !== undefined) result.push(`${path}.position_angle_deg`);
  return result;
}

function registryFor(role: FootprintSemanticsV3["role"] = "observed_area", cap = 100_000, footprint = large) {
  const registry = createBundledProfileRegistry();
  const add = (id: string, geometry: Footprint, declaredRole: FootprintSemanticsV3["role"]) => registry.registerInstrumentProfileV3({
    schema_version: 3, id, display_name: id, coordinate_frame: "icrs", footprint: geometry,
    footprint_semantics: { role: declaredRole, fidelity: declaredRole === "observed_area" ? "exact" : "approximate",
      ...(declaredRole === "observed_area" ? {} : { approximation_notice: "Synthetic envelope; excludes detector/fibre completeness." }) },
    position_angle: { mode: "per_pointing", required: false },
    provenance: { references: [{ url: source }], assumptions: ["Synthetic affine geometry."], limitations: ["No depth or fibre model."],
      parameter_sources: paths(geometry).map((parameter_path) => ({ parameter_path, reference_url: source })) },
  });
  add("output-math", footprint, "observed_area");
  add("other-math", small, role);
  registry.registerSurveyProfileV3({ ...SPLUS_SURVEY_V2, schema_version: 3, id: "math-survey", coverage_basis_default: "single_exposure",
    provenance: { references: [{ url: source }], assumptions: [], limitations: [], parameter_sources: [{ parameter_path: "tiling.basis_deg", reference_url: source }, { parameter_path: "tiling.origin.type", reference_url: source }] }, instrument_id: "output-math",
    tiling: { type: "lattice", basis_deg: [[0.7, 0], [0, 0.7]], origin: { type: "region_center" } },
    inference: { ...SPLUS_SURVEY_V2.inference, enabled: false }, coverage: { ...policy, target_samples_per_footprint_axis: 8, sampling: { ...policy.sampling, max_samples: cap }, efficient: { min_coverage: 0.9, min_marginal_efficiency: 0.01 } } });
  return { registry, add };
}

const observedContext: PointingGeometryContext = { measurementBasis: "observed_area" };

describe("Gate 6B role × scale scientific coverage", () => {
  it.each(["observed_area", "nominal_envelope", "target_access"] as const)("filters mixed observed + %s before selecting pitch", (role) => {
    const { registry } = registryFor(role);
    const region = box(0.05);
    // Large footprint contributes a thin west strip; the small rectangle lies
    // between coarse sample centers. A large-only grid cannot hit the IFU.
    const sources = [tile("large", "output-math", 149.28), tile("small", "other-math", 150.001)];
    const started = performance.now();
    const mixed = requireResolvedCoverage(measureActiveCoverage(region, sources, [], "math-survey", undefined, registry, observedContext));
    const largeOnly = requireResolvedCoverage(measureActiveCoverage(region, sources.slice(0, 1), [], "math-survey", undefined, registry, observedContext));
    expect(largeOnly.sampling!.characteristic_scale_deg).toBe(1.4);
    expect(mixed.coverage_basis).toBe("observed_area");
    console.info("G6B role scale", JSON.stringify({ role, pitch: mixed.sampling!.natural_step_deg, samples: mixed.sampling!.sample_count, fraction: mixed.selected_region_coverage, largeOnly: largeOnly.selected_region_coverage, elapsed_ms: performance.now() - started }));
    if (role === "observed_area") {
      expect(mixed.sampling!.characteristic_scale_deg).toBe(small.width_deg);
      expect(mixed.selected_region_coverage).toBeGreaterThan(largeOnly.selected_region_coverage);
      const expected = (0.005 * 0.05 + small.width_deg * small.height_deg) / 0.05 ** 2;
      expect(Math.abs(mixed.selected_region_coverage - expected)).toBeLessThan(0.006);
      expect(mixed.error_bound!.fraction_error_upper_bound).toBeGreaterThan(Math.abs(mixed.selected_region_coverage - expected));
    } else {
      expect(mixed.sampling).toEqual(largeOnly.sampling);
      expect(mixed.selected_region_coverage).toBe(largeOnly.selected_region_coverage);
      expect(mixed.existing_tiles_contributing).toBe(1);
    }
  });

  it.each(["target_access", "nominal_envelope"] as const)("%s only cannot fabricate an observed fraction", (role) => {
    const { registry } = registryFor(role);
    const result = measureActiveCoverage(box(0.02), [tile("small", "other-math")], [], "math-survey", undefined, registry, observedContext);
    expect(result.coverage_status).toBe("no_contributors");
    expect(result).not.toHaveProperty("selected_region_coverage");
    expect(result).not.toHaveProperty("remaining_uncovered_fraction");
  });

  it("labels approximate envelope diagnostics and uses their own small scale", () => {
    const { registry } = registryFor("nominal_envelope");
    const result = requireResolvedCoverage(measureActiveCoverage(box(0.02), [tile("small", "other-math")], [], "math-survey", undefined, registry, { measurementBasis: "nominal_envelope" }));
    expect(result.coverage_basis).toBe("nominal_envelope");
    expect(result.authoritative_observed_area).toBe(false);
    expect(result.contributing_semantics).toEqual([{ role: "nominal_envelope", fidelity: "approximate" }]);
    expect(result.sampling!.characteristic_scale_deg).toBe(small.width_deg);
    expect(result.selected_region_coverage).toBeGreaterThan(0);
    expect(measureActiveCoverage(box(0.02), [tile("small", "other-math")], [], "math-survey", undefined, registry, { measurementBasis: "target_access" }).coverage_status).toBe("unsupported_basis");
  });

  it("returns deterministic budget refusal and prevents both planner strategies", () => {
    const { registry } = registryFor("observed_area", 1000);
    const sources = [tile("large", "output-math", 149.28), tile("small", "other-math")];
    const run = () => measureActiveCoverage(box(0.05), sources, [], "math-survey", undefined, registry, observedContext);
    const result = run();
    expect(result).toEqual(run());
    expect(result.coverage_status).toBe("under_resolved");
    console.info("G6B budget", JSON.stringify(result));
    expect(result.sampling!.required_sample_count).toBeGreaterThan(1000);
    expect(result.sampling!.sample_count).toBeLessThanOrEqual(1000);
    for (const field of ["selected_region_coverage", "already_covered_fraction", "remaining_uncovered_fraction", "remaining_uncovered_area_deg2"]) expect(result).not.toHaveProperty(field);
    for (const strategy of ["complete", "efficient"] as const) {
      try { planRegion(box(0.05), sources, "math-survey", undefined, strategy, registry, observedContext); throw new Error("Expected refusal"); }
      catch (error) { expect(error).toBeInstanceOf(CoverageUnavailableError); expect((error as CoverageUnavailableError).result).toEqual(result); }
    }
    const grid = sampleRegion(box(0.05), small, { sampling: { ...policy.sampling, max_samples: 1000 } });
    expect(() => greedyChoose([], new Uint8Array(grid.ra.length), grid, small)).toThrow(CoverageUnavailableError);
    expect(() => measureMetrics([], new Uint8Array(grid.ra.length), grid, 0, small)).toThrow(CoverageUnavailableError);
  });

  it("retains unclassified v2 in a separate mixed legacy union without migration", () => {
    const { registry } = registryFor("observed_area");
    const region = box(0.02);
    const sources = [tile("v2", "t80-south", 149.295), tile("v3", "other-math")];
    const legacy = requireResolvedCoverage(measureActiveCoverage(region, sources, [], "math-survey", undefined, registry, { measurementBasis: "legacy_v2" }));
    const observed = requireResolvedCoverage(measureActiveCoverage(region, sources, [], "math-survey", undefined, registry, observedContext));
    expect(legacy.coverage_basis).toBe("legacy_v2");
    expect(legacy.selected_region_coverage).toBeGreaterThan(observed.selected_region_coverage);
    expect(registry.resolveInstrumentProfile("t80-south")).toEqual(T80_SOUTH_INSTRUMENT_V2);
    expect(registry.resolveInstrumentProfile("t80-south")).not.toHaveProperty("footprint_semantics");
  });

  it("v2 mixed instruments use the run-level floor without role or policy mutation", () => {
    const registry = createBundledProfileRegistry();
    const sources = [tile("kcwi", "keck-kcwi-small")];
    const before = registry.resolveSurveyProfile("splus-t80-south");
    const result = requireResolvedCoverage(measureActiveCoverage(box(0.02), sources, [], "splus-t80-south", undefined, registry));
    expect(result.coverage_basis).toBe("legacy_v2");
    expect(result.coverage_status).toBe("resolved");
    expect(result.authoritative_observed_area).toBe(false);
    expect(result.sampling!.natural_step_deg).toBe(small.width_deg / 8);
    expect(registry.resolveSurveyProfile("splus-t80-south")).toEqual(before);
    expect(registry.resolveInstrumentProfile("keck-kcwi-small")).not.toHaveProperty("footprint_semantics");
    expect(() => measureActiveCoverage(box(0.02), sources, [], "splus-t80-south", undefined, registry, { targetSamplesPerFootprintAxis: 7 })).toThrow(/>= 8/);
  });

  it("huge theoretical grids report unavailable safe counts without allocating them", () => {
    const footprint: Footprint = { type: "circle", radius_deg: 1e-12 };
    const grid = sampleRegion(box(1), footprint, { sampling: { target_samples_per_footprint_axis: 8, max_samples: 1 } });
    expect(grid.sampling!.status).toBe("under_resolved");
    expect(grid.sampling!.required_sample_count).toBeNull();
    expect(grid.ra).toHaveLength(1);
    expect(() => measureMetrics([], new Uint8Array(1), grid, 0, footprint)).toThrow(CoverageUnavailableError);
  });

  it("effective sequences keep the role and constituent scale", () => {
    for (const role of ["observed_area", "target_access"] as const) {
      const { registry } = registryFor(role);
      const context: PointingGeometryContext = { ...observedContext, coverageBasis: "effective_sequence", sequenceForTile: () => ({ id: "two", exposures: [
        { order: 1, east_arcsec: -8.4, north_arcsec: 0 }, { order: 2, east_arcsec: 8.4, north_arcsec: 0 },
      ] }) };
      const region = box(0.02);
      const result = measureActiveCoverage(region, [tile("small", "other-math")], [], "math-survey", undefined, registry, context);
      if (role === "target_access") { expect(result.coverage_status).toBe("no_contributors"); continue; }
      const metrics = requireResolvedCoverage(result);
      expect(metrics.sampling!.characteristic_scale_deg).toBe(small.width_deg);
      expect(metrics.selected_region_coverage).toBeCloseTo(2 * small.width_deg * small.height_deg / 0.02 ** 2, 2);
    }
  });

  it("consumes persisted v3 effective sequence through versioned planning and coverage", () => {
    const { registry } = registryFor("observed_area", 100_000, small);
    const strategy = registry.resolveAnySurveyProfile("math-survey");
    if (strategy.schema_version !== 3) throw new Error("Expected v3");
    const exposures = [{ order: 1, east_arcsec: -8.4, north_arcsec: 0 }, { order: 2, east_arcsec: 8.4, north_arcsec: 0 }];
    registry.registerSurveyProfileV3({ ...strategy, id: "sequence-math", coverage_basis_default: "effective_sequence", observing_sequence: { id: "two", exposures },
      provenance: { ...strategy.provenance, parameter_sources: [...strategy.provenance.parameter_sources, ...exposures.flatMap((_, i) => ["east_arcsec", "north_arcsec"].map((key) => ({ parameter_path: `observing_sequence.exposures[${i}].${key}`, reference_url: source })))] } });
    const proposed = { ...tile("manual", "output-math"), source: "proposed" as const };
    const metric = requireResolvedCoverage(measureActiveCoverage(box(0.02), [], [proposed], "sequence-math", undefined, registry));
    expect(metric.geometry_basis).toBe("effective_sequence");
    expect(metric.sampling!.characteristic_scale_deg).toBe(small.width_deg);
    expect(metric.selected_region_coverage).toBeCloseTo(2 * small.width_deg * small.height_deg / 0.02 ** 2, 2);
    const plan = planRegion(box(0.02), [], "sequence-math", undefined, "complete", registry);
    expect(plan.tiles).toHaveLength(1);
    expect(measureActiveCoverage(box(0.02), [], plan.tiles, "sequence-math", undefined, registry)).toEqual(plan.metrics);
  });

  it.each(["target_access", "nominal_envelope"] as const)("%s output cannot invoke observed Complete or Efficient", (role) => {
    const { registry } = registryFor(role);
    const strategy = registry.resolveAnySurveyProfile("math-survey");
    registry.registerSurveyProfileV3({ ...strategy, id: "role-strategy", instrument_id: "other-math" });
    for (const mode of ["complete", "efficient"] as const) expect(() => planRegion(box(0.02), [], "role-strategy", undefined, mode, registry)).toThrow(CoverageUnavailableError);
    if (role === "nominal_envelope") {
      const plan = planRegion(box(0.02), [], "role-strategy", undefined, "complete", registry, { measurementBasis: "nominal_envelope" });
      expect(plan.metrics.coverage_basis).toBe("nominal_envelope");
      expect(plan.metrics.authoritative_observed_area).toBe(false);
    }
  });

  it("preserves row-major order and registry insertion independence", () => {
    const { registry, add } = registryFor();
    const { profile } = resolvePlanningProfile("math-survey", undefined, registry);
    const sources = [tile("small", "other-math")];
    const first = prepareCoverageGrid(box(0.01), sources, profile, registry, observedContext);
    add("unrelated", { type: "circle", radius_deg: 1e-5 }, "observed_area");
    expect(prepareCoverageGrid(box(0.01), sources, profile, registry, observedContext)).toEqual(first);
    expect(first.ra[1]).toBeGreaterThan(first.ra[0]);
    expect(first.dec[1]).toBe(first.dec[0]);
    expect(coveredMask(first, sources, profile, registry, observedContext).some(Boolean)).toBe(true);
  });
});

/** Independent scalar quadrature: no production sampler, containment or projection.
 * Coordinates are local degrees; masks are independent analytic predicates.
 */
function reference(width: number, contains: (x: number, y: number) => boolean, cells: number): number {
  let hit = 0; let total = 0;
  for (let row = 0; row < cells; row += 1) {
    const y = (row + 0.5) * width / cells - width / 2;
    const w = Math.cos(y * Math.PI / 180);
    for (let col = 0; col < cells; col += 1) {
      const x = (col + 0.5) * width / cells - width / 2;
      total += w; if (contains(x, y)) hit += w;
    }
  }
  return hit / total;
}

const numericalCases: { name: string; footprint: Footprint; contains: (x: number, y: number) => boolean }[] = [
  { name: "rectangle", footprint: { type: "rectangle", width_deg: 0.012, height_deg: 0.006 }, contains: (x, y) => Math.abs(x) <= 0.006 && Math.abs(y) <= 0.003 },
  { name: "circle", footprint: { type: "circle", radius_deg: 0.004 }, contains: (x, y) => x * x + y * y <= 0.004 ** 2 },
  { name: "polygon", footprint: { type: "polygon", vertices_deg: [[-0.006, -0.003], [0.006, -0.003], [0, 0.006]] }, contains: (x, y) => y >= -0.003 && y <= 0.006 - 1.5 * Math.abs(x) },
  { name: "compound", footprint: { type: "compound", components: [-0.005, 0.005].map((x) => ({ offset_deg: [x, 0], footprint: { type: "rectangle", width_deg: 0.004, height_deg: 0.008 } })) }, contains: (x, y) => Math.abs(y) <= 0.004 && (Math.abs(x + 0.005) <= 0.002 || Math.abs(x - 0.005) <= 0.002) },
  { name: "rotated", footprint: { type: "rectangle", width_deg: 0.012, height_deg: 0.006, position_angle_deg: 37 }, contains: (x, y) => Math.abs(x * Math.cos(37 * Math.PI / 180) - y * Math.sin(37 * Math.PI / 180)) <= 0.006 && Math.abs(x * Math.sin(37 * Math.PI / 180) + y * Math.cos(37 * Math.PI / 180)) <= 0.003 },
];

describe("Gate 6B independent numerical references", () => {
  it.each(numericalCases)("$name converges within tolerance and its guaranteed bound", ({ name, footprint, contains }) => {
    const region = box(0.02);
    const grid = sampleRegion(region, footprint, { sampling: { target_samples_per_footprint_axis: 64, max_samples: 500_000 } });
    grid.boundaryGeometries = [{ center: [150, 0], footprint }];
    const metrics = measureMetrics([], tileMask(grid, 150, 0, footprint), grid, 1, footprint);
    const fine = reference(0.02, contains, 1600);
    const finer = reference(0.02, contains, 2400);
    const error = Math.abs(metrics.selected_region_coverage - finer);
    expect(Math.abs(fine - finer)).toBeLessThan(0.0008);
    expect(error).toBeLessThan(0.003);
    expect(error).toBeLessThan(metrics.error_bound!.fraction_error_upper_bound);
    const analyticRegionArea = 0.02 * 2 * Math.sin(0.01 * Math.PI / 180) / (Math.PI / 180);
    expect(Math.abs(metrics.selected_region_area_deg2 - analyticRegionArea)).toBeLessThan(metrics.error_bound!.area_error_upper_bound_deg2);
    console.info("G6B numerical", JSON.stringify({ name, error, refinement: Math.abs(fine - finer), bound: metrics.error_bound!.fraction_error_upper_bound, samples: grid.ra.length }));
  });

  it.each([0, 30, -45, 65])("retains local scales at DEC %s with RA wrap", (dec) => {
    const footprint: Footprint = { type: "rectangle", width_deg: 0.01, height_deg: 0.01 };
    const grid = sampleRegion(box(0.02, 0.02, 0, dec), footprint, { sampling: { target_samples_per_footprint_axis: 64, max_samples: 100_000 } });
    const metrics = measureMetrics([], tileMask(grid, 0, dec, footprint), grid, 1, footprint);
    expect(Math.abs(metrics.selected_region_coverage - 0.25)).toBeLessThan(0.005);
    expect(grid.sampling!.cell_width_deg).toBeLessThanOrEqual(0.01 / 64);
    expect(grid.ra.some((x) => x < 1)).toBe(true); expect(grid.ra.some((x) => x > 359)).toBe(true);
  });

  it("external masks without known boundaries get a rigorous worst-case bound", () => {
    const footprint: Footprint = { type: "rectangle", width_deg: 0.01, height_deg: 0.01 };
    const grid = sampleRegion(box(0.02), footprint, policy);
    const external = new Uint8Array(grid.ra.length).fill(1);
    expect(measureMetrics([], external, grid, 1, footprint).error_bound!.fraction_error_upper_bound).toBe(1);
    // Recorded source geometry cannot justify an unrelated external mask.
    grid.boundaryGeometries = [{ center: [150, 0], footprint }];
    expect(measureMetrics([], external, grid, 1, footprint).error_bound!.fraction_error_upper_bound).toBe(1);
    const empty = new Uint8Array(grid.ra.length);
    expect(measureMetrics([{ center: [150, 0], mask: external }], empty, grid, 0, footprint).error_bound!.fraction_error_upper_bound).toBe(1);
  });

  it("bounds east pitch in an off-center contributor's DEC frame", () => {
    const footprint: Footprint = { type: "rectangle", width_deg: 2, height_deg: 20 };
    const grid = sampleRegion(box(1, 1, 150, 60), footprint, policy);
    const actual = grid.raSpanDeg / grid.sampling!.column_count * Math.cos(55 * Math.PI / 180);
    expect(actual).toBeLessThanOrEqual(2 / 8);
    expect(grid.sampling!.east_projection_cosine).toBeGreaterThan(Math.cos(60 * Math.PI / 180));
  });

  it("uses minimum support width rather than diagonal polygon bounding-box span", () => {
    const a = Math.SQRT1_2;
    const footprint: Footprint = { type: "polygon", vertices_deg: [[-2, -0.1], [2, -0.1], [2, 0.1], [-2, 0.1]].map(([x, y]) => [(x - y) * a, (x + y) * a]) };
    expect(footprintCharacteristicScale(footprint)).toBeCloseTo(0.2, 12);
    expect(footprintCharacteristicScale({ ...footprint, position_angle_deg: 74 })).toBeCloseTo(0.2, 12);
  });
});
