import { afterAll, describe, expect, it } from "vitest";
import type { CenterInput, CoveragePolicy, Footprint, SkyPolygon } from "../types";
import { createBundledProfileRegistry, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { greedyChoose, measureMetrics, sampleRegion, tileMask, type CoverageGrid } from "./coverage";
import { footprintArea, footprintCharacteristicScale, footprintContainsPoint, rotateLocalOffset } from "./footprint-engine";
import { modulo } from "./math";
import { planRegion } from "./planner";
import { coverageFraction, referenceGrid, referenceMask } from "./test-support/coverage-reference";

const policy: CoveragePolicy = { sampling: { target_samples_per_footprint_axis: 64, max_samples: 90_000 } };
// Fixed after the exploratory matrix: 0.5 percentage point, including reference
// uncertainty (<=0.05 pp). This is a fixture acceptance bound, not a universal
// accuracy guarantee for every policy, cap, or sub-cell feature.
const ACCURACY_TOLERANCE = 0.005;
const REFERENCE_REFINEMENT_TOLERANCE = 0.0005;
const results: Record<string, unknown>[] = [];
// Cache only reference scalars, never production outcomes or large test arrays.
const referenceFractions = new Map<string, { fraction: number; count: number }>();

/** Rectangle using the model's midpoint cosine conversion to ICRS vertices.
 * @param width - Full local east extent in degrees.
 * @param height - Full north/DEC extent in degrees.
 * @param ra - Region midpoint ICRS RA in degrees, wrapped to [0,360).
 * @param dec - Region midpoint ICRS DEC in degrees; cosine floor matches the model.
 * @returns Four ordered RA/DEC vertices; no exact spherical rectangle is assumed.
 */
function box(width: number, height: number, ra = 150, dec = 0): SkyPolygon {
  const cosine = Math.max(Math.cos(dec * Math.PI / 180), 0.01);
  return { vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
    ra_deg: modulo(ra + x * width / 2 / cosine, 360), dec_deg: dec + y * height / 2,
  })) };
}

interface AccuracyCase {
  name: string;
  footprint: Footprint;
  region: SkyPolygon;
  pointing: CenterInput;
  policy?: CoveragePolicy;
  legacy?: boolean;
}

/** Geometrically similar partial circles in the existing local convention.
 * @param name - Diagnostic case identifier.
 * @param scale - Diameter in local degrees; all extents/offsets scale together.
 * @param ra - Selected region midpoint RA in ICRS degrees.
 * @param dec - Selected region midpoint DEC in ICRS degrees.
 * @returns Partial overlap fixture; offsets are east=0.5 and north=0.25 diameters.
 */
function circleCase(name: string, scale: number, ra = 150, dec = 0): AccuracyCase {
  return { name, footprint: { type: "circle", radius_deg: scale / 2 },
    region: box(1.75 * scale, 1.25 * scale, ra, dec),
    pointing: { ra_deg: modulo(ra + 0.5 * scale / Math.max(Math.cos(dec * Math.PI / 180), 0.01), 360), dec_deg: dec + 0.25 * scale } };
}

const mosaic: Footprint = { type: "compound", position_angle_deg: 17, components: [
  { offset_deg: [-0.42, 0], rotation_deg: 9, footprint: { type: "rectangle", width_deg: 0.6, height_deg: 0.8 } },
  { offset_deg: [0.42, 0.08], rotation_deg: -7, footprint: { type: "rectangle", width_deg: 0.6, height_deg: 0.8 } },
] };
const gapWidth = 3 / 256; // 0.75 of the normal 1/64-degree pitch.
const narrowGap: Footprint = { type: "compound", components: [-(1 + gapWidth) / 2, (1 + gapWidth) / 2].map((x) => ({
  offset_deg: [x, 0], footprint: { type: "rectangle" as const, width_deg: 1, height_deg: 1 },
})) };
const cases: AccuracyCase[] = [
  { name: "t80-legacy", footprint: T80_SOUTH_INSTRUMENT_V2.footprint, legacy: true,
    region: box(2.1, 1.8, 150, -25), pointing: { ra_deg: 150.38, dec_deg: -24.77 } },
  { name: "t80-generic", footprint: T80_SOUTH_INSTRUMENT_V2.footprint, policy: SPLUS_SURVEY_V2.coverage,
    region: box(2.1, 1.8, 150, -25), pointing: { ra_deg: 150.38, dec_deg: -24.77 } },
  circleCase("small-circle", 1 / 32), circleCase("degree-circle", 1), circleCase("large-circle", 8),
  { name: "rotated-polygon", footprint: { type: "polygon", position_angle_deg: 31,
    vertices_deg: [[-0.6, -0.4], [0.5, -0.4], [0.65, 0.1], [0.1, 0.55], [-0.5, 0.3]] },
    region: box(1.75, 1.25), pointing: { ra_deg: 150.5, dec_deg: 0.25 } },
  { name: "compound", footprint: mosaic, region: box(1.75, 1.25), pointing: { ra_deg: 150.3, dec_deg: 0.18 } },
  { name: "slanted-region", footprint: mosaic, region: { vertices: [
    { ra_deg: 149.125, dec_deg: -0.625 }, { ra_deg: 150.875, dec_deg: -0.5 },
    { ra_deg: 150.55, dec_deg: 0.625 }, { ra_deg: 149.25, dec_deg: 0.4 },
  ] }, pointing: { ra_deg: 150.3, dec_deg: 0.18 } },
  { name: "narrow-gap", footprint: narrowGap, region: box(1.5, 0.25), pointing: { ra_deg: 150, dec_deg: 0.1 } },
  { ...circleCase("budget-limited", 1), policy: { sampling: { ...policy.sampling, max_samples: 1600 } } },
  circleCase("ra-zero", 1 / 32, 0),
  circleCase("dec-minus-50", 1 / 32, 150, -50), circleCase("dec-plus-50", 1 / 32, 150, 50),
  circleCase("polar-stress", 1 / 32, 150, 89.8),
];

/** Compare production union/metrics with independently selected fine resolution.
 * @param test - Local-degree footprint and ICRS region/pointing fixture.
 * @param referenceDensity - Explicit test refinement per characteristic axis,
 *   unrelated to production policy/cap; defaults to 512 (1024 for T80).
 * @returns Unrounded fractions, absolute error, production grid/mask and audit row.
 */
function evaluate(test: AccuracyCase, referenceDensity = test.name.startsWith("t80-") ? 1024 : 512) {
  const scale = footprintCharacteristicScale(test.footprint);
  const grid = test.legacy ? sampleRegion(test.region) : sampleRegion(test.region, test.footprint, test.policy ?? policy);
  const mask = tileMask(grid, test.pointing.ra_deg, test.pointing.dec_deg, test.footprint);
  const production = coverageFraction(grid, mask);
  const key = JSON.stringify([test.region, test.footprint, test.pointing, referenceDensity]);
  let cached = referenceFractions.get(key);
  if (!cached) {
    const fine = referenceGrid(test.region, scale / referenceDensity);
    cached = { fraction: coverageFraction(fine, referenceMask(fine, test.footprint, [test.pointing])), count: fine.ra.length };
    referenceFractions.set(key, cached);
  }
  const reference = cached.fraction;
  const error = Math.abs(production - reference);
  const metrics = measureMetrics([], mask, grid, 1, test.footprint);
  expect(Math.abs(metrics.selected_region_coverage - production)).toBeLessThanOrEqual(0.0000051);
  const rows = grid.sampling ? 0 : new Set(grid.dec).size;
  const row = { case: test.name, scale, natural_step: grid.sampling?.natural_step_deg ?? 0.01,
    effective_step: grid.stepDeg, cell_width: grid.sampling?.cell_width_deg ??
      grid.raSpanDeg * Math.cos(grid.centerDecDeg * Math.PI / 180) / (grid.ra.length / rows),
    cell_height: grid.sampling?.cell_height_deg ?? (grid.decMaxDeg - grid.decMinDeg) / rows,
    sampling_mode: test.legacy ? "compatibility (dimensions derived)" : "generic (production metadata)", sample_count: grid.ra.length,
    budget_limited: grid.sampling?.budget_limited ?? false, production_coverage: production,
    reference_coverage: reference, reference_sample_count: cached.count, absolute_error: error,
    percentage_point_error: error * 100 };
  return { row, grid, mask, production, reference, error };
}

describe("Gate 6C measured coverage accuracy", () => {
  it.each(cases)("measures $name against independent fine quadrature", (test) => {
    const measured = evaluate(test);
    results.push(measured.row);
    expect(Number.isFinite(measured.error)).toBe(true);
    expect(measured.production).toBeGreaterThan(0);
    expect(measured.reference).toBeLessThan(1);
    if (test.name === "narrow-gap") {
      // The missing stripe is constant in DEC, so cos weighting cancels exactly.
      expect(measured.production).toBe(1);
      expect(measured.reference).toBeCloseTo(1 - gapWidth / 1.5, 10);
      expect(measured.error).toBeGreaterThan(ACCURACY_TOLERANCE);
      expect(measured.error).toBeLessThan(0.01);
    } else if (test.name !== "polar-stress") expect(measured.error).toBeLessThan(ACCURACY_TOLERANCE);
    if (test.name === "compound") {
      expect(footprintCharacteristicScale(mosaic)).toBe(0.6);
      expect(footprintContainsPoint(mosaic, rotateLocalOffset([0, 0.04], 17))).toBe(false);
    }
    if (test.name === "budget-limited") {
      expect(measured.grid.sampling!.budget_limited).toBe(true);
      expect(measured.grid.ra.length).toBeLessThanOrEqual(1600);
      expect(sampleRegion(test.region, test.footprint, test.policy)).toEqual(measured.grid);
      expect((measured.grid.dec[0] + measured.grid.dec.at(-1)!) / 2).toBeCloseTo(0, 12);
      expect((measured.grid.ra[0] + measured.grid.ra.at(-1)!) / 2).toBeCloseTo(150, 12);
    }
  });

  it("checks reference refinement and analytic local half/full rectangles", () => {
    for (const name of ["t80-legacy", "t80-generic", "small-circle", "large-circle", "rotated-polygon", "compound", "slanted-region", "budget-limited", "narrow-gap"]) {
      const test = cases.find((entry) => entry.name === name)!;
      const coarse = evaluate(test);
      const density = name.startsWith("t80-") ? 1280 : name === "narrow-gap" ? 1024 : 768;
      const finer = evaluate(test, density);
      const delta = Math.abs(coarse.reference - finer.reference);
      results.push({ case: `reference-refinement-${name}`, density, delta });
      expect(delta).toBeLessThan(REFERENCE_REFINEMENT_TOLERANCE);
    }
    const footprint: Footprint = { type: "rectangle", width_deg: 1, height_deg: 1 };
    const region = box(1, 1);
    for (const [offset, expected] of [[0, 1], [0.5, 0.5]]) {
      const pointing = { ra_deg: 150 + offset, dec_deg: 0 };
      const grid = sampleRegion(region, footprint, policy);
      const fine = referenceGrid(region, 1 / 512);
      expect(coverageFraction(grid, tileMask(grid, pointing.ra_deg, 0, footprint))).toBeCloseTo(expected, 10);
      expect(coverageFraction(fine, referenceMask(fine, footprint, [pointing]))).toBeCloseTo(expected, 10);
    }
    // Independent spherical-weight integral for the T80 axis-aligned overlap.
    const cos = (dec: number) => Math.cos(dec * Math.PI / 180);
    const sin = (dec: number) => Math.sin(dec * Math.PI / 180);
    const regionRaWidth = 2.1 / cos(-25);
    const footprintRaWidth = 1.4 / cos(-24.77);
    const overlapRa = Math.min(regionRaWidth / 2, 0.38 + footprintRaWidth / 2) -
      Math.max(-regionRaWidth / 2, 0.38 - footprintRaWidth / 2);
    const analytic = overlapRa / regionRaWidth * (sin(-24.1) - sin(-25.47)) / (sin(-24.1) - sin(-25.9));
    const reference = evaluate(cases[0]).reference;
    expect(Math.abs(reference - analytic)).toBeLessThan(REFERENCE_REFINEMENT_TOLERANCE);
    results.push({ case: "t80-analytic", coverage: analytic, reference_error: Math.abs(reference - analytic) });
  });

  it("characterizes increasingly restrictive budgets without a universal accuracy promise", () => {
    const budgetRows = [100, 400, 900, 1600].map((cap) => {
      const measurement = evaluate({ ...circleCase(`budget-${cap}`, 1),
        policy: { sampling: { ...policy.sampling, max_samples: cap } } });
      expect(measurement.grid.sampling!.budget_limited).toBe(true);
      expect(measurement.grid.ra.length).toBeLessThanOrEqual(cap);
      return measurement.row;
    });
    results.push(...budgetRows);
    expect(budgetRows[0].absolute_error).toBeGreaterThan(ACCURACY_TOLERANCE);
    for (const row of budgetRows.slice(1)) expect(row.absolute_error).toBeLessThan(ACCURACY_TOLERANCE);
  });

  it("measures low/normal/high density convergence with the same fine reference", () => {
    for (const test of [circleCase("circle", 1 / 32), cases.find((entry) => entry.name === "compound")!]) {
      const errors: number[] = [];
      for (const density of [16, 64, 128]) {
        const measured = evaluate({ ...test, name: `convergence-${test.name}-${density}`,
          policy: { sampling: { target_samples_per_footprint_axis: density, max_samples: 300_000 } } });
        results.push(measured.row);
        errors.push(measured.error);
      }
      expect(errors[2]).toBeLessThan(errors[0] / 5);
      expect(errors[2]).toBeLessThan(ACCURACY_TOLERANCE);
    }
  });

  it("measures boundary phase at constant contained-circle area and rigid translations", () => {
    const scale = 1 / 32;
    const footprint: Footprint = { type: "circle", radius_deg: scale / 2 };
    const region = box(1.75 * scale, 1.25 * scale);
    const grid = sampleRegion(region, footprint, policy);
    const fine = referenceGrid(region, scale / 512);
    const phases = Array.from({ length: 8 }, (_, index) => {
      const phase = index / 8;
      const pointing = { ra_deg: 150 + phase * scale / 64, dec_deg: phase * scale / 64 };
      const production = coverageFraction(grid, tileMask(grid, pointing.ra_deg, pointing.dec_deg, footprint));
      const reference = coverageFraction(fine, referenceMask(fine, footprint, [pointing]));
      return { phase, production, reference, error: Math.abs(production - reference) };
    });
    for (const phase of phases) {
      expect(phase.error).toBeLessThan(ACCURACY_TOLERANCE);
      // At this tiny DEC extent the spherical-weight correction is <1e-7.
      expect(Math.abs(phase.reference - Math.PI / (4 * 1.75 * 1.25))).toBeLessThan(REFERENCE_REFINEMENT_TOLERANCE);
    }
    results.push({ case: "grid-phase", phases,
      production_range: Math.max(...phases.map((p) => p.production)) - Math.min(...phases.map((p) => p.production)),
      reference_range: Math.max(...phases.map((p) => p.reference)) - Math.min(...phases.map((p) => p.reference)) });
    // Bounding-edge anchoring makes rigid translations phase-invariant.
    const translated = [0, 0.003, 21.007].map((shift) => evaluate(circleCase("translation", scale, 150 + shift)).production);
    expect(Math.max(...translated) - Math.min(...translated)).toBeLessThan(1e-10);
  });

  it("compares normalized errors across scales, RA zero, and ordinary declinations", () => {
    const measurements = ["small-circle", "degree-circle", "large-circle", "ra-zero", "dec-minus-50", "dec-plus-50", "polar-stress"]
      .map((name) => evaluate(cases.find((test) => test.name === name)!));
    const errors = measurements.slice(0, 3).map((m) => m.error);
    expect(Math.max(...errors) - Math.min(...errors)).toBeLessThan(0.0002);
    expect(measurements[3].production).toBeCloseTo(measurements[0].production, 10);
    expect(measurements[3].reference).toBeCloseTo(measurements[0].reference, 10);
    for (const measurement of measurements.slice(4, 6)) {
      expect(Math.abs(measurement.production - measurements[0].production)).toBeLessThan(0.0002);
      expect(Math.abs(measurement.reference - measurements[0].reference)).toBeLessThan(0.0002);
    }
    // Diagnostic only: resolution agreement cannot validate the polar model.
    // The cosine floor and varying cos(DEC) weights break local equivalence.
    expect(Math.abs(measurements[6].reference - measurements[0].reference)).toBeGreaterThan(0.005);
    expect(Number.isFinite(measurements[6].grid.totalWeight)).toBe(true);
  });

  it("validates Complete/Efficient integration and stop margins on a generic small camera", () => {
    const scale = 1 / 32;
    const footprint: Footprint = { type: "rectangle", width_deg: scale, height_deg: scale };
    const region = box(1.8 * scale, 1.8 * scale);
    const registry = createBundledProfileRegistry();
    registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "accuracy-camera", footprint });
    const efficient = { min_coverage: 0.4, min_marginal_efficiency: 0.8 };
    registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id: "accuracy-survey", instrument_id: "accuracy-camera",
      tiling: { type: "lattice", basis_deg: [[scale, 0], [0, scale]], origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 } },
      inference: { ...SPLUS_SURVEY_V2.inference, enabled: false }, coverage: { ...policy, efficient } });
    const complete = planRegion(region, [], "accuracy-survey", undefined, "complete", registry);
    const efficientPlan = planRegion(region, [], "accuracy-survey", undefined, "efficient", registry);
    const grid = sampleRegion(region, footprint, policy);
    const fine = referenceGrid(region, scale / 512);
    const completeReference = coverageFraction(fine, referenceMask(fine, footprint, complete.tiles));
    const efficientReference = coverageFraction(fine, referenceMask(fine, footprint, efficientPlan.tiles));
    const candidates = complete.candidate_centers;
    const rerank = (sampling: CoverageGrid) => greedyChoose(candidates.map((p) => ({
      center: [p.ra_deg, p.dec_deg] as [number, number], mask: referenceMask(sampling, footprint, [p]),
    })), new Uint8Array(sampling.ra.length), sampling, footprint, 1, "efficient", efficient);
    const fineChosen = rerank(fine);
    expect(complete.metrics.selected_region_coverage).toBe(1);
    expect(completeReference).toBeCloseTo(1, 10);
    expect(fineChosen.length).toBe(efficientPlan.tiles.length);
    expect(Math.abs(efficientPlan.metrics.selected_region_coverage - efficientReference)).toBeLessThan(ACCURACY_TOLERANCE);
    expect(planRegion(region, [], "accuracy-survey", undefined, "efficient", registry)).toEqual(efficientPlan);
    const stop = (sampling: CoverageGrid) => {
      const covered = referenceMask(sampling, footprint, efficientPlan.tiles);
      let maxMarginal = 0;
      for (const candidate of candidates) {
        const mask = referenceMask(sampling, footprint, [candidate]);
        let gain = 0;
        for (let i = 0; i < mask.length; i += 1) if (mask[i] && !covered[i]) gain += sampling.weights[i];
        maxMarginal = Math.max(maxMarginal, gain * sampling.cellAreaDeg2 / footprintArea(footprint));
      }
      return { coverage: coverageFraction(sampling, covered), next_marginal: maxMarginal };
    };
    const productionStop = stop(grid); const referenceStop = stop(fine);
    const firstProduction = coverageFraction(grid, referenceMask(grid, footprint, efficientPlan.tiles.slice(0, 1)));
    const firstReference = coverageFraction(fine, referenceMask(fine, footprint, efficientPlan.tiles.slice(0, 1)));
    expect(Math.abs(firstProduction - firstReference)).toBeLessThan(ACCURACY_TOLERANCE);
    expect(efficient.min_coverage - firstProduction).toBeGreaterThan(0.08);
    expect(efficient.min_coverage - firstReference).toBeGreaterThan(0.08);
    // The floor margin exceeds five times the measured coverage tolerance;
    // the next marginal is ~0.40 below its threshold, far from aliasing noise.
    expect(productionStop.coverage - efficient.min_coverage).toBeGreaterThan(5 * ACCURACY_TOLERANCE);
    expect(referenceStop.coverage - efficient.min_coverage).toBeGreaterThan(5 * ACCURACY_TOLERANCE);
    expect(efficient.min_marginal_efficiency - productionStop.next_marginal).toBeGreaterThan(0.3);
    expect(efficient.min_marginal_efficiency - referenceStop.next_marginal).toBeGreaterThan(0.3);
    results.push({ case: "planning", complete_tiles: complete.tiles.length, complete_production: complete.metrics.selected_region_coverage,
      complete_reference: completeReference, efficient_tiles: efficientPlan.tiles.length,
      efficient_production: efficientPlan.metrics.selected_region_coverage, efficient_reference: efficientReference,
      reference_selected_tiles: fineChosen.length, policy: efficient, production_stop: productionStop, reference_stop: referenceStop });
    results.push({ case: "efficient-prefix", first_production: firstProduction, first_reference: firstReference });
  });
});

afterAll(() => {
  if (import.meta.env.VITE_G6C_REPORT === "1") console.info(`G6C_RESULTS=${JSON.stringify(results)}`);
});
