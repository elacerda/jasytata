import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegionPlanRequest, downloadCatalogue, downloadInstrumentCoordinates, downloadInstrumentProfileJson, getProfiles, loadDefaultProfile, planRegion, uploadCatalogue, uploadProfileFile } from "./api";
import { ProfileRegistry, createBundledProfileRegistry } from "./profiles/registry";
import { parseProfileJsonV2, serializeProfile } from "./profiles/document";
import golden from "./data/golden.json";
import type { InstrumentProfileV3, SurveyProfileV3, TileRecord } from "./types";
import { makeCenterProposals, readCsv } from "./science/catalogue";

const proposal: TileRecord = {
  id: "proposal-1", name: "", ra_deg: 150.5, dec_deg: -24.25,
  source: "proposed", enabled: true, generation_method: "manual", original_values: null, metadata: {},
};

/** Supply browser file bytes in jsdom, which omits File.arrayBuffer. */
function csvFile(csv: string, name = "fixture.csv"): File {
  const file = new File([csv], name, { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(csv).buffer });
  return file;
}

function profileFile(json: string, name = "instrument-v3.json"): File {
  const file = new File([json], name, { type: "application/json" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(json).buffer });
  return file;
}

describe("local facade and download", () => {
  let createDescriptor: PropertyDescriptor | undefined;
  let revokeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    document.body.replaceChildren();
  });

  it("loads a local profile without HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await loadDefaultProfile()).id).toBe("splus-t80-south");
    expect((await getProfiles()).profiles).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports and exports an instrument-only v3 document through the core file lifecycle", async () => {
    const instrument = {
      schema_version: 3,
      id: "standalone-camera-v3",
      display_name: "Standalone camera",
      coordinate_frame: "icrs",
      footprint: { type: "circle", radius_deg: 0.1 },
      footprint_semantics: { role: "observed_area", fidelity: "exact" },
      provenance: {
        references: [{ url: "https://example.org/camera", title: "Camera specification" }],
        parameter_sources: [{ parameter_path: "footprint.radius_deg", reference_url: "https://example.org/camera" }],
        assumptions: [],
        limitations: [],
      },
      position_angle: { mode: "not_applicable", required: false },
    };
    const registry = new ProfileRegistry();
    const imported = await uploadProfileFile(profileFile(JSON.stringify({ instrument })), registry);
    expect(imported).toEqual({ instrument });
    expect(registry.resolveAnyInstrumentProfile(instrument.id)).toEqual(instrument);

    let downloaded: Blob | undefined;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { downloaded = blob; return "blob:v3-instrument"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("standalone-camera-v3.json");
      expect(this.href).toBe("blob:v3-instrument");
    });
    await downloadInstrumentProfileJson(instrument.id, registry);
    expect(click).toHaveBeenCalledOnce();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(downloaded!);
    });
    expect(JSON.parse(text)).toEqual(imported);
  });

  it("parses mapped upload bytes without HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadCatalogue(csvFile("RA,ra_deg,DEC\n10:03:05,150.77,-23:54:31\n"), {
      raColumn: "ra_deg", decColumn: "DEC", raUnit: "degrees",
    });
    expect(result.tiles[0].ra_deg).toBe(150.77);
    expect(result.tiles[0].metadata.RA).toBe("10:03:05");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates and revokes a named Blob download locally", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const create = vi.fn(() => "blob:jasytata-test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe("new_tiles.csv");
      expect(this.href).toBe("blob:jasytata-test");
    });
    await downloadCatalogue([proposal], "splus-t80-south");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:jasytata-test");
  });

  it("downloads standalone instrument centers through Gate 5 without survey policy or sequence expansion", async () => {
    const registry = createBundledProfileRegistry();
    const instrument = registry.resolveAnyInstrumentProfile("keck-kcwi-small");
    if (instrument.schema_version !== 3) throw new Error("Expected a v3 standalone instrument");
    const tile = {
      ...makeCenterProposals([{ ra_deg: 150.5, dec_deg: -24.25 }], "manual")[0],
      instrument_profile_id: instrument.id,
    };
    let downloaded: Blob | undefined;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { downloaded = blob; return "blob:manual-centers"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("manual_centers.csv");
      expect(this.href).toBe("blob:manual-centers");
    });

    await downloadInstrumentCoordinates([tile], instrument.id, registry);
    expect(click).toHaveBeenCalledOnce();
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloaded!);
    });
    expect(readCsv(csv)).toEqual([
      ["POINTING_ID", "RA_ICRS_DEG", "DEC_ICRS_DEG", "INSTRUMENT_PROFILE_ID", "PLACEMENT_ORIGIN", "POSITION_ANGLE_DEG"],
      ["POINTING_0001", "150.50000000", "-24.25000000", "keck-kcwi-small", "manual", "0.00000000"],
    ]);
    expect(csv).not.toContain("EPOCH");
    expect(csv).not.toContain("EXPOSURE");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("blocks standalone export when a selected per-pointing PA is required", async () => {
    const registry = createBundledProfileRegistry();
    const instrument = registry.resolveAnyInstrumentProfile("vlt-muse-wfm");
    if (instrument.schema_version !== 3) throw new Error("Expected a v3 nominal instrument");
    const tile = { ...makeCenterProposals([{ ra_deg: 150.5, dec_deg: -24.25 }], "manual")[0], instrument_profile_id: instrument.id };
    const create = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    await expect(downloadInstrumentCoordinates([tile], instrument.id, registry)).rejects.toThrow(/PA policy requires/i);
    expect(create).not.toHaveBeenCalled();
  });
  it("downloads imported T80 sexagesimal policy byte-for-byte like the frozen observer fixture", async () => {
    const document = createBundledProfileRegistry().resolveProfileDocument("splus-t80-south");
    document.survey.export.coordinate_format = "sexagesimal";
    const registry = new ProfileRegistry(); registry.registerProfileDocument(parseProfileJsonV2(serializeProfile(document)));
    let downloaded: Blob | undefined;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { downloaded = blob; return "blob:t80"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadCatalogue([proposal], document.survey.id, undefined, registry);
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloaded!);
    });
    expect(csv).toBe(golden.exports.sexagesimal);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("exports runtime pointing PA and ordered exposure centers through the canonical geometry resolver", async () => {
    const registry = createBundledProfileRegistry();
    const realInstrument = registry.resolveInstrumentProfile("vlt-muse-wfm");
    const realStrategy = registry.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (realInstrument.schema_version !== 3 || realStrategy.schema_version !== 3 || !realStrategy.observing_sequence) {
      throw new Error("Expected the registered SAMI sequence for this synthetic geometry test");
    }
    const syntheticReference = "https://example.org/jasytata-gate5-synthetic-fixture";
    const instrument: InstrumentProfileV3 = {
      ...realInstrument,
      id: "gate5-synthetic-export-camera",
      display_name: "Synthetic Gate 5 export camera",
      description: "Synthetic test-only PA policy using the registered sourced MUSE geometry.",
      position_angle: { mode: "per_pointing", required: true },
    };
    const strategy: SurveyProfileV3 = {
      ...realStrategy,
      id: "gate5-synthetic-export-strategy",
      display_name: "Synthetic Gate 5 export sequence",
      description: "Synthetic two-exposure sequence used only to test export geometry.",
      instrument_id: instrument.id,
      observing_sequence: { id: "gate5-synthetic-two-position", exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 },
        { order: 2, east_arcsec: 3600, north_arcsec: 0, rotation_deg: 90 },
      ] },
      export: {
        ra_column: "RA", dec_column: "DEC", coordinate_format: "decimal",
        position_angle_column: "PA", identifiers: { id_column: "TARGET" },
      },
      provenance: {
        references: [{ url: syntheticReference, title: "Synthetic Gate 5 test fixture" }],
        parameter_sources: [
          ...[0, 1].flatMap((index) => ["east_arcsec", "north_arcsec", "rotation_deg"].map((axis) => ({
            parameter_path: `observing_sequence.exposures[${index}].${axis}`,
            reference_url: syntheticReference, note: "Synthetic test input, not scientific evidence.",
          }))),
        ],
        assumptions: ["Sequence exists only to exercise runtime export behavior."],
        limitations: ["No real observing strategy or offsets are represented."],
      },
    };
    registry.registerInstrumentProfileV3(instrument);
    registry.registerSurveyProfileV3(strategy);
    const pointing = {
      ...proposal,
      position_angle_deg: 37,
      instrument_profile_id: instrument.id,
      output_strategy_id: strategy.id,
    };
    const sequence = strategy.observing_sequence!;
    let downloaded: Blob | undefined;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { downloaded = blob; return "blob:gate5"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadCatalogue([pointing], strategy.id, undefined, registry, {
      orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }),
      sequenceForTile: () => sequence,
      coverageBasis: "effective_sequence",
    }, "nominal");
    const nominalCsv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloaded!);
    });
    const nominalRows = readCsv(nominalCsv);
    expect(nominalRows).toEqual([
      ["RA", "DEC", "PA", "TARGET"],
      [proposal.ra_deg.toFixed(8), proposal.dec_deg.toFixed(8), "37.00000000", "PROPOSED_0001"],
    ]);

    await downloadCatalogue([pointing], strategy.id, undefined, registry, {
      orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }),
      sequenceForTile: () => sequence,
      coverageBasis: "single_exposure",
    }, "expanded");
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloaded!);
    });
    const rows = readCsv(csv);
    expect(rows[0]).toEqual(["RA", "DEC", "PA", "TARGET"]);
    expect(rows.slice(1).map((row) => row.slice(2))).toEqual([
      ["37.00000000", "PROPOSED_0001_EXP_0001"],
      ["127.00000000", "PROPOSED_0001_EXP_0002"],
    ]);
    expect(Number(rows[2][0])).toBeGreaterThan(Number(rows[1][0]));
    expect(Number(rows[2][1])).toBeCloseTo(Number(rows[1][1]), 8);
    expect(pointing.position_angle_deg).toBe(37);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("exports SAMI nominal pointings and ordered exposures as separate strategy-policy files", async () => {
    const registry = createBundledProfileRegistry();
    const strategy = registry.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (strategy.schema_version !== 3 || !strategy.observing_sequence) throw new Error("Expected the bundled SAMI v3 strategy");
    const acceptedPointings = [
      { ...proposal, id: "sami-nominal-1", instrument_profile_id: strategy.instrument_id, output_strategy_id: strategy.id },
      { ...proposal, id: "sami-nominal-2", ra_deg: 151.25, dec_deg: -23.5, instrument_profile_id: strategy.instrument_id, output_strategy_id: strategy.id },
    ];
    const downloads: Blob[] = [];
    const fileNames: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { downloads.push(blob); return `blob:sami-v3-${downloads.length}`; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { fileNames.push(this.download); });

    await downloadCatalogue(acceptedPointings, strategy.id, undefined, registry, {
      coverageBasis: "single_exposure",
      sequenceForTile: () => strategy.observing_sequence,
    });
    const nominalCsv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloads[0]);
    });
    const nominalRows = readCsv(nominalCsv);
    expect(nominalRows[0]).toEqual(["RA", "DEC", "EXPOSURE_ID", "INSTRUMENT_ID", "STRATEGY_ID"]);
    expect(nominalRows).toHaveLength(acceptedPointings.length + 1);
    expect(nominalRows.slice(1).map((row) => row.slice(0, 2))).toEqual(acceptedPointings.map((tile) => [tile.ra_deg.toFixed(8), tile.dec_deg.toFixed(8)]));
    expect(nominalRows[1][2]).toBe("PROPOSED_0001");
    expect(nominalRows[2][2]).toBe("PROPOSED_0002");

    await downloadCatalogue(acceptedPointings, strategy.id, undefined, registry, {
      coverageBasis: "single_exposure",
      sequenceForTile: () => strategy.observing_sequence,
    }, "expanded");
    const expandedCsv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloads[1]);
    });
    const expandedRows = readCsv(expandedCsv);
    expect(expandedRows[0]).toEqual(["RA", "DEC", "EXPOSURE_ID", "INSTRUMENT_ID", "STRATEGY_ID"]);
    const sequenceCount = strategy.observing_sequence.exposures.length;
    expect(expandedRows).toHaveLength(acceptedPointings.length * sequenceCount + 1);
    expect(expandedRows.slice(1).map((row) => row[2])).toEqual(acceptedPointings.flatMap((_, pointingIndex) =>
      Array.from({ length: sequenceCount }, (_, index) => `PROPOSED_${String(pointingIndex + 1).padStart(4, "0")}_EXP_${String(index + 1).padStart(4, "0")}`)));
    expect(expandedRows.slice(1).every((row) => row[3] === strategy.instrument_id && row[4] === strategy.id)).toBe(true);
    expect(expandedRows[1].slice(0, 2)).toEqual([acceptedPointings[0].ra_deg.toFixed(8), acceptedPointings[0].dec_deg.toFixed(8)]);
    expect(Number(expandedRows[2][0])).toBeCloseTo(acceptedPointings[0].ra_deg, 8);
    expect(Number(expandedRows[2][1])).toBeCloseTo(acceptedPointings[0].dec_deg + 0.7 / 3600, 8);
    expect(expandedRows[1 + sequenceCount].slice(0, 2)).toEqual([acceptedPointings[1].ra_deg.toFixed(8), acceptedPointings[1].dec_deg.toFixed(8)]);
    expect(expandedRows[0]).not.toContain("PA");
    expect(fileNames).toEqual(["new_tiles_nominal_pointings.csv", "new_tiles_expanded_exposures.csv"]);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("fails explicitly for an unresolved survey and creates no fallback download", async () => {
    const create = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    await expect(downloadCatalogue([proposal], "missing-survey")).rejects.toThrow(/Unknown survey/);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps expanded export unavailable for strategies without a registered sequence", async () => {
    const registry = createBundledProfileRegistry();
    const create = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    await expect(downloadCatalogue([proposal], "splus-t80-south", undefined, registry, undefined, "expanded"))
      .rejects.toThrow(/requires a registered observing sequence/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects expanded exports whose nominal pointing is associated with another strategy", async () => {
    const registry = createBundledProfileRegistry();
    const create = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    await expect(downloadCatalogue([{
      ...proposal,
      output_strategy_id: "califa-ppak-three-point",
    }], "sami-dr1-seven-position", undefined, registry, undefined, "expanded"))
      .rejects.toThrow(/cannot mix pointings associated with another observing strategy/);
    expect(create).not.toHaveBeenCalled();
  });

});

describe("local numerical facade", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plans locally from the same payload exposed to development diagnostics", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const polygon = { vertices: [
      { ra_deg: 150, dec_deg: -31 }, { ra_deg: 152, dec_deg: -31 },
      { ra_deg: 152, dec_deg: -29 }, { ra_deg: 150, dec_deg: -29 },
    ] };
    const result = await planRegion(polygon, [], "splus-t80-south");
    expect(result.solution).toBe("profile_fallback");
    expect(result.tiles.length).toBeGreaterThan(0);
    expect(buildRegionPlanRequest(polygon, [], "splus-t80-south")).toEqual({
      polygon, existing_tiles: [], profile_id: "splus-t80-south", coverage_strategy: "complete",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
