import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AladinMap from "./AladinMap";
import { cases, cameraPa, matrixRegistry } from "./data/gate8/fixtures";
import { resolvePlanningProfile } from "./profiles/planning";
import type { ProfileRegistry } from "./profiles/registry";
import { createDataset } from "./datasets";
import { parseCatalogueCsv } from "./science/catalogue";
import { planRegion } from "./science/planner";
import { tileFootprintBoundaries } from "./sky";
import type { SkyPolygon } from "./types";

const native = vi.hoisted(() => {
  const overlays: Array<{ shapes: unknown[]; add: (shape: unknown) => void; removeAll: () => void; reportChange: () => void }> = [];
  const instance = { on: vi.fn(), off: vi.fn(), addCatalog: vi.fn(), addOverlay: vi.fn(), remove: vi.fn(),
    getRaDec: vi.fn(() => [0, -32]), getFoV: vi.fn(() => [8, 8]), gotoRaDec: vi.fn(), setFoV: vi.fn(),
    select: vi.fn(), pix2world: vi.fn((x: number, y: number) => [x, y]), fire: vi.fn(), view: { selector: { dispatch: vi.fn() } } };
  return { overlays, instance, registry: null as ProfileRegistry | null };
});
vi.mock("./profiles/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("./profiles/registry")>();
  return { ...original, profileRegistry: new Proxy({} as ProfileRegistry, { get: (_, key) => {
    const value = Reflect.get(native.registry!, key); return typeof value === "function" ? value.bind(native.registry) : value;
  } }) };
});
vi.mock("aladin-lite", () => ({ default: {
  init: Promise.resolve(), aladin: () => native.instance,
  catalog: () => ({ show: vi.fn(), hide: vi.fn(), addSources: vi.fn(), removeAll: vi.fn() }),
  source: (ra: number, dec: number, data: unknown) => ({ ra, dec, data }),
  graphicOverlay: () => {
    const overlay = { shapes: [] as unknown[], add: (shape: unknown) => { overlay.shapes.push(shape); },
      removeAll: () => { overlay.shapes = []; }, reportChange: vi.fn() };
    native.overlays.push(overlay); return overlay;
  },
  polyline: (vertices: unknown) => vertices, circle: vi.fn(),
} }));

describe("Gate 8 native Aladin render integration", () => {
  beforeEach(() => {
    native.registry = matrixRegistry(); native.overlays.length = 0; vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each(cases)("$key: native region selection → science → proposal/source detector paths, repeat redraw", async (fixture) => {
    const registry = native.registry!, profile = resolvePlanningProfile(fixture.document.survey.id, undefined, registry).profile;
    native.instance.getRaDec.mockReturnValue([fixture.origin.ra_deg, fixture.origin.dec_deg]);
    const parsed = parseCatalogueCsv(new TextEncoder().encode(`ra_deg,dec_deg,quality\n${fixture.origin.ra_deg},${fixture.origin.dec_deg},immutable\n`), `${fixture.key}.csv`);
    const dataset = createDataset(parsed, 0, fixture.key, fixture.document.instrument.id, registry);
    const onRegionSelect = vi.fn<(region: SkyPolygon) => void>();
    const base = { profile, datasets: [dataset], tiles: [], mode: "idle" as const, selectingRegion: false,
      selectionRequest: 0, focusRequest: 0, selectedTileId: null, selectedPolygon: null,
      anchorTileIds: [], candidateCenters: [], planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
      onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect, onCancelRegion: vi.fn(), onError: vi.fn() };
    const view = render(<AladinMap {...base} />);
    await waitFor(() => expect(native.overlays).toHaveLength(8));
    native.instance.select.mockImplementationOnce((_mode, callback) => {
      callback({ vertices: fixture.region.vertices.map((p) => ({ x: p.ra_deg, y: p.dec_deg })) }); return Promise.resolve();
    });
    view.rerender(<AladinMap {...base} selectingRegion selectionRequest={1} />);
    await waitFor(() => expect(onRegionSelect).toHaveBeenCalledOnce());
    const region = onRegionSelect.mock.lastCall![0];
    expect(region.vertices).toEqual(fixture.region.vertices.map(({ ra_deg, dec_deg }) => ({ ra_deg, dec_deg })));
    const plan = planRegion(region, [], fixture.document.survey.id, undefined, "complete", registry);
    const accepted = plan.tiles.map((t) => ({ ...t, position_angle_deg: cameraPa(fixture.document) }));
    const sourceRows = dataset.tiles.map((t) => ({ ...t, instrument_profile_id: dataset.instrument_profile_id }));
    view.rerender(<AladinMap {...base} tiles={[...sourceRows, ...accepted]} selectedPolygon={region} />);
    const expected = accepted.flatMap((t) => tileFootprintBoundaries(t, fixture.document.instrument.footprint));
    expect(native.overlays[1].shapes).toEqual(expected);
    expect(native.overlays[7].shapes).toEqual(tileFootprintBoundaries(sourceRows[0], fixture.document.instrument.footprint));
    expect(native.overlays[5].shapes).toHaveLength(1);
    if (fixture.key === "mosaic") {
      expect(expected).toHaveLength(2 * accepted.length);
      expect(expected.every((path) => path.length === 5)).toBe(true);
      const footprint = fixture.document.instrument.footprint;
      if (footprint.type !== "compound") throw new Error("Expected mosaic");
      expect(expected[0]).not.toEqual(tileFootprintBoundaries(accepted[0], { ...footprint, position_angle_deg: 11 })[0]);
    } else if (fixture.key !== "t80") {
      // Circles render 96 tangent sides, four exact cardinal extrema, and a closing point.
      expect(expected.every((path) => path.length === 101)).toBe(true);
    }
    if (fixture.key === "circle") {
      expect(accepted.some((t) => t.ra_deg > 359)).toBe(true);
      expect(accepted.some((t) => t.ra_deg < 1)).toBe(true);
      // Display vertices may reach 360 at floating-point wrap; centers/export
      // remain canonical. Verify finite paths and short wrapped edge deltas.
      expect(expected.flat().every(([ra, dec]) => ra >= 0 && ra <= 360 && Number.isFinite(dec))).toBe(true);
      expect(expected.every((path) => path.every(([ra], i) => i === 0 || Math.abs(((ra - path[i - 1][0] + 540) % 360) - 180) < 0.02))).toBe(true);
    }
    view.rerender(<AladinMap {...base} tiles={[...sourceRows, ...accepted]} selectedPolygon={region} planningLayers={{ ...base.planningLayers, anchors: true }} />);
    expect(native.overlays[1].shapes).toEqual(expected);
    expect(base.onError).not.toHaveBeenCalled();
  }, 15000);
});
