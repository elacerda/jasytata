import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AladinMap from "./AladinMap";
import type { CatalogueDataset, TileRecord, TilingProfile } from "./types";

const aladinMocks = vi.hoisted(() => {
  const handlers = new Map<string, (value: unknown) => void>();
  const catalogues: Array<{ show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; addSources: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn> }> = [];
  const instance = {
    on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
    off: vi.fn(), addCatalog: vi.fn(), addOverlay: vi.fn(), remove: vi.fn(),
    getRaDec: vi.fn(() => [150, -30]), getFoV: vi.fn(() => [100, 80]),
    gotoRaDec: vi.fn(), setFoV: vi.fn(),
  };
  return { handlers, catalogues, instance };
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
  graphicOverlay: () => ({ add: vi.fn(), removeAll: vi.fn() }),
  polyline: vi.fn(), circle: vi.fn(),
} }));

const profile: TilingProfile = {
  id: "splus-t80-south", display_name: "S-PLUS / T80-South", tile_width_deg: 1.4,
  tile_height_deg: 1.4, effective_overlap_arcsec: 120, coordinate_frame: "icrs",
  epoch: "J2000", algorithm: "SPLUS_LEGACY_GRID_V1",
};

function dataset(id: string, filename: string, visible = true): CatalogueDataset {
  const tile: TileRecord = {
    id: `${id}:1`, name: filename, pid: "", ra_deg: 150, dec_deg: -30,
    epoch: "", status: "", source: "original", generation_method: null,
    dataset_id: id, dataset_name: filename, original_values: { ra: "150", dec: "-30" },
    metadata: { quality: "good" },
  };
  return { id, filename, color: id === "a" ? "cyan" : "violet", ra_column: "ra",
    dec_column: "dec", tiles: [tile], visible };
}

describe("native Aladin catalogue layers", () => {
  beforeEach(() => {
    aladinMocks.catalogues.length = 0;
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
      tiles: [...first.tiles, ...second.tiles], profile, mode: "idle" as const,
      selectionRequest: 0, focusRequest: 0, selectedTileId: null, selectedBounds: null,
      anchorTileIds: [], candidateCenters: [], showLattice: true,
      onSkyClick: vi.fn(), onTileSelect, onRegionSelect: vi.fn(), onError: vi.fn(),
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
});
