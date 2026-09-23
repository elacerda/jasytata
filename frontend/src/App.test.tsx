import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { CenterInput, CatalogueResponse, RegionPlanResponse, TileRecord } from "./types";

const apiMocks = vi.hoisted(() => ({
  downloadCatalogue: vi.fn(),
  loadDefaultProfile: vi.fn(),
  loadReferenceCatalogue: vi.fn(),
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
      onTileSelect: (tile: TileRecord) => void;
      onRegionSelect: (bounds: {
        ra_start_deg: number;
        ra_end_deg: number;
        dec_min_deg: number;
        dec_max_deg: number;
      }) => void;
      onSkyClick: (ra: number, dec: number) => void;
    }) =>
      React.createElement(
        "div",
        { "aria-label": "Sky map test controls" },
        React.createElement(
          "button",
          {
            onClick: () =>
              props.onRegionSelect({
                ra_start_deg: 120,
                ra_end_deg: 135,
                dec_min_deg: -61,
                dec_max_deg: -57,
              }),
          },
          "Mock select region",
        ),
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
  pid: "SPLUS",
  name: "SPLUS-d512",
  ra_deg: 120.875,
  dec_deg: -58.0064,
  epoch: "2000",
  status: "1",
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
    pid: "PROPOSED",
    name: `PROPOSED_${String(index + 1).padStart(4, "0")}`,
    ra_deg: 121 + index,
    dec_deg: -60,
    epoch: "2000",
    status: "-5",
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
    anchor_tile_ids: [original.id],
    diagnostics: ["Extended the local grid using 12 compatible neighbor pairs and 5 anchor tiles."],
    metrics: {
      existing_tiles_contributing: 2,
      anchor_tiles_used: 5,
      candidates_available: 9,
      new_tiles: count,
      selected_region_area_deg2: 59.91,
      selected_region_coverage: 0.96,
      incremental_coverage: 0.32,
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
      epoch: "J2000", algorithm: "SPLUS_LEGACY_GRID_V1",
    });
    apiMocks.loadReferenceCatalogue.mockResolvedValue(catalogue);
    apiMocks.planRegion.mockImplementation(
      async (_bounds: unknown, _tiles: unknown, mode: string, count?: number) =>
        makePlan(mode === "fixed" ? count ?? 1 : 2),
    );
    apiMocks.proposeCenters.mockImplementation(async (centers: CenterInput[], method: string) =>
      centers.map((center, index) => ({
        id: `manual-${index + 1}`,
        pid: "PROPOSED",
        name: `PROPOSED_${String(index + 1).padStart(4, "0")}`,
        ra_deg: center.ra_deg,
        dec_deg: center.dec_deg,
        epoch: "2000",
        status: "-5",
        source: "proposed",
        generation_method: method,
        original_values: null,
        metadata: {},
      })),
    );
    apiMocks.downloadCatalogue.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("plans, regenerates exact N, accepts, deletes, undoes, and exports", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    expect(await screen.findByText("1", { selector: ".summary-number" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Mock select region" }));
    await user.click(screen.getByRole("button", { name: "Generate automatic plan" }));
    expect(await screen.findByText("Existing grid extended")).toBeTruthy();
    expect(screen.getByText("59.91 deg²")).toBeTruthy();
    expect(apiMocks.planRegion).toHaveBeenLastCalledWith(
      { ra_start_deg: 120, ra_end_deg: 135, dec_min_deg: -61, dec_max_deg: -57 },
      expect.arrayContaining([expect.objectContaining({ name: original.name, original_values: original.original_values })]),
      "automatic",
      undefined,
      "splus-t80-south",
    );

    await user.click(screen.getByRole("button", { name: "Fixed N" }));
    const countInput = screen.getByRole("spinbutton", { name: "Exact number of new tiles" });
    await user.clear(countInput);
    await user.type(countInput, "4");
    await user.click(screen.getByRole("button", { name: "Find 4 new tiles" }));
    await waitFor(() => expect(screen.getByText("NEW TILE CENTERS").nextElementSibling?.textContent).toBe("4"));
    expect(apiMocks.planRegion).toHaveBeenLastCalledWith(
      { ra_start_deg: 120, ra_end_deg: 135, dec_min_deg: -61, dec_max_deg: -57 },
      expect.arrayContaining([expect.objectContaining({ name: original.name, original_values: original.original_values })]),
      "fixed",
      4,
      "splus-t80-south",
    );

    await user.click(screen.getByRole("button", { name: /accept proposal/i }));
    expect(screen.getByText("4", { selector: ".section-heading span" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /PROPOSED_0001/ }));
    await user.click(screen.getByRole("button", { name: /delete proposed tile/i }));
    expect(screen.getByText("3", { selector: ".section-heading span" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo last proposal change" }));
    expect(screen.getByText("4", { selector: ".section-heading span" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /download new_tiles.csv/i }));
    await user.click(screen.getByRole("button", { name: /download updated catalogue/i }));
    expect(apiMocks.downloadCatalogue).toHaveBeenCalledTimes(2);
    expect(apiMocks.downloadCatalogue).toHaveBeenNthCalledWith(
      1,
      "new",
      expect.arrayContaining([expect.objectContaining({ name: original.name, original_values: original.original_values })]),
      expect.arrayContaining([expect.objectContaining({ source: "proposed" })]),
      { pid: "SPLUS", name_prefix: "SPLUS_NEW", initial_sequence: 1, epoch: "2000", status: "-5" },
    );

    await user.click(screen.getByRole("button", { name: "Clear accepted proposals" }));
    expect(screen.getByText("0", { selector: ".section-heading span" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo last proposal change" }));
    expect(screen.getByText("4", { selector: ".section-heading span" })).toBeTruthy();
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

  it("can export an unchanged catalogue and an empty new-tiles file", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: /download updated catalogue/i }));
    await user.click(screen.getByRole("button", { name: /download new_tiles.csv/i }));
    expect(apiMocks.downloadCatalogue).toHaveBeenNthCalledWith(
      1,
      "updated",
      expect.arrayContaining([expect.objectContaining({ name: original.name, original_values: original.original_values })]),
      [],
      { pid: "SPLUS", name_prefix: "SPLUS_NEW", initial_sequence: 1, epoch: "2000", status: "-5" },
    );
    expect(apiMocks.downloadCatalogue).toHaveBeenNthCalledWith(
      2,
      "new",
      expect.arrayContaining([expect.objectContaining({ name: original.name, original_values: original.original_values })]),
      [],
      { pid: "SPLUS", name_prefix: "SPLUS_NEW", initial_sequence: 1, epoch: "2000", status: "-5" },
    );
  });

  it("inspects original tile metadata without offering to edit or delete it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    await user.click(screen.getByRole("button", { name: "Mock inspect original" }));
    expect(await screen.findByText("SPLUS-d512")).toBeTruthy();
    expect(screen.getByText("-58:00:23")).toBeTruthy();
    expect(screen.getByText("Original catalogue tile · immutable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete proposed tile/i })).toBeNull();
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

  it("keeps two uploaded datasets and plans against their visible union", async () => {
    const user = userEvent.setup();
    const second: TileRecord = {
      ...original, id: "original-2", name: "DR6 field", ra_deg: 124, dec_deg: -59,
      pid: "", epoch: "", status: "", metadata: { quality: "good", release: "DR6" },
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
    await user.click(screen.getByRole("button", { name: "Generate automatic plan" }));
    expect(apiMocks.planRegion).toHaveBeenLastCalledWith(
      expect.anything(), expect.arrayContaining([
        expect.objectContaining({ name: original.name }), expect.objectContaining({ name: second.name }),
      ]), "automatic", undefined, "splus-t80-south",
    );
    await user.click(firstToggle);
    expect((secondToggle as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Generate automatic plan" }));
    const plannedTiles = apiMocks.planRegion.mock.lastCall?.[1] as TileRecord[];
    expect(plannedTiles.some((tile) => tile.name === original.name)).toBe(false);
    expect(plannedTiles.some((tile) => tile.name === second.name)).toBe(true);
    await user.click(firstToggle);
    expect((firstToggle as HTMLInputElement).checked).toBe(true);
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
