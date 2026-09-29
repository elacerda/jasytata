import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentProfileEditor } from "./InstrumentProfileEditor";
import { SurveyProfileEditor } from "./SurveyProfileEditor";
import { parseProfileJson, serializeProfile, validateProfileDocument, type ProfileDocument } from "./document";
import { createBundledProfileRegistry, ProfileRegistry } from "./registry";
import { planRegion } from "../science/planner";
import { measureActiveCoverage } from "../science/coverage";
import { makeCenterProposals } from "../science/catalogue";
import type { InstrumentProfileV2 } from "../types";
import smallJson from "./fixtures/small-camera.json";

type User = ReturnType<typeof userEvent.setup>;
const polygon = { vertices: [
  { ra_deg: 150, dec_deg: -31 }, { ra_deg: 152, dec_deg: -31 },
  { ra_deg: 152, dec_deg: -29 }, { ra_deg: 150, dec_deg: -29 },
] };

async function edit(user: User, label: string, value: string) {
  const input = screen.getByRole("textbox", { name: label });
  await user.clear(input);
  if (value) await user.type(input, value);
}

async function openSurvey(user: User, instrumentId = "authored-camera", surveyId = "authored-survey") {
  await edit(user, "Instrument ID", instrumentId);
  await edit(user, "Display name", "Authored camera");
  await user.click(screen.getByRole("button", { name: "Continue to survey" }));
  await edit(user, "Survey ID", surveyId);
  await edit(user, "Survey display name", "Authored survey");
}

function getDraftDownload() {
  let blob: Blob | undefined;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn((value: Blob) => { blob = value; return "blob:authoring"; });
    static revokeObjectURL = vi.fn();
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe("authored-survey.json");
  });
  return { click, read: () => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob!);
  }) };
}

async function registerDraft(user: User, register: ReturnType<typeof vi.fn<(document: ProfileDocument) => void>>): Promise<ProfileDocument> {
  await user.click(screen.getByRole("button", { name: "Add profile" }));
  expect(register).toHaveBeenCalledOnce();
  return register.mock.lastCall![0];
}

describe("complete Schema v2 profile authoring", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("requires a valid instrument before opening the survey and validates the full document", async () => {
    const user = userEvent.setup();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Continue to survey" })).toBeDisabled();
    await edit(user, "Instrument ID", "authored-camera"); await edit(user, "Display name", "Camera");
    expect(screen.getByRole("status")).toHaveTextContent("Instrument valid");
    expect(screen.queryByText("Profile valid")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    expect(screen.getByRole("dialog", { name: "Create survey profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download profile JSON" })).toBeDisabled();
    const selector = screen.getByRole("combobox", { name: "Tiling strategy" });
    expect(within(selector).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["lattice", "manual"]);
    await edit(user, "Survey ID", "authored-survey"); await edit(user, "Survey display name", "Survey");
    expect(screen.getByRole("status")).toHaveTextContent("Profile valid");
  });

  it("authors rotated basis, fixed anchor and all policies, exports before registration, reimports and plans without a catalogue", async () => {
    const user = userEvent.setup();
    const registry = new ProfileRegistry();
    const register = vi.fn<(document: ProfileDocument) => void>((document) => { registry.registerProfileDocument(document); });
    const download = getDraftDownload();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />);
    await edit(user, "Instrument ID", "authored-camera"); await edit(user, "Display name", "Authored camera");
    await edit(user, "width (°)", "0.9"); await edit(user, "height (°)", "0.7"); await edit(user, "position angle (°)", "12");
    await edit(user, "Instrument description", "Physical camera");
    await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    await edit(user, "Survey ID", "authored-survey"); await edit(user, "Survey display name", "Authored survey");
    await edit(user, "Survey description", "Independent observing policy");
    for (const [label, value] of [["Basis 1 east (°)", "0.8"], ["Basis 1 north (°)", "0.6"], ["Basis 2 east (°)", "-0.6"], ["Basis 2 north (°)", "0.8"]]) await edit(user, label, value);
    await user.selectOptions(screen.getByRole("combobox", { name: "Lattice origin" }), "fixed_anchor");
    await edit(user, "Anchor RA (°)", "150.25"); await edit(user, "Anchor DEC (°)", "-30.125");
    await user.click(screen.getByRole("checkbox", { name: "Enable lattice inference" }));
    await user.click(screen.getByRole("checkbox", { name: "Allow inference rotation" }));
    for (const [label, value] of [["Spacing tolerance fraction", "0.17"], ["Phase tolerance fraction", "0.23"], ["Occupancy tolerance fraction", "0.11"], ["Minimum anchor tiles", "4"], ["Minimum neighbor pairs", "3"], ["Target samples per footprint axis", "12"], ["Maximum coverage samples", "4321"]]) await edit(user, label, value);
    await user.click(screen.getByRole("checkbox", { name: "Include Efficient policy" }));
    await edit(user, "Efficient minimum coverage", "0.82"); await edit(user, "Efficient minimum marginal efficiency", "0.27");
    await edit(user, "RA output column", "right_ascension"); await edit(user, "DEC output column", "declination");
    await user.selectOptions(screen.getByRole("combobox", { name: "Export coordinate format" }), "sexagesimal");
    await user.click(screen.getByRole("checkbox", { name: "Include epoch policy" }));
    await edit(user, "Epoch output column", "equinox"); await edit(user, "Default export epoch", "J2016"); await edit(user, "Allowed export epochs", "J2000\nJ2016");
    await edit(user, "Position angle output column · optional", "pa");
    for (const semantic of ["ID", "NAME", "GROUP"]) await edit(user, `${semantic} output column · optional`, semantic.toLowerCase());
    for (const key of ["release", "exposure", "calibrated", "__proto__"]) {
      await edit(user, "New constant column", key); await user.click(screen.getByRole("button", { name: "Add constant field" }));
    }
    await edit(user, "Constant release value", "pilot"); await edit(user, "Constant __proto__ value", "ordinary metadata");
    await user.selectOptions(screen.getByRole("combobox", { name: "Constant exposure type" }), "number"); await edit(user, "Constant exposure value", "123.5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Constant calibrated type" }), "boolean"); await user.click(screen.getByRole("checkbox", { name: "Constant calibrated value" }));
    expect(screen.getByText("Profile valid")).toBeTruthy();
    expect(registry.listSurveyProfiles()).toEqual([]); expect(register).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download profile JSON" }));
    await screen.findByText(/Profile JSON downloaded/);
    const json = await download.read();
    expect(download.click).toHaveBeenCalledOnce(); expect(register).not.toHaveBeenCalled(); expect(registry.listInstrumentProfiles()).toEqual([]);
    const parsed = parseProfileJson(json);
    expect(json).toBe(serializeProfile(parsed)); expect(validateProfileDocument(parsed)).toEqual(parsed);
    expect(parsed.instrument.footprint).toEqual({ type: "rectangle", width_deg: 0.9, height_deg: 0.7, position_angle_deg: 12 });
    expect(parsed.survey.instrument_id).toBe(parsed.instrument.id);
    expect(parsed.survey.tiling).toEqual({ type: "lattice", basis_deg: [[0.8, 0.6], [-0.6, 0.8]], origin: { type: "fixed_anchor", ra_deg: 150.25, dec_deg: -30.125 } });
    expect(parsed.survey.inference).toEqual({ enabled: true, allow_rotation: true, spacing_tolerance_fraction: 0.17, phase_tolerance_fraction: 0.23, occupancy_tolerance_fraction: 0.11, min_anchor_tiles: 4, min_neighbor_pairs: 3 });
    expect(parsed.survey.coverage).toEqual({ sampling: { target_samples_per_footprint_axis: 12, max_samples: 4321 }, efficient: { min_coverage: 0.82, min_marginal_efficiency: 0.27 } });
    expect(parsed.survey.export).toEqual({ ra_column: "right_ascension", dec_column: "declination", coordinate_format: "sexagesimal", epoch: { column: "equinox", default: "J2016", allowed: ["J2000", "J2016"] }, position_angle_column: "pa", identifiers: { id_column: "id", name_column: "name", group_column: "group" }, constant_fields: Object.fromEntries([["release", "pilot"], ["exposure", 123.5], ["calibrated", true], ["__proto__", "ordinary metadata"]]) });
    const authored = await registerDraft(user, register);
    expect(authored).toEqual(parsed);
    const imported = new ProfileRegistry(); imported.registerProfileDocument(parseProfileJson(json));
    expect(imported.resolveProfileDocument(parsed.survey.id)).toEqual(registry.resolveProfileDocument(parsed.survey.id));
    const plan = planRegion(polygon, [], parsed.survey.id, undefined, "complete", registry);
    expect(plan.tiles.length).toBeGreaterThan(0); expect(plan.solution).toBe("declared_lattice");
    expect(plan.metrics.sampling?.max_samples).toBe(4321);
    expect(plan.metrics.sampling?.natural_step_deg).toBeCloseTo(0.7 / 12, 12);
    expect(plan.inference.lattice?.status).toBe("no_usable_centers");
    expect(planRegion(polygon, [], parsed.survey.id, undefined, "complete", imported)).toEqual(plan);
    expect(planRegion(polygon, [], parsed.survey.id, undefined, "efficient", imported)).toEqual(planRegion(polygon, [], parsed.survey.id, undefined, "efficient", registry));
    for (const runtime of ["position_angle_deg", "phase_offset_deg", "projection_origin", "phase_fraction", "rotation_deg"]) expect(parsed.survey.tiling).not.toHaveProperty(runtime);
    expect(Object.keys(parsed)).toEqual(["instrument", "survey"]);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:authoring"));
  }, 20000);

  it("authors each identifier column, rejects collisions and removes an empty optional mapping", async () => {
    const user = userEvent.setup(); const register = vi.fn<(document: ProfileDocument) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await edit(user, "ID output column · optional", "RA");
    expect(screen.getByRole("alert")).toHaveTextContent("unique");
    expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();
    await edit(user, "ID output column · optional", "target");
    await edit(user, "NAME output column · optional", "target");
    expect(screen.getByRole("alert")).toHaveTextContent("unique");
    await edit(user, "NAME output column · optional", "label");
    await edit(user, "GROUP output column · optional", "project");
    expect(screen.getByRole("status")).toHaveTextContent("Profile valid");
    for (const semantic of ["ID", "NAME", "GROUP"]) await edit(user, `${semantic} output column · optional`, "");
    expect((await registerDraft(user, register)).survey.export).not.toHaveProperty("identifiers");
  });

  it("keeps region-center origin free of anchors and optional Efficient/epoch policies absent", async () => {
    const user = userEvent.setup(); const register = vi.fn<(document: ProfileDocument) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    expect(screen.queryByRole("textbox", { name: "Anchor RA (°)" })).toBeNull();
    const document = await registerDraft(user, register);
    expect(document.survey.tiling).toEqual({ type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "region_center" } });
    expect(document.survey.coverage).not.toHaveProperty("efficient"); expect(document.survey.export).not.toHaveProperty("epoch");
    const registry = new ProfileRegistry(); registry.registerProfileDocument(document);
    expect(planRegion(polygon, [], document.survey.id, undefined, "complete", registry).tiles.length).toBeGreaterThan(0);
    expect(() => planRegion(polygon, [], document.survey.id, undefined, "efficient", registry)).toThrow("requires coverage.efficient policy");
  });

  it("authors manual coverage honestly, registers it and refuses automatic planning", async () => {
    const user = userEvent.setup(); const register = vi.fn<(document: ProfileDocument) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await user.click(screen.getByRole("checkbox", { name: "Enable lattice inference" }));
    await user.click(screen.getByRole("checkbox", { name: "Allow inference rotation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Tiling strategy" }), "manual");
    expect(screen.getByText(/Coverage accounting and manual\/imported pointings work/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Basis 1 east (°)" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Enable lattice inference" })).toBeNull();
    const document = await registerDraft(user, register);
    expect(document.survey.tiling).toEqual({ type: "manual" }); expect(document.survey.inference.enabled).toBe(false); expect(document.survey.inference.allow_rotation).toBe(false);
    const registry = new ProfileRegistry(); registry.registerProfileDocument(parseProfileJson(serializeProfile(document)));
    expect(() => planRegion(polygon, [], document.survey.id, undefined, "complete", registry)).toThrow("uses manual tiling and does not define an automatic tiling strategy");
    for (const method of ["manual", "imported_centers"] as const) {
      const tiles = makeCenterProposals([{ ra_deg: 151, dec_deg: -30 }], method);
      const coverage = measureActiveCoverage(polygon, [], tiles, document.survey.id, undefined, registry);
      expect(coverage.new_tiles).toBe(1); expect(coverage.incremental_coverage).toBeGreaterThan(0);
    }
  });

  it.each([
    ["zero vector", "Basis 1 east (°)", "0", "must be non-zero"],
    ["collinear vectors", "Basis 2 north (°)", "0", "must be non-zero"],
    ["negative sampling", "Target samples per footprint axis", "-1", "must be a positive integer"],
    ["fraction above one", "Spacing tolerance fraction", "1.1", "must be in [0, 1]"],
    ["fraction below zero", "Phase tolerance fraction", "-0.1", "must be in [0, 1]"],
    ["invalid occupancy", "Occupancy tolerance fraction", "2", "must be in [0, 1]"],
    ["fractional anchors", "Minimum anchor tiles", "1.5", "must be a positive integer"],
    ["zero neighbor pairs", "Minimum neighbor pairs", "0", "must be a positive integer"],
    ["zero budget", "Maximum coverage samples", "0", "must be a positive finite integer"],
  ])("uses shared document errors for %s", async (_, label, value, message) => {
    const user = userEvent.setup(); const register = vi.fn();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await edit(user, label, value);
    expect(screen.getByRole("alert")).toHaveTextContent(message); expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled(); expect(register).not.toHaveBeenCalled();
  });

  it("rejects collinear non-zero vectors and incomplete/non-finite numeric text without clamping", async () => {
    const user = userEvent.setup(); const register = vi.fn();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await edit(user, "Basis 2 east (°)", "2"); await edit(user, "Basis 2 north (°)", "0");
    expect(screen.getByRole("alert")).toHaveTextContent("must not be collinear");
    await edit(user, "Basis 2 north (°)", "1");
    for (const value of ["", "-", "1e", "1e999", "NaN", "Infinity"]) {
      await edit(user, "Basis 1 east (°)", value);
      expect(screen.getByRole("textbox", { name: "Basis 1 east (°)" })).toHaveValue(value);
      expect(screen.getByRole("alert")).toHaveTextContent("Finish the numeric field");
      expect(screen.getByRole("button", { name: "Download profile JSON" })).toBeDisabled(); expect(screen.queryByText("Profile valid")).toBeNull();
    }
    await edit(user, "Basis 1 east (°)", "1"); expect(screen.getByText("Profile valid")).toBeTruthy();
  });

  it("validates fixed anchors and removes their fields when returning to region center", async () => {
    const user = userEvent.setup(); const register = vi.fn<(document: ProfileDocument) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    const origin = screen.getByRole("combobox", { name: "Lattice origin" }); await user.selectOptions(origin, "fixed_anchor");
    await edit(user, "Anchor RA (°)", "360"); expect(screen.getByRole("alert")).toHaveTextContent("RA in [0, 360)");
    expect(screen.getByRole("textbox", { name: "Anchor RA (°)" })).toHaveValue("360");
    await edit(user, "Anchor RA (°)", "150"); await edit(user, "Anchor DEC (°)", "90"); expect(screen.getByRole("alert")).toHaveTextContent("DEC in (-90, 90)");
    await edit(user, "Anchor DEC (°)", "-"); await user.selectOptions(origin, "region_center");
    expect(screen.getByText("Profile valid")).toBeTruthy(); const document = await registerDraft(user, register);
    expect(document.survey.tiling).toHaveProperty("origin", { type: "region_center" });
  });

  it("consumes authored sampling density, budget and Efficient thresholds through planning", async () => {
    const user = userEvent.setup(); const register = vi.fn<(document: ProfileDocument) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await edit(user, "Target samples per footprint axis", "24"); await edit(user, "Maximum coverage samples", "143");
    await user.click(screen.getByRole("checkbox", { name: "Include Efficient policy" }));
    await edit(user, "Efficient minimum coverage", "0"); await edit(user, "Efficient minimum marginal efficiency", "1");
    const document = await registerDraft(user, register); const registry = new ProfileRegistry(); registry.registerProfileDocument(document);
    const region = { vertices: [{ ra_deg: 150.9, dec_deg: -30.1 }, { ra_deg: 151.1, dec_deg: -30.1 }, { ra_deg: 151.1, dec_deg: -29.9 }, { ra_deg: 150.9, dec_deg: -29.9 }] };
    const complete = planRegion(region, [], document.survey.id, undefined, "complete", registry);
    expect(complete.tiles.length).toBeGreaterThan(0); expect(complete.metrics.sampling?.max_samples).toBe(143); expect(complete.metrics.sampling?.natural_step_deg).toBeCloseTo(1 / 24, 12);
    expect(planRegion(region, [], document.survey.id, undefined, "efficient", registry).tiles).toHaveLength(0);
    const large = planRegion(polygon, [], document.survey.id, undefined, "complete", registry);
    expect(large.metrics.sampling?.budget_limited).toBe(true); expect(large.metrics.sampling!.sample_count).toBeLessThanOrEqual(143);
  });

  it("clears incomplete buffers when optional policies/constant fields or tiling branches are removed", async () => {
    const user = userEvent.setup(); const register = vi.fn<(document: ProfileDocument) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await user.click(screen.getByRole("checkbox", { name: "Include Efficient policy" })); await edit(user, "Efficient minimum coverage", "2");
    expect(screen.getByRole("alert")).toHaveTextContent("Efficient minimum coverage must be in [0, 1]");
    await edit(user, "Efficient minimum coverage", ""); await user.click(screen.getByRole("checkbox", { name: "Include Efficient policy" }));
    for (const key of ["gain", "gain.extra"]) {
      await edit(user, "New constant column", key); await user.click(screen.getByRole("button", { name: "Add constant field" }));
      await user.selectOptions(screen.getByRole("combobox", { name: `Constant ${key} type` }), "number"); await edit(user, `Constant ${key} value`, "-");
    }
    await user.click(screen.getByRole("button", { name: "Remove constant gain" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Finish the numeric field");
    await user.selectOptions(screen.getByRole("combobox", { name: "Constant gain.extra type" }), "string");
    await user.click(screen.getByRole("button", { name: "Remove constant gain.extra" }));
    await edit(user, "Basis 1 east (°)", "-"); await edit(user, "Phase tolerance fraction", "-");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tiling strategy" }), "manual");
    expect(screen.getByText("Profile valid")).toBeTruthy(); const document = await registerDraft(user, register);
    expect(document.survey.coverage).not.toHaveProperty("efficient"); expect(document.survey.export).not.toHaveProperty("constant_fields");
  });

  it("rejects export column collisions/epoch mistakes and preserves constant entries on duplicate key attempts", async () => {
    const user = userEvent.setup(); const register = vi.fn();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />); await openSurvey(user);
    await edit(user, "DEC output column", "RA"); expect(screen.getByRole("alert")).toHaveTextContent("output column names must be unique");
    await edit(user, "DEC output column", "DEC"); await edit(user, "New constant column", "RA"); await user.click(screen.getByRole("button", { name: "Add constant field" }));
    expect(screen.getByRole("alert")).toHaveTextContent("output column names must be unique"); await user.click(screen.getByRole("button", { name: "Remove constant RA" }));
    await edit(user, "New constant column", "release"); await user.click(screen.getByRole("button", { name: "Add constant field" })); await edit(user, "Constant release value", "pilot");
    await edit(user, "New constant column", "release"); await user.click(screen.getByRole("button", { name: "Add constant field" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already exists"); expect(screen.getByRole("textbox", { name: "Constant release value" })).toHaveValue("pilot");
    await user.click(screen.getByRole("checkbox", { name: "Include epoch policy" })); await edit(user, "Default export epoch", "J2016"); await edit(user, "Allowed export epochs", "J2000");
    expect(screen.getByRole("alert")).toHaveTextContent("must be one of the allowed values");
    await user.click(screen.getByRole("checkbox", { name: "Include epoch policy" })); expect(screen.getByText("Profile valid")).toBeTruthy();
  });

  it.each(["instrument", "survey"])("rejects duplicate %s IDs atomically and lets users edit and retry", async (kind) => {
    const user = userEvent.setup(); const registry = createBundledProfileRegistry(); const beforeInstruments = registry.listInstrumentProfiles(); const beforeSurveys = registry.listSurveyProfiles();
    const register = vi.fn<(document: ProfileDocument) => void>((document) => { registry.registerProfileDocument(document); });
    render(<InstrumentProfileEditor onCancel={vi.fn()} onRegister={register} />);
    await openSurvey(user, kind === "instrument" ? "t80-south" : "authored-camera", kind === "survey" ? "splus-t80-south" : "authored-survey");
    expect(registry.listInstrumentProfiles()).toEqual(beforeInstruments); expect(registry.listSurveyProfiles()).toEqual(beforeSurveys);
    await user.click(screen.getByRole("button", { name: "Add profile" })); expect(screen.getByRole("alert")).toHaveTextContent("already registered");
    expect(registry.listInstrumentProfiles()).toEqual(beforeInstruments); expect(registry.listSurveyProfiles()).toEqual(beforeSurveys);
    if (kind === "instrument") { await user.click(screen.getByRole("button", { name: "Back to instrument" })); await edit(user, "Instrument ID", "authored-camera"); await user.click(screen.getByRole("button", { name: "Continue to survey" })); }
    else await edit(user, "Survey ID", "authored-survey");
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    expect(registry.listInstrumentProfiles()).toHaveLength(beforeInstruments.length + 1); expect(registry.listSurveyProfiles()).toHaveLength(beforeSurveys.length + 1);
    expect(registry.resolveProfileDocument("splus-t80-south")).toEqual({ instrument: beforeInstruments.find(({ id }) => id === "t80-south"), survey: beforeSurveys[0] });
    expect(registry.resolveProfileDocument("authored-survey").survey.instrument_id).toBe("authored-camera");
  });

  it("preserves both stages on Back, follows changed instrument identity and cancels without scientific mutation", async () => {
    const user = userEvent.setup(); const register = vi.fn(); const cancel = vi.fn();
    render(<InstrumentProfileEditor onCancel={cancel} onRegister={register} />); await openSurvey(user);
    await edit(user, "Basis 1 east (°)", "0.75"); await user.click(screen.getByRole("button", { name: "Back to instrument" }));
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Authored camera"); await edit(user, "Instrument ID", "changed-camera");
    await edit(user, "width (°)", ""); expect(screen.getByRole("button", { name: "Continue to survey" })).toBeDisabled();
    await edit(user, "width (°)", "0.8"); await user.click(screen.getByRole("button", { name: "Continue to survey" }));
    expect(screen.getByRole("textbox", { name: "Survey ID" })).toHaveValue("authored-survey"); expect(screen.getByRole("textbox", { name: "Basis 1 east (°)" })).toHaveValue("0.75");
    expect(screen.getByText(/changed-camera/)).toBeTruthy(); await user.click(screen.getByRole("button", { name: /^Cancel$/ })); expect(cancel).toHaveBeenCalledOnce(); expect(register).not.toHaveBeenCalled();
  });

  it("uses strict document validation for undeclared instrument fields rather than an instrument-only success", async () => {
    const instrument = { ...smallJson.instrument, runtime_phase: 5 } as InstrumentProfileV2;
    render(<SurveyProfileEditor instrument={instrument} onBack={vi.fn()} onCancel={vi.fn()} onRegister={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("unsupported field: runtime_phase"); expect(screen.queryByText("Profile valid")).toBeNull();
  });
});
