import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AladinMap from "./AladinMap";
import { cases, cameraPa, matrixRegistry } from "./data/gate8/fixtures";
import referenceCsv from "./science/fixtures/tiles_nc.csv?raw";
import { resolvePlanningProfile } from "./profiles/planning";
import { createBundledProfileRegistry, type ProfileRegistry } from "./profiles/registry";
import { createDataset } from "./datasets";
import { makeCenterProposals, parseCatalogueCsv } from "./science/catalogue";
import { coverageGeometryContext } from "./science/coverage-semantics";
import { planningGeometryContext } from "./science/planning-operation";
import { planRegion } from "./science/planner";
import { resolvePointingGeometries } from "./science/pointing-geometry";
import { tileFootprintBoundaries } from "./sky";
import type { PointingGeometryContext } from "./science/pointing-geometry";
import type { SkyPolygon, TileRecord, TilingProfile } from "./types";

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
      selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null, selectedPolygon: null,
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

  it("renders persisted production footprints through registry, pointing, effective geometry, and map boundary", async () => {
    const registry = createBundledProfileRegistry();
    native.registry = registry;
    native.instance.getRaDec.mockReturnValue([150.25, -30]);
    const cases = [
      { name: "T80/S-PLUS", instrumentId: "t80-south", strategyId: "splus-t80-south", profileId: "splus-t80-south" },
      { name: "KCWI", instrumentId: "keck-kcwi-small" },
      { name: "MaNGA", instrumentId: "sdss-manga-61-fiber", strategyId: "sdss-manga-61-three-point", profileId: "sdss-manga-61-three-point" },
      { name: "CALIFA/PPAK", instrumentId: "califa-pmas-ppak-331", strategyId: "califa-ppak-three-point", profileId: "califa-ppak-three-point" },
      { name: "Rubin area-equivalent circle", instrumentId: "rubin-lsstcam-area-equivalent" },
      { name: "MUSE WFM", instrumentId: "vlt-muse-wfm", positionAngle: 37 },
      { name: "PFS target access", instrumentId: "subaru-pfs-target-access", positionAngle: 51 },
      { name: "SAMI strategy", instrumentId: "aat-sami-61core-15arcsec", strategyId: "sami-dr1-seven-position", profileId: "sami-dr1-seven-position" },
    ];

    for (const item of cases) {
      native.overlays.length = 0;
      const instrument = registry.resolveInstrumentProfile(item.instrumentId);
      const profile = item.profileId ? resolvePlanningProfile(item.profileId, undefined, registry).profile : null;
      const tile: TileRecord = {
        ...makeCenterProposals([{ ra_deg: 150.25, dec_deg: -30 }], "manual")[0],
        instrument_profile_id: item.instrumentId,
        ...(item.strategyId ? { output_strategy_id: item.strategyId } : {}),
        ...(item.positionAngle === undefined ? {} : { position_angle_deg: item.positionAngle }),
      };
      let context: PointingGeometryContext | undefined;
      if (item.strategyId && item.profileId !== "splus-t80-south") {
        context = coverageGeometryContext([tile], profile as TilingProfile, registry);
      } else if (instrument.schema_version === 3) {
        context = {
          coverageBasis: "single_exposure",
          orientationPolicyForTile: () => ({ policy: instrument.position_angle.mode, required: instrument.position_angle.required }),
        };
      }
      const geometries = resolvePointingGeometries(tile, profile, registry, context);
      const expected = geometries.flatMap((geometry) => tileFootprintBoundaries(
        { ra_deg: geometry.center[0], dec_deg: geometry.center[1] }, geometry.footprint,
      ));
      const base = {
        profile, datasets: [], tiles: [tile], mode: "idle" as const, selectingRegion: false,
        selectionRequest: 0, focusRequest: 0, regionFocusRequest: 0, selectedTileId: null, selectedPolygon: null,
        anchorTileIds: [], candidateCenters: [], planningLayers: { proposals: true, region: true, anchors: false, lattice: false },
        onSkyClick: vi.fn(), onTileSelect: vi.fn(), onRegionSelect: vi.fn(), onCancelRegion: vi.fn(), onError: vi.fn(),
        ...(context ? { pointingGeometryContext: context } : {}),
      };
      const view = render(<AladinMap {...base} />);
      await waitFor(() => expect(native.overlays).toHaveLength(7));
      await waitFor(() => expect(native.overlays[1].shapes).toEqual(expected));
      expect(native.overlays[1].shapes).toHaveLength(geometries.length);
      expect(native.overlays[1].shapes.every((path) => Array.isArray(path))).toBe(true);
      expect(base.onError).not.toHaveBeenCalled();
      view.unmount();
    }
  }, 15000);

  it("renders uploaded S-PLUS rows in the S-PLUS/T80 context without a spurious PA error", async () => {
    const registry = createBundledProfileRegistry();
    native.registry = registry;
    const profile = resolvePlanningProfile("splus-t80-south", undefined, registry).profile;
    const parsed = parseCatalogueCsv(new TextEncoder().encode(referenceCsv), "tiles_nc.csv");
    const dataset = createDataset(parsed, 0, "uploaded-splus", "t80-south", registry);
    const tile: TileRecord = {
      ...dataset.tiles[0],
      instrument_profile_id: dataset.instrument_profile_id!,
      inference_role: dataset.inference_role,
    };
    native.instance.getRaDec.mockReturnValue([tile.ra_deg, tile.dec_deg]);
    const context = planningGeometryContext({
      coverageBasis: "single_exposure",
      outputInstrumentId: "t80-south",
      outputStrategyId: "splus-t80-south",
    }, registry);
    const onError = vi.fn();

    render(<AladinMap profile={profile} datasets={[dataset]} tiles={[tile]} mode="idle" selectingRegion={false}
      selectionRequest={0} focusRequest={0} regionFocusRequest={0} selectedTileId={null} selectedPolygon={null} anchorTileIds={[]}
      candidateCenters={[]} planningLayers={{ proposals: true, region: true, anchors: false, lattice: false }}
      pointingGeometryContext={context} onSkyClick={vi.fn()} onTileSelect={vi.fn()} onRegionSelect={vi.fn()}
      onCancelRegion={vi.fn()} onError={onError} />);

    await waitFor(() => expect(native.overlays).toHaveLength(8));
    const uploadedTileBoundary = tileFootprintBoundaries(
      tile, registry.resolveInstrumentProfile("t80-south").footprint,
    )[0];
    await waitFor(() => expect(native.overlays[7].shapes).toContainEqual(uploadedTileBoundary));
    expect(onError).not.toHaveBeenCalled();
  });
});
