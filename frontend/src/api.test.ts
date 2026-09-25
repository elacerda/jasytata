import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegionPlanRequest, downloadCatalogue, getProfiles, loadDefaultProfile, loadReferenceCatalogue, planRegion, uploadCatalogue } from "./api";
import type { TileRecord } from "./types";

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

  it("loads the bundled CSV from a static asset URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("RA,DEC\n150,-24\n"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadReferenceCatalogue();
    expect(result.row_count).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/data\/tiles_nc\.csv$/);
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
    await downloadCatalogue([proposal], "splus-t80-south", "2000", "decimal");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:jasytata-test");
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
