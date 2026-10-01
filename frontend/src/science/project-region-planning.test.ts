import { describe, expect, it } from "vitest";
import type { InstrumentProfileV3, SkyPolygon, SurveyProfileV3, TileRecord } from "../types";
import { createBundledProfileRegistry } from "../profiles/registry";
import { projectCoverageProfile } from "../profiles/planning";
import { resolveFootprintForTile } from "../profiles/footprints";
import { buildInstrumentCoordinateCsv } from "./export";
import { measureActiveCoverage, CoverageUnavailableError, greedyChoose, type CoverageGrid, type SelectionStop } from "./coverage";
import { localOffsetToSky, skyToLocalOffset } from "./footprint-engine";
import { previewProjectLattice } from "./project-lattice-preview";
import { planRegion, type ProjectLatticeCandidateSource } from "./planner";
import { expandPointingExposures, type PointingGeometryContext } from "./pointing-geometry";

const registry = createBundledProfileRegistry();
function region(width: number, height = width): SkyPolygon {
  return { vertices: [
    { ra_deg: 150 - width / 2, dec_deg: -height / 2 }, { ra_deg: 150 + width / 2, dec_deg: -height / 2 },
    { ra_deg: 150 + width / 2, dec_deg: height / 2 }, { ra_deg: 150 - width / 2, dec_deg: height / 2 },
  ] };
}
function source(instrumentId = "vlt-muse-wfm", pitch = 58 / 3600, pa: number | undefined = 30): ProjectLatticeCandidateSource {
  return { type: "project_lattice", instrumentId, positionAngleDeg: pa, placement: {
    type: "lattice_project_placement", provenance: "user_declared",
    authoring: { preset: "rectangular", east_spacing_deg: pitch, north_spacing_deg: pitch },
    rotation: { mode: "independent", rotation_deg: 0 }, origin: { type: "region_center" },
  } };
}
function run(polygon: SkyPolygon, input: ProjectLatticeCandidateSource, strategy: "complete" | "efficient" = "complete", existing: TileRecord[] = []) {
  return planRegion(polygon, existing, undefined, undefined, strategy, registry, undefined, input);
}
function assertSites(plan: ReturnType<typeof run>, input: ProjectLatticeCandidateSource) {
  for (const tile of plan.tiles) {
    const site = tile.placement_provenance?.project_lattice;
    expect(site).toBeDefined();
    const [east, north] = skyToLocalOffset(tile, site!.placement.resolved_origin);
    const [[e1, n1], [e2, n2]] = site!.placement.basis_deg;
    expect(east).toBeCloseTo(site!.i * e1 + site!.j * e2, 10);
    expect(north).toBeCloseTo(site!.i * n1 + site!.j * n2, 10);
    expect(tile.metadata.lattice_i).toBe(site!.i); expect(tile.metadata.lattice_j).toBe(site!.j);
    expect(tile.placement_provenance?.origin).toBe("user_declared");
    expect(tile.instrument_profile_id).toBe(input.instrumentId);
    expect(tile.output_strategy_id).toBe(input.strategyId ?? null);
    const instrument = registry.resolveInstrumentProfile(input.instrumentId);
    if (instrument.schema_version === 3) expect(resolveFootprintForTile(tile, null, registry, { policy: instrument.position_angle.mode, required: instrument.position_angle.required }).resolved_position_angle_deg).toBe(input.positionAngleDeg);
  }
}

describe("Gate 4 project source through one regional planner", () => {
  it.each(["complete", "efficient"] as const)("MUSE 58 arcsec %s uses preview sites and approximate envelope semantics", (strategy) => {
    const polygon = region(0.035); const input = source();
    const instrument = registry.resolveInstrumentProfile(input.instrumentId);
    const preview = previewProjectLattice(polygon, input.placement, instrument.footprint, input.positionAngleDeg);
    const plan = run(polygon, input, strategy);
    expect(plan.tiles.length).toBeGreaterThan(0); expect(preview.candidates.length).toBeGreaterThanOrEqual(plan.tiles.length);
    expect(plan.candidate_centers).toEqual(preview.candidates.map(({ ra_deg, dec_deg }) => ({ ra_deg, dec_deg, label: null })));
    assertSites(plan, input);
    expect(plan.metrics).toMatchObject({ coverage_basis: "nominal_envelope", authoritative_observed_area: false,
      contributing_semantics: [{ role: "nominal_envelope", fidelity: "approximate" }] });
    expect(plan.diagnostics.join(" ")).toMatch(/approximate and nominal-envelope based/);
    expect(run(polygon, input, strategy)).toEqual(plan);
  });
  it.each(["complete", "efficient"] as const)("KCWI fine-scale %s is deterministic observed-area planning", (strategy) => {
    const input = source("keck-kcwi-small", 4 / 3600, 0); const polygon = region(0.005);
    const result = run(polygon, input, strategy);
    expect(result.tiles.length).toBeGreaterThan(0); expect(result.metrics.coverage_basis).toBe("observed_area");
    expect(result.metrics.contributing_semantics).toEqual([{ role: "observed_area", fidelity: "exact" }]);
    expect(run(polygon, input, strategy)).toEqual(result); assertSites(result, input);
  });
  it.each(["complete", "efficient"] as const)("DECam larger-region %s retains a finite deterministic custom lattice", (strategy) => {
    const input = { ...source("ctio-decam-area-equivalent", 1), positionAngleDeg: undefined };
    const polygon = region(3, 2); const result = run(polygon, input, strategy);
    expect(result.candidate_centers.length).toBeGreaterThan(1); expect(result.candidate_centers.length).toBeLessThan(1200);
    expect(result.tiles.length).toBeGreaterThan(0); expect(run(polygon, input, strategy)).toEqual(result); assertSites(result, input);
  });
  it("reports Complete lattice exhaustion with holes and no off-lattice synthesis", () => {
    const input = source("keck-kcwi-small", 0.01, 0); const result = run(region(0.022), input);
    expect(result.selection_stop).toBe("candidate_lattice_exhausted"); expect(result.metrics.remaining_uncovered_fraction).toBeGreaterThan(0);
    expect(result.diagnostics.join(" ")).toMatch(/cannot fully cover the selected sampled region/);
    expect(result.tiles.length).toBe(result.candidate_centers.length); assertSites(result, input);
  });
  it("reports zero admissible sites without fabricated proposals", () => {
    const input = source("keck-kcwi-small", 0.5, 0);
    input.placement.origin = { type: "fixed_anchor", ra_deg: 159.37, dec_deg: 0 };
    const result = run(region(0.01), input);
    expect(result.candidate_centers).toEqual([]); expect(result.tiles).toEqual([]); expect(result.metrics.selected_region_coverage).toBe(0);
    expect(result.selection_stop).toBe("candidate_lattice_exhausted"); expect(result.diagnostics.join(" ")).toMatch(/zero admissible lattice sites/);
  });
  it("reports completed sampled coverage", () => {
    const result = run(region(0.005), source("keck-kcwi-small", 2 / 3600, 0));
    expect(result.selection_stop).toBe("coverage_complete"); expect(result.metrics.remaining_uncovered_fraction).toBe(0);
  });
  it.each(["complete", "efficient"] as const)("refuses target-access %s area planning", (strategy) => {
    expect(() => run(region(0.1), source("subaru-pfs-target-access"), strategy)).toThrow(CoverageUnavailableError);
  });
  it("requires physical MUSE PA even with independent lattice rotation", () => {
    expect(() => run(region(0.03), { ...source(), positionAngleDeg: undefined })).toThrow(/PA policy requires/);
  });
  it("keeps footprint PA 30 independent of lattice rotation 0", () => {
    const input = source(); const result = run(region(0.035), input); assertSites(result, input);
    result.tiles.forEach((tile) => {
      expect(tile.placement_provenance?.project_lattice?.placement.lattice_rotation_deg).toBe(0);
      expect(resolveFootprintForTile(tile, null, registry, { policy: "per_pointing", required: true }).resolved_position_angle_deg).toBe(30);
    });
  });
  it("follows PA only through the resolver while physical PA stays 30", () => {
    const input = source(); input.placement.rotation = { mode: "follow_instrument_pa" };
    const result = run(region(0.035), input); assertSites(result, input);
    result.tiles.forEach((tile) => expect(tile.placement_provenance?.project_lattice?.placement.lattice_rotation_deg).toBe(30));
    expect(run(region(0.035), input)).toEqual(result);
  });
  it("accounts for compatible existing coverage without catalogue phase inference", () => {
    const input = source("keck-kcwi-small", 4 / 3600, 0); const polygon = region(0.005);
    const first = run(polygon, input); const existing = first.tiles.map((tile) => ({ ...tile, source: "original" as const }));
    const repeated = run(polygon, input, "complete", existing);
    expect(repeated.candidate_centers).toEqual(first.candidate_centers); expect(repeated.inference.anchor_tile_ids).toEqual([]);
    expect(repeated.metrics.already_covered_fraction).toBeGreaterThan(0); expect(repeated.tiles).toEqual([]);
    expect(repeated.selection_stop).toBe("coverage_complete");
  });
  it("excludes target-access catalogue rows from observed coverage", () => {
    const input = source("keck-kcwi-small", 4 / 3600, 0); const polygon = region(0.005); const first = run(polygon, input);
    const access = { ...first.tiles[0], source: "original" as const, instrument_profile_id: "subaru-pfs-target-access" };
    const result = run(polygon, input, "complete", [access]); expect(result.tiles).toEqual(first.tiles); expect(result.metrics.already_covered_fraction).toBe(0);
  });
  it("recomputes accepted proposal coverage with the existing coverage machinery", () => {
    const input = source(); const polygon = region(0.035); const plan = run(polygon, input);
    const instrument = registry.resolveInstrumentProfile(input.instrumentId); if (instrument.schema_version !== 3) throw new Error("Expected v3");
    const metrics = measureActiveCoverage(polygon, [], plan.tiles, instrument.id, projectCoverageProfile(instrument), registry,
      { measurementBasis: "nominal_envelope", coverageBasis: "single_exposure", orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }) });
    expect(metrics).toEqual(plan.metrics);
  });
  it("exports user-declared provenance through the existing instrument CSV boundary", () => {
    const input = source(); const plan = run(region(0.035), input); const instrument = registry.resolveInstrumentProfile(input.instrumentId);
    if (instrument.schema_version !== 3) throw new Error("Expected v3");
    const csv = buildInstrumentCoordinateCsv(plan.tiles, instrument, { resolvePositionAngle: (tile) => tile.position_angle_deg });
    expect(csv).toContain("user_declared"); expect(csv).not.toContain("declared_profile_lattice");
  });
  it("keeps project plan output nominal while using the associated sequence for effective coverage", () => {
    const input = { ...source("aat-sami-61core-15arcsec", 0.005), positionAngleDeg: undefined, strategyId: "sami-dr1-seven-position" };
    const result = run(region(0.015), input);
    expect(result.metrics.geometry_basis).toBe("effective_sequence");
    expect(result.tiles.length).toBeGreaterThan(0);
    result.tiles.forEach((tile) => expect(tile.output_strategy_id).toBe(input.strategyId));
    expect(result.tiles.every((tile) => tile.ra_deg !== undefined && tile.dec_deg !== undefined)).toBe(true);
    expect(result.tiles.every((tile) => tile.placement_provenance?.origin === "user_declared")).toBe(true);
  });
  it.each([
    ["sami-dr1-seven-position", 7],
    ["califa-ppak-three-point", 3],
    ["sdss-manga-19-three-point", 3],
    ["sdss-manga-37-three-point", 3],
    ["sdss-manga-61-three-point", 3],
    ["sdss-manga-91-three-point", 3],
    ["sdss-manga-127-three-point", 3],
  ] as const)("expands registered strategy %s from nominal project centers in order", (strategyId, expectedCount) => {
    const strategy = registry.resolveAnySurveyProfile(strategyId);
    if (strategy.schema_version !== 3 || !strategy.observing_sequence) throw new Error("Expected a registered sequence-bearing strategy");
    const sequence = strategy.observing_sequence;
    expect(sequence.exposures).toHaveLength(expectedCount);
    const input = { ...source(strategy.instrument_id, 58 / 3600, undefined), strategyId };
    const polygon = region(0.015);
    const result = planRegion(polygon, [], undefined, undefined, "complete", registry, undefined, input);
    expect(result.tiles.length).toBeGreaterThan(0);
    expect(result.metrics).toMatchObject({ coverage_basis: "nominal_envelope", geometry_basis: "effective_sequence", authoritative_observed_area: false });
    expect(result.candidate_centers.length).toBeGreaterThanOrEqual(result.tiles.length);
    result.tiles.forEach((tile) => {
      expect(tile.output_strategy_id).toBe(strategyId);
      expect(tile.placement_provenance?.origin).toBe("user_declared");
      expect(tile.metadata.lattice_i).toBe(tile.placement_provenance?.project_lattice?.i);
      expect(tile.metadata.lattice_j).toBe(tile.placement_provenance?.project_lattice?.j);
    });
    const context: PointingGeometryContext = {
      coverageBasis: "single_exposure",
      sequenceForTile: (tile) => tile.output_strategy_id === strategyId
        ? { id: sequence.id, exposures: sequence.exposures }
        : undefined,
    };
    const expanded = result.tiles.flatMap((tile) => expandPointingExposures(tile, null, registry, context));
    expect(expanded).toHaveLength(result.tiles.length * sequence.exposures.length);
    expect(expanded.map(({ parentNominalPointingId, order }) => [parentNominalPointingId, order])).toEqual(
      result.tiles.flatMap((tile) => sequence.exposures.map((exposure) => [tile.id, exposure.order])),
    );
    expect(expanded.map(({ strategyId, sequenceId }) => [strategyId, sequenceId])).toEqual(
      result.tiles.flatMap(() => sequence.exposures.map(() => [strategyId, sequence.id])),
    );
    expect(expanded.map(({ parentLatticeSite }) => parentLatticeSite)).toEqual(
      result.tiles.flatMap((tile) => sequence.exposures.map(() => ({
        i: tile.placement_provenance!.project_lattice!.i,
        j: tile.placement_provenance!.project_lattice!.j,
      }))),
    );
    expect(expanded).toEqual(result.tiles.flatMap((tile) => expandPointingExposures(tile, null, registry, context)));
  });
  it("keeps synthetic single-exposure coverage nominal while still expanding observer-facing rows", () => {
    const local = createBundledProfileRegistry();
    const realInstrument = local.resolveInstrumentProfile("aat-sami-61core-15arcsec");
    const realStrategy = local.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (realInstrument.schema_version !== 3 || realStrategy.schema_version !== 3 || !realStrategy.observing_sequence) {
      throw new Error("Expected the registered SAMI instrument and strategy");
    }
    const sequence = realStrategy.observing_sequence;
    const instrument: InstrumentProfileV3 = { ...realInstrument, id: "synthetic-single-basis-camera" };
    const strategy: SurveyProfileV3 = { ...realStrategy, id: "synthetic-single-basis-strategy", instrument_id: instrument.id, coverage_basis_default: "single_exposure" };
    local.registerInstrumentProfileV3(instrument);
    local.registerSurveyProfileV3(strategy);
    const input = { ...source(instrument.id, 58 / 3600, undefined), strategyId: strategy.id };
    const result = planRegion(region(0.015), [], undefined, undefined, "complete", local, undefined, input);
    expect(result.metrics.geometry_basis).toBe("single_exposure");
    expect(result.tiles.length).toBeGreaterThan(0);
    const context: PointingGeometryContext = {
      coverageBasis: "single_exposure",
      sequenceForTile: () => ({ id: sequence.id, exposures: sequence.exposures }),
    };
    const expanded = result.tiles.flatMap((tile) => expandPointingExposures(tile, null, local, context));
    expect(expanded).toHaveLength(result.tiles.length * sequence.exposures.length);
    expect(expanded.map(({ order }) => order)).toEqual(result.tiles.flatMap(() => [1, 2, 3, 4, 5, 6, 7]));
  });
  it("refuses a synthetic target-access sequence as a regional area planner", () => {
    const local = createBundledProfileRegistry();
    const targetAccessInstrument = local.resolveInstrumentProfile("subaru-pfs-target-access");
    const realStrategy = local.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (targetAccessInstrument.schema_version !== 3 || realStrategy.schema_version !== 3 || !realStrategy.observing_sequence) {
      throw new Error("Expected registered target-access geometry and SAMI sequence data");
    }
    const instrument: InstrumentProfileV3 = {
      ...targetAccessInstrument,
      id: "synthetic-target-access-sequence-camera",
      display_name: "Synthetic target-access sequence test camera",
      description: "Synthetic association used only to prove sequence presence does not permit area planning.",
    };
    const strategy: SurveyProfileV3 = {
      ...realStrategy,
      id: "synthetic-target-access-sequence-strategy",
      instrument_id: instrument.id,
    };
    local.registerInstrumentProfileV3(instrument);
    local.registerSurveyProfileV3(strategy);
    const input = { ...source(instrument.id), strategyId: strategy.id };
    expect(() => planRegion(region(0.015), [], undefined, undefined, "complete", local, undefined, input))
      .toThrow(CoverageUnavailableError);
  });
  it.each([
    ["independent", 17, 17],
    ["follow_instrument_pa", 45, 45],
  ] as const)("keeps %s project rotation separate from sky-local sequence offsets", (rotationMode, declaredRotation, resolvedLatticeRotation) => {
    const local = createBundledProfileRegistry();
    const realInstrument = local.resolveInstrumentProfile("vlt-muse-wfm");
    const realStrategy = local.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (realInstrument.schema_version !== 3 || realStrategy.schema_version !== 3 || !realStrategy.observing_sequence) {
      throw new Error("Expected the registered SAMI instrument and strategy");
    }
    const sequence = realStrategy.observing_sequence;
    const instrument: InstrumentProfileV3 = {
      ...realInstrument,
      id: `synthetic-pa-${rotationMode.replaceAll("_", "-")}-camera`,
      display_name: "Synthetic PA-policy test camera using MUSE geometry",
      description: "Synthetic test-only PA policy; geometry remains the registered sourced MUSE footprint.",
      position_angle: { mode: "per_pointing", required: true },
    };
    const strategy: SurveyProfileV3 = {
      ...realStrategy,
      id: `synthetic-pa-${rotationMode.replaceAll("_", "-")}-strategy`,
      instrument_id: instrument.id,
    };
    local.registerInstrumentProfileV3(instrument);
    local.registerSurveyProfileV3(strategy);
    const input = source(instrument.id, 58 / 3600, 45);
    input.strategyId = strategy.id;
    input.placement.rotation = rotationMode === "independent"
      ? { mode: "independent", rotation_deg: declaredRotation }
      : { mode: "follow_instrument_pa" };
    const polygon = region(0.015);
    const result = planRegion(polygon, [], undefined, undefined, "complete", local, undefined, input);
    const context: PointingGeometryContext = {
      coverageBasis: "effective_sequence",
      orientationPolicyForTile: () => ({ policy: "per_pointing", required: true }),
      sequenceForTile: () => ({ id: sequence.id, exposures: sequence.exposures }),
    };
    const expanded = result.tiles.flatMap((tile) => expandPointingExposures(tile, null, local, context));
    expect(expanded).toHaveLength(result.tiles.length * sequence.exposures.length);
    for (const tile of result.tiles) {
      const site = tile.placement_provenance!.project_lattice!;
      expect(site.placement.lattice_rotation_deg).toBe(resolvedLatticeRotation);
      const [east, north] = skyToLocalOffset(tile, site.placement.resolved_origin);
      const [[e1, n1], [e2, n2]] = site.placement.basis_deg;
      expect(east).toBeCloseTo(site.i * e1 + site.j * e2, 10);
      expect(north).toBeCloseTo(site.i * n1 + site.j * n2, 10);
      const children = expanded.filter((exposure) => exposure.parentNominalPointingId === tile.id);
      expect(children.map((exposure) => exposure.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      children.forEach((exposure) => {
        expect(exposure.parentLatticeSite).toEqual({ i: site.i, j: site.j });
        expect(exposure.strategyId).toBe(strategy.id);
        expect(exposure.positionAngleDeg).toBe(45);
        const offsetElement = sequence.exposures[exposure.order - 1];
        expect(exposure.center).toEqual(localOffsetToSky(tile, [offsetElement.east_arcsec / 3600, offsetElement.north_arcsec / 3600]));
      });
    }
  });
  it("preserves canonical candidate j/i ordering without mutating placement", () => {
    const input = source(); const before = structuredClone(input.placement); const polygon = region(0.035); const result = run(polygon, input);
    const instrument = registry.resolveInstrumentProfile(input.instrumentId);
    const preview = previewProjectLattice(polygon, input.placement, instrument.footprint, input.positionAngleDeg);
    expect(preview.candidates.map(({ j, i }) => [j, i])).toEqual([...preview.candidates].sort((a, b) => a.j - b.j || a.i - b.i).map(({ j, i }) => [j, i]));
    expect(input.placement).toEqual(before); expect(result.solution).toBe("project_lattice");
  });
  it("reports the existing gain safeguard while preserving site identity through exact ties", () => {
    const grid: CoverageGrid = { ra: new Float64Array(2), dec: new Float64Array(2), weights: new Float64Array([1, 1]),
      totalWeight: 2, stepDeg: 1, centerRaDeg: 0, centerDecDeg: 0, raSpanDeg: 1, decMinDeg: 0, decMaxDeg: 1, cellAreaDeg2: 1 };
    const candidates = [0, 1].map((i) => ({ center: [0, 0] as [number, number], mask: new Uint8Array([1, 0]), latticeSite: { i, j: 0 } }));
    const stops: SelectionStop[] = [];
    const selected = greedyChoose(candidates, new Uint8Array(2), grid, { type: "rectangle", width_deg: 1, height_deg: 1 }, 1, "complete", undefined, (reason) => stops.push(reason));
    expect(selected).toHaveLength(1); expect(selected[0].latticeSite).toEqual({ i: 1, j: 0 });
    expect(stops).toEqual(["gain_safeguard"]);
  });
  it("reports Efficient's frozen strict marginal threshold and complete coverage independently", () => {
    const grid: CoverageGrid = { ra: new Float64Array(1000), dec: new Float64Array(1000), weights: new Float64Array(1000).fill(1),
      totalWeight: 1000, stepDeg: 1, centerRaDeg: 0, centerDecDeg: 0, raSpanDeg: 1, decMinDeg: 0, decMaxDeg: 1, cellAreaDeg2: 0.029 };
    const existing = new Uint8Array(1000).fill(1); existing[999] = 0;
    const mask = new Uint8Array(1000); mask[999] = 1;
    const policy = { min_coverage: 0.995, min_marginal_efficiency: 0.03 };
    const stops: SelectionStop[] = [];
    const select = () => greedyChoose([{ center: [0, 0], mask }], existing, grid, { type: "rectangle", width_deg: 1, height_deg: 1 }, 1, "efficient", policy, (reason) => stops.push(reason));
    expect(select()).toHaveLength(0); expect(stops).toEqual(["marginal_efficiency"]);
    grid.cellAreaDeg2 = 0.03; expect(select()).toHaveLength(1); expect(stops[1]).toBe("coverage_complete");
  });

  it("snapshots normalized physical PA without changing independent lattice rotation", () => {
    const input = { ...source(), positionAngleDeg: 390 }; const result = run(region(0.035), input);
    assertSites(result, { ...input, positionAngleDeg: 30 });
    expect(input.positionAngleDeg).toBe(390);
    expect(result).toEqual(run(region(0.035), source()));
  });
  it("supports renamed real geometry without instrument-ID dispatch", () => {
    const local = createBundledProfileRegistry(); const muse = local.resolveInstrumentProfile("vlt-muse-wfm");
    if (muse.schema_version !== 3) throw new Error("Expected v3");
    local.registerInstrumentProfileV3({ ...muse, id: "unrelated-user-geometry" });
    const input = source("unrelated-user-geometry");
    const result = planRegion(region(0.035), [], undefined, undefined, "complete", local, undefined, input);
    const original = run(region(0.035), source());
    expect(result.candidate_centers).toEqual(original.candidate_centers); expect(result.metrics).toEqual(original.metrics);
    expect(result.tiles.map((tile) => tile.placement_provenance)).toEqual(original.tiles.map((tile) => tile.placement_provenance));
  });

});
