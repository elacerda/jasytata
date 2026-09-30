import { describe, expect, it } from "vitest";
import type { Footprint, InferencePolicy, SkyPolygon, TilingModel, TileRecord } from "../types";
import { createBundledProfileRegistry, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { makeCenterProposals } from "./catalogue";
import { generateLatticeCandidates } from "./lattice";
import { inferSurveyLattice } from "./lattice-inference";
import { localOffsetToSky, rotateLocalOffset } from "./footprint-engine";
import { planRegion } from "./planner";
import { deriveExposurePlacements, type ObservingSequence } from "./exposure-sequence";

const region: SkyPolygon = { vertices: [
  { ra_deg: 148.9, dec_deg: -1.1 }, { ra_deg: 151.1, dec_deg: -1.1 },
  { ra_deg: 151.1, dec_deg: 1.1 }, { ra_deg: 148.9, dec_deg: 1.1 },
] };
const origin = { ra_deg: 150, dec_deg: 0 };
const tiling: TilingModel = {
  type: "lattice", basis_deg: [[0.5, 0], [0.25, 0.5]],
  origin: { type: "region_center" },
};

function registryFor(footprint: Footprint, inference: InferencePolicy = {
  ...SPLUS_SURVEY_V2.inference, allow_rotation: true,
}) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "gate5-camera", footprint });
  registry.registerSurveyProfile({
    ...SPLUS_SURVEY_V2, coverage: { ...SPLUS_SURVEY_V2.coverage, sampling: { target_samples_per_footprint_axis: 24, max_samples: 90_000 } }, id: "gate5-survey", instrument_id: "gate5-camera", tiling, inference,
  });
  return registry;
}

function rotatedCatalogue(angleDeg: number): TileRecord[] {
  const phase = [0.2 * 0.5 + 0.3 * 0.25, 0.3 * 0.5] as [number, number];
  const cells = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  const centers = cells.map(([i, j]) => {
    const local = [phase[0] + i * 0.5 + j * 0.25, phase[1] + j * 0.5] as [number, number];
    return localOffsetToSky(origin, rotateLocalOffset(local, angleDeg));
  });
  return makeCenterProposals(centers.map(([ra_deg, dec_deg]) => ({ ra_deg, dec_deg })), "imported_centers");
}

describe("Gate 5 pointing, exposure, and lattice separation", () => {
  it("keeps candidate lattice sites and phase fixed when a non-square footprint PA changes", () => {
    const base: Footprint = { type: "rectangle", width_deg: 0.8, height_deg: 0.2, position_angle_deg: 0 };
    const turned: Footprint = { ...base, position_angle_deg: 37 };
    const first = generateLatticeCandidates(region, tiling as Extract<TilingModel, { type: "lattice" }>, base, 20_000);
    const second = generateLatticeCandidates(region, tiling as Extract<TilingModel, { type: "lattice" }>, turned, 20_000);
    const firstBySite = new Map(first.map((candidate) => [`${candidate.i},${candidate.j}`, candidate]));
    const secondBySite = new Map(second.map((candidate) => [`${candidate.i},${candidate.j}`, candidate]));
    const commonSites = [...firstBySite.keys()].filter((site) => secondBySite.has(site));

    expect(commonSites.length).toBeGreaterThan(0);
    for (const site of commonSites) {
      expect(secondBySite.get(site)).toMatchObject({
        x_deg: firstBySite.get(site)!.x_deg,
        y_deg: firstBySite.get(site)!.y_deg,
        ra_deg: firstBySite.get(site)!.ra_deg,
        dec_deg: firstBySite.get(site)!.dec_deg,
      });
    }
    expect(firstBySite.get("0,0")).toBeDefined();
    expect(secondBySite.get("0,0")).toBeDefined();
  });

  it("does not turn inferred catalogue rotation into pointing PA", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.2 });
    const survey = registry.resolveSurveyProfile("gate5-survey");
    const imported = rotatedCatalogue(17);
    const snapshot = structuredClone(imported);
    const inference = inferSurveyLattice(imported, survey, origin);
    const plan = planRegion(region, imported, "gate5-survey", undefined, "complete", registry);

    expect(inference.status).toBe("success");
    if (inference.status !== "success") throw new Error("Expected a fitted lattice rotation");
    expect(inference.rotation_deg).toBeCloseTo(17, 8);
    expect(plan.inference.lattice?.status).toBe("success");
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(imported).toEqual(snapshot);
    for (const tile of [...imported, ...plan.tiles]) expect(tile).not.toHaveProperty("position_angle_deg");
  });

  it("keeps sequence exposures derived from nominal pointings outside planner and inference rows", () => {
    const registry = registryFor({ type: "circle", radius_deg: 0.2 });
    const imported = rotatedCatalogue(0);
    const sequence: ObservingSequence = {
      id: "three-exposure-check",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0 },
        { order: 2, east_arcsec: 12, north_arcsec: -6 },
        { order: 3, east_arcsec: -12, north_arcsec: -6 },
      ],
    };
    const derived = imported.flatMap((tile) => deriveExposurePlacements({
      id: tile.id,
      center: { ra_deg: tile.ra_deg, dec_deg: tile.dec_deg },
      ...(tile.position_angle_deg === undefined ? {} : { positionAngleDeg: tile.position_angle_deg }),
    }, sequence));
    const plan = planRegion(region, imported, "gate5-survey", undefined, "complete", registry);

    expect(derived).toHaveLength(imported.length * sequence.exposures.length);
    expect(plan.inference.lattice?.status).toBe("success");
    expect(plan.inference.nearby_tile_count).toBe(imported.length);
    expect(plan.inference.anchor_tile_ids).toHaveLength(imported.length);
    expect(new Set(plan.tiles.map(({ ra_deg, dec_deg }) => `${ra_deg},${dec_deg}`)).size).toBe(plan.tiles.length);
    expect(plan.tiles.every((tile) => plan.candidate_centers.some((center) =>
      center.ra_deg === tile.ra_deg && center.dec_deg === tile.dec_deg))).toBe(true);
    for (const exposure of derived.filter((item) => item.eastOffsetArcsec !== 0 || item.northOffsetArcsec !== 0)) {
      expect(imported.some((tile) => tile.ra_deg === exposure.center[0] && tile.dec_deg === exposure.center[1])).toBe(false);
      expect(plan.tiles.some((tile) => tile.ra_deg === exposure.center[0] && tile.dec_deg === exposure.center[1])).toBe(false);
    }
  });

  it("emits one nominal proposal for a single admissible lattice site", () => {
    const singleSiteRegion: SkyPolygon = { vertices: [
      { ra_deg: 149.95, dec_deg: -0.05 }, { ra_deg: 150.05, dec_deg: -0.05 },
      { ra_deg: 150.05, dec_deg: 0.05 }, { ra_deg: 149.95, dec_deg: 0.05 },
    ] };
    const singleTiling: TilingModel = {
      type: "lattice", basis_deg: [[0.5, 0], [0, 0.5]],
      origin: { type: "fixed_anchor", ...origin },
    };
    const registry = createBundledProfileRegistry();
    registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "gate5-single-camera", footprint: { type: "circle", radius_deg: 0.2 } });
    registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, coverage: { ...SPLUS_SURVEY_V2.coverage, sampling: { target_samples_per_footprint_axis: 24, max_samples: 90_000 } }, id: "gate5-single-survey", instrument_id: "gate5-single-camera", tiling: singleTiling,
      inference: { ...SPLUS_SURVEY_V2.inference, enabled: false } });
    const plan = planRegion(singleSiteRegion, [], "gate5-single-survey", undefined, "complete", registry);

    expect(plan.candidate_centers).toHaveLength(1);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]).toMatchObject({ source: "proposed", generation_method: "region_lattice", ra_deg: 150, dec_deg: 0 });
  });
});
