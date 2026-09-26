import { describe, expect, it } from "vitest";
import type { Footprint, InferencePolicy, SkyPolygon, TilingModel } from "../types";
import bundle from "../profiles/splus-t80-south.json";
import { createBundledProfileRegistry, DEFAULT_PROFILE, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { resolvePlanningProfile } from "../profiles/planning";
import { makeCenterProposals } from "./catalogue";
import { measureActiveCoverage } from "./coverage";
import { generateLatticeCandidates } from "./lattice";
import { localOffsetToSky, skyToLocalOffset } from "./footprint-engine";
import { planRegion } from "./planner";

const region: SkyPolygon = { vertices: [
  { ra_deg: 149.1, dec_deg: -0.9 }, { ra_deg: 150.9, dec_deg: -0.9 },
  { ra_deg: 150.9, dec_deg: 0.9 }, { ra_deg: 149.1, dec_deg: 0.9 },
] };
const tiling: TilingModel = { type: "lattice", basis_deg: [[0.5, 0], [0.25, 0.5]], origin: { type: "region_center" } };
function registryFor(geometry: Footprint, policy: TilingModel = tiling, inference: InferencePolicy = SPLUS_SURVEY_V2.inference) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "generic-camera", footprint: geometry });
  registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id: "generic-survey", instrument_id: "generic-camera", tiling: policy, inference });
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
    expect(first.inference.lattice?.status).toBe("no_usable_centers");
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

  it("retains declared basis and phase when inference is explicitly disabled", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.25 }, tiling, { ...SPLUS_SURVEY_V2.inference, enabled: false });
    const imported = makeCenterProposals([
      { ra_deg: 149.4, dec_deg: -0.4 }, { ra_deg: 150.4, dec_deg: -0.4 },
      { ra_deg: 149.4, dec_deg: 0.6 }, { ra_deg: 150.4, dec_deg: 0.6 },
    ], "imported_centers");
    const empty = planRegion(region, [], "generic-survey", undefined, "complete", registry);
    const populated = planRegion(region, imported, "generic-survey", undefined, "complete", registry);
    expect(populated.candidate_centers).toEqual(empty.candidate_centers);
    expect(populated.inference).toEqual(empty.inference);
    expect(populated.solution).toBe("declared_lattice");
    expect(populated.inference.lattice?.status).toBe("disabled");
    expect(populated.metrics.already_covered_fraction).toBeGreaterThan(0);
  });

  it("continues an inferred runtime phase with the Gate 4 generator and removes occupied sites", () => {
    const footprint: Footprint = { type: "circle", radius_deg: 0.25 };
    const registry = registryFor(footprint);
    const declared = registry.resolveSurveyProfile("generic-survey");
    const imported = makeCenterProposals([
      { ra_deg: 150.175, dec_deg: 0.15 }, { ra_deg: 150.675, dec_deg: 0.15 },
      { ra_deg: 150.425, dec_deg: 0.65 }, { ra_deg: 150.925, dec_deg: 0.65 },
    ], "imported_centers");
    const plan = planRegion(region, imported, "generic-survey", undefined, "complete", registry);
    expect(plan.solution).toBe("extended_existing_grid");
    expect(plan.generation_method).toBe("region_lattice");
    const fit = plan.inference.lattice;
    expect(fit?.status).toBe("success");
    if (!fit || fit.status !== "success" || tiling.type !== "lattice") throw new Error("Expected generic alignment");
    expect(fit.inlier_count).toBe(4);
    expect(fit.phase_fraction[0]).toBeCloseTo(0.2, 10);
    expect(fit.phase_fraction[1]).toBeCloseTo(0.3, 10);
    const generated = generateLatticeCandidates(region, { ...tiling, basis_deg: fit.basis_deg }, footprint, 1200, fit);
    const declaredSites = generateLatticeCandidates(region, tiling, footprint, 1200);
    expect(plan.candidate_centers.every((point) => !declaredSites.some((site) => site.ra_deg === point.ra_deg && site.dec_deg === point.dec_deg))).toBe(true);
    expect(plan.candidate_centers).toHaveLength(generated.length - imported.length);
    for (const candidate of plan.candidate_centers) {
      expect(generated.some((p) => p.ra_deg === candidate.ra_deg && p.dec_deg === candidate.dec_deg)).toBe(true);
      expect(imported.some((p) => Math.hypot(p.ra_deg - candidate.ra_deg, p.dec_deg - candidate.dec_deg) < 1e-8)).toBe(false);
    }
    expect(plan.tiles.every((tile) => tile.metadata.solution === "extended_existing_grid")).toBe(true);
    expect(registry.resolveSurveyProfile("generic-survey")).toEqual(declared);
    expect(plan).toEqual(planRegion(region, [...imported].reverse(), "generic-survey", undefined, "complete", registry));
  });

  it("keeps excluded original datasets in generic coverage and occupancy", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.25 });
    const tiny: SkyPolygon = { vertices: [
      { ra_deg: 149.95, dec_deg: -0.05 }, { ra_deg: 150.05, dec_deg: -0.05 },
      { ra_deg: 150.05, dec_deg: 0.05 }, { ra_deg: 149.95, dec_deg: 0.05 },
    ] };
    const excluded = { ...makeCenterProposals([{ ra_deg: 150, dec_deg: 0 }], "imported_centers")[0],
      source: "original" as const, instrument_profile_id: "generic-camera", dataset_id: "excluded-data", inference_role: "exclude" as const };
    const plan = planRegion(tiny, [excluded], "generic-survey", undefined, "complete", registry);
    expect(plan.inference.lattice?.status).toBe("no_usable_centers");
    expect(plan.inference.anchor_tile_ids).toEqual([]);
    expect(plan.metrics.already_covered_fraction).toBe(1);
    expect(plan.metrics.existing_tiles_contributing).toBe(1);
    expect(plan.candidate_centers.some((p) => p.ra_deg === 150 && p.dec_deg === 0)).toBe(false);
  });

  it("limits generic anchor evidence to the region plus a basis-derived local margin", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.1 });
    const distant = makeCenterProposals([
      { ra_deg: 170.175, dec_deg: 0.15 }, { ra_deg: 170.675, dec_deg: 0.15 },
      { ra_deg: 170.425, dec_deg: 0.65 }, { ra_deg: 170.925, dec_deg: 0.65 },
    ], "imported_centers");
    const plan = planRegion(region, distant, "generic-survey", undefined, "complete", registry);
    expect(plan.inference.nearby_tile_count).toBe(0);
    expect(plan.inference.lattice?.status).toBe("no_usable_centers");
    expect(plan.solution).toBe("declared_lattice");
  });

  it("continues a rotated lattice across RA zero with neutral integer metadata", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.25 }, tiling, { ...SPLUS_SURVEY_V2.inference, allow_rotation: true });
    const wrap = { vertices: region.vertices.map((point) => ({ ...point, ra_deg: (point.ra_deg + 210) % 360 })) };
    const origin = { ra_deg: 0, dec_deg: 0 };
    const theta = 17 * Math.PI / 180;
    const imported = makeCenterProposals([[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => {
      const x = (i + 0.2) * 0.5 + (j + 0.3) * 0.25; const y = (j + 0.3) * 0.5;
      const [ra, dec] = localOffsetToSky(origin, [x * Math.cos(theta) + y * Math.sin(theta), y * Math.cos(theta) - x * Math.sin(theta)]);
      return { ra_deg: ra, dec_deg: dec };
    }), "imported_centers");
    const plan = planRegion(wrap, imported, "generic-survey", undefined, "complete", registry);
    const fit = plan.inference.lattice;
    if (!fit || fit.status !== "success") throw new Error("Expected generic alignment");
    expect(fit.rotation_deg).toBeCloseTo(17, 9);
    for (const tile of plan.tiles) {
      const [x, y] = skyToLocalOffset(tile, fit.projection_origin);
      const i = Number(tile.metadata.lattice_i); const j = Number(tile.metadata.lattice_j);
      expect(x).toBeCloseTo(i * fit.basis_deg[0][0] + j * fit.basis_deg[1][0] + fit.phase_offset_deg[0], 10);
      expect(y).toBeCloseTo(i * fit.basis_deg[0][1] + j * fit.basis_deg[1][1] + fit.phase_offset_deg[1], 10);
    }
    expect(plan.candidate_centers.some((p) => p.ra_deg > 359)).toBe(true);
  });

  it("fails planning explicitly when existing centers disagree with the fixed anchor", () => {
    const fixed: TilingModel = { type: "lattice", basis_deg: [[0.5, 0], [0, 0.5]], origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 } };
    const registry = registryFor({ type: "circle", radius_deg: 0.1 }, fixed);
    const imported = makeCenterProposals([
      { ra_deg: 150.2, dec_deg: 0.2 }, { ra_deg: 150.7, dec_deg: 0.2 },
      { ra_deg: 150.2, dec_deg: 0.7 }, { ra_deg: 150.7, dec_deg: 0.7 },
    ], "imported_centers");
    expect(() => planRegion(region, imported, "generic-survey", undefined, "complete", registry))
      .toThrow(/Generic lattice inference failed.*generic-survey.*inconsistent_fixed_anchor/);
    expect(registry.resolveSurveyProfile("generic-survey").tiling).toEqual(fixed);
  });

  it.each([
    { failure: "insufficient_anchors", minAnchors: 3, offsets: [[0.2, 0.2], [0.7, 0.2]] },
    { failure: "insufficient_pairs", minAnchors: 3, offsets: [[0.2, 0.2], [0.6, 0.2], [0.2, 0.6]] },
    { failure: "no_alignment", minAnchors: 4, offsets: [[0.2, 0.2], [0.7, 0.2], [0.2, 0.7], [-0.2, -0.2], [0.3, -0.2], [-0.2, 0.3]] },
  ])("does not return a declared region-center plan after attempted inference fails: $failure", ({ failure, minAnchors, offsets }) => {
    const lattice: TilingModel = { type: "lattice", basis_deg: [[0.5, 0], [0, 0.5]], origin: { type: "region_center" } };
    const registry = registryFor({ type: "circle", radius_deg: 0.1 }, lattice,
      { ...SPLUS_SURVEY_V2.inference, min_anchor_tiles: minAnchors });
    const imported = makeCenterProposals(offsets.map(([east, north]) => ({ ra_deg: 150 + east, dec_deg: north })), "imported_centers");
    expect(() => planRegion(region, imported, "generic-survey", undefined, "complete", registry))
      .toThrow(new RegExp(`Generic lattice inference failed.*generic-survey.*${failure}`));
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
