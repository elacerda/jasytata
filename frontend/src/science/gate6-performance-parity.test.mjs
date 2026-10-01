import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import baseline from "../data/v0.5.0-gate6-parity.json";
import { performanceBox, performanceCompound, performancePlans, runPerformancePlan } from "./gate6-performance-workloads";
import { sampleRegion, tileMask, greedyChoose, createTileMasker } from "./coverage";
import { generateLatticeCandidates } from "./lattice";
import { createPointingUnionAreaMeasurer, pointingGeometryUnionArea, expandPointingExposures } from "./pointing-geometry";
import { profileRegistry } from "../profiles/registry";
import { referenceGreedyChoose } from "./test-support/gate6-reference";
import { localOffsetToSky, footprintArea, createFootprintContainmentTester, createSkyToLocalProjector } from "./footprint-engine";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const grids = [
  ["compound", performanceBox(0.4, 0.3), performanceCompound, 8],
  ["high-resolution", performanceBox(0.04, 0.03, 150, -25), { type: "circle", radius_deg: 0.003 }, 64],
  ["wrap", performanceBox(0.5, 0.25, 359.85, 30), { type: "circle", radius_deg: 0.05 }, 32],
  ["high-dec", performanceBox(0.35, 0.2, 149.9, 82), { type: "rectangle", width_deg: 0.1, height_deg: 0.08 }, 32],
];

describe("Gate 6 exact pre-optimization parity at 8512ac9", () => {
  it("union memoization keys retain exact sky round trips and are scoped to one operation", () => {
    const measure = createPointingUnionAreaMeasurer();
    for (const nominal of [{ ra_deg: 359.999, dec_deg: 30 }, { ra_deg: 150, dec_deg: 82 }]) {
      const geometries = [[0, 0], [0.002, 0.001], [-0.001, 0.002]].map((offset, index) => ({
        id: `exposure-${index}`, order: index + 1, center: localOffsetToSky(nominal, offset),
        footprint: { type: "rectangle", width_deg: 0.005, height_deg: 0.003, position_angle_deg: index * 17 },
      }));
      const before = structuredClone(geometries);
      const expected = pointingGeometryUnionArea(geometries, nominal);
      expect(measure(geometries, nominal)).toBe(expected);
      expect(measure(structuredClone(geometries), nominal)).toBe(expected);
      expect(createPointingUnionAreaMeasurer()(geometries, nominal)).toBe(expected);
      expect(geometries).toEqual(before);
      geometries[0].footprint.width_deg *= 2;
      expect(measure(geometries, nominal)).toBe(pointingGeometryUnionArea(geometries, nominal));
    }
  });
  it("mask preparation is local, reusable across identical geometry, and observes changed values", () => {
    const grid = sampleRegion(performanceBox(0.1, 0.1), performanceCompound, { sampling: { target_samples_per_footprint_axis: 8, max_samples: 100000 } });
    const build = createTileMasker(grid);
    const footprint = structuredClone(performanceCompound);
    expect(build(150, 0, footprint)).toEqual(tileMask(grid, 150, 0, footprint));
    expect(build(150, 0, structuredClone(footprint))).toEqual(tileMask(grid, 150, 0, footprint));
    footprint.position_angle_deg = 73;
    expect(build(150, 0, footprint)).toEqual(tileMask(grid, 150, 0, footprint));
  });
  it.each(baseline.areas)("$id compound integration is exactly unchanged", (record) => {
    expect(footprintArea(record.footprint)).toBe(record.area_deg2);
  });
  it.each(baseline.plans)("$id / $strategy full nominal response and expanded order", (record) => {
    const fixture = performancePlans.find((fixture) => fixture.id === record.id);
    const before = structuredClone(fixture);
    const result = runPerformancePlan(fixture, record.strategy);
    expect(hash(result)).toBe(record.expected_sha256);
    expect(result.candidate_centers).toHaveLength(record.candidates);
    expect(result.tiles).toHaveLength(record.selected);
    expect(result.selection_stop).toBe(record.stop);
    const survey = fixture.source.strategyId ? profileRegistry.resolveAnySurveyProfile(fixture.source.strategyId) : undefined;
    const expanded = survey?.observing_sequence ? result.tiles.flatMap((tile) => expandPointingExposures(tile, null, profileRegistry, {
      sequenceForTile: () => survey.observing_sequence,
    })) : [];
    expect(hash(expanded)).toBe(record.expanded_sha256);
    expect(fixture).toEqual(before);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  }, 30_000);
  it("retains all 3,721 canonical lattice identities, coordinates and j/i order", () => {
    const candidates = generateLatticeCandidates(performanceBox(1.5, 1.5), { type: "lattice", basis_deg: [[0.025, 0], [0, 0.025]], origin: { type: "region_center" } }, { type: "circle", radius_deg: 0.008 }, 5000);
    expect(hash(candidates)).toBe(baseline.lattice_sha256);
    expect(candidates).toHaveLength(3721);
    expect(candidates).toEqual([...candidates].sort((a, b) => a.j - b.j || a.i - b.i));
  });
  it.each(grids)("%s grid and mask preserve exact sample values and weights", (id, region, footprint, density) => {
    const record = baseline.grids.find((record) => record.id === id);
    const grid = sampleRegion(region, footprint, { sampling: { target_samples_per_footprint_axis: density, max_samples: 200_000 } });
    expect(hash(grid)).toBe(record.grid_sha256);
    expect(hash(tileMask(grid, grid.centerRaDeg, grid.centerDecDeg, footprint))).toBe(record.mask_sha256);
  });
  it.each(grids)("%s masks equal exhaustive frozen projection/containment at every sample", (_id, region, footprint, density) => {
    const grid = sampleRegion(region, footprint, { sampling: { target_samples_per_footprint_axis: density, max_samples: 200_000 } });
    for (const [east, north] of [[0, 0], [0.003, 0.002], [-0.2, 0.3]]) {
      const ra = grid.centerRaDeg + east; const dec = grid.centerDecDeg + north;
      const expected = new Uint8Array(grid.ra.length);
      const project = createSkyToLocalProjector({ ra_deg: ra, dec_deg: dec });
      const contains = createFootprintContainmentTester(footprint); const point = [0, 0];
      for (let sample = 0; sample < expected.length; sample++) {
        if (grid.weights[sample] > 0) {
          project(grid.ra[sample], grid.dec[sample], point);
          if (contains(...point)) expected[sample] = 1;
        }
      }
      expect(tileMask(grid, ra, dec, footprint)).toEqual(expected);
    }
  });
  it("conservative mask pruning retains the frozen polygon cross/dot boundary allowance", () => {
    for (const angle of [0, 17, 90]) {
      const footprint = { type: "polygon", position_angle_deg: angle, vertices_deg: [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]] };
      const grid = { ra: new Float64Array([0, 0, 0.001, 0.001, 0.0005]), dec: new Float64Array([-5e-10, 0, 0.001 + 5e-10, 0.001, 0.0005]),
        weights: new Float64Array(5).fill(1), totalWeight: 5, stepDeg: 1e-4, centerRaDeg: 0, centerDecDeg: 0,
        raSpanDeg: 0.1, decMinDeg: -0.1, decMaxDeg: 0.1, cellAreaDeg2: 1e-8 };
      const contains = createFootprintContainmentTester(footprint);
      const expected = Uint8Array.from(grid.ra, (ra, i) => contains(ra, grid.dec[i]) ? 1 : 0);
      expect(tileMask(grid, 0, 0, footprint)).toEqual(expected);
    }
  });
  it.each(["complete", "efficient"])("%s sparse selector equals frozen full scans and stop reason", (strategy) => {
    // Nonuniform weights, zero-weight cells, overlaps, exact center ties and
    // per-candidate union areas exercise each ordered score component.
    const weights = Float64Array.from({ length: 97 }, (_, i) => i % 11 === 0 ? 0 : Math.cos(i / 100));
    const grid = { ra: new Float64Array(97), dec: new Float64Array(97), weights, totalWeight: weights.reduce((a, b) => a + b, 0),
      stepDeg: 1, centerRaDeg: 0, centerDecDeg: 0, raSpanDeg: 1, decMinDeg: 0, decMaxDeg: 1, cellAreaDeg2: 0.01 };
    const candidates = Array.from({ length: 35 }, (_, i) => ({ center: [i % 3, i % 5], latticeSite: { i, j: 0 },
      mask: Uint8Array.from({ length: 97 }, (_, j) => (j * 17 + i * 7) % 31 < 9 ? 1 : 0), physicalAreaDeg2: 0.5 + i % 2 }));
    const existing = Uint8Array.from({ length: 97 }, (_, i) => i % 7 === 0 ? 1 : 0);
    for (const target of [undefined, 0.999, 0.7]) {
      let expectedStop; let actualStop;
      const args = [candidates, existing, grid, { type: "circle", radius_deg: 1 }, target, strategy, { min_coverage: 0.7, min_marginal_efficiency: 0.2 }];
      const expected = referenceGreedyChoose(...args, (stop) => { expectedStop = stop; });
      expect(greedyChoose(...args, (stop) => { actualStop = stop; })).toEqual(expected);
      expect(actualStop).toBe(expectedStop);
    }
  });
});
