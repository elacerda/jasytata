import { afterEach, describe, expect, it, vi } from "vitest";
import golden from "../data/golden.json";
import referenceCsv from "../../public/data/tiles_nc.csv?raw";
import { createDataset } from "../datasets";
import { createBundledProfileRegistry, profileRegistry, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { ProfileRegistry } from "../profiles/registry";
import { loadReferenceCatalogue } from "../api";
import { parseCatalogueCsv } from "./catalogue";
import { contributingTileCountForTiles, coveredMask, measureActiveCoverage, tileMask, type CoverageGrid } from "./coverage";
import { planRegion } from "./planner";
import type { CatalogueResponse, SkyPolygon, TileRecord, TilingProfile } from "../types";

const reference = parseCatalogueCsv(new TextEncoder().encode(referenceCsv), "tiles_nc.csv");
const referenceByName = new Map(reference.tiles.map((tile) => [tile.name, tile]));

function rectangularProfile(width: number, height: number): TilingProfile {
  return {
    id: "custom",
    display_name: "Active output profile",
    tile_width_deg: width,
    tile_height_deg: height,
    effective_overlap_arcsec: 10,
    coordinate_frame: "icrs",
    export_epoch_default: "2000",
    export_epoch_options: ["2000"],
    algorithm: "RECT_GRID_V1",
  };
}

function sourceTile(
  id: string,
  ra: number,
  dec: number,
  instrumentProfileId: string,
  inferenceRole: TileRecord["inference_role"] = "auto",
): TileRecord {
  return {
    id,
    name: id,
    ra_deg: ra,
    dec_deg: dec,
    source: "original",
    enabled: true,
    generation_method: null,
    dataset_id: `${instrumentProfileId}-dataset`,
    instrument_profile_id: instrumentProfileId,
    inference_role: inferenceRole,
    group_id: `${instrumentProfileId}-dataset:catalogue`,
    original_values: null,
    metadata: {},
  };
}

function twoInstrumentGrid(): CoverageGrid {
  return {
    ra: Float64Array.from([359.7, 359.9, 359.8, 0.2, 0.2]),
    dec: Float64Array.from([0, 0, 0.25, 0.25, 0]),
    weights: Float64Array.from([1, 1, 1, 1, 1]),
    totalWeight: 5,
    stepDeg: 0.01,
    centerRaDeg: 0,
    centerDecDeg: 0.1,
    raSpanDeg: 0.5,
    decMinDeg: 0,
    decMaxDeg: 0.25,
    cellAreaDeg2: 0.0001,
  };
}

function twoInstrumentRegistry(): ProfileRegistry {
  const registry = new ProfileRegistry();
  registry.registerInstrumentProfile({
    ...T80_SOUTH_INSTRUMENT_V2,
    id: "alpha-camera",
    display_name: "Alpha camera",
    footprint: { type: "rectangle", width_deg: 0.6, height_deg: 0.2 },
  });
  registry.registerInstrumentProfile({
    ...T80_SOUTH_INSTRUMENT_V2,
    id: "beta-camera",
    display_name: "Beta camera",
    footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.6 },
  });
  return registry;
}

const mixedTiles = [
  sourceTile("alpha-center", 359.8, 0, "alpha-camera"),
  sourceTile("beta-center", 0.2, 0, "beta-camera"),
];
const expectedMixedCoverage = [1, 1, 0, 1, 1];

afterEach(() => vi.unstubAllGlobals());

describe("Gate 2 dataset and instrument separation", () => {
  it("associates the bundled reference catalogue with T80-South automatically", async () => {
    const csv = new TextEncoder().encode("RA,DEC\n10,0\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => csv.buffer,
    }));

    const result = await loadReferenceCatalogue();
    const dataset = createDataset(result, 0, "bundled-reference");

    expect(result.instrument_profile_id).toBe("t80-south");
    expect(dataset.instrument_profile_id).toBe("t80-south");
    expect(dataset.inference_role).toBe("auto");
    expect(profileRegistry.resolveInstrumentProfile(dataset.instrument_profile_id)).toEqual(T80_SOUTH_INSTRUMENT_V2);
    expect("survey_profile_id" in dataset).toBe(false);
  });

  it("preserves T80 coverage and lattice results with automatic dataset association", () => {
    const fixture = golden.historical_holdout;
    const polygon = fixture.polygon as SkyPolygon;
    const originalTiles = fixture.surrounding_names.map((name) => referenceByName.get(name)!);
    const result: CatalogueResponse = {
      filename: "tiles_nc.csv",
      row_count: originalTiles.length,
      tiles: originalTiles,
      warnings: [],
    };
    const dataset = createDataset(result, 0, "t80-holdout");
    const associatedTiles = dataset.tiles.map((tile) => ({
      ...tile,
      instrument_profile_id: dataset.instrument_profile_id,
      inference_role: dataset.inference_role,
    }));
    const legacyPlan = planRegion(polygon, originalTiles);
    const associatedPlan = planRegion(polygon, associatedTiles);

    expect(associatedPlan.solution).toBe(legacyPlan.solution);
    expect(associatedPlan.tiles.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]))
      .toEqual(legacyPlan.tiles.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]));
    expect(associatedPlan.metrics).toEqual(legacyPlan.metrics);
    expect(associatedPlan.inference).toMatchObject({
      nearby_tile_count: legacyPlan.inference.nearby_tile_count,
      compatible_neighbor_pairs: legacyPlan.inference.compatible_neighbor_pairs,
      dec_spacing_deg: legacyPlan.inference.dec_spacing_deg,
      ra_spacing_deg: legacyPlan.inference.ra_spacing_deg,
    });
    expect(associatedPlan.inference.anchor_tile_ids).toHaveLength(legacyPlan.inference.anchor_tile_ids.length);

    const registry = createBundledProfileRegistry();
    registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "other-camera",
      display_name: "Other camera",
    });
    const origin = originalTiles[0];
    const spacingDeg = 1.4 - 120 / 3600;
    const unrelatedTiles = [
      sourceTile("other-1", origin.ra_deg + 0.2, origin.dec_deg + 0.2, "other-camera"),
      sourceTile("other-2", origin.ra_deg + 0.2 + spacingDeg, origin.dec_deg + 0.2, "other-camera"),
      sourceTile("other-3", origin.ra_deg + 0.2, origin.dec_deg + 0.2 + spacingDeg, "other-camera"),
      sourceTile("other-4", origin.ra_deg + 0.2 + spacingDeg, origin.dec_deg + 0.2 + spacingDeg, "other-camera"),
    ];
    const withUnrelatedAutoData = planRegion(polygon, [...associatedTiles, ...unrelatedTiles], undefined, undefined, "complete", registry);
    expect(withUnrelatedAutoData.inference).toEqual(associatedPlan.inference);
  });

  it("uses each existing rectangular instrument's own dimensions", () => {
    const grid = twoInstrumentGrid();
    const registry = twoInstrumentRegistry();
    const activeOutput = rectangularProfile(0.6, 0.2);
    const alphaMask = coveredMask(grid, [mixedTiles[0]], activeOutput, registry);
    const betaMask = coveredMask(grid, [mixedTiles[1]], activeOutput, registry);
    const combinedMask = coveredMask(grid, mixedTiles, activeOutput, registry);

    expect([...alphaMask]).toEqual([1, 1, 0, 0, 0]);
    expect([...betaMask]).toEqual([0, 0, 0, 1, 1]);
    expect([...combinedMask]).toEqual(expectedMixedCoverage);
  });

  it("keeps source geometry when a third profile controls new output", () => {
    const grid = twoInstrumentGrid();
    const registry = twoInstrumentRegistry();
    const thirdOutput = rectangularProfile(0.05, 0.05);
    const sourceCoverage = coveredMask(grid, mixedTiles, thirdOutput, registry);
    const overwrittenCoverage = mixedTiles.reduce((combined, tile) => {
      const mask = tileMask(grid, tile.ra_deg, tile.dec_deg, thirdOutput);
      for (let index = 0; index < combined.length; index += 1) combined[index] ||= mask[index];
      return combined;
    }, new Uint8Array(grid.ra.length));

    expect([...sourceCoverage]).toEqual(expectedMixedCoverage);
    expect([...overwrittenCoverage]).not.toEqual(expectedMixedCoverage);
  });

  it("counts excluded datasets for coverage but removes them from inference", () => {
    const polygon: SkyPolygon = { vertices: [
      { ra_deg: 149.98, dec_deg: -24.02 },
      { ra_deg: 150.02, dec_deg: -24.02 },
      { ra_deg: 150.02, dec_deg: -23.98 },
      { ra_deg: 149.98, dec_deg: -23.98 },
    ] };
    const excluded = sourceTile("excluded-t80", 150, -24, "t80-south", "exclude");
    const plan = planRegion(polygon, [excluded]);

    expect(plan.inference.nearby_tile_count).toBe(0);
    expect(plan.inference.anchor_tile_ids).toEqual([]);
    expect(plan.metrics.already_covered_fraction).toBe(1);
    expect(plan.metrics.existing_tiles_contributing).toBe(1);
  });

  it("covers mixed source footprints and keeps source geometry independent from output geometry", () => {
    const registry = createBundledProfileRegistry();
    registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "circle-camera",
      display_name: "Circular camera",
      footprint: { type: "circle", radius_deg: 0.1 },
    });
    registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "polygon-camera",
      display_name: "Polygon camera",
      footprint: { type: "polygon", vertices_deg: [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]] },
    });
    registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "mosaic-camera",
      display_name: "Mosaic camera",
      footprint: { type: "compound", components: [
        { offset_deg: [-0.25, 0], footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.2 } },
        { offset_deg: [0.25, 0], footprint: { type: "rectangle", width_deg: 0.2, height_deg: 0.2 } },
      ] },
    });
    registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "output-camera",
      display_name: "Independent output camera",
      footprint: { type: "circle", radius_deg: 0.04 },
    });
    registry.registerSurveyProfile({
      ...SPLUS_SURVEY_V2,
      id: "independent-output-survey",
      display_name: "Independent output survey",
      instrument_id: "output-camera",
    });

    const grid: CoverageGrid = {
      ra: Float64Array.from([359.95, 0.03, 0.07, 0.3, 0.5, 0.75, 1, 1.03, 1.25]),
      dec: Float64Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      weights: Float64Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      totalWeight: 9,
      stepDeg: 0.01,
      centerRaDeg: 0.4,
      centerDecDeg: 0,
      raSpanDeg: 1.3,
      decMinDeg: 0,
      decMaxDeg: 0,
      cellAreaDeg2: 0.0001,
    };
    const sources = [
      sourceTile("circle-source", 359.99, 0, "circle-camera", "exclude"),
      sourceTile("polygon-source", 0.4, 0, "polygon-camera", "exclude"),
      sourceTile("mosaic-source", 1, 0, "mosaic-camera", "exclude"),
    ];
    const activeOutput = { ...rectangularProfile(0.4, 0.4), id: "independent-output-survey" };
    const proposal = sourceTile("output-proposal", 1.03, 0, "mosaic-camera", "exclude");
    proposal.source = "proposed";
    proposal.instrument_profile_id = "mosaic-camera";

    expect([...coveredMask(grid, sources, activeOutput, registry)]).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 1]);
    expect([...coveredMask(grid, [proposal], activeOutput, registry)]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 0]);

    const proposalRegion: SkyPolygon = { vertices: [
      { ra_deg: 0.98, dec_deg: -0.05 }, { ra_deg: 1.08, dec_deg: -0.05 },
      { ra_deg: 1.08, dec_deg: 0.05 }, { ra_deg: 0.98, dec_deg: 0.05 },
    ] };
    const planningRegistry = new ProfileRegistry();
    planningRegistry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "small-output-camera",
      display_name: "Small circular output camera",
      footprint: { type: "circle", radius_deg: 0.04 },
    });
    planningRegistry.registerSurveyProfile({
      ...SPLUS_SURVEY_V2,
      display_name: "Small circular output survey",
      instrument_id: "small-output-camera",
    });
    const plan = planRegion(proposalRegion, [], undefined, undefined, "complete", planningRegistry);
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.metrics).toEqual(measureActiveCoverage(
      proposalRegion,
      [],
      plan.tiles,
      undefined,
      undefined,
      planningRegistry,
    ));
    expect(plan.metrics.selected_region_coverage).toBeLessThan(1);

    const acrossRaZero: SkyPolygon = { vertices: [
      { ra_deg: 359.8, dec_deg: -0.2 }, { ra_deg: 1.4, dec_deg: -0.2 },
      { ra_deg: 1.4, dec_deg: 0.2 }, { ra_deg: 359.8, dec_deg: 0.2 },
    ] };
    expect(contributingTileCountForTiles(acrossRaZero, sources, activeOutput, registry)).toBe(3);
  });

  it("uses the active rotated output rectangle for proposed coverage", () => {
    const registry = createBundledProfileRegistry();
    registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "rotated-camera",
      display_name: "Rotated camera",
      footprint: { type: "rectangle", width_deg: 0.4, height_deg: 0.1, position_angle_deg: 90 },
    });
    registry.registerSurveyProfile({
      ...SPLUS_SURVEY_V2,
      id: "rotated-output-survey",
      display_name: "Rotated output survey",
      instrument_id: "rotated-camera",
    });
    const grid: CoverageGrid = {
      ra: Float64Array.from([149.7, 150, 150.3]),
      dec: Float64Array.from([-24, -23.8, -24]),
      weights: Float64Array.from([1, 1, 1]),
      totalWeight: 3,
      stepDeg: 0.01,
      centerRaDeg: 150,
      centerDecDeg: -24,
      raSpanDeg: 0.6,
      decMinDeg: -24,
      decMaxDeg: -23.8,
      cellAreaDeg2: 0.0001,
    };
    const output = { ...rectangularProfile(0.4, 0.1), id: "rotated-output-survey" };
    expect([...tileMask(grid, 150, -24, registry.resolveInstrumentProfile("rotated-camera").footprint)])
      .toEqual([0, 1, 0]);
    const proposal = sourceTile("rotated-proposal", 150, -24, "rotated-camera", "exclude");
    proposal.source = "proposed";
    expect([...coveredMask(grid, [proposal], output, registry)]).toEqual([0, 1, 0]);
  });
});
