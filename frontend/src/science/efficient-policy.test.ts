import { describe, expect, it } from "vitest";
import type { CoveragePolicy, Footprint, SkyPolygon } from "../types";
import { createBundledProfileRegistry, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { resolvePlanningProfile } from "../profiles/planning";
import { makeCenterProposals } from "./catalogue";
import { greedyChoose, type CoverageGrid } from "./coverage";
import { footprintArea } from "./footprint-engine";
import { planRegion } from "./planner";

const region: SkyPolygon = { vertices: [
  { ra_deg: 149.1, dec_deg: -0.9 }, { ra_deg: 150.9, dec_deg: -0.9 },
  { ra_deg: 150.9, dec_deg: 0.9 }, { ra_deg: 149.1, dec_deg: 0.9 },
] };
const mosaic: Footprint = { type: "compound", components: [
  { offset_deg: [-0.4, 0], footprint: { type: "rectangle", width_deg: 0.6, height_deg: 1 } },
  { offset_deg: [0.4, 0], footprint: { type: "rectangle", width_deg: 0.6, height_deg: 1 } },
  // Duplicate detector: union area must not count its overlap twice.
  { offset_deg: [-0.4, 0], footprint: { type: "rectangle", width_deg: 0.6, height_deg: 1 } },
] };

/** Register two surveys differing only in Efficient policy for the same geometry. */
function pairedSurveys(footprint: Footprint, a: CoveragePolicy["efficient"], b: CoveragePolicy["efficient"]) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "policy-camera", footprint });
  for (const [id, efficient] of [["policy-a", a], ["policy-b", b]] as const) {
    registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id, instrument_id: "policy-camera",
      tiling: { type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 } },
      inference: { ...SPLUS_SURVEY_V2.inference, enabled: false },
      coverage: { sampling: { target_samples_per_footprint_axis: 20, max_samples: 20_000 }, ...(efficient ? { efficient } : {}) },
    });
  }
  return registry;
}

const geometries: { name: string; footprint: Footprint }[] = [
  { name: "rectangle", footprint: { type: "rectangle", width_deg: 1, height_deg: 1 } },
  { name: "circle", footprint: { type: "circle", radius_deg: 0.5 } },
  { name: "mosaic", footprint: mosaic },
];

describe("Gate 6B profile-driven Efficient planning", () => {
  it.each(geometries)("uses custom min_coverage for $name and leaves Complete independent", ({ name, footprint }) => {
    const registry = pairedSurveys(footprint,
      { min_coverage: 0.4, min_marginal_efficiency: 1 },
      { min_coverage: 1, min_marginal_efficiency: 1 });
    const efficientA = planRegion(region, [], "policy-a", undefined, "efficient", registry);
    const efficientB = planRegion(region, [], "policy-b", undefined, "efficient", registry);
    const completeA = planRegion(region, [], "policy-a", undefined, "complete", registry);
    const completeB = planRegion(region, [], "policy-b", undefined, "complete", registry);
    expect(efficientA.metrics.selected_region_coverage).toBeGreaterThanOrEqual(0.4);
    expect(efficientA.metrics.selected_region_coverage).toBeLessThan(1);
    expect(efficientA.tiles.length).toBeLessThan(efficientB.tiles.length);
    if (name === "rectangle") {
      expect(efficientA.tiles).toHaveLength(2);
      expect(efficientB.tiles).toHaveLength(9);
    }
    expect(efficientB.metrics).toEqual(completeB.metrics);
    expect(efficientB.tiles.map((tile) => [tile.ra_deg, tile.dec_deg])).toEqual(
      completeB.tiles.map((tile) => [tile.ra_deg, tile.dec_deg]));
    expect(completeA).toEqual(completeB);
    expect(efficientA.candidate_centers).toEqual(completeA.candidate_centers);
    expect(efficientA.metrics.sampling).toEqual(completeA.metrics.sampling);
    expect(efficientA.tiles.map((tile) => [tile.ra_deg, tile.dec_deg])).toEqual(
      completeA.tiles.slice(0, efficientA.tiles.length).map((tile) => [tile.ra_deg, tile.dec_deg]));
    expect(efficientA).toEqual(planRegion(region, [], "policy-a", undefined, "efficient", registry));
  });

  it("uses custom min_marginal_efficiency with identical geometry, samples and candidates", () => {
    const registry = pairedSurveys(geometries[0].footprint,
      { min_coverage: 0.4, min_marginal_efficiency: 0 },
      { min_coverage: 0.4, min_marginal_efficiency: 1 });
    const a = planRegion(region, [], "policy-a", undefined, "efficient", registry);
    const b = planRegion(region, [], "policy-b", undefined, "efficient", registry);
    expect(a.tiles.length).toBeGreaterThan(b.tiles.length);
    expect(a.tiles).toHaveLength(9);
    expect(b.tiles).toHaveLength(2);
    expect(a.metrics.selected_region_coverage).toBe(1);
    expect(b.metrics.selected_region_coverage).toBeLessThan(1);
    expect(a.candidate_centers).toEqual(b.candidate_centers);
    expect(a.metrics.sampling).toEqual(b.metrics.sampling);
  });

  it("requires an explicit v2 Efficient policy without installing T80 defaults", () => {
    const registry = pairedSurveys(geometries[0].footprint, undefined, undefined);
    expect(resolvePlanningProfile("policy-a", undefined, registry).efficientPolicy).toBeUndefined();
    expect(() => planRegion(region, [], "policy-a", undefined, "efficient", registry)).toThrow(/policy-a.*coverage.efficient/);
    expect(planRegion(region, [], "policy-a", undefined, "complete", registry).metrics.selected_region_coverage).toBe(1);
  });

  it("does not apply legacy absolute occupancy during Efficient planning of a small lattice", () => {
    const footprint: Footprint = { type: "rectangle", width_deg: 0.02, height_deg: 0.02 };
    const registry = pairedSurveys(footprint,
      { min_coverage: 1, min_marginal_efficiency: 0 }, undefined);
    const survey = registry.resolveSurveyProfile("policy-a");
    registry.registerSurveyProfile({ ...survey, id: "policy-small",
      tiling: { type: "lattice", basis_deg: [[0.02, 0], [0, 0.02]], origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 } },
      inference: { ...survey.inference, occupancy_tolerance_fraction: 0.1 },
    });
    const tiny: SkyPolygon = { vertices: [
      { ra_deg: 149.991, dec_deg: -0.009 }, { ra_deg: 150.029, dec_deg: -0.009 },
      { ra_deg: 150.029, dec_deg: 0.009 }, { ra_deg: 149.991, dec_deg: 0.009 },
    ] };
    const existing = makeCenterProposals([{ ra_deg: 150, dec_deg: 0 }], "imported_centers")
      .map((tile) => ({ ...tile, instrument_profile_id: "policy-camera" }));
    const plan = planRegion(tiny, existing, "policy-small", undefined, "efficient", registry);
    expect(plan.candidate_centers.some((point) => point.ra_deg === 150 && point.dec_deg === 0)).toBe(false);
    expect(plan.tiles.some((point) => Math.abs(point.ra_deg - 150.02) < 1e-9 && point.dec_deg === 0)).toBe(true);
    expect(plan.metrics.selected_region_coverage).toBe(1);
  });

  it("consumes v2 legacy_splus policy in primary selection and supplemental gap-fill", () => {
    const registry = pairedSurveys(geometries[0].footprint,
      { min_coverage: 0, min_marginal_efficiency: 1 },
      { min_coverage: 1, min_marginal_efficiency: 0 });
    for (const suffix of ["a", "b"]) {
      const survey = registry.resolveSurveyProfile(`policy-${suffix}`);
      registry.registerSurveyProfile({ ...survey, id: `legacy-policy-${suffix}`,
        tiling: { type: "legacy_splus", grid_extent_deg: [1, 1], effective_overlap_arcsec: 0 } });
    }
    // Region area is much smaller than a tile, including compatibility sampling
    // boundary cells, so no candidate can reach a marginal efficiency of one.
    const small: SkyPolygon = { vertices: region.vertices.map((point) => ({
      ra_deg: 150 + (point.ra_deg - 150) / 9, dec_deg: point.dec_deg / 9,
    })) };
    const a = planRegion(small, [], "legacy-policy-a", undefined, "efficient", registry);
    const b = planRegion(small, [], "legacy-policy-b", undefined, "efficient", registry);
    expect(a.tiles).toHaveLength(0);
    expect(b.tiles.length).toBeGreaterThan(0);
    expect(a.candidate_centers).toEqual(b.candidate_centers);
    expect(a.metrics.remaining_uncovered_fraction).toBe(1);
  });
});

describe("Gate 6B marginal physical footprint area", () => {
  it.each([
    ...geometries.map(({ name, footprint }) => ({ name, footprint, expectedArea: name === "rectangle" ? 1 : name === "circle" ? Math.PI / 4 : 1.2 })),
    { name: "polygon", footprint: { type: "polygon", vertices_deg: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5]] } as Footprint, expectedArea: 0.5 },
  ])("uses the shared $name physical area and strict threshold", ({ footprint, expectedArea }) => {
    expect(footprintArea(footprint)).toBeCloseTo(expectedArea, 3);
    const grid: CoverageGrid = {
      ra: new Float64Array(100), dec: new Float64Array(100), weights: new Float64Array(100).fill(1),
      totalWeight: 100, stepDeg: 1, centerRaDeg: 0, centerDecDeg: 0, raSpanDeg: 1,
      decMinDeg: 0, decMaxDeg: 1, cellAreaDeg2: 0.2,
    };
    const existing = new Uint8Array(100).fill(1); existing[99] = 0;
    const mask = new Uint8Array(100); mask[99] = 1;
    const candidates = [{ center: [0, 0] as [number, number], mask }];
    const efficiency = grid.cellAreaDeg2 / footprintArea(footprint);
    const choose = (threshold: number) => greedyChoose(candidates, existing, grid, footprint, 1, "efficient",
      { min_coverage: 0.9, min_marginal_efficiency: threshold });
    expect(choose(efficiency)).toHaveLength(1);
    expect(choose(efficiency + 1e-6)).toHaveLength(0);
    // Threshold above the bounding-area estimate but below the physical ratio.
    if (footprint.type !== "rectangle") expect(choose(footprint.type === "circle" ? 0.23 : footprint.type === "polygon" ? 0.3 : 0.155)).toHaveLength(1);
  });
});
