import { describe, expect, it } from "vitest";
import golden from "../data/golden.json";
import referenceCsv from "../../public/data/tiles_nc.csv?raw";
import { parseCatalogueCsv } from "./catalogue";
import { measureActiveCoverage, sampleRegion, type CoverageGrid } from "./coverage";
import { contributingTileCount, angularSeparationDeg } from "./geometry";
import { legacyGridCenters } from "./grid";
import { roundDecimal } from "./math";
import { excludeOccupied, planRegion } from "./planner";
import { loadProfile } from "../profiles";
import type { RegionPlanResponse, SkyPolygon, TileRecord, TilingProfile } from "../types";

const catalogue = parseCatalogueCsv(new TextEncoder().encode(referenceCsv), "tiles_nc.csv").tiles;
const byName = new Map(catalogue.map((tile) => [tile.name, tile]));

// Sexagesimal ICRS vertices: 02 30 44.67 -21 10 19.5; 02 28 32.97
// -13 46 19.8; 01 45 40.92 -14 24 19.0; 01 41 44.18 -21 13 59.5.
const widePolygon: SkyPolygon = { vertices: [
  { ra_deg: 15 * (2 + 30 / 60 + 44.67 / 3600), dec_deg: -(21 + 10 / 60 + 19.5 / 3600) },
  { ra_deg: 15 * (2 + 28 / 60 + 32.97 / 3600), dec_deg: -(13 + 46 / 60 + 19.8 / 3600) },
  { ra_deg: 15 * (1 + 45 / 60 + 40.92 / 3600), dec_deg: -(14 + 24 / 60 + 19 / 3600) },
  { ra_deg: 15 * (1 + 41 / 60 + 44.18 / 3600), dec_deg: -(21 + 13 / 60 + 59.5 / 3600) },
] };

/** Return the weight of the nearest ICRS sample to a requested sky position. */
function nearestWeight(grid: CoverageGrid, ra: number, dec: number): number {
  let nearest = 0;
  let distance = Infinity;
  for (let index = 0; index < grid.ra.length; index += 1) {
    const squared = (grid.ra[index] - ra) ** 2 + (grid.dec[index] - dec) ** 2;
    if (squared < distance) { distance = squared; nearest = index; }
  }
  return grid.weights[nearest];
}

function centersMatch(actual: TileRecord[], expected: number[][]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, tile] of actual.entries()) {
    expect(Math.abs(tile.ra_deg - expected[index][0])).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(tile.dec_deg - expected[index][1])).toBeLessThanOrEqual(1e-10);
    expect(tile.id).toBe(`proposal-region-${String(index + 1).padStart(4, "0")}`);
  }
}

function compactPlanMatches(actual: RegionPlanResponse, expected: {
  solution: string; generation_method: string; proposal_centers: number[][];
  candidate_centers: number[][]; inference: {
    nearby_tile_count: number; anchor_tile_ids: string[]; compatible_neighbor_pairs: number;
    dec_spacing_deg: number | null; ra_spacing_deg: number | null;
  }; diagnostics: string[]; metrics: RegionPlanResponse["metrics"];
}): void {
  expect(actual.solution).toBe(expected.solution);
  expect(actual.generation_method).toBe(expected.generation_method);
  centersMatch(actual.tiles, expected.proposal_centers);
  expect(actual.candidate_centers).toHaveLength(expected.candidate_centers.length);
  actual.candidate_centers.forEach((center, index) => {
    expect(Math.abs(center.ra_deg - expected.candidate_centers[index][0])).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(center.dec_deg - expected.candidate_centers[index][1])).toBeLessThanOrEqual(1e-10);
  });
  expect(actual.inference.nearby_tile_count).toBe(expected.inference.nearby_tile_count);
  expect(actual.inference.anchor_tile_ids).toEqual(expected.inference.anchor_tile_ids);
  expect(actual.inference.compatible_neighbor_pairs).toBe(expected.inference.compatible_neighbor_pairs);
  for (const key of ["dec_spacing_deg", "ra_spacing_deg"] as const) {
    const reference = expected.inference[key];
    if (reference === null) expect(actual.inference[key]).toBeNull();
    else expect(Math.abs(actual.inference[key]! - reference)).toBeLessThanOrEqual(1e-10);
  }
  expect(actual.diagnostics).toEqual(expected.diagnostics);
  expect(actual.metrics).toEqual(expected.metrics);
}

describe("Python planner golden parity", () => {
  it.each(golden.historical_cases)("matches historical case $id", (fixture) => {
    const existing = fixture.existing_names.map((name) => byName.get(name)!);
    compactPlanMatches(planRegion(fixture.polygon, existing), fixture);
  });

  it.each(golden.planner_cases)("matches planner case $id", (fixture) => {
    const existing = fixture.existing_tiles as unknown as TileRecord[];
    const profile = fixture.profile as TilingProfile | null;
    compactPlanMatches(planRegion(fixture.polygon, existing, profile ? "custom" : undefined, profile ?? undefined), fixture);
  });

  it("reconstructs the ordered historical holdout centers and metrics", () => {
    const fixture = golden.historical_holdout;
    const surrounding = fixture.surrounding_names.map((name) => byName.get(name)!);
    const plan = planRegion(fixture.polygon, surrounding);
    expect(plan.solution).toBe(fixture.solution);
    centersMatch(plan.tiles, fixture.proposal_centers);
    expect(plan.metrics).toEqual(fixture.metrics);
    expect(plan.inference.anchor_tile_ids.length).toBeGreaterThan(2);
  });

  it("uses the exact one-anchor fallback ordering and metrics", () => {
    const fixture = golden.historical_fallback;
    const plan = planRegion(fixture.polygon, [byName.get(fixture.anchor_name)!]);
    expect(plan.solution).toBe(fixture.solution);
    centersMatch(plan.tiles, fixture.proposal_centers);
    expect(plan.metrics).toEqual(fixture.metrics);
    expect(plan.inference.anchor_tile_ids).toEqual([]);
  });

  it("uses actual 4,774 centers in the large overlap regression", () => {
    const fixture = golden.large_overlap;
    const plan = planRegion(fixture.polygon, catalogue);
    expect(plan.solution).toBe(fixture.solution);
    expect(plan.inference.anchor_tile_ids).toHaveLength(fixture.anchor_count);
    centersMatch(plan.tiles, fixture.proposal_centers);
    expect(plan.metrics).toEqual(fixture.metrics);
    const existingOnly = measureActiveCoverage(fixture.polygon, catalogue, []);
    expect(existingOnly).toEqual(fixture.existing_only_metrics);
  });

  it("repeats a solution with identical order and discrete audit data", () => {
    const fixture = golden.historical_holdout;
    const surrounding = fixture.surrounding_names.map((name) => byName.get(name)!);
    expect(planRegion(fixture.polygon, surrounding)).toEqual(planRegion(fixture.polygon, surrounding));
  });
});

describe("Python direct coverage golden parity", () => {
  it.each(golden.coverage_cases)("matches coverage case $id", (fixture) => {
    const existing = fixture.existing_tiles as unknown as TileRecord[];
    const proposed = fixture.proposed_tiles as unknown as TileRecord[];
    expect(measureActiveCoverage(fixture.polygon, existing, proposed)).toEqual(fixture.metrics);
  });
});

describe("scientific geometry and coverage contracts", () => {
  it("samples the full sexagesimal polygon and plans across its interior", () => {
    const grid = sampleRegion(widePolygon);
    const area = grid.totalWeight * grid.cellAreaDeg2;
    expect(area).toBeGreaterThan(77);
    expect(area).toBeLessThan(79);
    for (const ra of [28, 30, 32, 34, 36]) expect(nearestWeight(grid, ra, -18)).toBeGreaterThan(0);
    expect(nearestWeight(grid, 26, -14)).toBe(0);

    const plan = planRegion(widePolygon, []);
    expect(plan.metrics.selected_region_area_deg2).toBeCloseTo(area, 3);
    expect(plan.metrics.selected_region_area_deg2).toBe(77.7009);
    expect(plan.metrics.selected_region_coverage).toBeGreaterThan(0.95);
    expect(plan.metrics.remaining_uncovered_area_deg2).toBeLessThan(4);
    expect(plan.tiles.length).toBeGreaterThan(5);
  });

  it("keeps polygon sampling invariant under all cyclic starts and both windings", () => {
    const baseline = sampleRegion(widePolygon);
    const baselineArea = baseline.totalWeight * baseline.cellAreaDeg2;
    const plans: Array<{ area: number; coverage: number; tileCount: number }> = [];
    for (const vertices of [widePolygon.vertices, [...widePolygon.vertices].reverse()]) {
      for (let start = 0; start < vertices.length; start += 1) {
        const polygon = { vertices: [...vertices.slice(start), ...vertices.slice(0, start)] };
        const grid = sampleRegion(polygon);
        expect(Math.abs(grid.totalWeight * grid.cellAreaDeg2 - baselineArea)).toBeLessThan(0.2);
        for (const ra of [28, 30, 32, 34, 36]) expect(nearestWeight(grid, ra, -18)).toBeGreaterThan(0);
        expect(nearestWeight(grid, 26, -14)).toBe(0);
        const plan = planRegion(polygon, []);
        plans.push({ area: plan.metrics.selected_region_area_deg2, coverage: plan.metrics.selected_region_coverage, tileCount: plan.tiles.length });
      }
    }
    for (const plan of plans) {
      expect(Math.abs(plan.area - baselineArea)).toBeLessThan(0.001);
      expect(plan.coverage).toBe(1);
      expect(plan.tileCount).toBe(plans[0].tileCount);
    }
  });

  it("samples both sides of the ICRS RA zero meridian", () => {
    const grid = sampleRegion({ vertices: [
      { ra_deg: 359.2, dec_deg: -30 }, { ra_deg: 0.8, dec_deg: -30 },
      { ra_deg: 0.8, dec_deg: -28 }, { ra_deg: 359.2, dec_deg: -28 },
    ] });
    expect(nearestWeight(grid, 359.5, -29)).toBeGreaterThan(0);
    expect(nearestWeight(grid, 0.5, -29)).toBeGreaterThan(0);
    expect(grid.totalWeight * grid.cellAreaDeg2).toBeCloseTo(2.7986, 3);
  });

  it.each(golden.rounding)("uses Python decimal rounding for $value at $digits places", ({ value, digits, result }) => {
    expect(Object.is(roundDecimal(value, digits), result)).toBe(true);
  });

  it("matches the Python legacy grid across RA zero", () => {
    const actual = legacyGridCenters([359, 2], [-1, 1], true);
    expect(actual).toHaveLength(golden.geometry.legacy_wrap_centers.length);
    actual.forEach((center, index) => {
      expect(Math.abs(center[0] - golden.geometry.legacy_wrap_centers[index][0])).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(center[1] - golden.geometry.legacy_wrap_centers[index][1])).toBeLessThanOrEqual(1e-10);
    });
  });

  it("excludes polar near duplicates by great-circle distance", () => {
    const existing: TileRecord = {
      id: "polar", name: "", ra_deg: 0, dec_deg: 89.95, source: "original",
      generation_method: null, original_values: { RA: "0", DEC: "89.95" }, metadata: {},
    };
    expect(angularSeparationDeg(180, 89.95, 0, 89.95)).toBeCloseTo(0.1, 10);
    expect(excludeOccupied([[180, 89.95]], [existing])).toEqual([]);
  });

  it("counts a real footprint sliver narrower than one coverage sample", () => {
    const profile = loadProfile();
    const ra = 150;
    const dec = -30;
    const halfRa = profile.tile_width_deg / (2 * Math.cos(dec * Math.PI / 180));
    const polygon: SkyPolygon = { vertices: [
      { ra_deg: ra + halfRa - 0.0005, dec_deg: -30.2 },
      { ra_deg: ra + halfRa + 0.2, dec_deg: -30.2 },
      { ra_deg: ra + halfRa + 0.2, dec_deg: -29.8 },
      { ra_deg: ra + halfRa - 0.0005, dec_deg: -29.8 },
    ] };
    const tile: TileRecord = {
      id: "edge", name: "", ra_deg: ra, dec_deg: dec, source: "original",
      generation_method: null, original_values: { RA: "150", DEC: "-30" }, metadata: {},
    };
    expect(contributingTileCount(polygon, [tile], profile)).toBe(1);
  });

  it("preserves zero, partial, and restored coverage after proposal edits", () => {
    const polygon: SkyPolygon = { vertices: [
      { ra_deg: 150, dec_deg: -31 }, { ra_deg: 154, dec_deg: -31 },
      { ra_deg: 154, dec_deg: -27 }, { ra_deg: 150, dec_deg: -27 },
    ] };
    const tile: TileRecord = {
      id: "p1", name: "", ra_deg: 151, dec_deg: -30, source: "proposed",
      generation_method: "manual", original_values: null, metadata: {}, enabled: true,
    };
    const zero = measureActiveCoverage(polygon, [], []);
    const partial = measureActiveCoverage(polygon, [], [tile]);
    const removed = measureActiveCoverage(polygon, [], [{ ...tile, enabled: false }]);
    expect(zero.selected_region_coverage).toBe(0);
    expect(partial.selected_region_coverage).toBeGreaterThan(0);
    expect(partial.selected_region_coverage).toBeLessThan(1);
    expect(removed).toEqual(zero);
    expect(measureActiveCoverage(polygon, [], [tile])).toEqual(partial);
  });

  it("keeps valid tiny polygons measurable and rejects crossings", () => {
    const tiny: SkyPolygon = { vertices: [
      { ra_deg: 150, dec_deg: -30 }, { ra_deg: 150.03, dec_deg: -30 },
      { ra_deg: 150, dec_deg: -29.97 },
    ] };
    expect(planRegion(tiny, []).metrics.selected_region_area_deg2).toBeGreaterThan(0);
    const crossed: SkyPolygon = { vertices: [
      { ra_deg: 0, dec_deg: 0 }, { ra_deg: 2, dec_deg: 2 },
      { ra_deg: 0, dec_deg: 2 }, { ra_deg: 2, dec_deg: 0 },
    ] };
    expect(() => planRegion(crossed, [])).toThrow();
  });
});
