import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AladinMap from "./AladinMap";
import type { CatalogueDataset, TileRecord, TilingProfile } from "./types";

const aladinMocks = vi.hoisted(() => {
  const handlers = new Map<string, (value: unknown) => void>();
  const catalogues: Array<{ show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; addSources: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn> }> = [];
  const overlays: Array<{ add: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn>; reportChange: ReturnType<typeof vi.fn>; shapes: unknown[]; painted: unknown[] }> = [];
  const instance = {
    on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
    off: vi.fn(), addCatalog: vi.fn(), addOverlay: vi.fn(), remove: vi.fn(),
    getRaDec: vi.fn(() => [150, -30]), getFoV: vi.fn(() => [100, 80]),
    gotoRaDec: vi.fn(), setFoV: vi.fn(), select: vi.fn(), pix2world: vi.fn((x: number, y: number) => [x, y]),
    fire: vi.fn(), view: { selector: { dispatch: vi.fn() } },
  };
  return { handlers, catalogues, overlays, instance };
});

vi.mock("aladin-lite", () => ({ default: {
  init: Promise.resolve(),
  aladin: () => aladinMocks.instance,
  catalog: () => {
    const catalogue = { show: vi.fn(), hide: vi.fn(), addSources: vi.fn(), removeAll: vi.fn() };
    aladinMocks.catalogues.push(catalogue);
    return catalogue;
  },
  source: (ra: number, dec: number, data: Record<string, unknown>) => ({ ra, dec, data }),
  graphicOverlay: () => {
    const overlay = {
      shapes: [] as unknown[], painted: [] as unknown[],
      add: vi.fn(), removeAll: vi.fn(), reportChange: vi.fn(),
    };
    overlay.add.mockImplementation((shape: unknown) => {
      overlay.shapes.push(shape);
      overlay.painted = [...overlay.shapes];
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

function dataset(id: string, filename: string, visible = true): CatalogueDataset {
  const tile: TileRecord = {
    id: `${id}:1`, name: filename, ra_deg: 150, dec_deg: -30,
    source: "original", generation_method: null,
    dataset_id: id, dataset_name: filename, original_values: { ra: "150", dec: "-30" },
    metadata: { quality: "good" },
  };
  return { id, filename, color: id === "a" ? "cyan" : "violet", ra_column: "ra",
    dec_column: "dec", tiles: [tile], visible };
}

describe("native Aladin catalogue layers", () => {
  beforeEach(() => {
    aladinMocks.catalogues.length = 0;
    aladinMocks.overlays.length = 0;
    aladinMocks.handlers.clear();
    vi.stubGlobal("ResizeObserver", class {
      observe() { /* Aladin reacts to viewport changes in the browser. */ }
      disconnect() { /* No observer state in this test. */ }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps datasets independent, toggles native visibility, and resolves source metadata", async () => {
    const onTileSelect = vi.fn();
    const first = dataset("a", "first.csv");
    const second = dataset("b", "second.csv");
    const base = {
      tiles: [...first.tiles, ...second.tiles], profile, mode: "idle" as const, selectingRegion: false,
      selectionRequest: 0, focusRequest: 0, selectedTileId: null, selectedPolygon: null,
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

  it("uses Aladin's native polygon selector and clears only the region overlay", async () => {
    const onRegionSelect = vi.fn();
    const first = dataset("a", "first.csv");
    const base = {
      tiles: first.tiles, datasets: [first], profile, mode: "idle" as const, selectingRegion: false,
      focusRequest: 0, selectedTileId: null, selectedPolygon: null,
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
      focusRequest: 0, selectedTileId: null, anchorTileIds: [], candidateCenters: [],
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
      selectingRegion: false, selectionRequest: 0, focusRequest: 0, selectedTileId: null,
      selectedPolygon: polygon, anchorTileIds: [first.tiles[0].id],
      candidateCenters: [{ ra_deg: 150, dec_deg: -30 }],
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
    };
    const visible = { proposals: true, region: true, anchors: true, lattice: true };
    const view = render(<AladinMap {...base} planningLayers={visible} />);
    await waitFor(() => expect(aladinMocks.overlays).toHaveLength(8));
    expect(aladinMocks.overlays[1].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[3].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[4].add).toHaveBeenCalled();
    expect(aladinMocks.overlays[5].add).toHaveBeenCalled();
    const counts = aladinMocks.overlays.map((overlay) => overlay.add.mock.calls.length);
    view.rerender(<AladinMap {...base} planningLayers={{ proposals: false, region: false, anchors: false, lattice: false }} />);
    expect(aladinMocks.catalogues[1].hide).toHaveBeenCalled();
    for (const index of [1, 3, 4, 5]) {
      expect(aladinMocks.overlays[index].add).toHaveBeenCalledTimes(counts[index]);
    }
    view.rerender(<AladinMap {...base} planningLayers={visible} />);
    expect(aladinMocks.catalogues[1].show).toHaveBeenCalled();
    for (const index of [1, 3, 4, 5]) {
      expect(aladinMocks.overlays[index].add.mock.calls.length).toBeGreaterThan(counts[index]);
    }
    aladinMocks.instance.getFoV.mockReturnValue([100, 80]);
  });
});
