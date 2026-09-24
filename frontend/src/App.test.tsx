import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { CenterInput, CatalogueResponse, RegionPlanResponse, TileRecord } from "./types";

const apiMocks = vi.hoisted(() => ({
  buildRegionPlanRequest: vi.fn((polygon: unknown, existingTiles: unknown, profileId: unknown) => ({
    polygon, existing_tiles: existingTiles, profile_id: profileId,
  })),
  downloadCatalogue: vi.fn(),
  loadDefaultProfile: vi.fn(),
  loadReferenceCatalogue: vi.fn(),
  measureCoverage: vi.fn(),
  parseCenters: vi.fn(),
  planRegion: vi.fn(),
  proposeCenters: vi.fn(),
  uploadCatalogue: vi.fn(),
}));

vi.mock("./api", () => apiMocks);
vi.mock("./AladinMap", async () => {
  const React = await import("react");
  return {
    default: (props: {
      tiles: TileRecord[];
      mode: "idle" | "add-tile";
      selectingRegion: boolean;
      selectionRequest: number;
      planningLayers: { proposals: boolean; region: boolean; anchors: boolean; lattice: boolean };
      selectedPolygon: { vertices: CenterInput[] } | null;
      anchorTileIds: string[];
      candidateCenters: CenterInput[];
      onTileSelect: (tile: TileRecord) => void;
      onRegionSelect: (polygon: { vertices: CenterInput[] }) => void;
      onSkyClick: (ra: number, dec: number) => void;
    }) =>
      React.createElement(
      "div",
        { "aria-label": "Sky map test controls" },
        React.createElement(
          "output",
          { "data-testid": "map-interaction-state" },
          `${props.mode}:${props.selectingRegion}:${props.selectionRequest}`,
        ),
        React.createElement("output", { "data-testid": "map-layer-state" },
          `${props.tiles.filter((tile) => tile.source === "proposed").length}:${Boolean(props.selectedPolygon)}:${props.planningLayers.region}:${props.planningLayers.anchors}:${props.planningLayers.lattice}`),
        React.createElement(
          "button",
          {
            onClick: () =>
              props.onRegionSelect({ vertices: [
                { ra_deg: 120, dec_deg: -61 }, { ra_deg: 135, dec_deg: -61 },
                { ra_deg: 135, dec_deg: -57 }, { ra_deg: 120, dec_deg: -57 },
              ] }),
          },
          "Mock select region",
        ),
        React.createElement("button", {
          onClick: () => props.onRegionSelect({ vertices: [
            { ra_deg: 262, dec_deg: -40 }, { ra_deg: 277, dec_deg: -40 },
            { ra_deg: 277, dec_deg: -27 }, { ra_deg: 262, dec_deg: -27 },
          ] }),
        }, "Mock select different region"),
        React.createElement(
          "button",
          { onClick: () => props.onSkyClick(150.5, -24.25) },
          "Mock place tile",
        ),
        React.createElement(
          "button",
          { onClick: () => props.onTileSelect(props.tiles[0]) },
          "Mock inspect original",
        ),
        React.createElement(
          "button",
          { onClick: () => props.onTileSelect(props.tiles[1]) },
          "Mock inspect second",
        ),
      ),
  };
});

const original: TileRecord = {
  id: "original-1",
  name: "SPLUS-d512",
  ra_deg: 120.875,
  dec_deg: -58.0064,
  source: "original",
  generation_method: null,
  original_values: {
    PID: "SPLUS",
    NAME: "SPLUS-d512",
    RA: "08:03:30",
    DEC: "-58:00:23",
    EPOC: "2000",
    STATUS: "1",
  },
  ra_column: "RA",
  dec_column: "DEC",
  metadata: {},
};

const catalogue: CatalogueResponse = {
  filename: "tiles_nc.csv",
  row_count: 4774,
  tiles: [original],
  warnings: [],
};

function makePlan(count: number): RegionPlanResponse {
  const tiles = Array.from({ length: count }, (_, index) => ({
    id: `preview-${index + 1}`,
    name: `PROPOSED_${String(index + 1).padStart(4, "0")}`,
    ra_deg: 121 + index,
    dec_deg: -60,
    source: "proposed" as const,
    generation_method: "region_extended" as const,
    original_values: null,
    metadata: { solution: "extended_existing_grid" },
  }));
  return {
    solution: "extended_existing_grid",
    generation_method: "region_extended",
    tiles,
    candidate_centers: tiles.map(({ ra_deg, dec_deg }) => ({ ra_deg, dec_deg })),
    inference: {
      nearby_tile_count: 7, anchor_tile_ids: [original.id], compatible_neighbor_pairs: 2,
      dec_spacing_deg: 1.35, ra_spacing_deg: 1.35,
    },
    diagnostics: ["Extended the local grid using 12 compatible neighbor pairs and 5 anchor tiles."],
    metrics: {
      existing_tiles_contributing: 2,
      new_tiles: count,
      selected_region_area_deg2: 59.91,
      already_covered_fraction: 0.64,
      selected_region_coverage: 0.96,
      incremental_coverage: 0.32,
      remaining_uncovered_fraction: 0.04,
      remaining_uncovered_area_deg2: 2.3964,
      redundant_coverage: 0.12,
      outside_region_coverage_deg2: 3.64,
      sample_step_deg: 0.12,
    },
  };
}

describe("Tile Planner proposal workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.loadDefaultProfile.mockResolvedValue({
      id: "splus-t80-south", display_name: "S-PLUS / T80-South", tile_width_deg: 1.4,
      tile_height_deg: 1.4, effective_overlap_arcsec: 120, coordinate_frame: "icrs",
      export_epoch_default: "2000", export_epoch_options: ["2000"], algorithm: "SPLUS_LEGACY_GRID_V1",
    });
    apiMocks.loadReferenceCatalogue.mockResolvedValue(catalogue);
    apiMocks.planRegion.mockResolvedValue(makePlan(2));
    apiMocks.proposeCenters.mockImplementation(async (centers: CenterInput[], method: string) =>
      centers.map((center, index) => ({
        id: `manual-${index + 1}`,
        name: `PROPOSED_${String(index + 1).padStart(4, "0")}`,
        ra_deg: center.ra_deg,
        dec_deg: center.dec_deg,
        source: "proposed",
        generation_method: method,
        original_values: null,
        metadata: {},
      })),
    );
    apiMocks.downloadCatalogue.mockResolvedValue(undefined);
    apiMocks.measureCoverage.mockResolvedValue(makePlan(2).metrics);
  });

  afterEach(() => cleanup());

  it("plans a polygon, reversibly edits proposals, and exports enabled tiles", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    expect(await screen.findByText("1", { selector: ".summary-number" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(await screen.findByText("Existing grid extended")).toBeTruthy();
    expect(screen.getByText("59.91 deg²")).toBeTruthy();
    expect(apiMocks.planRegion).toHaveBeenLastCalledWith(
      { vertices: [{ ra_deg: 120, dec_deg: -61 }, { ra_deg: 135, dec_deg: -61 }, { ra_deg: 135, dec_deg: -57 }, { ra_deg: 120, dec_deg: -57 }] },
      expect.arrayContaining([expect.objectContaining({ name: original.name, original_values: original.original_values })]),
      "splus-t80-south",
    );

    await user.click(screen.getByRole("button", { name: /accept proposal/i }));
    expect(screen.getByText("2", { selector: ".section-heading span" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /PROPOSED_0001/ }));
    await user.click(screen.getByRole("button", { name: "Disable tile" }));
    expect(screen.getByRole("button", { name: "Enable tile" })).toBeTruthy();
    expect(screen.getByText("DISABLED")).toBeTruthy();
    expect(apiMocks.measureCoverage).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(),
      expect.arrayContaining([expect.objectContaining({ enabled: false })]), "splus-t80-south",
    );
    await user.click(screen.getByRole("button", { name: "Enable tile" }));
    expect(screen.getByRole("button", { name: "Disable tile" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove all" }));
    expect(screen.getByText("0 enabled · 2 disabled")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore all" }));
    expect(screen.getByText("2 enabled · 0 disabled")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /download new_tiles.csv/i }));
    expect(apiMocks.downloadCatalogue).toHaveBeenCalledOnce();
    expect(apiMocks.downloadCatalogue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ source: "proposed", enabled: true })]),
      "splus-t80-south", "2000", "decimal",
    );

    await user.click(screen.getByRole("button", { name: "Clear proposal" }));
    expect(screen.getByText("0", { selector: ".section-heading span" })).toBeTruthy();
    expect(screen.getByText(/4 vertices · finalized/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/4 vertices · finalized/)).toBeNull();
    expect(screen.getByText("1", { selector: ".summary-number" })).toBeTruthy();
  });

  it("previews single-tile placement and lets the user cancel it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: /single tile/i }));
    await user.click(screen.getByRole("button", { name: "Mock place tile" }));
    expect(await screen.findByText("Manual sky placement")).toBeTruthy();
    expect(apiMocks.proposeCenters).toHaveBeenCalledWith(
      [{ ra_deg: 150.5, dec_deg: -24.25, label: "Manual sky click" }],
      "manual",
    );
    await user.click(screen.getByRole("button", { name: /cancel preview/i }));
    expect(screen.queryByText("Manual sky placement")).toBeNull();
  });

  it("cancels region selection when switching map modes or pressing Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));

    const interactionState = screen.getByTestId("map-interaction-state");
    await user.click(screen.getByRole("button", { name: /select area/i }));
    expect(interactionState.textContent).toBe("idle:true:1");

    await user.click(screen.getByRole("button", { name: /single tile/i }));
    expect(interactionState.textContent).toBe("add-tile:false:1");

    await user.click(screen.getByRole("button", { name: /select area/i }));
    expect(interactionState.textContent).toBe("idle:true:2");
    await user.keyboard("{Escape}");
    expect(interactionState.textContent).toBe("idle:false:2");
  });

  it("keeps disabled tiles out of planning and preserves proposal on Clear selection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: /accept proposal/i }));
    await user.click(screen.getByRole("button", { name: /PROPOSED_0001/ }));
    await user.click(screen.getByRole("button", { name: "Disable tile" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    const inputs = apiMocks.planRegion.mock.lastCall?.[1] as TileRecord[];
    expect(inputs.some((tile) => tile.source === "proposed" && tile.enabled === false)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("2", { selector: ".section-heading span" })).toBeTruthy();
    expect(screen.queryByText(/vertices · finalized/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /PROPOSED_0001/ }));
    expect(screen.getByRole("button", { name: "Enable tile" })).toBeTruthy();
  });

  it("disables generic download when there is no active proposal", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    expect(screen.getByRole("button", { name: /download new_tiles.csv/i })).toBeDisabled();
    expect(apiMocks.downloadCatalogue).not.toHaveBeenCalled();
  });

  it("uses the profile epoch and selected sexagesimal representation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: /accept proposal/i }));
    expect((screen.getByRole("combobox", { name: "Export epoch" }) as HTMLSelectElement).value).toBe("2000");
    await user.selectOptions(screen.getByRole("combobox", { name: "Export coordinates" }), "sexagesimal");
    await user.click(screen.getByRole("button", { name: /download new_tiles.csv/i }));
    expect(apiMocks.downloadCatalogue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ enabled: true })]),
      "splus-t80-south", "2000", "sexagesimal",
    );
    await user.click(screen.getByRole("button", { name: "Remove all" }));
    expect(screen.getByRole("button", { name: /download new_tiles.csv/i })).toBeDisabled();
  });

  it("inspects original tile metadata without offering to edit or delete it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock inspect original" }));
    expect(await screen.findByText("SPLUS-d512")).toBeTruthy();
    expect(screen.getByText("-58:00:23")).toBeTruthy();
    expect(screen.getByText("Original catalogue tile · immutable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /disable tile/i })).toBeNull();
  });

  it("offers coordinate-column mapping when a CSV cannot be inferred", async () => {
    const user = userEvent.setup();
    apiMocks.uploadCatalogue
      .mockResolvedValueOnce({ filename: "ambiguous.csv", row_count: 0, tiles: [], warnings: [], columns: ["RA", "ra_deg", "DEC", "quality"], needs_mapping: true })
      .mockResolvedValueOnce({ ...catalogue, filename: "ambiguous.csv", row_count: 1 });
    render(<App />);
    const file = new File(["RA,ra_deg,DEC,quality\n10:03:05,150.77,-23:54:31,good\n"], "ambiguous.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Choose catalogue CSV"), file);
    expect(await screen.findByText(/Map coordinates in ambiguous.csv/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("RA column"), "RA");
    await user.selectOptions(screen.getByLabelText("DEC column"), "DEC");
    await user.click(screen.getByRole("button", { name: "Load mapped catalogue" }));
    await waitFor(() => expect(apiMocks.uploadCatalogue).toHaveBeenLastCalledWith(file, expect.objectContaining({ raColumn: "RA", decColumn: "DEC", raUnit: "auto" })));
  });

  it("keeps scientific planning independent from catalogue layer visibility", async () => {
    const user = userEvent.setup();
    const second: TileRecord = {
      ...original, id: "original-2", name: "DR6 field", ra_deg: 124, dec_deg: -59,
      metadata: { quality: "good", release: "DR6" },
      original_values: { ra_deg: "124", dec_deg: "-59", quality: "good", release: "DR6" },
      ra_column: "ra_deg", dec_column: "dec_deg",
    };
    apiMocks.uploadCatalogue
      .mockResolvedValueOnce({ ...catalogue, row_count: 1 })
      .mockResolvedValueOnce({ filename: "dr6.csv", row_count: 1, tiles: [second], warnings: [], ra_column: "ra_deg", dec_column: "dec_deg" });
    render(<App />);
    const input = screen.getByLabelText("Choose catalogue CSV");
    await user.upload(input, new File(["RA,DEC\n"], "tiles_nc.csv", { type: "text/csv" }));
    await user.upload(input, new File(["ra_deg,dec_deg\n"], "dr6.csv", { type: "text/csv" }));
    expect(await screen.findByText("2 catalogues loaded")).toBeTruthy();
    const firstToggle = screen.getByRole("checkbox", { name: "Show tiles_nc.csv" });
    const secondToggle = screen.getByRole("checkbox", { name: "Show dr6.csv" });
    expect((firstToggle as HTMLInputElement).checked).toBe(true);
    expect((secondToggle as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Mock inspect second" }));
    expect(screen.getByText("dr6.csv", { selector: ".tile-name-block span" })).toBeTruthy();
    expect(screen.getByText("good")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(apiMocks.planRegion).toHaveBeenLastCalledWith(
      expect.anything(), expect.arrayContaining([
        expect.objectContaining({ name: original.name }), expect.objectContaining({ name: second.name }),
      ]), "splus-t80-south",
    );
    const firstPlanInputs = apiMocks.planRegion.mock.lastCall?.[1] as TileRecord[];
    const initialMetrics = screen.getByText("Already covered").closest(".metrics-panel")?.textContent;
    await user.click(firstToggle);
    expect((secondToggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Existing grid extended")).toBeTruthy();
    expect(screen.getByText("Already covered").closest(".metrics-panel")?.textContent).toBe(initialMetrics);
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    const plannedTiles = apiMocks.planRegion.mock.lastCall?.[1] as TileRecord[];
    expect(plannedTiles).toEqual(firstPlanInputs);
    expect(plannedTiles.some((tile) => tile.name === original.name)).toBe(true);
    expect(plannedTiles.some((tile) => tile.name === second.name)).toBe(true);
    await user.click(await screen.findByRole("button", { name: /accept proposal/i }));
    const measuredTiles = apiMocks.measureCoverage.mock.lastCall?.[1] as TileRecord[];
    expect(measuredTiles.map((tile) => tile.name)).toEqual(expect.arrayContaining([original.name, second.name]));
    expect(screen.getByRole("button", { name: /PROPOSED_0001/ })).toBeTruthy();
    await user.click(firstToggle);
    expect((firstToggle as HTMLInputElement).checked).toBe(true);
  });

  it("keeps planning layer visibility independent from proposal, region, metrics, and export", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: /accept proposal/i }));
    await waitFor(() => expect(apiMocks.measureCoverage).toHaveBeenCalled());
    const coverageCalls = apiMocks.measureCoverage.mock.calls.length;
    expect(screen.getByTestId("map-layer-state").textContent).toBe("2:true:true:false:false");
    await user.click(screen.getByRole("checkbox", { name: "Show Proposed tiles" }));
    await user.click(screen.getByRole("checkbox", { name: "Show Selected region" }));
    await user.click(screen.getByRole("checkbox", { name: "Show Inference anchors" }));
    await user.click(screen.getByRole("checkbox", { name: "Show Candidate lattice" }));
    expect(screen.getByTestId("map-layer-state").textContent).toBe("0:true:false:true:true");
    expect(screen.getByText("2 enabled · 0 disabled")).toBeTruthy();
    expect(screen.getByText(/4 vertices · finalized/)).toBeTruthy();
    expect(apiMocks.measureCoverage).toHaveBeenCalledTimes(coverageCalls);
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(apiMocks.planRegion.mock.lastCall?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "proposed", enabled: true }),
    ]));
    await user.click(screen.getByRole("button", { name: /download new_tiles.csv/i }));
    expect(apiMocks.downloadCatalogue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ source: "proposed", enabled: true })]),
      "splus-t80-south", "2000", "decimal",
    );
  });

  it("exposes finalized vertices and the submitted plan payload in development", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByText("Development: plan input"));
    expect(screen.getByText(/"ra_deg": 120/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy last plan request JSON" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(screen.getByRole("button", { name: "Copy last plan request JSON" }));
    const [polygon, existingTiles, profileId] = apiMocks.planRegion.mock.lastCall ?? [];
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({
      polygon, existing_tiles: existingTiles, profile_id: profileId,
    }));
  });

  it("keeps inference evidence consistent when coverage is recalculated", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByText("Nearby anchor candidates").parentElement?.textContent).toContain("7");
    expect(screen.getByText("Inference anchors used").parentElement?.textContent).toContain("1");
    expect(screen.getByRole("checkbox", { name: "Show Inference anchors" }).closest("label")?.textContent).toContain("1");
    await user.click(await screen.findByRole("button", { name: /accept proposal/i }));
    await waitFor(() => expect(apiMocks.measureCoverage).toHaveBeenCalled());
    expect(screen.getByText("Nearby anchor candidates").parentElement?.textContent).toContain("7");
    expect(screen.getByText("Inference anchors used").parentElement?.textContent).toContain("1");
    await user.click(screen.getByRole("button", { name: "Remove all" }));
    await waitFor(() => expect(apiMocks.measureCoverage).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Inference anchors used").parentElement?.textContent).toContain("1");
  });

  it("does not pair a new polygon's coverage with anchors from an older plan", async () => {
    const user = userEvent.setup();
    apiMocks.measureCoverage.mockImplementation(async (polygon: { vertices: CenterInput[] }) =>
      polygon.vertices[0].ra_deg === 262
        ? { ...makePlan(2).metrics, existing_tiles_contributing: 11, already_covered_fraction: 0.033 }
        : makePlan(2).metrics);
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await user.click(await screen.findByRole("button", { name: /accept proposal/i }));
    await waitFor(() => expect(screen.getByText("Inference anchors used")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Mock select different region" }));
    await waitFor(() => expect(screen.getByText("Existing contributors").parentElement?.textContent).toContain("11"));
    expect(screen.getByText("Already covered").parentElement?.textContent).toContain("3.3%");
    expect(screen.queryByText("Inference anchors used")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Show Inference anchors" }).closest("label")?.textContent).toContain("0");
    expect(screen.getByText("2 enabled · 0 disabled")).toBeTruthy();
  });

  it("shows fallback anchor candidates and zero matched anchors", async () => {
    const user = userEvent.setup();
    apiMocks.planRegion.mockResolvedValueOnce({
      ...makePlan(2), solution: "profile_fallback", inference: {
        nearby_tile_count: 1, anchor_tile_ids: [], compatible_neighbor_pairs: 0,
        dec_spacing_deg: null, ra_spacing_deg: null,
      },
    });
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByText("Nearby anchor candidates").parentElement?.textContent).toContain("1");
    expect(screen.getByText("Inference anchors used").parentElement?.textContent).toContain("0");
    expect(screen.getByRole("checkbox", { name: "Show Inference anchors" }).closest("label")?.textContent).toContain("0");
  });

  it("validates, previews, and stages imported centers before acceptance", async () => {
    const user = userEvent.setup();
    apiMocks.parseCenters.mockResolvedValue([
      { ra_deg: 150.7708333, dec_deg: -23.9086111, label: "Line 2" },
    ]);
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.type(screen.getByLabelText("RA and DEC pairs"), "10:03:05, -23:54:31");
    await user.click(screen.getByRole("button", { name: /validate and preview/i }));
    expect(await screen.findByText(/1 valid center parsed/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /stage import preview/i }));
    expect(await screen.findByText("Imported centers")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /accept proposal/i }));
    expect(screen.getByText("1", { selector: ".section-heading span" })).toBeTruthy();
  });
});
