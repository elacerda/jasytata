import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { createProjectManifest, parseProjectManifest, serializeProjectManifest } from "./project-manifest";
import { profileRegistry } from "./profiles";
import { planRegion as planRegionLocal } from "./science/planner";
import type { RegionPlanResponse, SkyPolygon, TileRecord } from "./types";

vi.mock("./api", async (original) => {
  const actual = await original<typeof api>();
  return { ...actual, planRegion: vi.fn(actual.planRegion), measureCoverage: vi.fn(actual.measureCoverage),
    downloadInstrumentCoordinates: vi.fn(), downloadCatalogue: vi.fn() };
});
vi.mock("./AladinMap", () => ({ default: (props: {
  onRegionSelect: (region: SkyPolygon) => void;
  tiles: TileRecord[];
  projectCandidateCenters: unknown[];
}) => <div>
  <button onClick={() => props.onRegionSelect({ vertices: [
    { ra_deg: 149.9825, dec_deg: -0.0175 }, { ra_deg: 150.0175, dec_deg: -0.0175 },
    { ra_deg: 150.0175, dec_deg: 0.0175 }, { ra_deg: 149.9825, dec_deg: 0.0175 },
  ] })}>Set project region</button>
  <output data-testid="pointings">{JSON.stringify(props.tiles)}</output>
  <output data-testid="candidate-sites">{props.projectCandidateCenters.length}</output>
</div> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.planRegion).mockImplementation(async (polygon, existingTiles, profileId, profile, strategy, context, source) =>
    planRegionLocal(polygon, existingTiles, profileId, profile, strategy, profileRegistry, context, source));
});

async function authorEmptyRegionalProject() {
  const user = userEvent.setup();
  render(<App />);
  await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "instrument:vlt-muse-wfm");
  await user.type(screen.getByLabelText(/PA \(degrees east of north\)/), "30");
  await user.click(screen.getByRole("button", { name: "Set project region" }));
  await user.click(screen.getByRole("radio", { name: "Regional mosaic" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Project lattice type" }), "rectangular");
  await user.type(screen.getByLabelText("East spacing"), "58");
  await user.type(screen.getByLabelText("North spacing"), "58");
  await user.click(screen.getByRole("radio", { name: "Independent" }));
  await user.type(screen.getByLabelText("Lattice rotation · degrees east of north"), "0");
  await user.click(screen.getByRole("radio", { name: "Region center" }));
  await user.click(screen.getByRole("button", { name: "Apply placement" }));
  return user;
}

function importedRecipe() {
  return createProjectManifest({
    instrumentId: "vlt-muse-wfm",
    observingStrategyId: null,
    planningMode: "regional_mosaic",
    region: { vertices: [
      { ra_deg: 150.28, dec_deg: 1.18 }, { ra_deg: 150.32, dec_deg: 1.18 },
      { ra_deg: 150.32, dec_deg: 1.22 }, { ra_deg: 150.28, dec_deg: 1.22 },
    ] },
    placement: {
      type: "lattice_project_placement", provenance: "user_declared",
      authoring: { preset: "triangular", pitch_deg: 48 / 3600 },
      rotation: { mode: "independent", rotation_deg: 13 },
      origin: { type: "region_center" },
    },
    positionAngleInputDeg: 17,
    coverageStrategy: "efficient",
    sequenceCoverageBasis: null,
    catalogueDependencies: [],
  }, profileRegistry);
}

async function uploadManifest(user: ReturnType<typeof userEvent.setup>, json = serializeProjectManifest(importedRecipe())) {
  const file = new File([json], "recipe.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => json });
  await user.upload(screen.getByLabelText("Choose Jasytata project JSON"), file);
}

describe("Gate 7 integrated project workflow", () => {
  it("plans a standalone Regional mosaic from an empty project without loading a catalogue", async () => {
    const user = await authorEmptyRegionalProject();
    expect(screen.getByText("0", { selector: ".summary-number" })).toBeTruthy();
    expect(screen.getByText(/OPTIONAL/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Accept proposal" });
    const result = await (vi.mocked(api.planRegion).mock.results.at(-1)!.value as Promise<RegionPlanResponse>);
    expect(result.tiles.length).toBeGreaterThan(0);
    expect(result.tiles.every((tile) => tile.instrument_profile_id === "vlt-muse-wfm")).toBe(true);
    expect(screen.getByText(/pointings ready for review/)).toBeTruthy();
  });

  it("downloads the canonical project recipe separately from pointing CSV products", async () => {
    const user = await authorEmptyRegionalProject();
    const createUrl = vi.fn((blob: Blob) => {
      expect(blob.type).toBe("application/json; charset=utf-8");
      return "blob:jasytata-project";
    });
    const revokeUrl = vi.fn();
    const urlWithBlobSupport = class extends URL {};
    Object.defineProperties(urlWithBlobSupport, {
      createObjectURL: { configurable: true, value: createUrl },
      revokeObjectURL: { configurable: true, value: revokeUrl },
    });
    vi.stubGlobal("URL", urlWithBlobSupport);
    const downloadedNames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedNames.push(this.download);
    });

    await user.click(screen.getByRole("button", { name: "Export project" }));
    expect(await screen.findByText(/jasytata-project\.json downloaded/)).toBeTruthy();
    expect(downloadedNames).toEqual(["jasytata-project.json"]);
    expect(revokeUrl).toHaveBeenCalledWith("blob:jasytata-project");
    const blob = createUrl.mock.calls[0][0] as Blob;
    const json = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    const exported = parseProjectManifest(json, profileRegistry);
    expect(exported.project.instrument.id).toBe("vlt-muse-wfm");
    expect(exported.project.region).toEqual({ vertices: [
      { ra_deg: 149.9825, dec_deg: -0.0175 }, { ra_deg: 150.0175, dec_deg: -0.0175 },
      { ra_deg: 150.0175, dec_deg: 0.0175 }, { ra_deg: 149.9825, dec_deg: 0.0175 },
    ] });
    expect(exported.project.catalogue_dependencies).toEqual([]);
    expect(exported.project.placement?.provenance).toBe("user_declared");
  });

  it("leaves current project and pending plan untouched after invalid JSON import", async () => {
    const user = await authorEmptyRegionalProject();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Accept proposal" });
    const before = screen.getByTestId("project-summary").textContent;
    const beforePointings = screen.getByTestId("pointings").textContent;
    await uploadManifest(user, "{bad project json");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Malformed project JSON/);
    expect(screen.getByTestId("project-summary").textContent).toBe(before);
    expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("instrument:vlt-muse-wfm");
    expect(screen.getByRole("radio", { name: "Regional mosaic" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Accept proposal" })).toBeEnabled();
    expect(screen.getByTestId("pointings").textContent).toBe(beforePointings);
  });

  it("keeps current project and plan unchanged for every rejected manifest category", async () => {
    const user = await authorEmptyRegionalProject();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Accept proposal" });

    const mutateManifest = (change: (manifest: Record<string, unknown>) => void) => {
      const value: unknown = JSON.parse(serializeProjectManifest(importedRecipe(), profileRegistry));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a project manifest object.");
      const manifest = value as Record<string, unknown>;
      change(manifest);
      return JSON.stringify(manifest);
    };
    const mutateProject = (change: (project: Record<string, unknown>) => void) => mutateManifest((manifest) => {
      const project = manifest["project"];
      if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("Expected project inputs.");
      change(project as Record<string, unknown>);
    });
    const invalidManifests: Array<[string, RegExp]> = [
      ["{bad project json", /Malformed project JSON/],
      [mutateManifest((manifest) => { manifest["schema_version"] = 2; }), /newer than this app supports/],
      [mutateProject((project) => { project["instrument"] = { id: "missing-camera" }; }), /Unknown instrument/],
      [mutateProject((project) => { project["observing_strategy"] = { id: "missing-strategy" }; }), /Unknown observing strategy/],
      [mutateProject((project) => { project["observing_strategy"] = { id: "sami-dr1-seven-position" }; }), /incompatible with instrument/],
      [mutateProject((project) => {
        const placement = project["placement"] as Record<string, unknown>;
        placement["authoring"] = { preset: "advanced_basis", basis_deg: [[1, 1], [2, 2]] };
      }), /Invalid project placement\/basis/],
      [mutateProject((project) => {
        project["region"] = { vertices: [
          { ra_deg: 10, dec_deg: 91 }, { ra_deg: 11, dec_deg: 91 }, { ra_deg: 11, dec_deg: 92 },
        ] };
      }), /Invalid region/],
      [mutateProject((project) => {
        project["position_angle"] = { policy: "fixed", required: true, input_deg: 17 };
      }), /PA policy does not match/],
      [mutateProject((project) => { delete project["coverage_strategy"]; }), /Coverage strategy/],
      [mutateProject((project) => { project["planning_mode"] = "scheduler"; }), /Unsupported project mode/],
      [serializeProjectManifest(importedRecipe(), profileRegistry).replace(/("input_deg"\s*:\s*)17/, "$1NaN"), /Malformed project JSON/],
      [serializeProjectManifest(importedRecipe(), profileRegistry).replace(/("input_deg"\s*:\s*)17/, "$1Infinity"), /Malformed project JSON/],
    ];
    const beforeSummary = screen.getByTestId("project-summary").textContent;
    const beforePointings = screen.getByTestId("pointings").textContent;

    for (const [contents, error] of invalidManifests) {
      await uploadManifest(user, contents);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(error));
      expect(screen.getByTestId("project-summary").textContent).toBe(beforeSummary);
      expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("instrument:vlt-muse-wfm");
      expect(screen.getByRole("radio", { name: "Regional mosaic" })).toBeChecked();
      expect(screen.getByRole("button", { name: "Accept proposal" })).toBeEnabled();
      expect(screen.getByTestId("pointings").textContent).toBe(beforePointings);
    }
  });

  it("imports all recipe inputs together, clears old plan state, and regenerates on demand", async () => {
    const user = await authorEmptyRegionalProject();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Accept proposal" });
    expect(screen.getByText("Proposal preview")).toBeTruthy();

    await uploadManifest(user);
    expect(await screen.findByText(/Project imported\. Candidate preview and plan are empty/)).toBeTruthy();
    expect(screen.queryByText("Proposal preview")).toBeNull();
    expect(screen.getByTestId("candidate-sites")).toHaveTextContent("0");
    expect(screen.getByTestId("pointings")).toHaveTextContent("[]");
    expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("instrument:vlt-muse-wfm");
    expect(screen.getByLabelText(/PA \(degrees east of north\)/)).toHaveValue(17);
    expect(screen.getByRole("radio", { name: /Efficient coverage/ })).toBeChecked();
    expect(screen.getByTestId("project-summary")).toHaveTextContent("triangular · independent rotation");
    expect(screen.getByTestId("project-summary")).toHaveTextContent("Region: 4 vertices");
    expect(screen.getByLabelText("Pitch · nearest-neighbor spacing")).toHaveValue(48 / 3600);
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Accept proposal" });
    const planCall = vi.mocked(api.planRegion).mock.calls.at(-1)!;
    expect(planCall[4]).toBe("efficient");
    expect(planCall[6]).toMatchObject({ type: "project_lattice", placement: importedRecipe().project.placement });
  });

  it("marks an imported external catalogue dependency incomplete until an exact file is supplied", async () => {
    const user = userEvent.setup();
    render(<App />);
    const recipe = importedRecipe();
    const recipeWithExternalInput = createProjectManifest({
      instrumentId: recipe.project.instrument.id,
      observingStrategyId: null,
      planningMode: recipe.project.planning_mode,
      region: recipe.project.region,
      placement: recipe.project.placement,
      positionAngleInputDeg: recipe.project.position_angle?.input_deg ?? null,
      coverageStrategy: recipe.project.coverage_strategy,
      sequenceCoverageBasis: recipe.project.sequence_coverage_basis,
      catalogueDependencies: [{
        source_name: "legacy-survey.csv", row_count: 2, ra_column: "RA", dec_column: "DEC",
        instrument_profile_id: "vlt-muse-wfm", inference_role: "auto", sha256: "a".repeat(64),
      }],
    }, profileRegistry);
    await uploadManifest(user, serializeProjectManifest(recipeWithExternalInput, profileRegistry));
    expect(await screen.findByText(/1 external catalogue file is still required/)).toBeTruthy();
    expect(screen.getByTestId("project-summary")).toHaveTextContent("Catalogue: 0/1 referenced files loaded");
    expect(screen.getByText(/Incomplete project: supply 1 matching catalogue file/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export project" })).toBeDisabled();
  });

  it("aborts and fences a previous Worker result when a valid project is imported", async () => {
    const user = await authorEmptyRegionalProject();
    let finishOld!: (result: RegionPlanResponse) => void;
    let oldSignal: AbortSignal | undefined;
    let oldResult!: RegionPlanResponse;
    vi.mocked(api.planRegion).mockImplementationOnce((polygon, existingTiles, profileId, profile, strategy, context, source, signal) => {
      oldSignal = signal;
      oldResult = planRegionLocal(polygon, existingTiles, profileId, profile, strategy, profileRegistry, context, source);
      return new Promise((resolve) => { finishOld = resolve; });
    });
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("button", { name: "Cancel planning" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Import project" })).toBeEnabled();

    await uploadManifest(user);
    expect(await screen.findByText(/Project imported/)).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { finishOld(oldResult); });
    expect(screen.queryByRole("button", { name: "Accept proposal" })).toBeNull();
    expect(screen.getByTestId("project-summary")).toHaveTextContent("triangular · independent rotation");
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeEnabled();
  });

  it("does not let a project file that finishes late overwrite New project", async () => {
    const user = await authorEmptyRegionalProject();
    let finishOld!: (result: RegionPlanResponse) => void;
    let oldResult!: RegionPlanResponse;
    vi.mocked(api.planRegion).mockImplementationOnce((polygon, existingTiles, profileId, profile, strategy, context, source) => {
      oldResult = planRegionLocal(polygon, existingTiles, profileId, profile, strategy, profileRegistry, context, source);
      return new Promise((resolve) => { finishOld = resolve; });
    });
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("button", { name: "Cancel planning" })).toBeEnabled();

    let finishFileRead!: (contents: string) => void;
    const file = new File([], "delayed-recipe.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => new Promise<string>((resolve) => { finishFileRead = resolve; }) });
    await user.upload(screen.getByLabelText("Choose Jasytata project JSON"), file);
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Discard and start new" }));
    finishFileRead(serializeProjectManifest(importedRecipe()));

    await waitFor(() => expect(screen.getByTestId("project-summary")).toHaveTextContent("Region: not set"));
    await act(async () => { finishOld(oldResult); });
    expect(screen.getByRole("radio", { name: "Manual pointings" })).toBeChecked();
    expect(screen.queryByText(/Project imported/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept proposal" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("instrument:vlt-muse-wfm");
  });

  it("New project clears accepted pointings and project choices while keeping the selected instrument", async () => {
    const user = await authorEmptyRegionalProject();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Accept proposal" });
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("pointings").textContent!)).not.toHaveLength(0));
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Discard and start new" }));
    expect(screen.getByRole("combobox", { name: "Output profile" })).toHaveValue("instrument:vlt-muse-wfm");
    expect(screen.getByRole("radio", { name: "Manual pointings" })).toBeChecked();
    expect(screen.getByTestId("pointings")).toHaveTextContent("[]");
    expect(screen.getByTestId("project-summary")).toHaveTextContent("Region: not set");
    expect(screen.getByTestId("project-summary")).toHaveTextContent("Placement: not set");
    expect(screen.getByTestId("project-summary")).toHaveTextContent("Coverage: Complete");
    expect(screen.queryByLabelText("East spacing")).toBeNull();
  });
});
