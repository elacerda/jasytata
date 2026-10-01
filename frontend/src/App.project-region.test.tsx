import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import type { SkyPolygon, TileRecord } from "./types";

vi.mock("./api", async (original) => {
  const actual = await original<typeof api>();
  return { ...actual, planRegion: vi.fn(actual.planRegion), measureCoverage: vi.fn(actual.measureCoverage),
    downloadInstrumentCoordinates: vi.fn(), downloadCatalogue: vi.fn() };
});
vi.mock("./AladinMap", () => ({ default: (props: {
  onRegionSelect: (region: SkyPolygon) => void; tiles: TileRecord[]; projectCandidateCenters: unknown[];
}) => <div>
  <button onClick={() => props.onRegionSelect({ vertices: [
    { ra_deg: 149.9825, dec_deg: -0.0175 }, { ra_deg: 150.0175, dec_deg: -0.0175 },
    { ra_deg: 150.0175, dec_deg: 0.0175 }, { ra_deg: 149.9825, dec_deg: 0.0175 },
  ] })}>Small region</button>
  <button onClick={() => props.onRegionSelect({ vertices: [
    { ra_deg: 149.98, dec_deg: -0.02 }, { ra_deg: 150.02, dec_deg: -0.02 },
    { ra_deg: 150.02, dec_deg: 0.02 }, { ra_deg: 149.98, dec_deg: 0.02 },
  ] })}>Changed region</button>
  <output data-testid="candidate-sites">{props.projectCandidateCenters.length}</output>
  <output data-testid="pointings">{JSON.stringify(props.tiles)}</output>
</div> }));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
async function author(preview = false) {
  const user = userEvent.setup(); render(<App />);
  await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "instrument:vlt-muse-wfm");
  await user.type(screen.getByLabelText(/PA \(degrees east of north\)/), "30");
  await user.click(screen.getByRole("button", { name: "Small region" }));
  await user.click(screen.getByRole("radio", { name: "Regional mosaic" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Project lattice type" }), "rectangular");
  await user.type(screen.getByLabelText("East spacing"), "58"); await user.type(screen.getByLabelText("North spacing"), "58");
  await user.click(screen.getByRole("radio", { name: "Independent" }));
  await user.type(screen.getByLabelText("Lattice rotation · degrees east of north"), "0");
  await user.click(screen.getByRole("radio", { name: "Region center" }));
  expect(screen.getByRole("button", { name: "Generate plan" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: preview ? "Preview lattice" : "Apply placement" }));
  return user;
}
async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Generate plan" }));
  await screen.findByRole("button", { name: "Accept proposal" });
  return vi.mocked(api.planRegion).mock.results.at(-1)!.value as Promise<Awaited<ReturnType<typeof api.planRegion>>>;
}

describe("Gate 4 real App project planner integration", () => {
  it("generates without Preview, reviews, accepts, preserves sites and exports via existing workflow", async () => {
    const user = await author(); expect(screen.getByTestId("candidate-sites")).toHaveTextContent("0");
    const plan = await generate(user);
    expect(plan.tiles.length).toBeGreaterThan(0); expect(plan.solution).toBe("project_lattice");
    expect(screen.getByText(/Nominal envelope overlap · sampled estimate · Approximate/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    await waitFor(() => expect(api.measureCoverage).toHaveBeenCalled());
    const pointings = JSON.parse(screen.getByTestId("pointings").textContent!) as TileRecord[];
    expect(pointings.map((tile) => tile.placement_provenance)).toEqual(plan.tiles.map((tile) => tile.placement_provenance));
    expect(pointings.every((tile) => tile.instrument_profile_id === "vlt-muse-wfm" && tile.output_strategy_id === null)).toBe(true);
    await user.click(screen.getByRole("button", { name: /Download manual_centers.csv/ }));
    expect(api.downloadInstrumentCoordinates).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear proposal" }));
    expect(screen.getByTestId("pointings")).toHaveTextContent("[]");
  });
  it("preview includes every selected site and Candidate visibility cannot change inputs, metrics or selection", async () => {
    const user = await author(true); const count = Number(screen.getByTestId("candidate-sites").textContent);
    const first = await generate(user); expect(count).toBeGreaterThanOrEqual(first.tiles.length);
    await user.click(screen.getByRole("checkbox", { name: "Show Candidate lattice" }));
    expect(screen.getByRole("button", { name: "Accept proposal" })).toBeEnabled();
    const repeated = await generate(user); expect(repeated).toEqual(first);
    expect(vi.mocked(api.planRegion).mock.calls[1]).toEqual(vi.mocked(api.planRegion).mock.calls[0]);
    await user.click(screen.getByRole("button", { name: "Cancel preview" }));
    expect(screen.queryByText("Proposal preview")).toBeNull();
  });
  it.each(["region", "placement", "PA", "strategy", "instrument", "mode"])("invalidates pending plan and metrics after %s change", async (dependency) => {
    const user = await author(); await generate(user);
    if (dependency === "region") await user.click(screen.getByRole("button", { name: "Changed region" }));
    if (dependency === "placement") await user.clear(screen.getByLabelText("East spacing"));
    if (dependency === "PA") await user.clear(screen.getByLabelText(/PA \(degrees east of north\)/));
    if (dependency === "strategy") await user.click(screen.getByRole("radio", { name: /Efficient coverage/ }));
    if (dependency === "instrument") await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "instrument:keck-kcwi-small");
    if (dependency === "mode") await user.click(screen.getByRole("radio", { name: "Manual pointings" }));
    expect(screen.queryByText("Proposal preview")).toBeNull(); expect(screen.queryByText("Remaining uncovered")).toBeNull();
    if (dependency === "mode") {
      await user.click(screen.getByRole("radio", { name: "Regional mosaic" }));
      expect(screen.getByRole("button", { name: "Generate plan" })).toBeEnabled();
      expect(screen.getByLabelText("East spacing")).toHaveValue(58);
    }
  });
  it("reference marker leaves generated scientific result intact", async () => {
    const user = await author(); const first = await generate(user);
    await user.click(screen.getByText("Reference coordinate", { selector: "summary" }));
    await user.type(screen.getByLabelText("Reference RA"), "10"); await user.type(screen.getByLabelText("Reference Dec"), "20");
    await user.click(screen.getByRole("button", { name: "Place marker" }));
    expect(screen.getByRole("button", { name: "Accept proposal" })).toBeEnabled();
    expect(await generate(user)).toEqual(first);
  });
  it("target-access has no regional Generate action or Complete/Efficient controls", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "instrument:subaru-pfs-target-access");
    expect(screen.queryByRole("button", { name: "Generate plan" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Complete coverage/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Regional mosaic" })).toBeNull(); expect(api.planRegion).not.toHaveBeenCalled();
  });
  it("zero-site project planning shows the diagnostic and cannot accept fabricated pointings", async () => {
    const user = await author();
    await user.clear(screen.getByLabelText("East spacing")); await user.type(screen.getByLabelText("East spacing"), "1800");
    await user.clear(screen.getByLabelText("North spacing")); await user.type(screen.getByLabelText("North spacing"), "1800");
    await user.click(screen.getByRole("radio", { name: "Fixed sky coordinate" }));
    await user.type(screen.getByLabelText("Origin RA"), "159.37"); await user.type(screen.getByLabelText("Origin Dec"), "0");
    await user.click(screen.getByRole("button", { name: "Apply placement" })); const plan = await generate(user);
    expect(plan.tiles).toEqual([]); expect(screen.getByText(/zero admissible lattice sites/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept proposal" })).toBeDisabled();
    expect(screen.queryByText("Existing coverage already satisfies this plan.")).toBeNull();
  });
  it("does not let a delayed accepted-coverage response restore metrics after placement edits", async () => {
    const user = await author(); const plan = await generate(user);
    let resolveCoverage: (metrics: typeof plan.metrics) => void = () => undefined;
    vi.mocked(api.measureCoverage).mockImplementationOnce(() => new Promise((resolve) => { resolveCoverage = resolve; }));
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    await waitFor(() => expect(api.measureCoverage).toHaveBeenCalled());
    await user.clear(screen.getByLabelText("East spacing"));
    resolveCoverage(plan.metrics);
    await waitFor(() => expect(screen.queryByText("Remaining uncovered")).toBeNull());
    expect(screen.queryByText("Nominal envelope overlap · sampled estimate · Approximate")).toBeNull();
    expect(JSON.parse(screen.getByTestId("pointings").textContent!).length).toBe(plan.tiles.length);
  });

});
