import { describe, expect, it } from "vitest";
import type { Footprint, InferencePolicy, SkyPolygon, TilingModel, TileRecord } from "../types";
import { createBundledProfileRegistry, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { measureActiveCoverage } from "./coverage";
import { planRegion } from "./planner";
import { deriveExposurePlacements, type ObservingSequence } from "./exposure-sequence";
import type { PointingGeometryContext } from "./pointing-geometry";

const region: SkyPolygon = { vertices: [
  { ra_deg: 148.9, dec_deg: -1.1 }, { ra_deg: 151.1, dec_deg: -1.1 },
  { ra_deg: 151.1, dec_deg: 1.1 }, { ra_deg: 148.9, dec_deg: 1.1 },
] };
const origin = { ra_deg: 150, dec_deg: 0 };
const tiling: TilingModel = {
  type: "lattice", basis_deg: [[0.5, 0], [0.25, 0.5]],
  origin: { type: "region_center" },
};
const footprint: Footprint = { type: "rectangle", width_deg: 0.8, height_deg: 0.2 };
const inference: InferencePolicy = { ...SPLUS_SURVEY_V2.inference, enabled: false };

function registryFor(cameraFootprint: Footprint = footprint) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "gate5-planner-camera", footprint: cameraFootprint });
  registry.registerSurveyProfile({
    // Resolve this geometry fixture within its budget; no implicit coarsening.

    ...SPLUS_SURVEY_V2, coverage: { ...SPLUS_SURVEY_V2.coverage, sampling: { target_samples_per_footprint_axis: 24, max_samples: 90_000 } }, id: "gate5-planner-survey", instrument_id: "gate5-planner-camera", tiling, inference,
  });
  return registry;
}

function plannerContext(
  policy: "fixed" | "per_pointing" | "not_applicable",
  coverageBasis: PointingGeometryContext["coverageBasis"] = "single_exposure",
  sequence?: ObservingSequence,
): PointingGeometryContext {
  return {
    orientationPolicyForTile: () => ({ policy, required: policy !== "not_applicable" }),
    coverageBasis,
    ...(sequence ? { sequenceForTile: (tile) => tile.source === "proposed" ? sequence : undefined } : {}),
  };
}

function expectMetricsEqual(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}

describe("Gate 5 planner geometry context", () => {
  it("uses fixed PA for proposal preview and preserves lattice candidate centers", () => {
    const registry = registryFor({ ...footprint, position_angle_deg: 90 });
    const context = plannerContext("fixed");
    const baseline = planRegion(region, [], "gate5-planner-survey", undefined, "complete", registry);
    const oriented = planRegion(region, [], "gate5-planner-survey", undefined, "complete", registry, context);
    const acceptedMetrics = measureActiveCoverage(region, [], oriented.tiles, "gate5-planner-survey", undefined, registry, context);

    expect(oriented.candidate_centers).toEqual(baseline.candidate_centers);
    expect(oriented.tiles.every((tile) => !Object.hasOwn(tile, "position_angle_deg"))).toBe(true);
    expectMetricsEqual(oriented.metrics, acceptedMetrics);
  });

  it("fails automatic proposals when a required per-pointing PA cannot be assigned", () => {
    const registry = registryFor();
    expect(() => planRegion(
      region, [], "gate5-planner-survey", undefined, "complete", registry, plannerContext("per_pointing"),
    )).toThrow(/automatic planner proposals cannot satisfy required per-pointing PA/i);
  });

  it("keeps absent PA undeclared while using computational geometry for preview", () => {
    const registry = registryFor();
    const context = plannerContext("not_applicable");
    const plan = planRegion(region, [], "gate5-planner-survey", undefined, "complete", registry, context);
    const acceptedMetrics = measureActiveCoverage(region, [], plan.tiles, "gate5-planner-survey", undefined, registry, context);

    expect(plan.tiles.length).toBeGreaterThan(0);
    for (const tile of plan.tiles) expect(tile).not.toHaveProperty("position_angle_deg");
    expectMetricsEqual(plan.metrics, acceptedMetrics);
  });

  it("scores the effective exposure union while emitting one nominal tile per lattice site", () => {
    const registry = registryFor();
    const sequence: ObservingSequence = { id: "planner-two-point-sequence", exposures: [
      { order: 1, east_arcsec: -90, north_arcsec: 0, rotation_deg: 0 },
      { order: 2, east_arcsec: 90, north_arcsec: 0, rotation_deg: 0 },
    ] };
    const context = plannerContext("not_applicable", "effective_sequence", sequence);
    const baseline = planRegion(region, [], "gate5-planner-survey", undefined, "complete", registry);
    const effective = planRegion(region, [], "gate5-planner-survey", undefined, "complete", registry, context);
    const acceptedMetrics = measureActiveCoverage(region, [], effective.tiles, "gate5-planner-survey", undefined, registry, context);

    expect(effective.candidate_centers).toEqual(baseline.candidate_centers);
    expectMetricsEqual(effective.metrics, acceptedMetrics);
    expect(effective.tiles.length).toBeLessThanOrEqual(effective.candidate_centers.length);
    for (const tile of effective.tiles) {
      expect(effective.candidate_centers).toContainEqual({ ra_deg: tile.ra_deg, dec_deg: tile.dec_deg, label: null });
      const exposures = deriveExposurePlacements({ id: tile.id, center: tile }, sequence);
      for (const exposure of exposures.slice(1)) {
        expect(effective.tiles.some((candidate) => candidate.ra_deg === exposure.center[0] && candidate.dec_deg === exposure.center[1])).toBe(false);
        expect(effective.candidate_centers.some((candidate) => candidate.ra_deg === exposure.center[0] && candidate.dec_deg === exposure.center[1])).toBe(false);
      }
    }
  });

  it("keeps source per-pointing PA in preview without changing inference centers", () => {
    const registry = registryFor();
    const existing: TileRecord[] = [{
      id: "existing-camera", name: "", ra_deg: origin.ra_deg, dec_deg: origin.dec_deg,
      position_angle_deg: 90, source: "original", generation_method: null,
      instrument_profile_id: "gate5-planner-camera", original_values: null, metadata: {},
    }];
    const policyContext: PointingGeometryContext = {
      orientationPolicyForTile: (tile) => ({
        policy: tile.source === "original" ? "per_pointing" : "not_applicable",
        required: tile.source === "original",
      }),
    };
    const nominal = planRegion(region, existing, "gate5-planner-survey", undefined, "complete", registry);
    const oriented = planRegion(region, existing, "gate5-planner-survey", undefined, "complete", registry, policyContext);
    const acceptedMetrics = measureActiveCoverage(region, existing, oriented.tiles, "gate5-planner-survey", undefined, registry, policyContext);

    expect(oriented.candidate_centers).toEqual(nominal.candidate_centers);
    expect(oriented.inference).toEqual(nominal.inference);
    expectMetricsEqual(oriented.metrics, acceptedMetrics);
  });
});
