import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createBundledProfileRegistry, type ProfileRegistry } from "./profiles/registry";
import { resolvePointingGeometries, type PointingGeometryContext } from "./science/pointing-geometry";
import { CoverageReadout, PointingScience } from "./ScientificReadouts";
import type { InstrumentProfileV3, SkyPolygon, SurveyProfileV3, TileRecord } from "./types";
import { readCsv } from "./science/catalogue";

interface MapModel {
  tiles: TileRecord[];
  pointingGeometryContext: PointingGeometryContext;
  onRegionSelect: (polygon: SkyPolygon) => void;
  onSkyClick: (ra: number, dec: number) => void;
}
const session = vi.hoisted(() => ({ registry: null as ProfileRegistry | null, map: null as MapModel | null, width: 0.006 }));
// Exercise real browser APIs/science/export; isolate only the session registry and remote map.
vi.mock("./profiles/registry", async (original) => {
  const module = await original<typeof import("./profiles/registry")>();
  const proxy = new Proxy({} as ProfileRegistry, { get: (_, key) => {
    const value = Reflect.get(session.registry!, key);
    return typeof value === "function" ? value.bind(session.registry) : value;
  } });
  return { ...module, profileRegistry: proxy };
});
vi.mock("./AladinMap", async () => {
  const React = await import("react");
  return { default: (props: MapModel) => {
    session.map = props;
    return React.createElement("div", {},
      React.createElement("button", { onClick: () => props.onSkyClick(150, 0) }, "Scientific sky click"),
      React.createElement("button", { onClick: () => props.onRegionSelect({ vertices: [
        { ra_deg: 150 - session.width / 2, dec_deg: -session.width / 2 },
        { ra_deg: 150 + session.width / 2, dec_deg: -session.width / 2 },
        { ra_deg: 150 + session.width / 2, dec_deg: session.width / 2 },
        { ra_deg: 150 - session.width / 2, dec_deg: session.width / 2 },
      ] }) }, "Scientific region"));
  } };
});

const user = () => userEvent.setup();
async function select(u: ReturnType<typeof user>, id: string) {
  await u.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), id);
}
async function place(u: ReturnType<typeof user>) {
  await u.click(screen.getByRole("button", { name: "Scientific sky click" }));
  await screen.findByText("Proposal preview");
}
async function accept(u: ReturnType<typeof user>) {
  await u.click(screen.getByRole("button", { name: "Accept proposal" }));
}
function pointings() { return session.map!.tiles.filter((tile) => tile.source === "proposed"); }
function instrument(id: string) { return session.registry!.resolveAnyInstrumentProfile(id) as InstrumentProfileV3; }

/** Synthetic strategy reuses frozen geometry; it is never added to the production library. */
function registerTestStrategy(id: string, cap = 100_000, lattice = false) {
  const base = session.registry!.resolveAnySurveyProfile("sami-dr1-seven-position") as SurveyProfileV3;
  const { observing_sequence: omitted, ...strategy } = base;
  void omitted;
  return session.registry!.registerSurveyProfileV3({
    ...strategy, id, display_name: `Synthetic ${id}`, instrument_id: "keck-kcwi-small",
    tiling: lattice ? { type: "lattice", basis_deg: [[0.002, 0], [0, 0.004]], origin: { type: "region_center" } } : { type: "manual" },
    coverage_basis_default: "single_exposure",
    coverage: { ...base.coverage, target_samples_per_footprint_axis: 8, sampling: { ...base.coverage.sampling, max_samples: cap } },
    provenance: lattice ? { ...base.provenance, parameter_sources: [
      { parameter_path: "tiling.basis_deg", reference_url: base.provenance.references[0].url! },
      { parameter_path: "tiling.origin.type", reference_url: base.provenance.references[0].url! }] } : { ...base.provenance, parameter_sources: [] },
  });
}

/** Decode the real local download Blob. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
}

describe("Gate 7B scientific browser controls", () => {
  let downloads: Blob[];
  beforeEach(() => {
    session.registry = createBundledProfileRegistry(); session.map = null; session.width = 0.006; downloads = [];
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { downloads.push(blob); return "blob:scientific"; });
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows legacy/exact/envelope/access semantics, all production modes, fixed PA and accessible evidence", async () => {
    const u = user(); render(<App />);
    expect(screen.getByLabelText("Active survey summary")).toHaveTextContent("Legacy v2 behavior · role not classified");
    const selector = screen.getByRole("combobox", { name: "Output profile" });
    expect(within(selector).getAllByRole("option")).toHaveLength(30);
    expect(selector.querySelectorAll("optgroup")).toHaveLength(4);
    await select(u, "instrument:keck-kcwi-small");
    expect(screen.getByLabelText("Active instrument summary")).toHaveTextContent("Exact observed-area geometry");
    expect(screen.getByLabelText("Active instrument summary")).toHaveTextContent("Fixed · 0° east of north");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await place(u); await accept(u);
    await u.click(screen.getByRole("button", { name: /Pointing 1/ }));
    expect(document.querySelector(".pointing-science")).toHaveTextContent("Placement: Manual");
    expect(document.querySelector(".pointing-science")).toHaveTextContent("PA 0° east of north");
    const disclosure = screen.getByText("Scientific details");
    disclosure.focus(); expect(disclosure).toHaveFocus();
    expect(disclosure.tagName).toBe("SUMMARY");
    // jsdom does not implement native summary key activation; the browser supplies it.
    await u.click(disclosure);
    expect(disclosure.closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("link", { name: /KCWI/i })).toHaveAttribute("href");
    await select(u, "instrument:vlt-muse-wfm");
    expect(screen.getByLabelText("Active instrument summary")).toHaveTextContent("Nominal envelope · Approximate");
    await u.click(screen.getByText("Scientific details"));
    const evidence = document.querySelector(".scientific-details")!;
    expect(evidence).toHaveTextContent(instrument("vlt-muse-wfm").footprint_semantics.approximation_notice!);
    expect(evidence).toHaveTextContent("Assumptions"); expect(evidence).toHaveTextContent("Limitations");
    expect(evidence).toHaveTextContent(instrument("vlt-muse-wfm").provenance.limitations[0]);
    await select(u, "instrument:subaru-pfs-target-access");
    expect(screen.getByLabelText("Active instrument summary")).toHaveTextContent("not observed coverage");
  });

  it("requires per-pointing PA, explicitly opts a pasted batch into common PA, and preserves each exported row", async () => {
    const u = user(); render(<App />); await select(u, "instrument:vlt-muse-wfm");
    await u.click(screen.getByRole("button", { name: "Scientific sky click" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a finite position angle");
    expect(screen.queryByText("Proposal preview")).toBeNull();
    const pa = screen.getByRole("spinbutton", { name: "Required pointing PA in degrees east of north" });
    expect(pa).toBeRequired(); await u.type(pa, "25"); await place(u); await accept(u);
    await u.clear(pa); await u.type(pa, "80");
    await u.type(screen.getByRole("textbox", { name: "RA and DEC pairs" }), "150.001, 0\n150.002, 0");
    await u.click(screen.getByRole("button", { name: "Validate and preview" }));
    await u.click(screen.getByRole("button", { name: "Stage import preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Apply pointing PA to this pasted batch");
    await u.click(screen.getByRole("checkbox", { name: "Apply pointing PA to this pasted batch" }));
    await u.click(screen.getByRole("button", { name: "Stage import preview" }));
    await screen.findByText("Proposal preview");
    expect(pointings().map(({ position_angle_deg }) => position_angle_deg)).toEqual([25, 80, 80]);
    await accept(u); await u.clear(pa);
    await u.click(screen.getByRole("button", { name: /Download manual_centers.csv/ }));
    const csv = readCsv(await blobText(downloads[0]));
    expect(csv[0]).toContain("POSITION_ANGLE_DEG");
    const paIndex = csv[0].indexOf("POSITION_ANGLE_DEG");
    expect(csv.slice(1).map((row) => Number(row[paIndex]))).toEqual([25, 80, 80]);
    expect(csv[0]).not.toContain("EPOCH"); expect(csv[0]).not.toContain("strategy_id");
    expect(pointings().map(({ placement_provenance }) => placement_provenance?.origin)).toEqual(["manual", "imported_unverified", "imported_unverified"]);
  });

  it("prefills user-selected PA, freezes preview before acceptance and retains snapshots across session edits", async () => {
    const muse = instrument("vlt-muse-wfm");
    session.registry!.registerInstrumentProfileV3({ ...muse, id: "test-plan-pa", display_name: "Synthetic session PA",
      footprint: { ...muse.footprint, position_angle_deg: 17 }, position_angle: { mode: "user_selected", required: true },
      provenance: { ...muse.provenance, parameter_sources: [...muse.provenance.parameter_sources,
        { parameter_path: "footprint.position_angle_deg", reference_url: muse.provenance.references[0].url! }] } });
    const u = user(); render(<App />); await select(u, "instrument:test-plan-pa");
    const pa = screen.getByRole("spinbutton", { name: "Plan/session PA in degrees east of north" });
    expect(pa).toHaveValue(17); await place(u);
    await u.clear(pa); await u.type(pa, "91");
    expect(pointings()[0].output_position_angle_deg).toBe(17);
    await accept(u); await place(u); await accept(u);
    expect(pointings().map(({ output_position_angle_deg }) => output_position_angle_deg)).toEqual([17, 91]);
    await select(u, "instrument:keck-kcwi-small"); await select(u, "instrument:test-plan-pa");
    expect(pointings().map(({ output_position_angle_deg }) => output_position_angle_deg)).toEqual([17, 91]);
    await u.click(screen.getByRole("button", { name: /Download manual_centers.csv/ }));
    expect(await blobText(downloads[0])).toContain("17.00000000");
    expect(await blobText(downloads[0])).toContain("91.00000000");
  });

  it("uses one nominal SAMI pointing, controls geometry/metrics/export basis, and omits nonphysical PA", async () => {
    const u = user(); render(<App />); await select(u, "survey:sami-dr1-seven-position");
    const basis = screen.getByRole("combobox", { name: "Geometry and export basis" });
    expect(basis).toHaveValue("effective_sequence"); expect(screen.queryByRole("spinbutton")).toBeNull();
    await place(u); expect(pointings()).toHaveLength(1);
    expect(resolvePointingGeometries(pointings()[0], null, session.registry!, session.map!.pointingGeometryContext)).toHaveLength(7);
    expect(document.querySelectorAll(".proposal-row")).toHaveLength(1);
    expect(document.querySelector(".proposal-section")).not.toHaveTextContent("PA 0");
    await accept(u); await u.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    const expanded = readCsv(await blobText(downloads[0])); expect(expanded).toHaveLength(8); expect(expanded[0]).not.toContain("POSITION_ANGLE_DEG");
    await u.selectOptions(basis, "single_exposure");
    expect(pointings()).toHaveLength(1);
    expect(resolvePointingGeometries(pointings()[0], null, session.registry!, session.map!.pointingGeometryContext)).toHaveLength(1);
    await u.click(screen.getByRole("button", { name: /Download new_tiles.csv/ }));
    expect(readCsv(await blobText(downloads[1]))).toHaveLength(2);
    await u.click(screen.getByRole("button", { name: "Scientific region" }));
    await waitFor(() => expect(screen.getAllByText("Nominal envelope overlap").find((node) => node.tagName === "SPAN")?.closest(".metric-row")).toBeTruthy());
    expect(document.querySelector(".scientific-coverage")).toHaveTextContent("Approximate");
    expect(document.querySelector(".scientific-coverage")).not.toHaveTextContent("Observed-area geometry coverage");
    await u.click(screen.getByText("Sampling details"));
    expect(screen.getByText("Required pitch")).toBeVisible();
    expect(screen.getByText("Fraction error upper bound")).toBeVisible();
    await u.selectOptions(basis, "effective_sequence");
    await waitFor(() => expect(document.querySelector(".scientific-coverage")).toHaveTextContent("Effective sequence · geometric union only"));
    expect(pointings()).toHaveLength(1);
    await select(u, "instrument:aat-sami-61core-15arcsec");
    expect(screen.queryByRole("combobox", { name: "Geometry and export basis" })).toBeNull();
    expect(session.map!.pointingGeometryContext.sequenceForTile?.({ ...pointings()[0], source: "proposed" } as TileRecord)).toBeUndefined();
  });

  it("measures exact observed-area geometry with resolved sampling and keeps diagnostics isolated across contexts", async () => {
    registerTestStrategy("test-observed");
    const u = user(); render(<App />); await select(u, "survey:test-observed");
    await place(u); await accept(u); await u.click(screen.getByRole("button", { name: "Scientific region" }));
    await waitFor(() => expect(screen.getAllByText("Observed-area geometry coverage").find((node) => node.tagName === "SPAN")).toBeTruthy());
    expect(document.querySelector(".scientific-coverage")).toHaveTextContent("Exact geometry");
    await u.click(screen.getByText("Sampling details"));
    expect(screen.getByText("Actual cell size (east × north)")).toBeVisible();
    expect(document.querySelector(".scientific-details[open]")).toHaveTextContent("arcsec");
    await select(u, "instrument:keck-kcwi-small"); expect(document.querySelector(".scientific-coverage")).toBeNull();
  });

  it("presents typed planner refusal with required pitch/budget and no percentage, then clears it on context switch", async () => {
    registerTestStrategy("test-under-resolved", 1000, true); session.width = 0.05;
    const u = user(); render(<App />); await select(u, "survey:test-under-resolved");
    await u.click(screen.getByRole("button", { name: "Scientific region" }));
    await u.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByText("Coverage unavailable at required resolution");
    const readout = document.querySelector(".scientific-coverage")!;
    expect(readout).toHaveTextContent("No authoritative coverage percentage");
    expect(readout).toHaveTextContent("maximum budget: 1,000");
    expect(readout.textContent).not.toMatch(/\d%|NaN%|--%/);
    expect(screen.queryByText("Proposal preview")).toBeNull();
    await u.click(screen.getByText("Sampling details"));
    expect(readout).toHaveTextContent("Actual cells are diagnostic only");
    await select(u, "survey:splus-t80-south"); expect(document.querySelector(".scientific-coverage")).toBeNull();
  });

  it("isolates transient state through S-PLUS → KCWI → MUSE → PFS → SAMI → S-PLUS and restores accepted identity", async () => {
    const u = user(); render(<App />);
    await select(u, "instrument:keck-kcwi-small"); await place(u); await accept(u);
    const identity = pointings()[0];
    await select(u, "instrument:vlt-muse-wfm");
    await u.type(screen.getByRole("spinbutton", { name: /Required pointing PA/ }), "37"); await place(u);
    await select(u, "instrument:subaru-pfs-target-access");
    expect(screen.getByRole("spinbutton", { name: /Required pointing PA/ })).toHaveValue(null);
    expect(screen.queryByText("Proposal preview")).toBeNull(); expect(pointings()).toHaveLength(0);
    await u.type(screen.getByRole("spinbutton", { name: /Required pointing PA/ }), "63"); await place(u); await accept(u);
    await u.click(screen.getByRole("button", { name: /Pointing 1/ }));
    expect(document.querySelector(".pointing-science")).toHaveTextContent("Target-access envelope");
    expect(document.querySelector(".pointing-science")).toHaveTextContent("Not observed coverage");
    await select(u, "survey:sami-dr1-seven-position");
    expect(screen.getByRole("combobox", { name: "Geometry and export basis" })).toHaveValue("effective_sequence");
    await u.selectOptions(screen.getByRole("combobox", { name: "Geometry and export basis" }), "single_exposure");
    await place(u); await accept(u); session.width = 0.3;
    await u.click(screen.getByRole("button", { name: "Scientific region" }));
    await screen.findByText("Coverage unavailable at required resolution");
    await select(u, "survey:splus-t80-south");
    expect(screen.queryByText("Proposal preview")).toBeNull(); expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(document.querySelector(".scientific-coverage")).toBeNull();
    await select(u, "survey:sami-dr1-seven-position");
    expect(screen.getByRole("combobox", { name: "Geometry and export basis" })).toHaveValue("effective_sequence");
    await select(u, "instrument:keck-kcwi-small"); expect(pointings()).toEqual([identity]);
  });

  it("displays approximate observed metrics and target-access unavailability without upgrading their meaning", () => {
    const { unmount } = render(<CoverageReadout metrics={{ coverage_status: "resolved", coverage_basis: "observed_area", geometry_basis: "single_exposure",
      contributing_semantics: [{ role: "observed_area", fidelity: "approximate" }], existing_tiles_contributing: 1, new_tiles: 0,
      selected_region_area_deg2: 0.01, already_covered_fraction: 0.5, selected_region_coverage: 0.5, incremental_coverage: 0,
      remaining_uncovered_fraction: 0.5, remaining_uncovered_area_deg2: 0.005, redundant_coverage: 0, outside_region_coverage_deg2: 0, sample_step_deg: 0.001 }} />);
    expect(document.querySelector(".scientific-coverage")).toHaveTextContent("Approximate"); unmount();
    render(<CoverageReadout metrics={{ coverage_status: "unsupported_basis", coverage_basis: "target_access" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("individual fibre reachability, assignment or successful observation");
    expect(document.querySelector(".scientific-coverage")!.textContent).not.toContain("%");
  });

  it.each(["manual", "imported_unverified", "authoritative_import", "declared_profile_lattice", "local_inference"] as const)("shows the frozen %s placement origin without generation-method authority", (origin) => {
    const tile: TileRecord = { id: "origin", name: "", source: "proposed", generation_method: "region_lattice", instrument_profile_id: "keck-kcwi-small",
      ra_deg: 150, dec_deg: 0, metadata: {}, original_values: null, placement_provenance: { origin,
        ...(origin === "authoritative_import" ? { source_reference: { url: "https://example.org/declared-release", title: "Declared test release" } } : {}) } };
    render(<PointingScience tile={tile} context={{ orientationPolicyForTile: () => ({ policy: "fixed", required: true }) }} fallbackInstrument={null} />);
    const labels = { manual: "Manual", imported_unverified: "Imported · unverified", authoritative_import: "Authoritative import", declared_profile_lattice: "Declared profile lattice", local_inference: "Local inference" };
    expect(screen.getByText(`Placement: ${labels[origin]}`)).toBeTruthy();
    if (origin === "authoritative_import") expect(screen.getByRole("link", { name: "Declared test release" })).toHaveAttribute("href", "https://example.org/declared-release");
    else expect(screen.queryByRole("link")).toBeNull();
  });
});
