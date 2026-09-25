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
      <button onClick={() => props.onRegionSelect({ vertices: [
        { ra_deg: 37.686125, dec_deg: -21.172083 }, { ra_deg: 37.137375, dec_deg: -13.772167 },
        { ra_deg: 26.4205, dec_deg: -14.405278 }, { ra_deg: 25.434083, dec_deg: -21.233194 },
      ] })}>Draw profile fallback region</button>
      <button onClick={() => props.onRegionSelect({ vertices: [
        { ra_deg: 150, dec_deg: -31 }, { ra_deg: 154, dec_deg: -31 },
        { ra_deg: 154, dec_deg: -27 }, { ra_deg: 150, dec_deg: -27 },
      ] })}>Draw empty rectangle</button>
      <button onClick={() => props.onSkyClick(150.5, -24.25)}>Place center</button>
      <output data-testid="real-map-state">{JSON.stringify({
        selected: Boolean(props.selectedPolygon),
        proposed: props.tiles.filter((tile) => tile.source === "proposed").length,
        proposedCenters: props.tiles.filter((tile) => tile.source === "proposed")
          .map(({ ra_deg, dec_deg }) => ({ ra_deg, dec_deg })),
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
  it("switches real zero-catalogue plans from Complete to Efficient", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Profile only · no original tiles");
    await user.click(screen.getByRole("button", { name: "Draw empty rectangle" }));
    expect(screen.getByRole("radio", { name: /Complete coverage/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(await screen.findByText("Complete coverage", { selector: ".strategy-result" })).toBeTruthy();
    expect(screen.getByText("New tiles").parentElement).toHaveTextContent("15");
    await user.click(screen.getByRole("radio", { name: /Efficient coverage/ }));
    expect(screen.queryByRole("button", { name: /accept proposal/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(await screen.findByText("Efficient coverage", { selector: ".strategy-result" })).toBeTruthy();
    expect(screen.getByText("New tiles").parentElement).toHaveTextContent("14");
    expect(screen.getByText("Remaining uncovered").parentElement).toHaveTextContent("0.2%");
    await user.click(screen.getByRole("button", { name: /accept proposal/i }));
    expect(screen.getByText("Efficient coverage", { selector: ".accepted-section .strategy-result" })).toBeTruthy();
  });

  it("plans, accepts, measures, edits, and exports with zero original tiles", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    const exportedBlobs: Blob[] = [];
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => { exportedBlobs.push(blob); return "blob:jasytata-empty-catalogue"; }),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);

    expect(await screen.findByText("OPTIONAL")).toBeTruthy();
    expect(await screen.findByText("Profile only · no original tiles")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /select area/i }));
    await user.click(screen.getByRole("button", { name: "Draw profile fallback region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(await screen.findByText("Profile fallback", {}, { timeout: 10000 })).toBeTruthy();
    expect(screen.getByText("Already covered").parentElement).toHaveTextContent("0.0%");
    expect(screen.getByText("Final region coverage").parentElement).toHaveTextContent("100.0%");

    await user.click(screen.getByRole("button", { name: /accept proposal/i }));
    await waitFor(() => expect(screen.getByText(/^\d+ enabled · 0 disabled$/)).toBeTruthy(), { timeout: 10000 });
    await waitFor(() => expect(screen.getByText("Final region coverage").parentElement).toHaveTextContent("100.0%"), { timeout: 10000 });
    expect(screen.getByText("Already covered").parentElement).toHaveTextContent("0.0%");
    await user.click(screen.getByRole("button", { name: "Disable all" }));
    await waitFor(() => expect(screen.getByText(/^0 enabled · \d+ disabled$/)).toBeTruthy(), { timeout: 10000 });
    await waitFor(() => expect(screen.getByText("Final region coverage").parentElement).toHaveTextContent("0.0%"), { timeout: 10000 });
    await user.click(screen.getByRole("button", { name: "Restore all" }));
    await waitFor(() => expect(screen.getByText(/^\d+ enabled · 0 disabled$/)).toBeTruthy(), { timeout: 10000 });
    await waitFor(() => expect(screen.getByText("Final region coverage").parentElement).toHaveTextContent("100.0%"), { timeout: 10000 });

    await user.click(screen.getByRole("button", { name: /download new_tiles.csv/i }));
    await waitFor(() => expect(exportedBlobs).toHaveLength(1));
    expect(click).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    const state = JSON.parse(screen.getByTestId("real-map-state").textContent ?? "{}") as {
      proposedCenters: Array<{ ra_deg: number; dec_deg: number }>;
    };
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Could not read the exported CSV."));
      reader.readAsText(exportedBlobs[0]);
    });
    const rows = csv.trim().split(/\r?\n/);
    expect(rows[0]).toBe("RA,DEC,EPOCH");
    expect(rows).toHaveLength(state.proposedCenters.length + 1);
    for (const { ra_deg, dec_deg } of state.proposedCenters) {
      expect(rows).toContain(`${ra_deg.toFixed(8)},${dec_deg.toFixed(8)},2000`);
    }
  }, 30000);

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
    await waitFor(() => expect([...document.querySelectorAll(".metric-row")].map((row) => row.textContent)).toContain("Final region coverage100.0%"), { timeout: 10000 });
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
