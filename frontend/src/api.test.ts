import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegionPlanRequest, downloadCatalogue, planRegion, uploadCatalogue } from "./api";
import type { TileRecord } from "./types";

const proposals: TileRecord[] = [];

describe("CSV browser download", () => {
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

  it("posts export metadata and triggers a named download from the CSV response", async () => {
    const csv = "RA,DEC,EPOCH\r\n";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(csv, {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:t80-test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.isConnected).toBe(true);
        expect(this.download).toBe("new_tiles.csv");
        expect(this.href).toBe("blob:t80-test");
      });

    await downloadCatalogue(proposals, "splus-t80-south", "2000", "decimal");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/export",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          proposed_tiles: proposals,
          profile_id: "splus-t80-south",
          epoch: "2000",
          coordinate_format: "decimal",
        }),
      }),
    );
    expect(click).toHaveBeenCalledOnce();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:t80-test");
  });
});

describe("catalogue upload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an explicit coordinate mapping and RA unit with the CSV", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      filename: "ambiguous.csv", row_count: 1, tiles: [], warnings: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["RA,ra_deg,DEC\n"], "ambiguous.csv", { type: "text/csv" });
    await uploadCatalogue(file, { raColumn: "ra_deg", decColumn: "DEC", raUnit: "degrees" });
    const [, options] = fetchMock.mock.lastCall as [string, { body: FormData }];
    expect(options.body.get("file")).toBe(file);
    expect(options.body.get("ra_column")).toBe("ra_deg");
    expect(options.body.get("dec_column")).toBe("DEC");
    expect(options.body.get("ra_unit")).toBe("degrees");
  });
});

describe("region plan request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the same payload exposed to development diagnostics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const polygon = { vertices: [
      { ra_deg: 262, dec_deg: -40 }, { ra_deg: 277, dec_deg: -40 },
      { ra_deg: 277, dec_deg: -27 }, { ra_deg: 262, dec_deg: -27 },
    ] };
    await planRegion(polygon, proposals, "splus-t80-south");
    expect(fetchMock).toHaveBeenCalledWith("/api/plan/region", expect.objectContaining({
      body: JSON.stringify(buildRegionPlanRequest(polygon, proposals, "splus-t80-south")),
    }));
  });
});
