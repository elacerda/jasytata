import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { RegionPlanResponse } from "./types";
import { createBundledProfileRegistry, type ProfileRegistry } from "./profiles/registry";
import { parseProfileJsonV2, serializeProfile } from "./profiles/document";
import { planRegion as planRegionLocal } from "./science/planner";
import { readCsv } from "./science/catalogue";
import smallJson from "./profiles/fixtures/small-camera.json";

const session = vi.hoisted(() => ({ registry: null as ProfileRegistry | null }));
const apiSession = vi.hoisted(() => ({ planRegion: vi.fn() }));
vi.mock("./profiles", async (importOriginal) => {
  const original = await importOriginal<typeof import("./profiles")>();
  const { resolvePlanningProfile } = await import("./profiles/planning");
  const registry = new Proxy({} as ProfileRegistry, {
    get: (_, key) => {
      const value = Reflect.get(session.registry!, key);
      return typeof value === "function" ? value.bind(session.registry) : value;
    },
  });
  return { ...original, profileRegistry: registry, loadProfile: (id = original.DEFAULT_PROFILE.id) => resolvePlanningProfile(id, undefined, registry).profile };
});
vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, planRegion: apiSession.planRegion };
});
vi.mock("./AladinMap", async () => {
  const React = await import("react");
  return {
    default: (props: {
      onRegionSelect: (polygon: { vertices: Array<{ ra_deg: number; dec_deg: number }> }) => void;
      onSkyClick: (ra: number, dec: number) => void;
    }) =>
      React.createElement("div", { "aria-label": "Sky map" }, React.createElement("button", {
        onClick: () => props.onRegionSelect({ vertices: [
          { ra_deg: 120, dec_deg: -61 }, { ra_deg: 135, dec_deg: -61 },
          { ra_deg: 135, dec_deg: -57 }, { ra_deg: 120, dec_deg: -57 },
        ] }),
      }, "Mock select region"), React.createElement("button", {
        onClick: () => props.onSkyClick(150.5, -24.25),
      }, "Mock place tile")),
  };
});

const regionPlan: RegionPlanResponse = {
  coverage_strategy: "complete",
  solution: "profile_fallback",
  generation_method: "region_lattice",
  tiles: [{
    id: "preview-1", name: "PROPOSED_0001", ra_deg: 150, dec_deg: -30,
    source: "proposed", generation_method: "region_lattice", original_values: null, metadata: {},
  }],
  candidate_centers: [{ ra_deg: 150, dec_deg: -30 }],
  inference: { nearby_tile_count: 0, anchor_tile_ids: [], compatible_neighbor_pairs: 0, dec_spacing_deg: null, ra_spacing_deg: null },
  diagnostics: [],
  metrics: {
      coverage_basis: "legacy_v2", coverage_status: "resolved",    existing_tiles_contributing: 0, new_tiles: 1, selected_region_area_deg2: 1,
    already_covered_fraction: 0, selected_region_coverage: 1, incremental_coverage: 1,
    remaining_uncovered_fraction: 0, remaining_uncovered_area_deg2: 0,
    redundant_coverage: 0, outside_region_coverage_deg2: 0, sample_step_deg: 0.01,
  },
};

function jsonFile(text: string, name = "profile.json"): File {
  const file = new File([text], name, { type: "application/json" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

function csvFile(text: string, name: string): File {
  const file = new File([text], name, { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

const mosaicJson = {
  instrument: {
    ...smallJson.instrument,
    id: "mosaic-camera",
    display_name: "Two field mosaic camera",
    footprint: { type: "compound" as const, components: [
      { offset_deg: [-0.12, 0], footprint: { type: "rectangle" as const, width_deg: 0.2, height_deg: 0.12 } },
      { offset_deg: [0.12, 0], footprint: { type: "rectangle" as const, width_deg: 0.2, height_deg: 0.12 } },
    ] },
  },
  survey: { ...smallJson.survey, id: "mosaic-survey", display_name: "Mosaic survey", instrument_id: "mosaic-camera" },
};
const manualJson = {
  instrument: { ...smallJson.instrument, id: "manual-camera", display_name: "Manual camera" },
  survey: { ...smallJson.survey, id: "manual-survey", display_name: "Manual survey", instrument_id: "manual-camera", tiling: { type: "manual" as const } },
};

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Capture the real browser download without network or filesystem output. */
function captureCsvDownloads(filename = "new_tiles.csv") {
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:pointings"; });
    static revokeObjectURL = vi.fn();
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe(filename);
  });
  return { blobs, click };
}

function captureFileDownloads(filename: string) {
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:profile-download"; });
    static revokeObjectURL = vi.fn();
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe(filename);
    expect(this.href).toBe("blob:profile-download");
  });
  return { blobs, click };
}

describe("minimal browser profile file controls", () => {
  beforeEach(() => {
    session.registry = createBundledProfileRegistry();
    apiSession.planRegion.mockReset().mockResolvedValue(regionPlan);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("imports a survey, plans with it immediately, and keeps catalogue geometry separate", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("survey:splus-t80-south"));
    const input = screen.getByLabelText("Profile JSON file");
    const click = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Import profile" }));
    expect(click).toHaveBeenCalledOnce();
    await user.upload(input, jsonFile(JSON.stringify(smallJson)));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported survey profile: Small oblique survey");
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    expect(within(selector).getByRole("option", { name: /^Small oblique survey/ })).toBeTruthy();
    expect(session.registry!.listInstrumentProfiles().map(({ id }) => id)).toContain("small-camera");
    await user.selectOptions(selector, "survey:small-survey");
    expect(selector).toHaveValue("survey:small-survey");
    expect(screen.getByRole("button", { name: "Export survey JSON" })).toBeEnabled();
    expect(screen.getByText("Small circular camera")).toBeTruthy();
    expect(screen.getByText("Circle · radius 0.12°")).toBeTruthy();
    expect(screen.getByText("Lattice · fixed anchor 150° RA, -30° DEC")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalled());
    expect(apiSession.planRegion).toHaveBeenLastCalledWith(expect.objectContaining({ vertices: expect.any(Array) }), [], "small-survey", undefined, "complete", expect.any(Object));
    expect(await screen.findByText("No catalogue is loaded; the active survey supplies the grid for this new project.")).toBeTruthy();

    await user.selectOptions(selector, "survey:splus-t80-south");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    expect(screen.getByText("T80-South camera")).toBeTruthy();
    fetchMock.mockResolvedValue(new Response("RA,DEC\n150,-30\n"));
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    const instrumentSelector = await screen.findByRole("combobox", { name: "Catalogue instrument for tiles_nc.csv" });
    expect(instrumentSelector).toHaveValue("t80-south");
    expect(within(instrumentSelector).getByRole("option", { name: /Small circular camera/ })).toBeTruthy();
  });

  it("orders registry-backed survey choices deterministically by ID", async () => {
    const user = userEvent.setup();
    const alpha = {
      instrument: { ...smallJson.instrument, id: "alpha-camera", display_name: "Alpha camera" },
      survey: { ...smallJson.survey, id: "alpha-survey", display_name: "Alpha survey", instrument_id: "alpha-camera" },
    };
    const zeta = {
      instrument: { ...smallJson.instrument, id: "zeta-camera", display_name: "Zeta camera" },
      survey: { ...smallJson.survey, id: "zeta-survey", display_name: "Zeta survey", instrument_id: "zeta-camera" },
    };
    render(<App />);
    const input = screen.getByLabelText("Profile JSON file");
    await user.upload(input, jsonFile(JSON.stringify(zeta)));
    await screen.findByText(/Imported survey profile: Zeta survey/);
    await user.upload(input, jsonFile(JSON.stringify(alpha)));
    await screen.findByText(/Imported survey profile: Alpha survey/);

    const selector = screen.getByRole("combobox", { name: "Output profile" });
    const surveyOptions = Array.from(selector.querySelector('optgroup[label="Survey strategies"]')!.querySelectorAll("option"));
    expect(surveyOptions.map((option) => option.value)).toEqual(
      session.registry!.listAnySurveyProfiles().map((survey) => `survey:${survey.id}`),
    );
    expect(selector).toHaveValue("survey:splus-t80-south");
    await user.selectOptions(selector, "survey:alpha-survey");
    expect(within(screen.getByLabelText("Active survey summary")).getByText("Alpha camera")).toBeTruthy();
  });

  it("exposes all bundled v3 instruments and strategies while preserving the S-PLUS default", async () => {
    render(<App />);
    const selector = screen.getByRole("combobox", { name: "Output profile" }) as HTMLSelectElement;
    expect(selector).toHaveValue("survey:splus-t80-south");
    const surveyOptions = Array.from(selector.querySelector('optgroup[label="Survey strategies"]')!.querySelectorAll("option"));
    expect(surveyOptions.map((option) => option.value)).toEqual(
      session.registry!.listAnySurveyProfiles().map((survey) => `survey:${survey.id}`),
    );
    const instrumentOptions = Array.from(selector.querySelectorAll<HTMLOptionElement>('optgroup:not([label="Survey strategies"]) option'));
    expect(instrumentOptions).toHaveLength(22);
    expect(instrumentOptions.map((option) => option.value).sort()).toEqual(
      session.registry!.listAnyInstrumentProfiles()
        .filter((instrument) => instrument.schema_version === 3)
        .map((instrument) => `instrument:${instrument.id}`).sort(),
    );
    expect(instrumentOptions.some((option) => option.textContent?.includes("exact observed area"))).toBe(true);
    expect(instrumentOptions.some((option) => option.textContent?.includes("approximate nominal envelope"))).toBe(true);
    expect(instrumentOptions.some((option) => option.textContent?.includes("approximate target access"))).toBe(true);
  });

  it("places manual and pasted centers without a catalogue and downloads generic standalone coordinates", async () => {
    const user = userEvent.setup();
    const downloads = captureCsvDownloads("manual_centers.csv");
    render(<App />);
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(selector, "instrument:keck-kcwi-small");
    const summary = screen.getByLabelText("Active instrument summary");
    expect(within(summary).getByText("Standalone instrument")).toBeTruthy();
    expect(within(summary).getByText("keck-kcwi-small")).toBeTruthy();
    expect(within(summary).getByText("Exact observed-area geometry")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Select area/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^Single tile/ }));
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "RA and DEC pairs" }), "151.25, -25.5");
    await user.click(screen.getByRole("button", { name: "Validate and preview" }));
    expect(await screen.findByText("1 valid center parsed. Review the list, then stage it.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stage import preview" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(screen.getByText("2 generated · 2 enabled · 0 disabled")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Download manual_centers.csv" }));
    expect(downloads.click).toHaveBeenCalledOnce();
    const rows = readCsv(await blobText(downloads.blobs[0]));
    expect(rows[0]).toEqual([
      "POINTING_ID", "RA_ICRS_DEG", "DEC_ICRS_DEG", "INSTRUMENT_PROFILE_ID", "PLACEMENT_ORIGIN", "POSITION_ANGLE_DEG",
    ]);
    expect(rows.slice(1).map((row) => [row[1], row[2], row[3], row[4], row[5]])).toEqual([
      ["150.50000000", "-24.25000000", "keck-kcwi-small", "manual", "0.00000000"],
      ["151.25000000", "-25.50000000", "keck-kcwi-small", "imported_unverified", "0.00000000"],
    ]);
    expect(rows[0]).not.toContain("EPOCH");
    expect(rows[0]).not.toContain("SURVEY_ID");
    expect(rows).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Disable all" }));
    expect(screen.getByText("0 enabled · 2 disabled")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore all" }));
    expect(screen.getByText("2 enabled · 0 disabled")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear proposal" }));
    expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();
  });

  it("requires an explicit PA before MUSE manual geometry, then restores instrument-pinned pointings", async () => {
    const user = userEvent.setup();
    render(<App />);
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(selector, "instrument:keck-kcwi-small");
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    await screen.findByText("Proposal preview");
    await user.selectOptions(selector, "instrument:sdss-lvm-i-science-ifu");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();
    await user.selectOptions(selector, "instrument:keck-kcwi-small");
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));

    await user.selectOptions(selector, "instrument:vlt-muse-wfm");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();
    const pa = screen.getByRole("spinbutton", { name: "Required pointing PA in degrees east of north" });
    expect(pa).toHaveValue(null);
    expect(pa).toBeRequired();
    expect(screen.getByRole("button", { name: /^Single tile/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Enter a finite position angle/);
    expect(screen.queryByText("Proposal preview")).toBeNull();

    await user.type(pa, "68.25");
    await user.click(screen.getByRole("button", { name: /^Single tile/ }));
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download manual_centers.csv" }));

    await user.selectOptions(selector, "instrument:sdss-lvm-i-science-ifu");
    expect(within(screen.getByLabelText("Active instrument summary")).getByText(/Nominal envelope · Approximate/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: "Required pointing PA in degrees east of north" })).toBeNull();
    expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();

    await user.selectOptions(selector, "instrument:vista-4most-target-access");
    expect(within(screen.getByLabelText("Active instrument summary")).getByText(/not observed coverage/)).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Required pointing PA in degrees east of north" })).toBeTruthy();

    await user.selectOptions(selector, "instrument:vlt-muse-wfm");
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();
    await user.selectOptions(selector, "instrument:keck-kcwi-small");
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();
    expect(within(screen.getByLabelText("Active instrument summary")).getByText("Exact observed-area geometry")).toBeTruthy();

    await user.selectOptions(selector, "survey:sami-dr1-seven-position");
    expect(within(screen.getByLabelText("Active survey summary")).getByText(/AAT \/ SAMI 61-core/)).toBeTruthy();
    expect(within(screen.getByLabelText("Active survey summary")).getByText("7 ordered exposures")).toBeTruthy();
    await user.selectOptions(selector, "survey:splus-t80-south");
    expect(within(screen.getByLabelText("Active survey summary")).getByText("Legacy S-PLUS grid")).toBeTruthy();
    expect(within(screen.getByLabelText("Active survey summary")).getByText("Legacy v2 behavior · role not classified")).toBeTruthy();
  });

  it("pins an explicit user-selected PA to accepted pointings across edits and context switches", async () => {
    const user = userEvent.setup();
    const downloads = captureCsvDownloads("manual_centers.csv");
    render(<App />);
    const source = session.registry!.resolveAnyInstrumentProfile("vlt-muse-wfm");
    if (source.schema_version !== 3) throw new Error("Expected a v3 MUSE profile");
    const instrument = {
      ...source,
      id: "browser-user-selected-muse",
      display_name: "User-selected MUSE geometry",
      position_angle: { mode: "user_selected" as const, required: true },
    };
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(serializeProfile({ instrument })));
    await screen.findByText(/Imported instrument profile: User-selected MUSE geometry/);
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(selector, "instrument:browser-user-selected-muse");
    const pa = screen.getByRole("spinbutton", { name: "Plan/session PA in degrees east of north" });
    await user.type(pa, "42.5");
    await user.click(screen.getByRole("button", { name: /^Single tile/ }));
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));

    await user.clear(pa);
    await user.type(pa, "101");
    await user.selectOptions(selector, "instrument:keck-kcwi-small");
    expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();
    await user.selectOptions(selector, "instrument:browser-user-selected-muse");
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Plan/session PA in degrees east of north" })).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: "Download manual_centers.csv" }));
    const rows = readCsv(await blobText(downloads.blobs[0]));
    expect(rows[1]).toContain("42.50000000");
    expect(rows[1]).not.toContain("101.00000000");
  });

  it("keeps a catalogue instrument assignment independent of output instrument selection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), csvFile("RA,DEC\n150,-30\n", "assigned.csv"));
    const assignment = await screen.findByRole("combobox", { name: "Catalogue instrument for assigned.csv" });
    await user.selectOptions(assignment, "keck-kcwi-small");
    expect(assignment).toHaveValue("keck-kcwi-small");
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "instrument:vlt-muse-wfm");
    expect(assignment).toHaveValue("keck-kcwi-small");
    expect(within(assignment).getByRole("option", { name: /Keck \/ KCWI — small slicer/ })).toBeTruthy();
    expect(within(screen.getByLabelText("Active instrument summary")).getByText("VLT / MUSE Wide Field Mode")).toBeTruthy();
  });

  it("imports and exports standalone instrument, strategy-only, and matching pair JSON documents", async () => {
    const user = userEvent.setup();
    const downloads = captureFileDownloads("browser-standalone-kcwi.json");
    render(<App />);

    const sourceInstrument = session.registry!.resolveAnyInstrumentProfile("keck-kcwi-small");
    if (sourceInstrument.schema_version !== 3) throw new Error("Expected a bundled v3 instrument");
    const standaloneInstrument = { ...sourceInstrument, id: "browser-standalone-kcwi", display_name: "Browser KCWI slicer" };
    const instrumentDocument = { instrument: standaloneInstrument };
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(serializeProfile(instrumentDocument)));
    await screen.findByText(/Imported instrument profile: Browser KCWI slicer/);
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(selector, "instrument:browser-standalone-kcwi");
    await user.click(screen.getByRole("button", { name: "Export instrument JSON" }));
    expect(downloads.click).toHaveBeenCalledOnce();
    expect(await blobText(downloads.blobs[0])).toBe(serializeProfile(instrumentDocument));

    const sourceStrategy = session.registry!.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (sourceStrategy.schema_version !== 3 || !sourceStrategy.observing_sequence) throw new Error("Expected a bundled v3 strategy");
    const strategyDocument = { survey: {
      ...sourceStrategy,
      id: "browser-sami-strategy",
      display_name: "Browser SAMI sequence",
      observing_sequence: { ...sourceStrategy.observing_sequence, id: "browser-sami-sequence" },
    } };
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(serializeProfile(strategyDocument)));
    await screen.findByText(/Imported strategy: Browser SAMI sequence/);
    await user.selectOptions(selector, "survey:browser-sami-strategy");
    const strategyDownload = captureFileDownloads("browser-sami-strategy.json");
    await user.click(screen.getByRole("button", { name: "Export strategy JSON" }));
    expect(await blobText(strategyDownload.blobs[0])).toBe(serializeProfile(strategyDocument));
    expect(JSON.parse(await blobText(strategyDownload.blobs[0]))).not.toHaveProperty("instrument");

    const pairInstrument = { ...sourceInstrument, id: "browser-pair-camera", display_name: "Browser pair camera" };
    const pairStrategy = {
      ...sourceStrategy,
      id: "browser-pair-strategy",
      display_name: "Browser pair strategy",
      instrument_id: pairInstrument.id,
      observing_sequence: { ...sourceStrategy.observing_sequence, id: "browser-pair-sequence" },
    };
    const pairDocument = { instrument: pairInstrument, survey: pairStrategy };
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(serializeProfile(pairDocument)));
    await screen.findByText(/Imported matching pair: Browser pair camera \+ Browser pair strategy/);
    await user.selectOptions(selector, "survey:browser-pair-strategy");
    const pairDownload = captureFileDownloads("browser-pair-strategy.json");
    await user.click(screen.getByRole("button", { name: "Export strategy JSON" }));
    expect(await blobText(pairDownload.blobs[0])).toBe(serializeProfile(pairDocument));
    expect(JSON.parse(await blobText(pairDownload.blobs[0]))).toHaveProperty("instrument");
  });

  it("invalidates pending previews and restores accepted proposals with their original survey context", async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByLabelText("Profile JSON file");
    await user.upload(input, jsonFile(JSON.stringify(smallJson)));
    await screen.findByText(/Imported survey profile:/);
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(selector, "survey:small-survey");
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(screen.getByText("PROPOSED_0001")).toBeTruthy();
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();

    await user.selectOptions(selector, "survey:splus-t80-south");

    expect(screen.queryByText("PROPOSED_0001")).toBeNull();
    expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();
    expect(screen.queryByText("Proposal preview")).toBeNull();

    await user.selectOptions(selector, "survey:small-survey");
    expect(screen.getByText("PROPOSED_0001")).toBeTruthy();
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();
  });

  it("keeps the registry, active survey, and accepted proposals unchanged while editing a draft", async () => {
    const user = userEvent.setup();
    render(<App />);
    const surveySelector = screen.getByRole("combobox", { name: "Output profile" });
    const profileInput = screen.getByLabelText("Profile JSON file");
    await user.upload(profileInput, jsonFile(JSON.stringify(smallJson)));
    await screen.findByText(/Imported survey profile: Small oblique survey/);
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), csvFile("RA,DEC\n150,-30\n", "draft-check.csv"));
    const assignment = screen.getByRole("combobox", { name: /Catalogue instrument for/ });
    await user.selectOptions(assignment, "small-camera");

    const surveyIdBefore = (surveySelector as HTMLSelectElement).value;
    const profileSummaryBefore = screen.getByLabelText("Active survey summary").textContent;
    const profilesBefore = session.registry!.listInstrumentProfiles();
    const assignmentBefore = (assignment as HTMLSelectElement).value;

    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByText("Proposal preview");
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(screen.getByText("PROPOSED_0001")).toBeTruthy();
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(screen.getByRole("dialog", { name: "Create instrument profile" })).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Instrument ID" }), "scratch-camera");
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Scratch camera");
    await user.clear(screen.getByRole("textbox", { name: "width (°)" }));
    await user.type(screen.getByRole("textbox", { name: "width (°)" }), "2.4");
    expect(within(screen.getByRole("dialog", { name: "Create instrument profile" })).getByRole("status")).toHaveTextContent("Instrument valid");
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    await user.type(screen.getByRole("textbox", { name: "Survey ID" }), "scratch-survey");
    await user.type(screen.getByRole("textbox", { name: "Survey display name" }), "Scratch survey");
    expect(within(screen.getByRole("dialog", { name: "Create survey profile" })).getByRole("status")).toHaveTextContent("Profile valid");

    expect(session.registry!.listInstrumentProfiles()).toEqual(profilesBefore);
    expect((surveySelector as HTMLSelectElement).value).toBe(surveyIdBefore);
    expect(screen.getByLabelText("Active survey summary").textContent).toBe(profileSummaryBefore);
    expect((assignment as HTMLSelectElement).value).toBe(assignmentBefore);
    expect(screen.getByText("PROPOSED_0001")).toBeTruthy();
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled")).toBeTruthy();
    expect(apiSession.planRegion).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(session.registry!.listInstrumentProfiles()).toEqual(profilesBefore);
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(screen.getByRole("textbox", { name: "Instrument ID" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.getByText("PROPOSED_0001")).toBeTruthy();
  });

  it("keeps assignments independent across catalogues and invalidates previews after science changes", async () => {
    const user = userEvent.setup();
    render(<App />);
    const profileInput = screen.getByLabelText("Profile JSON file");
    await user.upload(profileInput, jsonFile(JSON.stringify(smallJson)));
    await screen.findByText(/Imported survey profile:/);
    await user.upload(profileInput, jsonFile(JSON.stringify(mosaicJson)));
    await screen.findByText(/Imported survey profile: Mosaic survey/);

    const surveySelector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(surveySelector, "survey:mosaic-survey");
    expect(screen.getByText("Mosaic · 2 components")).toBeTruthy();
    expect(screen.getByText("Lattice · fixed anchor 150° RA, -30° DEC")).toBeTruthy();

    const catalogueInput = screen.getByLabelText("Choose catalogue CSV");
    await user.upload(catalogueInput, csvFile("RA,DEC\n150,-30\n", "alpha.csv"));
    await user.upload(catalogueInput, csvFile("RA,DEC\n151,-30\n", "beta.csv"));
    const instruments = screen.getAllByRole("combobox", { name: /Catalogue instrument for/ });
    const roles = screen.getAllByRole("combobox", { name: /Inference participation for/ });
    expect(instruments).toHaveLength(2);
    expect(instruments.map((control) => (control as HTMLSelectElement).value)).toEqual(["", ""]);
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Assign a registered instrument profile"))).toBe(true);
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeDisabled();

    await user.selectOptions(instruments[0], "small-camera");
    await user.selectOptions(instruments[1], "mosaic-camera");
    await user.selectOptions(roles[0], "include");
    expect(roles[0]).toHaveValue("include");
    await user.selectOptions(roles[0], "exclude");
    expect(roles[0]).toHaveValue("exclude");
    await user.selectOptions(roles[0], "auto");
    expect(roles[0]).toHaveValue("auto");
    await user.selectOptions(roles[0], "exclude");

    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalled());
    const firstTiles = apiSession.planRegion.mock.lastCall?.[1] as Array<{
      dataset_name?: string; instrument_profile_id?: string | null; inference_role?: string; original_values: Record<string, string> | null;
    }>;
    expect(firstTiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset_name: "alpha.csv", instrument_profile_id: "small-camera", inference_role: "exclude" }),
      expect.objectContaining({ dataset_name: "beta.csv", instrument_profile_id: "mosaic-camera", inference_role: "auto" }),
    ]));
    const sourceRowsBeforeReassignment = firstTiles.map((tile) => tile.original_values);
    expect(screen.getByRole("button", { name: "Accept proposal" })).toBeEnabled();

    await user.selectOptions(roles[0], "include");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalledTimes(2));
    const includedTiles = apiSession.planRegion.mock.lastCall?.[1] as typeof firstTiles;
    expect(includedTiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset_name: "alpha.csv", inference_role: "include" }),
    ]));

    await user.selectOptions(roles[0], "exclude");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalledTimes(3));
    const excludedTiles = apiSession.planRegion.mock.lastCall?.[1] as typeof firstTiles;
    expect(excludedTiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset_name: "alpha.csv", inference_role: "exclude" }),
    ]));

    await user.selectOptions(instruments[0], "mosaic-camera");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    expect(instruments[1]).toHaveValue("mosaic-camera");
    expect(roles[0]).toHaveValue("exclude");
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalledTimes(4));
    const reassignedTiles = apiSession.planRegion.mock.lastCall?.[1] as typeof firstTiles;
    expect(reassignedTiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset_name: "alpha.csv", instrument_profile_id: "mosaic-camera", inference_role: "exclude" }),
      expect.objectContaining({ dataset_name: "beta.csv", instrument_profile_id: "mosaic-camera", inference_role: "auto" }),
    ]));
    expect(reassignedTiles.map((tile) => tile.original_values)).toEqual(sourceRowsBeforeReassignment);

    await user.selectOptions(instruments[1], "small-camera");
    expect(instruments[0]).toHaveValue("mosaic-camera");
    expect(instruments[1]).toHaveValue("small-camera");
    expect(screen.queryByText("Proposal preview")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalledTimes(5));
    await user.selectOptions(surveySelector, "survey:small-survey");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    expect(surveySelector).toHaveValue("survey:small-survey");
    expect(within(screen.getByLabelText("Active survey summary")).getByText("Small circular camera")).toBeTruthy();
    expect(instruments[0]).toHaveValue("mosaic-camera");
    expect(instruments[1]).toHaveValue("small-camera");
    expect(screen.queryByText("Selected polygon")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(apiSession.planRegion).toHaveBeenCalledTimes(6));
    expect(apiSession.planRegion.mock.lastCall?.[2]).toBe("small-survey");
    const outputChangeTiles = apiSession.planRegion.mock.lastCall?.[1] as typeof firstTiles;
    expect(outputChangeTiles.map((tile) => tile.instrument_profile_id)).toEqual(["mosaic-camera", "small-camera"]);
  });

  it("shows manual tiling as unavailable for automatic region planning", async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByLabelText("Profile JSON file");
    await user.upload(input, jsonFile(JSON.stringify(manualJson)));
    await screen.findByRole("status");
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    await user.selectOptions(selector, "survey:manual-survey");
    expect(screen.getByText("Manual coverage")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeDisabled();
    expect(screen.getByText("Manual strategy: select a region to measure the declared geometry.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Measure selected geometry" })).toBeEnabled();
    expect(apiSession.planRegion).not.toHaveBeenCalled();
  });

  it("reports malformed/scientifically invalid files and duplicate IDs without partial imports", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("survey:splus-t80-south"));
    const input = screen.getByLabelText("Profile JSON file");
    const beforeInstruments = session.registry!.listInstrumentProfiles();
    await user.upload(input, jsonFile("{"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Malformed profile JSON");
    await user.upload(input, jsonFile(JSON.stringify({ ...smallJson, instrument: { ...smallJson.instrument, footprint: { type: "circle", radius_deg: 0 } } })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Circle radius");
    expect(session.registry!.listInstrumentProfiles()).toEqual(beforeInstruments);
    expect(screen.queryByRole("option", { name: "Small oblique survey" })).toBeNull();
    await user.upload(input, jsonFile(serializeProfile(session.registry!.resolveProfileDocument("splus-t80-south"))));
    expect(await screen.findByRole("alert")).toHaveTextContent('Instrument profile ID "t80-south" is already registered');
    expect(session.registry!.listSurveyProfiles()).toHaveLength(1);
  });

  it("treats a survey called custom as an ordinary registry entry", async () => {
    const user = userEvent.setup();
    const customId = { ...smallJson, survey: { ...smallJson.survey, id: "custom" } };
    render(<App />);
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(customId)));
    await screen.findByRole("status");
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    expect(within(selector).getByRole("option", { name: /^Small oblique survey/ })).toBeTruthy();
    await user.selectOptions(selector, "survey:custom");
    expect(selector).toHaveValue("survey:custom");
    expect(screen.getByText("Small circular camera")).toBeTruthy();
  });

  it("registers an authored survey into both selectors and plans with no catalogue immediately", async () => {
    const user = userEvent.setup();
    apiSession.planRegion.mockImplementation(async (polygon, existing, id, inline, strategy) => planRegionLocal(polygon, existing, id, inline, strategy, session.registry!));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await user.type(screen.getByRole("textbox", { name: "Instrument ID" }), "browser-camera");
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Browser camera");
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    await user.type(screen.getByRole("textbox", { name: "Survey ID" }), "browser-survey");
    await user.type(screen.getByRole("textbox", { name: "Survey display name" }), "Browser survey");
    expect(session.registry!.listSurveyProfiles()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Added survey profile: Browser survey. Select it in Output profile to use its strategy.");
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    expect(selector).toHaveValue("survey:splus-t80-south");
    expect(within(selector).getByRole("option", { name: /^Browser survey/ })).toBeTruthy();
    await user.selectOptions(selector, "survey:browser-survey");
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByText("Proposal preview");
    expect(apiSession.planRegion).toHaveBeenLastCalledWith(expect.anything(), [], "browser-survey", undefined, "complete", expect.any(Object));
    const plan = await apiSession.planRegion.mock.results[0].value as RegionPlanResponse;
    expect(plan.solution).toBe("declared_lattice"); expect(plan.tiles.length).toBeGreaterThan(0);
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), csvFile("RA,DEC\n150,-30\n", "assign.csv"));
    const assignment = await screen.findByRole("combobox", { name: "Catalogue instrument for assign.csv" });
    expect(assignment).toHaveValue("");
    expect(within(assignment).getByRole("option", { name: /Browser camera/ })).toBeTruthy();
    await user.selectOptions(assignment, "browser-camera"); expect(assignment).toHaveValue("browser-camera");
  });

  it("preserves catalogue assignments, proposals and coverage on registration until explicit survey selection", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), csvFile("RA,DEC\n150,-30\n", "existing.csv"));
    const assignment = await screen.findByRole("combobox", { name: "Catalogue instrument for existing.csv" });
    expect(assignment).toHaveValue("");
    await user.selectOptions(assignment, "t80-south");
    expect(assignment).toHaveValue("t80-south");
    await user.click(screen.getByRole("button", { name: "Mock select region" })); await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    await waitFor(() => expect(screen.getByText("Already covered")).toBeTruthy());
    const summaryBefore = screen.getByLabelText("Active survey summary").textContent;
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await user.type(screen.getByRole("textbox", { name: "Instrument ID" }), "isolation-camera");
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Isolation camera");
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    await user.type(screen.getByRole("textbox", { name: "Survey ID" }), "isolation-survey");
    await user.type(screen.getByRole("textbox", { name: "Survey display name" }), "Isolation survey");
    const coverageBefore = screen.getByText("Already covered").closest(".metrics-panel")?.textContent;
    const proposalsBefore = screen.getByText("1 generated · 1 enabled · 0 disabled").textContent;
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    expect(selector).toHaveValue("survey:splus-t80-south"); expect(assignment).toHaveValue("t80-south");
    expect(screen.getByLabelText("Active survey summary").textContent).toBe(summaryBefore);
    expect(screen.getByText("Already covered").closest(".metrics-panel")?.textContent).toBe(coverageBefore);
    expect(screen.getByText("1 generated · 1 enabled · 0 disabled").textContent).toBe(proposalsBefore);
    expect(screen.getByText("PROPOSED_0001")).toBeTruthy();
    expect(within(assignment).getByRole("option", { name: /Isolation camera/ })).toBeTruthy();
    expect(apiSession.planRegion).toHaveBeenCalledOnce();
    await user.selectOptions(selector, "survey:isolation-survey");
    expect(screen.queryByText("PROPOSED_0001")).toBeNull(); expect(screen.getByText("0 generated · 0 enabled · 0 disabled")).toBeTruthy();
    expect(assignment).toHaveValue("t80-south");
  });

  it("downloads the selected survey and instrument as canonical JSON", async () => {
    const user = userEvent.setup();
    let downloaded: Blob | undefined;
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { downloaded = blob; return "blob:profile-test"; });
      static revokeObjectURL = vi.fn();
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("small-survey.json");
      expect(this.href).toBe("blob:profile-test");
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("survey:splus-t80-south"));
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(smallJson)));
    await screen.findByText(/Imported survey profile:/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "survey:small-survey");
    await user.click(screen.getByRole("button", { name: "Export survey JSON" }));
    expect(click).toHaveBeenCalledOnce();
    expect(downloaded!.type).toBe("application/json; charset=utf-8");
    const text = await blobText(downloaded!);
    expect(text).toBe(serializeProfile(session.registry!.resolveProfileDocument("small-survey")));
    expect(parseProfileJsonV2(text).survey.id).toBe("small-survey");
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:profile-test"));
    expect(document.querySelector('a[download]')).toBeNull();
  });
  it("authors distinctive export policy, registers/selects it, plans/accepts without a catalogue and downloads deterministically", async () => {
    const user = userEvent.setup();
    const downloads = captureCsvDownloads();
    apiSession.planRegion.mockImplementation(async (polygon, existing, id, inline, strategy) => planRegionLocal(polygon, existing, id, inline, strategy, session.registry!));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await user.type(screen.getByRole("textbox", { name: "Instrument ID" }), "export-camera");
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Export camera");
    const angle = screen.getByRole("textbox", { name: "position angle (°)" });
    await user.clear(angle); await user.type(angle, "23.5");
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    await user.type(screen.getByRole("textbox", { name: "Survey ID" }), "export-survey");
    await user.type(screen.getByRole("textbox", { name: "Survey display name" }), "Export survey");
    for (const [label, value] of [["RA output column", "ALPHA_J2000"], ["DEC output column", "DELTA_J2000"],
      ["Position angle output column · optional", "CAMERA_PA"], ["ID output column · optional", "TARGET"],
      ["NAME output column · optional", "LABEL"], ["GROUP output column · optional", "COHORT"]]) {
      const field = screen.getByRole("textbox", { name: label }); await user.clear(field); await user.type(field, value);
    }
    await user.selectOptions(screen.getByRole("combobox", { name: "Export coordinate format" }), "sexagesimal");
    await user.type(screen.getByRole("textbox", { name: "New constant column" }), "PROJECT");
    await user.click(screen.getByRole("button", { name: "Add constant field" }));
    await user.type(screen.getByRole("textbox", { name: "Constant PROJECT value" }), 'pilot,"one"');
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "survey:export-survey");
    expect(screen.queryByRole("combobox", { name: "Export epoch" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const plan = await apiSession.planRegion.mock.results[0].value as RegionPlanResponse;
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(apiSession.planRegion).toHaveBeenLastCalledWith(expect.anything(), [], "export-survey", undefined, "complete", expect.any(Object));
    expect(plan.tiles.every((tile) => tile.original_values === null && !Object.hasOwn(tile.metadata, "PID"))).toBe(true);
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    await waitFor(() => expect(downloads.blobs).toHaveLength(1));
    const csv = await blobText(downloads.blobs[0]); const rows = readCsv(csv);
    expect(rows[0]).toEqual(["ALPHA_J2000", "DELTA_J2000", "CAMERA_PA", "TARGET", "LABEL", "COHORT", "PROJECT"]);
    expect(rows).toHaveLength(plan.tiles.length + 1);
    expect(rows[1][0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(rows.slice(1).every((row) => row[2] === "23.50000000" && row[5] === "export-survey" && row[6] === 'pilot,"one"')).toBe(true);
    expect(rows[1].slice(3, 5)).toEqual(["PROPOSED_0001", "PROPOSED_0001"]);
    expect(csv).not.toContain("proposal-1-");
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(await blobText(downloads.blobs[1])).toBe(csv);
    const registered = session.registry!.resolveProfileDocument("export-survey");
    expect(parseProfileJsonV2(serializeProfile(registered)).survey.export).toEqual(registered.survey.export);
  });

  it("imports export policy and uses active output survey across mixed source instruments without exporting or changing source rows", async () => {
    const user = userEvent.setup(); const downloads = captureCsvDownloads();
    const document = { ...smallJson, survey: { ...smallJson.survey, export: {
      ra_column: "longitude", dec_column: "latitude", coordinate_format: "decimal",
      epoch: { column: "EQUINOX", default: "J2016", allowed: ["J2000", "J2016"] },
      constant_fields: { release: 7, calibrated: true, project: 'a,"b"\nc' },
    } } };
    render(<App />);
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(document)));
    await screen.findByText(/Imported survey profile:/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "survey:small-survey");
    const input = screen.getByLabelText("Choose catalogue CSV");
    await user.upload(input, csvFile("RA,DEC,PID,NAME\n150,-30,arbitrary,Source A\n", "alpha.csv"));
    await user.upload(input, csvFile("ra_deg,dec_deg,quality\n151,-31,untouched\n", "beta.csv"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Catalogue instrument for alpha.csv" }), "t80-south");
    await user.selectOptions(screen.getByRole("combobox", { name: "Catalogue instrument for beta.csv" }), "small-camera");
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    const sources = apiSession.planRegion.mock.lastCall![1]; const snapshot = structuredClone(sources);
    expect(sources.map((tile: { instrument_profile_id: string }) => tile.instrument_profile_id)).toEqual(["t80-south", "small-camera"]);
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    const csv = await blobText(downloads.blobs[0]);
    expect(readCsv(csv)).toEqual([["longitude", "latitude", "EQUINOX", "calibrated", "project", "release"],
      ["150.00000000", "-30.00000000", "J2016", "true", 'a,"b"\nc', "7"]]);
    expect(csv).not.toMatch(/PID|quality|arbitrary|Source A|151\.00000000/);
    expect(sources).toEqual(snapshot);
    await user.selectOptions(screen.getByRole("combobox", { name: "Export epoch" }), "J2000");
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(readCsv(await blobText(downloads.blobs[1]))[1][2]).toBe("J2000");
  });

  it("reports a useful missing-PA export error and creates no download", async () => {
    const user = userEvent.setup(); const downloads = captureCsvDownloads(); render(<App />);
    const document = { ...smallJson, survey: { ...smallJson.survey, export: { ...smallJson.survey.export, position_angle_column: "camera_pa" } } };
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(document)));
    await screen.findByText(/Imported survey profile:/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "survey:small-survey");
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: "Accept proposal" }));
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(await screen.findByText(/no declared camera position angle required by 'camera_pa'/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download new_tiles.csv/ })).toBeDisabled();
    expect(downloads.click).not.toHaveBeenCalled(); expect(downloads.blobs).toEqual([]);
  });

});
