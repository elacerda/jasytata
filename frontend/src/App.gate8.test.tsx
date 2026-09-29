import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { cases, cameraPa, matrixRegistry } from "./data/gate8/fixtures";
import type { ProfileRegistry } from "./profiles/registry";
import { createBundledProfileRegistry } from "./profiles/registry";
import { parseProfileJson, serializeProfile } from "./profiles/document";
import { planRegion } from "./science/planner";
import { measureActiveCoverage } from "./science/coverage";
import { buildExportCsv } from "./science/export";
import { readCsv } from "./science/catalogue";
import { outputFootprintForProfile } from "./profiles/footprints";
import { tileFootprintBoundaries } from "./sky";
import type { CatalogueDataset, SkyPolygon, TileRecord, TilingProfile } from "./types";
import golden from "./data/golden.json";
import plannerContract from "./data/planner-contract.json";
import referenceCsv from "../public/data/tiles_nc.csv?raw";

interface MapModel {
  tiles: TileRecord[];
  datasets: CatalogueDataset[];
  profile: TilingProfile;
  onRegionSelect: (polygon: SkyPolygon) => void;
  onSkyClick: (ra: number, dec: number) => void;
}
const session = vi.hoisted(() => ({ registry: null as ProfileRegistry | null, map: null as MapModel | null, region: null as SkyPolygon | null, origin: { ra_deg: 0, dec_deg: 0 } }));

// Keep the actual API, planner, coverage, catalogue and export. Only isolate the
// browser-memory registry and replace Aladin's remote renderer with its props.
vi.mock("./profiles/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("./profiles/registry")>();
  const proxy = new Proxy({} as ProfileRegistry, { get: (_, key) => {
    const value = Reflect.get(session.registry!, key);
    return typeof value === "function" ? value.bind(session.registry) : value;
  } });
  return { ...original, profileRegistry: proxy };
});
vi.mock("./AladinMap", async () => {
  const React = await import("react");
  return { default: (props: MapModel) => {
    session.map = props;
    return React.createElement("div", {},
      React.createElement("button", { onClick: () => props.onRegionSelect(session.region!) }, "Select G8 region"),
      React.createElement("button", { onClick: () => props.onSkyClick(session.origin.ra_deg, session.origin.dec_deg) }, "G8 sky click"));
  } };
});

/** Browser file bytes, without depending on jsdom's incomplete File.arrayBuffer. */
function inputFile(text: string, name: string): File {
  const file = new File([text], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

/** Read the exact CSV Blob emitted by the real browser download API. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error); reader.readAsText(blob);
  });
}

/** Edit a browser authoring field, exercising its controlled numeric/text draft. */
async function edit(user: ReturnType<typeof userEvent.setup>, name: string, value: string) {
  const field = screen.getByRole("textbox", { name }); await user.clear(field); await user.type(field, value);
}

describe("Gate 8 real App workflow matrix", () => {
  let downloads: Blob[];
  beforeEach(() => {
    session.registry = createBundledProfileRegistry(); session.map = null; downloads = [];
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { downloads.push(blob); return "blob:g8"; });
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(cases)("$key: G7A import/default → region → real plan → review/accept → coverage → exact download, twice fresh", async (fixture) => {
    const run = async () => {
      cleanup(); session.registry = createBundledProfileRegistry();
      session.region = fixture.region; session.origin = fixture.origin;
      const user = userEvent.setup(); render(<App />);
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Active survey" })).toBeEnabled());
      if (fixture.key !== "t80") {
        await user.upload(screen.getByLabelText("Profile JSON file"), inputFile(serializeProfile(fixture.document), `${fixture.key}.json`));
        await screen.findByText(`Imported survey profile: ${fixture.document.survey.display_name}`, { exact: false });
        await user.selectOptions(screen.getByRole("combobox", { name: "Active survey" }), fixture.document.survey.id);
      }
      await user.click(screen.getByRole("button", { name: "Select G8 region" }));
      const expected = planRegion(fixture.region, [], fixture.document.survey.id, undefined, "complete", session.registry!);
      await user.click(screen.getByRole("button", { name: "Generate plan" }));
      await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
      await waitFor(() => expect(session.map!.tiles.filter((t) => t.source === "proposed")).toHaveLength(expected.tiles.length));
      const accepted = session.map!.tiles.filter((t) => t.source === "proposed");
      expect(accepted.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg])).toEqual(expected.tiles.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]));
      const footprint = outputFootprintForProfile(session.map!.profile, session.registry!);
      expect(footprint).toEqual(fixture.document.instrument.footprint);
      expect(tileFootprintBoundaries(accepted[0], footprint)).toHaveLength(fixture.key === "mosaic" ? 2 : 1);
      expect(accepted.every((t) => t.position_angle_deg === cameraPa(fixture.document))).toBe(true);
      expect(measureActiveCoverage(fixture.region, [], accepted, fixture.document.survey.id, undefined, session.registry!).selected_region_coverage).toBe(1);
      await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
      const csv = await blobText(downloads.at(-1)!);
      expect(csv).toBe(buildExportCsv(accepted, fixture.document.survey));
      if (fixture.key === "mosaic") {
        expect(readCsv(csv).slice(1).every((r) => r[2] === "31.00000000" && r[3] === "G8-MOSAIC")).toBe(true);
        const tiling = fixture.document.survey.tiling;
        if (tiling.type !== "lattice") throw new Error("Expected lattice");
        expect(-Math.atan2(tiling.basis_deg[0][1], tiling.basis_deg[0][0]) * 180 / Math.PI).toBeCloseTo(11, 10);
      }
      await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
      expect(await blobText(downloads.at(-1)!)).toBe(csv);
      return { centers: accepted.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]), csv };
    };
    const first = await run(); expect(await run()).toEqual(first);
  }, 20000);

  it.each(cases)("$key: manual click and imported centers review/cancel/accept/export without inference", async (fixture) => {
    session.registry = matrixRegistry(); session.region = fixture.region; session.origin = fixture.origin;
    const user = userEvent.setup(); render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Active survey" })).toBeEnabled());
    await user.selectOptions(screen.getByRole("combobox", { name: "Active survey" }), fixture.document.survey.id);
    await user.click(screen.getByRole("button", { name: "Select G8 region" }));
    await user.click(screen.getByRole("button", { name: "G8 sky click" }));
    await user.click(await screen.findByRole("button", { name: "Cancel preview" }));
    expect(session.map!.tiles).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "G8 sky click" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    await user.type(screen.getByLabelText("RA and DEC pairs"), `${fixture.origin.ra_deg} ${fixture.origin.dec_deg}`);
    await user.click(screen.getByRole("button", { name: "Validate and preview" }));
    await user.click(await screen.findByRole("button", { name: "Stage import preview" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const rows = session.map!.tiles;
    expect(rows.map((t) => t.generation_method)).toEqual(["manual", "imported_centers"]);
    expect(rows.every((t) => t.ra_deg === fixture.origin.ra_deg && t.dec_deg === fixture.origin.dec_deg && !Object.hasOwn(t.metadata, "lattice_i"))).toBe(true);
    expect(rows.every((t) => t.position_angle_deg === cameraPa(fixture.document))).toBe(true);
    const metrics = measureActiveCoverage(fixture.region, [], rows, fixture.document.survey.id, undefined, session.registry!);
    expect(metrics.selected_region_coverage).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(await blobText(downloads.at(-1)!)).toBe(buildExportCsv(rows, fixture.document.survey));
  }, 15000);

  it("loads B catalogue, assigns B independently of C output, accepts/removes C proposals and preserves source rows", async () => {
    session.registry = matrixRegistry(); const [circle, mosaic] = cases.slice(1);
    session.region = mosaic.region; session.origin = mosaic.origin;
    const user = userEvent.setup(); render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Active survey" })).toBeEnabled());
    await user.selectOptions(screen.getByRole("combobox", { name: "Active survey" }), mosaic.document.survey.id);
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), inputFile("ra_deg,dec_deg,quality\n149.78,-25,immutable\n", "circle.csv"));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Catalogue instrument for circle.csv" }), circle.document.instrument.id);
    const sources = session.map!.tiles.filter((t) => t.source === "original"), snapshot = structuredClone(sources);
    expect(sources[0].instrument_profile_id).toBe(circle.document.instrument.id);
    await user.click(screen.getByRole("button", { name: "Select G8 region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Cancel preview" }));
    expect(session.map!.tiles).toEqual(snapshot);
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const accepted = session.map!.tiles.filter((t) => t.source === "proposed");
    expect(accepted.length).toBeGreaterThan(0);
    const coverage = () => measureActiveCoverage(mosaic.region, sources, session.map!.tiles.filter((t) => t.source === "proposed"), mosaic.document.survey.id, undefined, session.registry!);
    const enabledCoverage = coverage(); expect(enabledCoverage.selected_region_coverage).toBe(1);
    await user.click(screen.getByRole("button", { name: "Disable all" }));
    expect(coverage().selected_region_coverage).toBeLessThan(enabledCoverage.selected_region_coverage);
    await user.click(screen.getByRole("button", { name: "Restore all" }));
    expect(coverage()).toEqual(enabledCoverage);
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    const csv = await blobText(downloads.at(-1)!);
    expect(csv).toBe(buildExportCsv(accepted, mosaic.document.survey)); expect(csv).not.toMatch(/quality|immutable|PID/);
    await user.click(screen.getByRole("button", { name: "Clear proposal" }));
    expect(session.map!.tiles).toEqual(snapshot);
    expect(session.map!.datasets[0].instrument_profile_id).toBe(circle.document.instrument.id);
  }, 15000);

  it.each(cases.slice(1))("$key: user CSV assignment → active-profile inference → accepted continuation → download without PID", async (fixture) => {
    session.registry = matrixRegistry(); session.region = fixture.region;
    const user = userEvent.setup(); render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Active survey" })).toBeEnabled());
    await user.selectOptions(screen.getByRole("combobox", { name: "Active survey" }), fixture.document.survey.id);
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), inputFile(fixture.csv!, `${fixture.key}.csv`));
    await user.selectOptions(await screen.findByRole("combobox", { name: `Catalogue instrument for ${fixture.key}.csv` }), fixture.document.instrument.id);
    const sources = session.map!.tiles.filter((t) => t.source === "original"), snapshot = structuredClone(sources);
    expect(JSON.stringify(sources)).not.toContain("PID");
    await user.click(screen.getByRole("button", { name: "Select G8 region" }));
    const expected = planRegion(fixture.region, sources, fixture.document.survey.id, undefined, "complete", session.registry!);
    expect(expected.inference.lattice?.status).toBe("success");
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const accepted = session.map!.tiles.filter((t) => t.source === "proposed");
    expect(accepted.map((t) => [t.ra_deg, t.dec_deg])).toEqual(expected.tiles.map((t) => [t.ra_deg, t.dec_deg]));
    expect(accepted.every((t) => t.position_angle_deg === cameraPa(fixture.document))).toBe(true);
    if (fixture.key === "mosaic") {
      const fit = expected.inference.lattice;
      if (fit?.status !== "success") throw new Error("Expected fit");
      expect(fit.rotation_deg).toBeCloseTo(7, 7);
      // 11° declared basis + 7° inferred rotation = 18° lattice; camera = 31°.
      expect(-Math.atan2(fit.basis_deg[0][1], fit.basis_deg[0][0]) * 180 / Math.PI).toBeCloseTo(18, 7);
    }
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(await blobText(downloads.at(-1)!)).toBe(buildExportCsv(accepted, fixture.document.survey));
    expect(session.map!.tiles.filter((t) => t.source === "original")).toEqual(snapshot);
  }, 15000);

  it("authors a profile scientifically equivalent to B through G7B2, registers it and executes planning/export", async () => {
    const user = userEvent.setup(), fixture = cases[1];
    session.region = fixture.region; session.origin = fixture.origin; render(<App />);
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await edit(user, "Instrument ID", fixture.document.instrument.id);
    await edit(user, "Display name", fixture.document.instrument.display_name);
    await user.selectOptions(screen.getByRole("combobox", { name: "Footprint type" }), "circle");
    await edit(user, "radius (°)", "0.08");
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    await edit(user, "Survey ID", fixture.document.survey.id); await edit(user, "Survey display name", fixture.document.survey.display_name);
    for (const [label, value] of [["Basis 1 east (°)", "0.1"], ["Basis 1 north (°)", "0"], ["Basis 2 east (°)", "0"], ["Basis 2 north (°)", "0.1"], ["Spacing tolerance fraction", "0.02"], ["Phase tolerance fraction", "0.04"], ["Occupancy tolerance fraction", "0.06"], ["Minimum anchor tiles", "4"], ["Minimum neighbor pairs", "3"], ["Target samples per footprint axis", "32"], ["Maximum coverage samples", "20000"], ["RA output column", "ALPHA"], ["DEC output column", "DELTA"]]) await edit(user, label, value);
    await user.click(screen.getByRole("checkbox", { name: "Enable lattice inference" }));
    await user.click(screen.getByRole("checkbox", { name: "Allow inference rotation" }));
    await user.click(screen.getByRole("checkbox", { name: "Include Efficient policy" }));
    await edit(user, "Efficient minimum coverage", "0.8"); await edit(user, "Efficient minimum marginal efficiency", "0.25");
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    const authored = session.registry!.resolveProfileDocument(fixture.document.survey.id);
    // The editor may include empty optional descriptions; all scientific fields match.
    expect(authored.instrument.footprint).toEqual(fixture.document.instrument.footprint);
    expect(authored.survey.tiling).toEqual(fixture.document.survey.tiling);
    expect(authored.survey.inference).toEqual(fixture.document.survey.inference);
    expect(authored.survey.coverage).toEqual(fixture.document.survey.coverage);
    expect(authored.survey.export).toEqual(fixture.document.survey.export);
    expect(parseProfileJson(serializeProfile(authored))).toEqual(authored);
    await user.selectOptions(screen.getByRole("combobox", { name: "Active survey" }), authored.survey.id);
    await user.click(screen.getByRole("button", { name: "Select G8 region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const expected = planRegion(fixture.region, [], fixture.document.survey.id, undefined, "complete", matrixRegistry());
    expect(session.map!.tiles.map((t) => [t.ra_deg, t.dec_deg])).toEqual(expected.tiles.map((t) => [t.ra_deg, t.dec_deg]));
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(await blobText(downloads.at(-1)!)).toBe(buildExportCsv(expected.tiles, fixture.document.survey));
  }, 20000);

  it("T80 default/reference browser workflow retains frozen holdout coverage and export ordering", async () => {
    const fixture = golden.historical_holdout;
    // Real reference loader and CSV parser; remove held-out rows from the input file.
    const referenceRows = readCsv(referenceCsv);
    const names = new Set(fixture.surrounding_names);
    const subset = [referenceRows[0], ...referenceRows.slice(1).filter((row) => names.has(row[1]))].map((row) => row.join(",")).join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(subset)));
    session.region = fixture.polygon;
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: /Load reference/ }));
    await screen.findByRole("combobox", { name: "Catalogue instrument for tiles_nc.csv" });
    const sources = structuredClone(session.map!.tiles);
    await user.click(screen.getByRole("button", { name: "Select G8 region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const accepted = session.map!.tiles.filter((t) => t.source === "proposed");
    expect(accepted).toHaveLength(plannerContract.plans.historical_holdout.new_tiles);
    expect(measureActiveCoverage(fixture.polygon, sources, accepted).selected_region_coverage)
      .toBe(plannerContract.plans.historical_holdout.selected_region_coverage);
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(await blobText(downloads.at(-1)!)).toBe(buildExportCsv(accepted, cases[0].document.survey));
    expect(session.map!.tiles.filter((t) => t.source === "original")).toEqual(sources);
  }, 20000);
});
