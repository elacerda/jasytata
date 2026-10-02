import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AladinMap from "./AladinMap";
import A from "aladin-lite";
import { profileRegistry, T80_SOUTH_INSTRUMENT_V2 } from "./profiles";
import type { CatalogueDataset, TileRecord, TilingProfile } from "./types";
import { tileFootprintBoundaries } from "./sky";
import { regionViewport } from "./region-viewport";

const aladinMocks = vi.hoisted(() => {
  const handlers = new Map<string, (value: unknown) => void>();
  const catalogues: Array<{ show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; addSources: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn> }> = [];
  const overlays: Array<{ add: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn>; reportChange: ReturnType<typeof vi.fn>; shapes: unknown[]; painted: unknown[] }> = [];
  const instance = {
    on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
    off: vi.fn(), addCatalog: vi.fn(), addOverlay: vi.fn(), removeOverlay: vi.fn(), remove: vi.fn(),
    getRaDec: vi.fn(() => [150, -30]), getFoV: vi.fn(() => [100, 80]),
    gotoRaDec: vi.fn(), setFoV: vi.fn(), select: vi.fn(), pix2world: vi.fn((x: number, y: number) => [x, y]),
    fire: vi.fn(), view: { selector: { dispatch: vi.fn() } },
  };
  return { handlers, catalogues, overlays, instance };
});

vi.mock("aladin-lite", () => ({ default: {
  init: Promise.resolve(),
  aladin: vi.fn(() => aladinMocks.instance),
  catalog: vi.fn(() => {
    const catalogue = { show: vi.fn(), hide: vi.fn(), addSources: vi.fn(), removeAll: vi.fn() };
    aladinMocks.catalogues.push(catalogue);
    return catalogue;
  }),
  source: (ra: number, dec: number, data: Record<string, unknown>) => ({ ra, dec, data }),
  graphicOverlay: () => {
    const overlay = {
      shapes: [] as unknown[], painted: [] as unknown[],
      add: vi.fn(), removeAll: vi.fn(), reportChange: vi.fn(),
    };
    overlay.add.mockImplementation((shape: unknown, redraw = true) => {
      overlay.shapes.push(shape);
      if (redraw) overlay.painted = [...overlay.shapes];
    });
    overlay.removeAll.mockImplementation(() => { overlay.shapes = []; });
    overlay.reportChange.mockImplementation(() => { overlay.painted = [...overlay.shapes]; });
    aladinMocks.overlays.push(overlay);
    return overlay;
  },
  polyline: vi.fn((vertices: unknown) => vertices), circle: vi.fn(),
} }));

const profile: TilingProfile = {
  id: "splus-t80-south", display_name: "S-PLUS / T80-South", tile_width_deg: 1.4,
  tile_height_deg: 1.4, effective_overlap_arcsec: 120, coordinate_frame: "icrs",
  export_epoch_default: "2000", export_epoch_options: ["2000"], algorithm: "SPLUS_LEGACY_GRID_V1",
};

function dataset(id: string, filename: string, visible = true, instrumentProfileId = "t80-south"): CatalogueDataset {
  const tile: TileRecord = {
    id: `${id}:1`, name: filename, ra_deg: 150, dec_deg: -30,
    source: "original", generation_method: null,
    dataset_id: id, dataset_name: filename, instrument_profile_id: instrumentProfileId,
    inference_role: "auto", original_values: { ra: "150", dec: "-30" },
    metadata: { quality: "good" },
  };
  return { id, filename, color: id === "a" ? "cyan" : "violet", ra_column: "ra",
    dec_column: "dec", instrument_profile_id: instrumentProfileId, inference_role: "auto", tiles: [tile], visible };
}

describe("native Aladin catalogue layers", () => {
  beforeEach(() => {
    aladinMocks.catalogues.length = 0;
    aladinMocks.overlays.length = 0;
    aladinMocks.instance.addCatalog.mockClear();
    aladinMocks.instance.addOverlay.mockClear();
    aladinMocks.instance.removeOverlay.mockClear();
    aladinMocks.handlers.clear();
    vi.stubGlobal("ResizeObserver", class {
      observe() { /* Aladin reacts to viewport changes in the browser. */ }
      disconnect() { /* No observer state in this test. */ }
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("fits a narrow region across the RA zero boundary", () => {
    const fit = regionViewport({ vertices: [
      { ra_deg: 359.5, dec_deg: -1 }, { ra_deg: 0.5, dec_deg: -1 },
      { ra_deg: 0.5, dec_deg: 1 }, { ra_deg: 359.5, dec_deg: 1 },
    ] });
    expect(fit.centerRaDeg).toBeCloseTo(0, 10);
    expect(fit.centerDecDeg).toBe(0);
    expect(fit.fieldOfViewDeg).toBeCloseTo(2.8, 1);
  });

  it("focuses only a finalized selected region when its request changes", async () => {
    const region = { vertices: [
      { ra_deg: 359.5, dec_deg: -1 }, { ra_deg: 0.5, dec_deg: -1 },
      { ra_deg: 0.5, dec_deg: 1 }, { ra_deg: 359.5, dec_deg: 1 },
    ] };
    const base = {
      tiles: [], datasets: [], profile: null, mode: "idle" as const, selectingRegion: false,
      selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null,
      selectedPolygon: region, anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} />);
    await waitFor(() => expect(A.aladin).toHaveBeenCalled());
    aladinMocks.instance.gotoRaDec.mockClear();
    aladinMocks.instance.setFoV.mockClear();
    view.rerender(<AladinMap {...base} regionFocusRequest={1} />);
    await waitFor(() => expect(aladinMocks.instance.gotoRaDec).toHaveBeenCalledWith(0, 0));
    expect(aladinMocks.instance.setFoV).toHaveBeenCalledWith(expect.closeTo(2.8, 1));
  });

  it("keeps datasets independent, toggles native visibility, and resolves source metadata", async () => {
    const onTileSelect = vi.fn();
    const first = dataset("a", "first.csv");
    const second = dataset("b", "second.csv");
    const base = {
      tiles: [...first.tiles, ...second.tiles], profile, mode: "idle" as const, selectingRegion: false,
      selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null, selectedPolygon: null,
      anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect, onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} datasets={[first, second]} />);
    await waitFor(() => expect(aladinMocks.catalogues).toHaveLength(2));
    expect(aladinMocks.instance.addCatalog).toHaveBeenCalledTimes(2);
    const nativeSource = aladinMocks.catalogues[1].addSources.mock.calls[0][0][0];
    expect(nativeSource.data).toEqual({ RA: "150.000000", DEC: "-30.000000", Dataset: "second.csv", quality: "good" });
    aladinMocks.handlers.get("objectClicked")?.(nativeSource);
    expect(onTileSelect).toHaveBeenCalledWith(second.tiles[0]);
    aladinMocks.handlers.get("objectHovered")?.(nativeSource);
    expect(onTileSelect).toHaveBeenCalledTimes(2);
    view.rerender(<AladinMap {...base} tiles={[first.tiles[0]]} datasets={[first, { ...second, visible: false }]} />);
    expect(aladinMocks.catalogues).toHaveLength(2);
    expect(aladinMocks.catalogues[1].hide).toHaveBeenCalled();
    expect(aladinMocks.catalogues[0].hide).not.toHaveBeenCalled();
    view.rerender(<AladinMap {...base} datasets={[first, second]} />);
    expect(aladinMocks.catalogues[1].show).toHaveBeenCalled();
  });

  it("detaches removed imported catalogue and footprint without affecting remaining datasets", async () => {
    const first = dataset("a", "first.csv");
    const second = dataset("b", "second.csv");
    const base = {
      tiles: [...first.tiles, ...second.tiles], datasets: [first, second], profile, mode: "idle" as const,
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0,
      selectedTileId: null, selectedPolygon: null, anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} />);
    await waitFor(() => expect(aladinMocks.instance.addCatalog).toHaveBeenCalledTimes(2));
    const staleCatalogue = aladinMocks.catalogues[0];
    const staleOverlay = aladinMocks.overlays[7];
    const preservedCatalogue = aladinMocks.catalogues[1];

    view.rerender(<AladinMap {...base} tiles={second.tiles} datasets={[second]} />);

    expect(staleCatalogue.removeAll).toHaveBeenCalled();
    expect(aladinMocks.instance.removeOverlay).toHaveBeenCalledWith(staleCatalogue);
    expect(staleOverlay.removeAll).toHaveBeenCalled();
    expect(staleOverlay.reportChange).toHaveBeenCalled();
    expect(aladinMocks.instance.removeOverlay).toHaveBeenCalledWith(staleOverlay);
    expect(preservedCatalogue.removeAll).not.toHaveBeenCalled();
    expect(preservedCatalogue.show).toHaveBeenCalled();
  });

  it("clears all imported native layers on reset and creates one clean layer on reload", async () => {
    const first = dataset("a", "tiles_nc.csv");
    const base = {
      tiles: first.tiles, datasets: [first], profile, mode: "idle" as const,
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0,
      selectedTileId: null, selectedPolygon: null, anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} />);
    await waitFor(() => expect(aladinMocks.instance.addCatalog).toHaveBeenCalledTimes(1));
    const oldCatalogue = aladinMocks.catalogues[0];
    const oldOverlay = aladinMocks.overlays[7];

    view.rerender(<AladinMap {...base} tiles={[]} datasets={[]} />);
    expect(oldCatalogue.removeAll).toHaveBeenCalled();
    expect(aladinMocks.instance.removeOverlay).toHaveBeenCalledWith(oldCatalogue);
    expect(oldOverlay.removeAll).toHaveBeenCalled();
    expect(aladinMocks.instance.removeOverlay).toHaveBeenCalledWith(oldOverlay);

    const reloaded = dataset("a-reloaded", "tiles_nc.csv");
    view.rerender(<AladinMap {...base} tiles={reloaded.tiles} datasets={[reloaded]} />);
    expect(aladinMocks.instance.addCatalog).toHaveBeenCalledTimes(2);
    expect(aladinMocks.catalogues).toHaveLength(2);
    expect(aladinMocks.catalogues[1].addSources).toHaveBeenCalledTimes(1);
    expect(aladinMocks.catalogues[1].addSources.mock.calls[0][0]).toHaveLength(1);
  });

  it("does not detach proposal, reference, or candidate layers while removing an import", async () => {
    const imported = dataset("a", "import.csv");
    const proposed: TileRecord = {
      ...imported.tiles[0], id: "proposal:1", source: "proposed", generation_method: "manual",
      dataset_id: undefined, dataset_name: undefined,
    };
    const base = {
      tiles: [...imported.tiles, proposed], datasets: [imported], profile, mode: "idle" as const,
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0,
      selectedTileId: null, selectedPolygon: null, anchorTileIds: [], candidateCenters: [{ ra_deg: 151, dec_deg: -30 }],
      referenceMarker: { ra_deg: 152, dec_deg: -30 },
      planningLayers: { proposals: true, region: true, anchors: false, lattice: true },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} />);
    await waitFor(() => expect(aladinMocks.catalogues).toHaveLength(3));
    const proposalCatalogue = aladinMocks.catalogues[1];
    const referenceCatalogue = aladinMocks.catalogues[2];
    const candidateLayer = aladinMocks.overlays[4];

    view.rerender(<AladinMap {...base} tiles={[]} datasets={[]} />);

    expect(aladinMocks.instance.removeOverlay).toHaveBeenCalledTimes(2);
    expect(aladinMocks.instance.removeOverlay).not.toHaveBeenCalledWith(proposalCatalogue);
    expect(aladinMocks.instance.removeOverlay).not.toHaveBeenCalledWith(referenceCatalogue);
    expect(aladinMocks.instance.removeOverlay).not.toHaveBeenCalledWith(candidateLayer);
    cleanup();
  });

  it("renders each dataset with its associated instrument footprint", async () => {
    aladinMocks.instance.getFoV.mockReturnValue([30, 20]);
    const instrumentProfileId = "aladin-circle-test-camera";
    profileRegistry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: instrumentProfileId,
      display_name: "Aladin circle test camera",
      footprint: { type: "circle", radius_deg: 0.2 },
    });
    const circular = dataset("circle", "circle.csv", true, instrumentProfileId);
    const base = {
      tiles: circular.tiles, datasets: [circular], profile, mode: "idle" as const,
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0,
      selectedTileId: null, selectedPolygon: null, anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    render(<AladinMap {...base} />);
    await waitFor(() => expect(aladinMocks.catalogues).toHaveLength(1));
    expect(aladinMocks.overlays[7].shapes).toHaveLength(1);
    expect(aladinMocks.overlays[7].shapes[0]).toHaveLength(101);
    aladinMocks.instance.getFoV.mockReturnValue([100, 80]);
  });

  it("keeps source footprints pinned to their dataset instrument when output has no survey", async () => {
    aladinMocks.instance.getFoV.mockReturnValue([30, 20]);
    const source = dataset("kcwi-source", "kcwi-source.csv", true, "keck-kcwi-small");
    const base = {
      tiles: source.tiles, datasets: [source], profile: null, mode: "idle" as const,
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null,
      selectedPolygon: null, anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    render(<AladinMap {...base} />);
    await waitFor(() => expect(aladinMocks.overlays[7].shapes).toHaveLength(1));
    const instrument = profileRegistry.resolveAnyInstrumentProfile("keck-kcwi-small");
    expect(aladinMocks.overlays[7].shapes[0]).toEqual(tileFootprintBoundaries(source.tiles[0], instrument.footprint)[0]);
    aladinMocks.instance.getFoV.mockReturnValue([100, 80]);
  });

  it("renders an accepted standalone v3 pointing without a survey tiling profile", async () => {
    aladinMocks.instance.getFoV.mockReturnValue([30, 20]);
    const tile: TileRecord = {
      id: "standalone-kcwi-pointing", name: "KCWI manual center", ra_deg: 150, dec_deg: -30,
      source: "proposed", generation_method: "manual", enabled: true,
      instrument_profile_id: "keck-kcwi-small", original_values: null, metadata: {},
      placement_provenance: { origin: "manual" },
    };
    render(<AladinMap
      tiles={[tile]} datasets={[]} profile={null} mode="idle" selectingRegion={false}
      selectionRequest={0} focusRequest={0} regionFocusRequest={0} selectedTileId={null} selectedPolygon={null}
      anchorTileIds={[]} candidateCenters={[]}
      planningLayers={{ proposals: true, region: true, anchors: false, lattice: false }}
      pointingGeometryContext={{ orientationPolicyForTile: () => ({ policy: "fixed", required: true }) }}
      onSkyClick={vi.fn()} onTileSelect={vi.fn()} onRegionSelect={vi.fn()} onCancelRegion={vi.fn()} onError={vi.fn()}
    />);

    await waitFor(() => expect(aladinMocks.overlays[1].shapes).toHaveLength(1));
    const instrument = profileRegistry.resolveAnyInstrumentProfile("keck-kcwi-small");
    expect(aladinMocks.overlays[1].shapes[0]).toEqual(tileFootprintBoundaries(tile, instrument.footprint)[0]);
    aladinMocks.instance.getFoV.mockReturnValue([100, 80]);
  });

  it("uses Aladin's native polygon selector and clears only the region overlay", async () => {
    const onRegionSelect = vi.fn();
    const first = dataset("a", "first.csv");
    const base = {
      tiles: first.tiles, datasets: [first], profile, mode: "idle" as const, selectingRegion: false,
      focusRequest: 0, regionFocusRequest: 0, selectedTileId: null, selectedPolygon: null,
      anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect, onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} selectionRequest={0} />);
    await waitFor(() => expect(aladinMocks.instance.addCatalog).toHaveBeenCalled());
    aladinMocks.instance.select.mockImplementationOnce((_mode, callback) => {
      callback({ vertices: [{ x: 359, y: -30 }, { x: 1, y: -30 }, { x: 1, y: -28 }] });
      return Promise.resolve();
    });
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={1} />);
    await waitFor(() => expect(onRegionSelect).toHaveBeenCalledTimes(1));
    expect(aladinMocks.instance.select).toHaveBeenCalledWith("poly", expect.any(Function));
    const polygon = onRegionSelect.mock.calls[0][0];
    expect(polygon.vertices.map((vertex: { ra_deg: number }) => vertex.ra_deg)).toEqual([359, 1, 1]);
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={1} selectedPolygon={polygon} />);
    expect(aladinMocks.overlays[5].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[5].painted).toHaveLength(1);
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={1} selectedPolygon={null} />);
    expect(aladinMocks.overlays[5].removeAll).toHaveBeenCalled();
    expect(aladinMocks.overlays[5].painted).toEqual([]);
    expect(aladinMocks.overlays[5].reportChange).toHaveBeenCalled();
    expect(aladinMocks.catalogues[0].removeAll).not.toHaveBeenCalled();

    aladinMocks.instance.select.mockResolvedValueOnce(undefined);
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={2} />);
    await waitFor(() => expect(aladinMocks.instance.select).toHaveBeenCalledTimes(2));
    view.rerender(<AladinMap {...base} selectingRegion={false} selectionRequest={2} />);
    await waitFor(() => expect(aladinMocks.instance.fire).toHaveBeenCalledWith("default"));
  });

  it("replaces polygon A with B and lets the drawing controls finish or cancel", async () => {
    const user = userEvent.setup();
    const first = dataset("a", "first.csv");
    const polygonA = { vertices: [
      { ra_deg: 120, dec_deg: -30 }, { ra_deg: 122, dec_deg: -30 }, { ra_deg: 122, dec_deg: -28 },
    ] };
    const polygonB = { vertices: [
      { ra_deg: 150, dec_deg: -30 }, { ra_deg: 152, dec_deg: -30 }, { ra_deg: 152, dec_deg: -28 },
    ] };
    const base = {
      tiles: first.tiles, datasets: [first], profile, mode: "idle" as const,
      focusRequest: 0, regionFocusRequest: 0, selectedTileId: null, anchorTileIds: [], candidateCenters: [],
      planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const view = render(<AladinMap {...base} selectingRegion={false} selectionRequest={0} selectedPolygon={polygonA} />);
    await waitFor(() => expect(aladinMocks.overlays[5].painted).toHaveLength(1));
    expect(aladinMocks.overlays[5].painted[0]).toEqual(expect.arrayContaining([[120, -30]]));
    aladinMocks.instance.select.mockResolvedValue(undefined);
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={1} selectedPolygon={null} />);
    expect(aladinMocks.overlays[5].painted).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Finish polygon" }));
    expect(aladinMocks.instance.view.selector.dispatch).toHaveBeenCalledWith("finish");
    view.rerender(<AladinMap {...base} selectingRegion={false} selectionRequest={1} selectedPolygon={polygonB} />);
    expect(aladinMocks.overlays[5].painted).toHaveLength(1);
    expect(aladinMocks.overlays[5].painted[0]).toEqual(expect.arrayContaining([[150, -30]]));
    expect(aladinMocks.overlays[5].painted[0]).not.toEqual(expect.arrayContaining([[120, -30]]));
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={2} selectedPolygon={null} />);
    await user.click(screen.getByRole("button", { name: "Cancel drawing" }));
    expect(base.onCancelRegion).toHaveBeenCalledOnce();
  });

  it("batches candidate repaint while retaining full input and visual culling", async () => {
    aladinMocks.instance.getFoV.mockReturnValue([20, 20]);
    const candidates = Array.from({ length: 1500 }, (_, i) => ({ ra_deg: 150 + i / 10000, dec_deg: -30 }));
    const base = { datasets: [], tiles: [], profile, mode: "idle" as const, selectingRegion: false, focusRequest: 0, regionFocusRequest: 0,
      selectedTileId: null, selectedPolygon: null, anchorTileIds: [], candidateCenters: [], projectCandidateCenters: candidates,
      planningLayers: { proposals: false, region: false, anchors: false, lattice: true },
      onTileSelect: vi.fn(), onSkyClick: vi.fn(), onRegionSelect: vi.fn(), onError: vi.fn(), onCancelRegion: vi.fn(), selectionRequest: 0 };
    const view = render(<AladinMap {...base} />);
    await waitFor(() => expect(aladinMocks.overlays[4]?.shapes).toHaveLength(1200));
    const layer = aladinMocks.overlays[4];
    expect(layer.add.mock.calls.every((call) => call[1] === false)).toBe(true);
    layer.add.mockClear(); layer.reportChange.mockClear();
    view.rerender(<AladinMap {...base} planningLayers={{ ...base.planningLayers, lattice: false }} />);
    expect(layer.add).not.toHaveBeenCalled(); expect(layer.reportChange).toHaveBeenCalledOnce();
    expect(layer.painted).toEqual([]); expect(candidates).toHaveLength(1500);
    layer.reportChange.mockClear();
    view.rerender(<AladinMap {...base} />);
    expect(layer.add).toHaveBeenCalledTimes(1200); expect(layer.reportChange).toHaveBeenCalledOnce();
    expect(layer.painted).toHaveLength(1200); expect(candidates).toHaveLength(1500);
    view.unmount();
  });

  it("applies planning visibility to native markers and overlays", async () => {
    aladinMocks.instance.getFoV.mockReturnValue([30, 20]);
    const first = dataset("a", "first.csv");
    const proposed: TileRecord = { ...first.tiles[0], id: "proposal-1", source: "proposed", enabled: true };
    const polygon = { vertices: [
      { ra_deg: 149, dec_deg: -31 }, { ra_deg: 151, dec_deg: -31 },
      { ra_deg: 151, dec_deg: -29 }, { ra_deg: 149, dec_deg: -29 },
    ] };
    const base = {
      tiles: [...first.tiles, proposed], datasets: [first], profile, mode: "idle" as const,
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null,
      selectedPolygon: polygon, anchorTileIds: [first.tiles[0].id],
      candidateCenters: [{ ra_deg: 150, dec_deg: -30 }],
      projectCandidateCenters: [{ ra_deg: 150.1, dec_deg: -30.1 }],
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const visible = { proposals: true, region: true, anchors: true, lattice: true };
    const view = render(<AladinMap {...base} planningLayers={visible} />);
    await waitFor(() => expect(aladinMocks.overlays).toHaveLength(8));
    expect(aladinMocks.overlays[1].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[3].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[4].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[4].shapes).toHaveLength(2);
    expect(aladinMocks.overlays[5].add).toHaveBeenCalled();
    const counts = aladinMocks.overlays.map((overlay) => overlay.add.mock.calls.length);
    view.rerender(<AladinMap {...base} planningLayers={{ proposals: false, region: false, anchors: false, lattice: false }} />);
    expect(aladinMocks.catalogues[1].hide).toHaveBeenCalled();
    for (const index of [1, 3, 4, 5]) {
      expect(aladinMocks.overlays[index].add).toHaveBeenCalledTimes(counts[index]);
    }
    expect(aladinMocks.overlays[4].shapes).toHaveLength(0);
    view.rerender(<AladinMap {...base} planningLayers={visible} />);
    expect(aladinMocks.catalogues[1].show).toHaveBeenCalled();
    for (const index of [1, 3, 4, 5]) {
      expect(aladinMocks.overlays[index].add.mock.calls.length).toBeGreaterThan(counts[index]);
    }
    expect(aladinMocks.overlays[4].shapes).toHaveLength(2);
    aladinMocks.instance.getFoV.mockReturnValue([100, 80]);
  });
});

it("renders the reference in a dedicated labelled plus catalogue, independently of proposals", async () => {
  aladinMocks.catalogues.length = 0;
  const onTileSelect = vi.fn();
  const base = {
    tiles: [], datasets: [], profile, mode: "idle" as const, selectingRegion: false,
    selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null, selectedPolygon: null,
    anchorTileIds: [], candidateCenters: [], planningLayers: { proposals: false, region: false, anchors: false, lattice: false },
    onSkyClick: vi.fn(), onTileSelect, onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
  };
  vi.stubGlobal("ResizeObserver", class { observe() { /* Mock native observer. */ } disconnect() { /* Mock native observer. */ } });
  const view = render(<AladinMap {...base} referenceMarker={{ ra_deg: 37.686125, dec_deg: -21.1720833 }} />);
  await waitFor(() => expect(aladinMocks.catalogues).toHaveLength(1));
  expect(A.catalog).toHaveBeenCalledWith(expect.objectContaining({ name: "Reference coordinate · visual aid", shape: "plus", displayLabel: true, labelColumn: "label" }));
  expect(A.aladin).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ showZoomControl: true }));
  expect(aladinMocks.instance.gotoRaDec).toHaveBeenCalledWith(37.686125, -21.1720833);
  const catalogue = aladinMocks.catalogues[0];
  const nativeSource = catalogue.addSources.mock.calls.at(-1)?.[0][0];
  expect(nativeSource).toEqual({ ra: 37.686125, dec: -21.1720833, data: { label: "Reference coordinate", role: "visual reference only" } });
  aladinMocks.handlers.get("objectClicked")?.(nativeSource);
  expect(onTileSelect).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Reference coordinate marker");
  expect(view.container.querySelector(".map-zoom-hint")).toHaveTextContent("wheel to zoom");
  view.rerender(<AladinMap {...base} referenceMarker={null} />);
  expect(catalogue.removeAll).toHaveBeenCalled(); expect(catalogue.hide).toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  vi.unstubAllGlobals();
});
