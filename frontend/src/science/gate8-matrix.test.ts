import { describe, expect, it } from "vitest";
import { cases, cameraPa, localRegion, matrixRegistry } from "../data/gate8/fixtures";
import golden from "../data/golden.json";
import contract from "../data/planner-contract.json";
import results from "../data/gate8/results.json";
import referenceCsv from "../../public/data/tiles_nc.csv?raw";
import { createDataset } from "../datasets";
import { parseProfileJsonV2, serializeProfile } from "../profiles/document";
import { resolvePlanningProfile } from "../profiles/planning";
import { makeCenterProposals, parseCatalogueCsv, parseCenterText, readCsv } from "./catalogue";
import { coveredMask, measureActiveCoverage, sampleRegion, tileMask } from "./coverage";
import { footprintArea, footprintCharacteristicScale, footprintContainsPoint, localOffsetToSky, skyToLocalOffset } from "./footprint-engine";
import { buildExportCsv } from "./export";
import { generateLatticeCandidates, latticePlanningOrigin } from "./lattice";
import { planRegion } from "./planner";
import { coverageFraction, referenceGrid, referenceMask } from "./test-support/coverage-reference";
import { tileFootprintBoundaries } from "../sky";
import type { TileRecord } from "../types";

/** Load real CSV bytes, then apply dataset assignment as App's planning input does. */
function sourceRows(fixture: typeof cases[number], registry = matrixRegistry()): TileRecord[] {
  const parsed = parseCatalogueCsv(new TextEncoder().encode(fixture.csv!), `${fixture.key}.csv`);
  const dataset = createDataset(parsed, 0, `g8-${fixture.key}-data`, fixture.document.instrument.id, registry);
  return dataset.tiles.map((tile) => ({ ...tile, instrument_profile_id: dataset.instrument_profile_id, inference_role: dataset.inference_role }));
}

describe("Gate 8 scientific workflow matrix", () => {
  it.each(cases)("$key: validated registry → zero-catalogue selection → plan → coverage → export, repeated fresh", (fixture) => {
    const run = () => {
      const registry = matrixRegistry();
      const { document, region } = fixture;
      const roundtrip = parseProfileJsonV2(serializeProfile(document));
      expect(roundtrip).toEqual(document);
      expect(serializeProfile(roundtrip)).toBe(serializeProfile(document));
      const plan = planRegion(region, [], document.survey.id, undefined, "complete", registry);
      expect(plan.tiles.length).toBeGreaterThan(0);
      expect(plan.candidate_centers.length).toBeLessThan(1200);
      expect(plan.tiles.length).toBeLessThan(500);
      expect(plan.metrics.selected_region_coverage).toBe(1);
      expect(plan.metrics).toEqual(measureActiveCoverage(region, [], plan.tiles, document.survey.id, undefined, registry));
      const accepted = plan.tiles.map((tile) => ({ ...tile, ...(cameraPa(document) === undefined ? {} : { position_angle_deg: cameraPa(document) }) }));
      const csv = buildExportCsv(accepted, document.survey);
      const recorded = results.find((r) => r.profile_id === document.survey.id)!;
      expect(plan.candidate_centers).toHaveLength(recorded.zero_candidates);
      expect(accepted).toHaveLength(recorded.zero_accepted);
      expect(readCsv(csv).slice(0, 2)).toEqual(recorded.first_export);
      expect(readCsv(csv).length).toBe(accepted.length + 1);
      if (document.survey.tiling.type === "lattice") {
        const tiling = document.survey.tiling;
        const origin = latticePlanningOrigin(region, tiling);
        const candidates = generateLatticeCandidates(region, tiling, document.instrument.footprint, 1200);
        expect(plan.candidate_centers.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg])).toEqual(candidates.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]));
        for (const tile of plan.tiles) {
          const [x, y] = skyToLocalOffset(tile, origin);
          const i = Number(tile.metadata.lattice_i), j = Number(tile.metadata.lattice_j);
          expect(x).toBeCloseTo(i * tiling.basis_deg[0][0] + j * tiling.basis_deg[1][0], 9);
          expect(y).toBeCloseTo(i * tiling.basis_deg[0][1] + j * tiling.basis_deg[1][1], 9);
          expect(tile.metadata).not.toHaveProperty("PID");
        }
        const sampling = plan.metrics.sampling!;
        expect(sampling).toMatchObject(recorded.sampling!);
        expect(sampling.characteristic_scale_deg).toBe(footprintCharacteristicScale(document.instrument.footprint));
        expect(sampling.natural_step_deg).toBe(sampling.characteristic_scale_deg / document.survey.coverage.sampling.target_samples_per_footprint_axis);
        expect(sampling.effective_step_deg).toBe(sampling.natural_step_deg);
        expect(sampling.budget_limited).toBe(false);
        expect(sampling.sample_count).toBeLessThanOrEqual(sampling.max_samples);
      }
      return { plan, accepted, csv };
    };
    const first = run();
    expect(run()).toEqual(first);
    console.info("G8 zero", fixture.key, JSON.stringify({ candidates: first.plan.candidate_centers.length, accepted: first.accepted.length, coverage: first.plan.metrics.selected_region_coverage, sampling: first.plan.metrics.sampling, firstExport: readCsv(first.csv).slice(0, 2) }));
  });

  it.each(cases.slice(1))("$key: no-PID catalogue → profile inference → missing-cell continuation → export", (fixture) => {
    const run = () => {
      const registry = matrixRegistry();
      const rows = sourceRows(fixture, registry), before = structuredClone(rows);
      expect(fixture.csv).not.toContain("PID");
      const plan = planRegion(fixture.region, rows, fixture.document.survey.id, undefined, "complete", registry);
      expect(plan.solution).toBe("extended_existing_grid");
      const fit = plan.inference.lattice;
      if (fit?.status !== "success") throw new Error("Expected validated profile inference");
      expect(fit.inlier_count).toBe(9);
      expect(fit.rotation_deg).toBeCloseTo(fixture.rotation, 6);
      expect(fit.phase_fraction[0]).toBeCloseTo(0.2, 6);
      expect(fit.phase_fraction[1]).toBeCloseTo(0.3, 6);
      expect(fit.rms_residual_fraction).toBeLessThan(1e-8);
      expect(fit.assignments.every((a) => a.inlier && Number.isInteger(a.i) && Number.isInteger(a.j) && a.residual_fraction < 1e-8)).toBe(true);
      expect(plan.tiles.length).toBeGreaterThan(0);
      expect(plan.metrics.selected_region_coverage).toBe(1);
      const tiling = fixture.document.survey.tiling;
      if (tiling.type !== "lattice") throw new Error("Expected lattice");
      const generated = generateLatticeCandidates(fixture.region, { ...tiling, basis_deg: fit.basis_deg }, fixture.document.instrument.footprint, 1200, fit);
      const missing = generated.find((p) => p.i === 1 && p.j === 1)!;
      expect(missing).toBeDefined();
      expect(plan.candidate_centers.some((p) => p.ra_deg === missing.ra_deg && p.dec_deg === missing.dec_deg)).toBe(true);
      const recorded = results.find((r) => r.profile_id === fixture.document.survey.id)!.inference!;
      expect(plan.tiles).toHaveLength(recorded.accepted);
      expect(fit.compatible_pair_count).toBe(recorded.pairs);
      for (const tile of plan.tiles) {
        expect(generated.some((p) => p.ra_deg === tile.ra_deg && p.dec_deg === tile.dec_deg)).toBe(true);
        expect(rows.some((p) => Math.hypot(...skyToLocalOffset(tile, p)) < 1e-8)).toBe(false);
        const [x, y] = skyToLocalOffset(tile, fit.projection_origin);
        const i = Number(tile.metadata.lattice_i), j = Number(tile.metadata.lattice_j);
        expect(x).toBeCloseTo(i * fit.basis_deg[0][0] + j * fit.basis_deg[1][0] + fit.phase_offset_deg[0], 8);
        expect(y).toBeCloseTo(i * fit.basis_deg[0][1] + j * fit.basis_deg[1][1] + fit.phase_offset_deg[1], 8);
      }
      expect(rows).toEqual(before);
      expect(measureActiveCoverage(fixture.region, rows, plan.tiles, fixture.document.survey.id, undefined, registry)).toEqual(plan.metrics);
      const accepted = plan.tiles.map((tile) => ({ ...tile, position_angle_deg: cameraPa(fixture.document) }));
      return { plan, csv: buildExportCsv(accepted, fixture.document.survey) };
    };
    const result = run();
    expect(run()).toEqual(result);
    const fit = result.plan.inference.lattice;
    if (fit?.status !== "success") throw new Error("Expected successful matrix fit");
    console.info("G8 inference", fixture.key, JSON.stringify({ proposals: result.plan.tiles.length, inliers: fit.inlier_count, pairs: fit.compatible_pair_count, rotation: fit.rotation_deg, phase: fit.phase_fraction, rmsFraction: fit.rms_residual_fraction, coverage: result.plan.metrics.selected_region_coverage }));
  });

  it.each(cases.slice(1))("$key: Complete ignores Efficient thresholds; Efficient uses generic area and profile policy", (fixture) => {
    const registry = matrixRegistry(), { document, region } = fixture;
    const complete = planRegion(region, [], document.survey.id, undefined, "complete", registry);
    const efficient = planRegion(region, [], document.survey.id, undefined, "efficient", registry);
    const recorded = results.find((r) => r.profile_id === document.survey.id)!.efficient!;
    expect(efficient.tiles).toHaveLength(recorded.accepted);
    expect(efficient.metrics.selected_region_coverage).toBe(recorded.coverage);
    expect(efficient).toEqual(planRegion(region, [], document.survey.id, undefined, "efficient", matrixRegistry()));
    expect(efficient.tiles.length).toBeLessThan(complete.tiles.length);
    expect(efficient.metrics.selected_region_coverage).toBeGreaterThanOrEqual(document.survey.coverage.efficient!.min_coverage);
    const variant = parseProfileJsonV2(JSON.stringify({ ...document, survey: { ...document.survey, coverage: { ...document.survey.coverage, efficient: { min_coverage: 0, min_marginal_efficiency: 1 } } } }));
    const isolated = matrixRegistry();
    variant.instrument.id += "-policy"; variant.survey.id += "-policy"; variant.survey.instrument_id = variant.instrument.id;
    isolated.registerProfileDocument(variant);
    expect(planRegion(region, [], variant.survey.id, undefined, "complete", isolated).tiles).toEqual(complete.tiles);
    expect(planRegion(region, [], variant.survey.id, undefined, "efficient", isolated).tiles.length).toBeLessThan(efficient.tiles.length);
    const grid = sampleRegion(region, document.instrument.footprint, document.survey.coverage);
    const profile = resolvePlanningProfile(document.survey.id, undefined, registry).profile;
    const covered = coveredMask(grid, efficient.tiles, profile, registry);
    const physicalArea = footprintArea(document.instrument.footprint);
    const remaining = complete.candidate_centers.filter((p) => !efficient.tiles.some((t) => t.ra_deg === p.ra_deg && t.dec_deg === p.dec_deg));
    const efficiencies = remaining.map((p) => {
      const mask = tileMask(grid, p.ra_deg, p.dec_deg, document.instrument.footprint);
      let gain = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i] && !covered[i]) gain += grid.weights[i];
      return gain * grid.cellAreaDeg2 / physicalArea;
    });
    expect(Math.max(...efficiencies)).toBeLessThan(document.survey.coverage.efficient!.min_marginal_efficiency);
    console.info("G8 strategies", fixture.key, JSON.stringify({ complete: complete.tiles.length, efficient: efficient.tiles.length, efficientCoverage: efficient.metrics.selected_region_coverage, policy: document.survey.coverage.efficient }));
  });

  it("mixes circular and triangular source datasets with mosaic output without changing source rows/formats", () => {
    const registry = matrixRegistry(), [circle, mosaic, triangle] = cases.slice(1);
    const csvs = ["ra_deg,dec_deg,quality\n149.78,-25,small\n", "ra_deg,dec_deg,quality\n150.42,-25,wide\n"];
    const datasets = [circle, triangle].map((f, i) => createDataset(parseCatalogueCsv(new TextEncoder().encode(csvs[i]), `${f.key}.csv`), i, f.key, f.document.instrument.id, registry));
    const before = structuredClone(datasets);
    const rows = datasets.flatMap((d) => d.tiles.map((t) => ({ ...t, instrument_profile_id: d.instrument_profile_id, inference_role: d.inference_role })));
    const plan = planRegion(mosaic.region, rows, mosaic.document.survey.id, undefined, "complete", registry);
    expect(plan.inference.lattice?.status).toBe("no_usable_centers");
    expect(plan.metrics.existing_tiles_contributing).toBe(2);
    expect(plan.tiles.length).toBeGreaterThan(0);
    const grid = referenceGrid(mosaic.region, plan.metrics.sampling!.natural_step_deg / 2);
    const masks = [referenceMask(grid, circle.document.instrument.footprint, [rows[0]]), referenceMask(grid, triangle.document.instrument.footprint, [rows[1]]), referenceMask(grid, mosaic.document.instrument.footprint, plan.tiles)];
    const union = masks[0].map((_, i) => masks.some((mask) => mask[i]) ? 1 : 0);
    expect(coverageFraction(grid, union)).toBeCloseTo(plan.metrics.selected_region_coverage, 2);
    const existing = masks[0].map((_, i) => masks[0][i] || masks[1][i]);
    expect(coverageFraction(grid, existing)).toBeCloseTo(plan.metrics.already_covered_fraction, 2);
    const wrong = referenceMask(grid, mosaic.document.instrument.footprint, rows);
    expect(Math.abs(coverageFraction(grid, wrong) - plan.metrics.already_covered_fraction)).toBeGreaterThan(0.1);
    const csv = buildExportCsv(plan.tiles.map((tile) => ({ ...tile, position_angle_deg: 31 })), mosaic.document.survey);
    expect(readCsv(csv)[0]).toEqual(["RA_HMS", "DEC_DMS", "PA", "SURVEY"]);
    expect(csv).not.toMatch(/quality|small|wide|PID|FRAME_EPOCH/);
    expect(datasets).toEqual(before);
    console.info("G8 mixed", JSON.stringify(plan.metrics));
  });

  it.each(cases.slice(1))("$key: exact public export headers/values and coordinate roundtrip in acceptance order", (fixture) => {
    const registry = matrixRegistry(), document = fixture.document;
    const plan = planRegion(fixture.region, [], document.survey.id, undefined, "complete", registry);
    const accepted = plan.tiles.map((tile) => ({ ...tile, position_angle_deg: cameraPa(document) }));
    const csv = buildExportCsv(accepted, document.survey), rows = readCsv(csv);
    const headers = { circle: ["ALPHA", "DELTA"], mosaic: ["RA_HMS", "DEC_DMS", "PA", "SURVEY"], triangular: ["RA_DEG", "DEC_DEG", "FRAME_EPOCH", "TARGET", "LABEL", "PROGRAM"] };
    expect(rows[0]).toEqual(headers[fixture.key as keyof typeof headers]);
    const parsed = parseCatalogueCsv(new TextEncoder().encode(csv), "accepted.csv", document.survey.export.ra_column, document.survey.export.dec_column);
    parsed.tiles.forEach((tile, index) => {
      expect(tile.ra_deg).toBeCloseTo(accepted[index].ra_deg, fixture.key === "mosaic" ? 4 : 7);
      expect(tile.dec_deg).toBeCloseTo(accepted[index].dec_deg, fixture.key === "mosaic" ? 5 : 7);
      expect(tile.ra_deg).toBeGreaterThanOrEqual(0); expect(tile.ra_deg).toBeLessThan(360);
      if (fixture.key === "triangular") expect(rows[index + 1].slice(2)).toEqual(["J2000", `PROPOSED_${String(index + 1).padStart(4, "0")}`, `PROPOSED_${String(index + 1).padStart(4, "0")}`, "g8-triangular"]);
      if (fixture.key === "mosaic") expect(rows[index + 1].slice(2)).toEqual(["31.00000000", "G8-MOSAIC"]);
    });
    expect(rows[1]).toEqual({ circle: ["0.00000000", "-32.10000000"], mosaic: ["10:00:00.000", "-25:00:00.000", "31.00000000", "G8-MOSAIC"], triangular: ["73.92349382", "42.00000000", "J2000", "PROPOSED_0001", "PROPOSED_0001", "g8-triangular"] }[fixture.key]);
  });

  it("resolves normal mosaic gaps in coverage and separate rotated detector render paths", () => {
    const fixture = cases[2], registry = matrixRegistry(), footprint = fixture.document.instrument.footprint;
    if (footprint.type !== "compound") throw new Error("Expected mosaic");
    expect(footprintContainsPoint(footprint, [0, 0])).toBe(false);
    const manual = makeCenterProposals([fixture.origin], "manual");
    const gap = localRegion(fixture.origin, 0.04, 0.04);
    expect(measureActiveCoverage(gap, [], manual, fixture.document.survey.id, undefined, registry).selected_region_coverage).toBe(0);
    const boundaries = tileFootprintBoundaries(manual[0], footprint);
    expect(boundaries).toHaveLength(2);
    expect(boundaries.map((b) => b.length)).toEqual([5, 5]);
    const theta = 31 * Math.PI / 180;
    for (const child of footprint.components) {
      const [x, y] = child.offset_deg;
      const [ra_deg, dec_deg] = localOffsetToSky(fixture.origin, [x * Math.cos(theta) + y * Math.sin(theta), y * Math.cos(theta) - x * Math.sin(theta)]);
      expect(measureActiveCoverage(localRegion({ ra_deg, dec_deg }, 0.03, 0.03), [], manual, fixture.document.survey.id, undefined, registry).selected_region_coverage).toBe(1);
    }
    const metrics = measureActiveCoverage(fixture.region, [], manual, fixture.document.survey.id, undefined, registry);
    const ref = referenceGrid(fixture.region, metrics.sampling!.natural_step_deg / 2);
    expect(coverageFraction(ref, referenceMask(ref, footprint, manual))).toBeCloseTo(metrics.selected_region_coverage, 2);
    const noPa = tileFootprintBoundaries(manual[0], { ...footprint, position_angle_deg: 0 });
    expect(boundaries).not.toEqual(noPa);
    console.info("G8 mosaic gap", JSON.stringify({ singleFootprintCoverage: metrics.selected_region_coverage, pitch: metrics.sampling!.natural_step_deg, paths: boundaries.length }));
  });

  it("keeps disabled inference on declared tiling and explicitly refuses manual automatic planning", () => {
    for (const manual of [false, true]) {
      const fixture = cases[1];
      const document = parseProfileJsonV2(JSON.stringify({ ...fixture.document, instrument: { ...fixture.document.instrument, id: `g8-mode-${manual}` }, survey: { ...fixture.document.survey, id: `g8-mode-survey-${manual}`, instrument_id: `g8-mode-${manual}`, inference: { ...fixture.document.survey.inference, enabled: false }, tiling: manual ? { type: "manual" } : fixture.document.survey.tiling } }));
      const registry = matrixRegistry(); registry.registerProfileDocument(document);
      if (manual) expect(() => planRegion(fixture.region, [], document.survey.id, undefined, "complete", registry)).toThrow(/manual.*automatic tiling/);
      else {
        const empty = planRegion(fixture.region, [], document.survey.id, undefined, "complete", registry);
        const existing = makeCenterProposals([fixture.origin], "manual");
        const plan = planRegion(fixture.region, existing, document.survey.id, undefined, "complete", registry);
        expect(plan.solution).toBe("declared_lattice"); expect(plan.inference.lattice?.status).toBe("disabled");
        // Occupied sites are removed, but no inferred phase is substituted.
        expect(plan.candidate_centers.every((p) => empty.candidate_centers.some((q) => q.ra_deg === p.ra_deg && q.dec_deg === p.dec_deg))).toBe(true);
      }
    }
  });

  it("fails insufficient and incompatible generic evidence without changing phase or profile", () => {
    const fixture = cases[1], registry = matrixRegistry(), rows = sourceRows(fixture, registry);
    const before = registry.resolveProfileDocument(fixture.document.survey.id);
    expect(() => planRegion(fixture.region, rows.slice(0, 2), before.survey.id, undefined, "complete", registry)).toThrow(/Generic lattice inference failed.*insufficient_anchors/);
    const incompatible = rows.slice(0, 4).map((r, i) => ({ ...r, dec_deg: r.dec_deg + [0, 0.023, 0.041, 0.067][i] }));
    expect(() => planRegion(fixture.region, incompatible, before.survey.id, undefined, "complete", registry)).toThrow(/Generic lattice inference failed/);
    expect(registry.resolveProfileDocument(before.survey.id)).toEqual(before);
  });

  it.each(cases.slice(1))("$key: scientific output is independent of profile spelling and legacy PID/group metadata", (fixture) => {
    const registry = matrixRegistry(), rows = sourceRows(fixture, registry);
    const original = planRegion(fixture.region, rows, fixture.document.survey.id, undefined, "complete", registry);
    const renamed = parseProfileJsonV2(JSON.stringify({ ...fixture.document,
      instrument: { ...fixture.document.instrument, id: `agnostic-${fixture.key}-camera` },
      survey: { ...fixture.document.survey, id: `agnostic-${fixture.key}`, instrument_id: `agnostic-${fixture.key}-camera` },
    }));
    registry.registerProfileDocument(renamed);
    const unrelatedGrouping = rows.map((t, i) => ({ ...t, instrument_profile_id: renamed.instrument.id, group_id: `arbitrary-${i}`, metadata: { ...t.metadata, PID: `not-a-scientific-key-${i}` } }));
    const plan = planRegion(fixture.region, unrelatedGrouping, renamed.survey.id, undefined, "complete", registry);
    expect(plan.tiles).toEqual(original.tiles);
    expect(plan.candidate_centers).toEqual(original.candidate_centers);
    expect(plan.metrics).toEqual(original.metrics);
    expect(plan.generation_method).toBe("region_lattice");
  });

  it.each(cases)("$key: manual/imported canonical centers contribute coverage/rendering/export without lattice metadata", (fixture) => {
    const registry = matrixRegistry();
    const centers = parseCenterText(`${fixture.origin.ra_deg} ${fixture.origin.dec_deg}`);
    const manual = makeCenterProposals(centers, "manual"), imported = makeCenterProposals(centers, "imported_centers");
    const a = measureActiveCoverage(fixture.region, [], manual, fixture.document.survey.id, undefined, registry);
    expect(a.selected_region_coverage).toBeGreaterThan(0);
    expect(measureActiveCoverage(fixture.region, [], imported, fixture.document.survey.id, undefined, registry)).toEqual(a);
    for (const rows of [manual, imported]) {
      expect(rows[0].metadata).not.toHaveProperty("lattice_i");
      expect(tileFootprintBoundaries(rows[0], fixture.document.instrument.footprint).length).toBe(fixture.key === "mosaic" ? 2 : 1);
      const accepted = rows.map((tile) => ({ ...tile, position_angle_deg: cameraPa(fixture.document) }));
      expect(buildExportCsv(accepted, fixture.document.survey)).toBe(buildExportCsv(accepted, fixture.document.survey));
    }
  });

  it("T80 reference catalogue holdout → frozen historical centers → Complete → decimal/sexagesimal export", () => {
    const registry = matrixRegistry(), document = cases[0].document;
    const dataset = createDataset(parseCatalogueCsv(new TextEncoder().encode(referenceCsv), "tiles_nc.csv"), 0, "reference", document.instrument.id, registry);
    expect(dataset.tiles).toHaveLength(4774);
    const fixture = golden.historical_holdout;
    const rows = dataset.tiles.filter((tile) => fixture.surrounding_names.includes(tile.name)).map((tile) => ({ ...tile, instrument_profile_id: document.instrument.id }));
    const before = structuredClone(rows);
    const plan = planRegion(fixture.polygon, rows, document.survey.id, undefined, "complete", registry);
    expect(plan.solution).toBe(fixture.solution);
    expect(plan.metrics.new_tiles).toBe(contract.plans.historical_holdout.new_tiles);
    expect(plan.metrics.sample_step_deg).toBe(contract.plans.historical_holdout.sample_step_deg);
    expect(plan.metrics.selected_region_coverage).toBe(contract.plans.historical_holdout.selected_region_coverage);
    for (const [ra, dec] of fixture.proposal_centers) expect(plan.tiles.some((t) => Math.abs(t.ra_deg - ra) < 1e-8 && Math.abs(t.dec_deg - dec) < 1e-8)).toBe(true);
    expect(measureActiveCoverage(fixture.polygon, rows, plan.tiles, document.survey.id, undefined, registry)).toEqual(plan.metrics);
    expect(plan).toEqual(planRegion(fixture.polygon, structuredClone(rows), document.survey.id, undefined, "complete", matrixRegistry()));
    for (const coordinate_format of ["decimal", "sexagesimal"] as const) {
      const survey = { ...document.survey, export: { ...document.survey.export, coordinate_format } };
      const csv = buildExportCsv(plan.tiles, survey), read = parseCatalogueCsv(new TextEncoder().encode(csv));
      expect(readCsv(csv)[0]).toEqual(["RA", "DEC", "EPOCH"]);
      expect(read.tiles).toHaveLength(plan.tiles.length);
      read.tiles.forEach((tile, i) => {
        expect(tile.ra_deg).toBeCloseTo(plan.tiles[i].ra_deg, coordinate_format === "decimal" ? 7 : 4);
        expect(tile.dec_deg).toBeCloseTo(plan.tiles[i].dec_deg, coordinate_format === "decimal" ? 7 : 5);
      });
      expect(buildExportCsv(plan.tiles, survey)).toBe(csv);
    }
    expect(rows).toEqual(before);
  });
});
