import { describe, expect, it } from "vitest";
import type { Footprint, SkyPolygon, TilingModel } from "../types";
import bundle from "../profiles/splus-t80-south.json";
import { createBundledProfileRegistry, DEFAULT_PROFILE, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { resolvePlanningProfile } from "../profiles/planning";
import { makeCenterProposals } from "./catalogue";
import { measureActiveCoverage } from "./coverage";
import { generateLatticeCandidates } from "./lattice";
import { planRegion } from "./planner";

const region: SkyPolygon = { vertices: [
  { ra_deg: 149.1, dec_deg: -0.9 }, { ra_deg: 150.9, dec_deg: -0.9 },
  { ra_deg: 150.9, dec_deg: 0.9 }, { ra_deg: 149.1, dec_deg: 0.9 },
] };
const tiling: TilingModel = { type: "lattice", basis_deg: [[0.5, 0], [0.25, 0.5]], origin: { type: "region_center" } };
function registryFor(geometry: Footprint, policy: TilingModel = tiling) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "generic-camera", footprint: geometry });
  registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id: "generic-survey", instrument_id: "generic-camera", tiling: policy });
  return registry;
}

describe("Gate 4 planner tiling dispatch", () => {
  it("plans a nonrectangular instrument only on declared lattice sites with neutral provenance", () => {
    const footprint: Footprint = { type: "circle", radius_deg: 0.4 };
    const registry = registryFor(footprint);
    const first = planRegion(region, [], "generic-survey", undefined, "complete", registry);
    expect(first).toEqual(planRegion(region, [], "generic-survey", undefined, "complete", registry));
    expect(first.solution).toBe("declared_lattice");
    expect(first.generation_method).toBe("region_lattice");
    expect(first.inference.anchor_tile_ids).toEqual([]);
    expect(first.inference.compatible_neighbor_pairs).toBe(0);
    if (tiling.type !== "lattice") throw new Error("Expected lattice");
    const candidates = generateLatticeCandidates(region, tiling, footprint, 1200);
    expect(first.candidate_centers.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]))
      .toEqual(candidates.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]));
    expect(first.tiles.length).toBeGreaterThan(0);
    for (const tile of first.tiles) {
      const candidate = candidates.find(({ ra_deg, dec_deg }) => ra_deg === tile.ra_deg && dec_deg === tile.dec_deg)!;
      expect(tile.metadata).toMatchObject({ lattice_i: candidate.i, lattice_j: candidate.j });
      expect(tile.generation_method).toBe("region_lattice");
    }
  });

  it("accepts neutral lattice provenance in the shared proposal constructor", () => {
    const centers = makeCenterProposals([{ ra_deg: 150, dec_deg: 0 }], "region_lattice");
    expect(centers[0].generation_method).toBe("region_lattice");
    expect(centers[0].ra_deg).toBe(150);
  });

  it("plans declared lattice footprints across RA zero", () => {
    const footprint: Footprint = { type: "circle", radius_deg: 0.4 };
    const registry = registryFor(footprint);
    const wrap = { vertices: region.vertices.map((point) => ({ ...point, ra_deg: (point.ra_deg + 210) % 360 })) };
    const plan = planRegion(wrap, [], "generic-survey", undefined, "complete", registry);
    expect(plan.solution).toBe("declared_lattice");
    expect(plan.candidate_centers.some(({ ra_deg }) => ra_deg < 1)).toBe(true);
    expect(plan.candidate_centers.some(({ ra_deg }) => ra_deg > 359)).toBe(true);
    expect(plan).toEqual(planRegion(wrap, [], "generic-survey", undefined, "complete", registry));
    expect(plan.metrics.selected_region_coverage).toBeGreaterThan(0);
  });

  it("retains declared basis and phase despite existing regular centers", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.25 });
    const imported = makeCenterProposals([
      { ra_deg: 149.4, dec_deg: -0.4 }, { ra_deg: 150.4, dec_deg: -0.4 },
      { ra_deg: 149.4, dec_deg: 0.6 }, { ra_deg: 150.4, dec_deg: 0.6 },
    ], "imported_centers");
    const empty = planRegion(region, [], "generic-survey", undefined, "complete", registry);
    const populated = planRegion(region, imported, "generic-survey", undefined, "complete", registry);
    expect(populated.candidate_centers).toEqual(empty.candidate_centers);
    expect(populated.inference).toEqual(empty.inference);
    expect(populated.metrics.already_covered_fraction).toBeGreaterThan(0);
  });

  it("reports gaps without introducing supplemental spacing or phase", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.1 });
    const plan = planRegion(region, [], "generic-survey", undefined, "complete", registry);
    expect(plan.metrics.remaining_uncovered_fraction).toBeGreaterThan(0.5);
    expect(plan.diagnostics.some((message) => message.includes("declared lattice leaves sampled gaps"))).toBe(true);
    expect(plan.tiles.every((tile) => plan.candidate_centers.some((point) => tile.ra_deg === point.ra_deg && tile.dec_deg === point.dec_deg))).toBe(true);
  });

  it("makes manual automatic planning explicitly unavailable while preserving pointings and coverage", () => {
    const registry = registryFor({ type: "circle", radius_deg: 2 }, { type: "manual" });
    expect(() => planRegion(region, [], "generic-survey", undefined, "complete", registry)).toThrow(/generic-survey.*manual.*automatic tiling/);
    const manual = makeCenterProposals([{ ra_deg: 150, dec_deg: 0 }], "manual");
    const imported = makeCenterProposals([{ ra_deg: 150, dec_deg: 0 }], "imported_centers");
    const metrics = measureActiveCoverage(region, [], manual, "generic-survey", undefined, registry);
    expect(metrics.selected_region_coverage).toBe(1);
    expect(measureActiveCoverage(region, [], imported, "generic-survey", undefined, registry)).toEqual(metrics);
    expect(measureActiveCoverage(region, [], [{ ...manual[0], enabled: false }], "generic-survey", undefined, registry).selected_region_coverage).toBe(0);
  });

  it("exposes a basis for v1 authoring while retaining the frozen custom rectangle entry point", () => {
    const inline = { ...DEFAULT_PROFILE, id: "custom", algorithm: "RECT_GRID_V1", tile_width_deg: 1, tile_height_deg: 0.8, effective_overlap_arcsec: 360 };
    expect(resolvePlanningProfile("custom", inline).tiling).toEqual({
      type: "lattice", basis_deg: [[0.9, 0], [0, 0.7000000000000001]], origin: { type: "region_center" },
    });
    expect(planRegion(region, [], "custom", inline).generation_method).toBe("region_legacy");
  });

  it("keeps the bundled strategy and an ordinary imported copy scientifically equivalent", () => {
    const registry = createBundledProfileRegistry();
    registry.registerInstrumentProfile({ ...JSON.parse(JSON.stringify(bundle.instrument)), id: "imported-camera" });
    registry.registerSurveyProfile({ ...JSON.parse(JSON.stringify(bundle.survey)), id: "imported-survey", instrument_id: "imported-camera" });
    expect(resolvePlanningProfile(DEFAULT_PROFILE.id).tiling.type).toBe("legacy_splus");
    const original = planRegion(region, []);
    const imported = planRegion(region, [], "imported-survey", undefined, "complete", registry);
    expect(imported).toEqual(original);
    expect(original.generation_method).toBe("region_legacy");
  });

  it("reads legacy dimensions and effective overlap from validated profile data", () => {
    const registry = registryFor({ type: "rectangle", width_deg: 1, height_deg: 0.8 }, { type: "legacy_splus", grid_extent_deg: [1, 0.8], effective_overlap_arcsec: 180 });
    const resolved = resolvePlanningProfile("generic-survey", undefined, registry);
    expect(resolved.profile.tile_width_deg).toBe(1);
    expect(resolved.profile.effective_overlap_arcsec).toBe(180);
    const plan = planRegion(region, [], "generic-survey", undefined, "complete", registry);
    expect(plan.generation_method).toBe("region_legacy");
    expect(plan.candidate_centers.some(({ dec_deg }) => Math.abs(dec_deg + 0.9) < 1e-10)).toBe(true);
  });
});
