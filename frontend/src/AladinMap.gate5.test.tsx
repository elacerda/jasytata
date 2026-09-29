import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AladinMap from "./AladinMap";
import { profileRegistry, T80_SOUTH_INSTRUMENT_V2 } from "./profiles";
import type { CatalogueDataset, TileRecord, TilingProfile } from "./types";
import type { PointingGeometryContext } from "./science/pointing-geometry";

const mocks = vi.hoisted(() => {
  const overlays: Array<{ add: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn>; shapes: unknown[] }> = [];
  const instance = {
    on: vi.fn(), off: vi.fn(), addCatalog: vi.fn(), addOverlay: vi.fn(), remove: vi.fn(),
    getRaDec: vi.fn(() => [150, -30]), getFoV: vi.fn(() => [30, 20]),
    gotoRaDec: vi.fn(), setFoV: vi.fn(), select: vi.fn(), pix2world: vi.fn(() => [150, -30]), fire: vi.fn(),
    view: { selector: { dispatch: vi.fn() } },
  };
  return { overlays, instance };
});

vi.mock("aladin-lite", () => ({ default: {
  init: Promise.resolve(),
  aladin: () => mocks.instance,
  catalog: () => ({ show: vi.fn(), hide: vi.fn(), addSources: vi.fn(), removeAll: vi.fn() }),
  source: (ra: number, dec: number, data: Record<string, unknown>) => ({ ra, dec, data }),
  graphicOverlay: () => {
    const overlay = { add: vi.fn(), removeAll: vi.fn(), shapes: [] as unknown[], reportChange: vi.fn() };
    overlay.add.mockImplementation((shape: unknown) => overlay.shapes.push(shape));
    overlay.removeAll.mockImplementation(() => { overlay.shapes = []; });
    mocks.overlays.push(overlay);
    return overlay;
  },
  polyline: (vertices: unknown) => vertices,
  circle: vi.fn(),
} }));

const profile: TilingProfile = {
  id: "gate5-map-profile", display_name: "Gate 5 map test", tile_width_deg: 1,
  tile_height_deg: 0.4, effective_overlap_arcsec: 0, coordinate_frame: "icrs",
  export_epoch_default: "2000", export_epoch_options: ["2000"], algorithm: "SPLUS_LEGACY_GRID_V1",
};

const baseTile = (overrides: Partial<TileRecord> = {}): TileRecord => ({
  id: "source-1", name: "source", ra_deg: 150, dec_deg: -30,
  source: "original", generation_method: null,
  dataset_id: "camera-data", dataset_name: "camera.csv", instrument_profile_id: "gate5-map-camera",
  original_values: { ra: "150", dec: "-30" }, metadata: {}, ...overrides,
});

const makeDataset = (tiles: TileRecord[]): CatalogueDataset => ({
  id: "camera-data", filename: "camera.csv", color: "cyan", ra_column: "ra", dec_column: "dec",
  instrument_profile_id: "gate5-map-camera", inference_role: "auto", tiles, visible: true,
});

function mapProps(tiles: TileRecord[], pointingGeometryContext?: PointingGeometryContext) {
  return {
    tiles, datasets: [makeDataset(tiles)], profile, mode: "idle" as const,
    selectingRegion: false, selectionRequest: 0, focusRequest: 0, selectedTileId: null, selectedPolygon: null,
    planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
    anchorTileIds: [], candidateCenters: [], pointingGeometryContext,
    onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
  };
}

function pathCenter(boundary: [number, number][]) {
  const vertices = boundary.slice(0, -1);
  return [
    vertices.reduce((sum, point) => sum + point[0], 0) / vertices.length,
    vertices.reduce((sum, point) => sum + point[1], 0) / vertices.length,
  ];
}

describe("Gate 5 map footprint orientation and exposure geometry", () => {
  beforeAll(() => {
    profileRegistry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "gate5-map-camera",
      display_name: "Gate 5 rectangular map camera",
      footprint: { type: "rectangle", width_deg: 1, height_deg: 0.4 },
    });
  });

  beforeEach(() => {
    mocks.overlays.length = 0;
    vi.stubGlobal("ResizeObserver", class {
      observe() { /* Browser viewport events are outside this focused rendering test. */ }
      disconnect() { /* No observer state is retained. */ }
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders per-pointing PA differences at the same nominal center", async () => {
    const tiles = [baseTile({ id: "pa-0", position_angle_deg: 0 }), baseTile({ id: "pa-90", position_angle_deg: 90 })];
    const context: PointingGeometryContext = {
      orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }),
      coverageBasis: "single_exposure",
    };
    render(<AladinMap {...mapProps(tiles, context)} />);
    await waitFor(() => expect(mocks.overlays[7]?.shapes).toHaveLength(2));
    const boundaries = mocks.overlays[7].shapes as [number, number][][];
    expect(boundaries[0]).not.toEqual(boundaries[1]);
    expect(pathCenter(boundaries[0])).toEqual(expect.arrayContaining([150, -30]));
    expect(pathCenter(boundaries[1])).toEqual(expect.arrayContaining([150, -30]));
  });

  it("renders every ordered exposure boundary at its derived sky-local offset center", async () => {
    const tile = baseTile({ id: "dithered", position_angle_deg: 37 });
    const context: PointingGeometryContext = {
      orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }),
      sequenceForTile: () => ({ id: "two-position-test", exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 },
        { order: 2, east_arcsec: 30, north_arcsec: 60, rotation_deg: 90 },
      ] }),
      coverageBasis: "effective_sequence",
    };
    render(<AladinMap {...mapProps([tile], context)} />);
    await waitFor(() => expect(mocks.overlays[7]?.shapes).toHaveLength(2));
    const boundaries = mocks.overlays[7].shapes as [number, number][][];
    const firstCenter = pathCenter(boundaries[0]);
    const secondCenter = pathCenter(boundaries[1]);
    expect(firstCenter[0]).toBeCloseTo(150, 5);
    expect(firstCenter[1]).toBeCloseTo(-30, 5);
    expect(secondCenter[0]).toBeCloseTo(150 + 30 / (3600 * Math.cos(Math.PI / 6)), 5);
    expect(secondCenter[1]).toBeCloseTo(-30 + 60 / 3600, 5);
    expect(boundaries[0]).not.toEqual(boundaries[1]);
  });

  it("keeps canonical single-footprint rendering usable when PA is intentionally absent", async () => {
    const tile = baseTile();
    const context: PointingGeometryContext = {
      orientationPolicyForTile: () => ({ policy: "not_applicable" }),
      coverageBasis: "single_exposure",
    };
    render(<AladinMap {...mapProps([tile], context)} />);
    await waitFor(() => expect(mocks.overlays[7]?.shapes).toHaveLength(1));
    const boundary = mocks.overlays[7].shapes[0] as [number, number][];
    expect(boundary).toHaveLength(5);
    expect(pathCenter(boundary)[0]).toBeCloseTo(150, 5);
    expect(pathCenter(boundary)[1]).toBeCloseTo(-30, 5);
  });

  it("renders assigned source footprints without an active planner profile", async () => {
    const tile = baseTile();
    render(<AladinMap {...mapProps([tile])} profile={null} />);
    await waitFor(() => expect(mocks.overlays[7]?.shapes).toHaveLength(1));
    expect(mocks.overlays[7].shapes[0]).toHaveLength(5);
  });

  it("reports a missing PA under an explicit required policy instead of hiding it silently", async () => {
    const tile = baseTile();
    const onError = vi.fn();
    const context: PointingGeometryContext = {
      orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }),
    };
    render(<AladinMap {...mapProps([tile], context)} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/per-pointing PA policy requires/i)));
    expect(mocks.overlays[7]?.shapes).toEqual([]);
  });
});
