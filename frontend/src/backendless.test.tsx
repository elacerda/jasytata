import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import referenceCsv from "../public/data/tiles_nc.csv?raw";
import App from "./App";
import type { CenterInput, SkyPolygon, TileRecord } from "./types";

vi.mock("./AladinMap", () => ({
  default: (props: {
    tiles: TileRecord[];
    selectedPolygon: SkyPolygon | null;
    onRegionSelect: (polygon: SkyPolygon) => void;
    onSkyClick: (ra: number, dec: number) => void;
    candidateCenters: CenterInput[];
  }) => (
    <div aria-label="Sky map test controls">
      <button onClick={() => props.onRegionSelect({ vertices: [
        { ra_deg: 262, dec_deg: -40 }, { ra_deg: 277, dec_deg: -40 },
        { ra_deg: 277, dec_deg: -27 }, { ra_deg: 262, dec_deg: -27 },
      ] })}>Select overlap region</button>
      <button onClick={() => props.onSkyClick(150.5, -24.25)}>Place center</button>
      <output data-testid="real-map-state">{JSON.stringify({
        selected: Boolean(props.selectedPolygon),
        proposed: props.tiles.filter((tile) => tile.source === "proposed").length,
        candidates: props.candidateCenters.length,
      })}</output>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("backend-off application workflow", () => {
  it("loads the static reference, plans and measures overlap, then exports without a backend", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(referenceCsv, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:jasytata-smoke") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);

    await user.click(screen.getByRole("button", { name: /load reference/i }));
    expect(await screen.findByText("4,774 original tiles")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select overlap region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(await screen.findByText("Existing grid extended", {}, { timeout: 10000 })).toBeTruthy();
    expect(screen.getByTestId("real-map-state")).toHaveTextContent('"candidates":');
    await user.click(screen.getByRole("button", { name: /accept proposal/i }));
    await waitFor(() => expect([...document.querySelectorAll(".metric-row")].map((row) => row.textContent)).toContain("Final region coverage99.6%"), { timeout: 10000 });
    await user.click(screen.getByRole("button", { name: /Download new_tiles.csv/i }));
    expect(click).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/data\/tiles_nc\.csv$/);
  }, 20000);

  it("parses an uploaded catalogue and stages pasted centers locally", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const csv = "RA,DEC,quality\n150.5,-24.25,good\n";
    const file = new File([csv], "uploaded.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(csv).buffer });
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), file);
    expect(await screen.findByText("1 original tiles")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("RA and DEC pairs"), "10:03:05, -23:54:31");
    await user.click(screen.getByRole("button", { name: "Validate and preview" }));
    expect(await screen.findByText("1 centers parsed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stage import preview" }));
    expect(screen.getByTestId("real-map-state")).toHaveTextContent('"proposed":1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
