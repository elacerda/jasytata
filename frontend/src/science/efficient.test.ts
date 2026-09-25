import { describe, expect, it } from "vitest";
import golden from "../data/golden.json";
import contract from "../data/efficient-contract.json";
import referenceCsv from "../../public/data/tiles_nc.csv?raw";
import { parseCatalogueCsv } from "./catalogue";
import { coveredMask, EFFICIENT_MIN_COVERAGE, EFFICIENT_MIN_MARGINAL_EFFICIENCY, greedyChoose, sampleRegion, tileMask, type CoverageGrid } from "./coverage";
import { planRegion } from "./planner";
import { loadProfile } from "../profiles";
import type { SkyPolygon, TileRecord, TilingProfile } from "../types";

const catalogue = parseCatalogueCsv(new TextEncoder().encode(referenceCsv), "tiles_nc.csv").tiles;
const byName = new Map(catalogue.map((tile) => [tile.name, tile]));
const widePolygon: SkyPolygon = { vertices: [
  { ra_deg: 15 * (2 + 30 / 60 + 44.67 / 3600), dec_deg: -(21 + 10 / 60 + 19.5 / 3600) },
  { ra_deg: 15 * (2 + 28 / 60 + 32.97 / 3600), dec_deg: -(13 + 46 / 60 + 19.8 / 3600) },
  { ra_deg: 15 * (1 + 45 / 60 + 40.92 / 3600), dec_deg: -(14 + 24 / 60 + 19 / 3600) },
  { ra_deg: 15 * (1 + 41 / 60 + 44.18 / 3600), dec_deg: -(21 + 13 / 60 + 59.5 / 3600) },
] };

/** Resolve catalogue centers and profile geometry for a named ICRS fixture.
 * @param id - Fixture name in the historical or current planning input data.
 * @returns Polygon and tile centers in ICRS decimal degrees, with optional physical tile dimensions.
 * @throws If the requested fixture name is unknown.
 */
function fixtureInputs(id: string): { polygon: SkyPolygon; existing: TileRecord[]; profile?: TilingProfile } {
  if (id === "large_overlap") return { polygon: golden.large_overlap.polygon, existing: catalogue };
  if (id === "wide_polygon") return { polygon: widePolygon, existing: [] };
  const fixture = golden.planner_cases.find((entry) => entry.id === id);
  if (fixture) return { polygon: fixture.polygon, existing: fixture.existing_tiles as TileRecord[], profile: fixture.profile as TilingProfile | undefined };
  const historical = golden.historical_cases.find((entry) => entry.id === id);
  if (!historical) throw new Error(`Unknown planning fixture: ${id}`);
  return { polygon: historical.polygon, existing: historical.existing_names.map((name) => byName.get(name)!) };
}

/** Measure coverage and marginal efficiency immediately before one selected tile.
 * @param polygon - Ordered ICRS polygon vertices in decimal degrees.
 * @param existing - Already present field centers in ICRS decimal degrees.
 * @param selected - Earlier proposals in greedy order, also in decimal degrees.
 * @param next - Next proposal center whose physical footprint is tested.
 * @param profile - Physical tile width and height in degrees.
 * @returns Unrounded weighted coverage fraction and newly covered sampled area divided by physical tile area.
 */
function nextTileEfficiency(polygon: SkyPolygon, existing: TileRecord[], selected: TileRecord[], next: TileRecord, profile: TilingProfile): { coverage: number; efficiency: number } {
  const grid = sampleRegion(polygon);
  const covered = coveredMask(grid, [...existing, ...selected], profile);
  const nextMask = tileMask(grid, next.ra_deg, next.dec_deg, profile);
  let coveredWeight = 0;
  let gain = 0;
  for (let index = 0; index < grid.weights.length; index += 1) {
    if (covered[index]) coveredWeight += grid.weights[index];
    else if (nextMask[index]) gain += grid.weights[index];
  }
  return { coverage: coveredWeight / grid.totalWeight, efficiency: gain * grid.cellAreaDeg2 / (profile.tile_width_deg * profile.tile_height_deg) };
}

describe("v0.2.0 T80-South Efficient coverage contract", () => {
  it.each(Object.entries(contract.plans))("matches %s without changing candidates or selected prefixes", (id, expected) => {
    const { polygon, existing, profile } = fixtureInputs(id);
    const complete = planRegion(polygon, existing, profile ? "custom" : undefined, profile);
    const efficient = planRegion(polygon, existing, profile ? "custom" : undefined, profile, "efficient");
    expect(complete.coverage_strategy).toBe("complete");
    expect(efficient.coverage_strategy).toBe("efficient");
    expect(complete.tiles).toHaveLength(expected.complete_tiles);
    expect(efficient.tiles).toHaveLength(expected.efficient_tiles);
    expect(efficient.metrics.selected_region_coverage).toBeCloseTo(expected.efficient_coverage, 5);
    expect(efficient.candidate_centers).toEqual(complete.candidate_centers);
    expect(efficient.inference).toEqual(complete.inference);
    expect(efficient.solution).toBe(complete.solution);
    expect(efficient.generation_method).toBe(complete.generation_method);
    expect(efficient.tiles.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg])).toEqual(
      complete.tiles.slice(0, efficient.tiles.length).map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]),
    );
    expect(efficient.tiles.every((tile) => tile.metadata.coverage_strategy === "efficient")).toBe(true);
    expect(efficient.metrics.remaining_uncovered_fraction).toBeCloseTo(1 - efficient.metrics.selected_region_coverage, 4);
    if (expected.efficient_coverage < 1) expect(efficient.metrics.remaining_uncovered_area_deg2).toBeGreaterThan(0);
    if (id === "empty_rectangle") expect(efficient.solution).toBe("profile_fallback");
    if (id === "wide_polygon") {
      const terminal = nextTileEfficiency(polygon, existing, efficient.tiles.slice(0, -1), efficient.tiles[efficient.tiles.length - 1], loadProfile());
      expect(terminal.efficiency).toBeGreaterThanOrEqual(EFFICIENT_MIN_MARGINAL_EFFICIENCY);
    }
  });

  it("stops primary selection after the floor when the next large-overlap gain is below 3%", () => {
    const { polygon, existing } = fixtureInputs("large_overlap");
    const complete = planRegion(polygon, existing);
    const efficient = planRegion(polygon, existing, undefined, undefined, "efficient");
    const next = nextTileEfficiency(polygon, existing, efficient.tiles, complete.tiles[efficient.tiles.length], loadProfile());
    expect(efficient.tiles).toHaveLength(20);
    expect(next.coverage).toBeGreaterThanOrEqual(EFFICIENT_MIN_COVERAGE);
    expect(next.efficiency).toBeCloseTo(0.029364, 5);
    expect(next.efficiency).toBeLessThan(EFFICIENT_MIN_MARGINAL_EFFICIENCY);
    expect(efficient.diagnostics.some((line) => line.startsWith("Added "))).toBe(false);
    expect(planRegion(polygon, existing, undefined, undefined, "efficient")).toEqual(efficient);
  });

  it("accepts tile 14 below the floor and rejects tile 15 after the floor", () => {
    const { polygon, existing } = fixtureInputs("empty_rectangle");
    const complete = planRegion(polygon, existing);
    const profile = loadProfile();
    const beforeFourteenth = nextTileEfficiency(polygon, existing, complete.tiles.slice(0, 13), complete.tiles[13], profile);
    const beforeFifteenth = nextTileEfficiency(polygon, existing, complete.tiles.slice(0, 14), complete.tiles[14], profile);
    expect(beforeFourteenth.coverage).toBeLessThan(EFFICIENT_MIN_COVERAGE);
    expect(beforeFifteenth.coverage).toBeGreaterThanOrEqual(EFFICIENT_MIN_COVERAGE);
    expect(beforeFifteenth.efficiency).toBeLessThan(EFFICIENT_MIN_MARGINAL_EFFICIENCY);
  });

  it("retains gap-fill and applies the stop in that stage", () => {
    const { polygon, existing } = fixtureInputs("splus_b_single");
    const complete = planRegion(polygon, existing);
    const efficient = planRegion(polygon, existing, undefined, undefined, "efficient");
    expect(complete.diagnostics).toContainEqual(expect.stringMatching(/^Added 2 overlap-fill tiles/));
    expect(efficient.diagnostics).toContainEqual(expect.stringMatching(/^Added 1 overlap-fill tile/));
  });

  it("uses a strict comparison at 0.03 and protects the coverage floor", () => {
    const profile = { ...loadProfile(), tile_width_deg: 1, tile_height_deg: 1 };
    const grid: CoverageGrid = {
      ra: new Float64Array(1000), dec: new Float64Array(1000), weights: new Float64Array(1000).fill(1),
      totalWeight: 1000, stepDeg: 1, centerRaDeg: 0, centerDecDeg: 0, raSpanDeg: 1,
      decMinDeg: 0, decMaxDeg: 1, cellAreaDeg2: 0.03,
    };
    const existing = new Uint8Array(1000).fill(1);
    existing[999] = 0;
    const candidate = [{ center: [0, 0] as [number, number], mask: new Uint8Array(1000) }];
    candidate[0].mask[999] = 1;
    expect(greedyChoose(candidate, existing, grid, profile, 1, "efficient")).toHaveLength(1);
    grid.cellAreaDeg2 = 0.029;
    expect(greedyChoose(candidate, existing, grid, profile, 1, "efficient")).toHaveLength(0);
    existing.fill(0);
    expect(greedyChoose(candidate, existing, grid, profile, 1, "efficient")).toHaveLength(1);
  });
});
