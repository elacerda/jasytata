import { describe, expect, it } from "vitest";
import { createBundledProfileRegistry } from "../profiles/registry";
import { SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles/v2";
import { validateSurveyProfileV2 } from "../profiles/schema-v2";
import type { CoveragePolicy, Footprint, SkyPolygon, SurveyProfileV2 } from "../types";
import { measureActiveCoverage, sampleRegion, tileMask } from "./coverage";
import { footprintCharacteristicScale, footprintLocalBounds } from "./footprint-engine";
import { wrappedRaDelta } from "./math";
import { planRegion } from "./planner";

const rectangle: Footprint = { type: "rectangle", width_deg: 2, height_deg: 1 };
const policy: CoveragePolicy = { sampling: { target_samples_per_footprint_axis: 8, max_samples: 10_000 } };

function box(width: number, height = width, ra = 0, dec = 0): SkyPolygon {
  return { vertices: [
    { ra_deg: ra, dec_deg: dec - height / 2 }, { ra_deg: ra + width, dec_deg: dec - height / 2 },
    { ra_deg: ra + width, dec_deg: dec + height / 2 }, { ra_deg: ra, dec_deg: dec + height / 2 },
  ] };
}

function withCap(max_samples: number): CoveragePolicy {
  return { sampling: { ...policy.sampling, max_samples } };
}

function genericRegistry(tiling: SurveyProfileV2["tiling"]) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "sampling-camera", footprint: rectangle });
  registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id: "sampling-survey", instrument_id: "sampling-camera",
    tiling, inference: { ...SPLUS_SURVEY_V2.inference, enabled: false }, coverage: withCap(100) });
  return registry;
}

describe("footprint characteristic sampling scale", () => {
  it("uses the smaller rectangle side", () => {
    expect(footprintCharacteristicScale(rectangle)).toBe(1);
  });
  it("uses the circle diameter", () => {
    expect(footprintCharacteristicScale({ type: "circle", radius_deg: 0.025 })).toBe(0.05);
  });
  it("uses polygon intrinsic smaller extent rather than area", () => {
    const polygon: Footprint = { type: "polygon", vertices_deg: [[-2, -0.25], [2, -0.25], [2, 0.25], [-2, 0.25]] };
    expect(footprintCharacteristicScale(polygon)).toBe(0.5);
    expect(footprintCharacteristicScale({ ...polygon, vertices_deg: [...polygon.vertices_deg].reverse() })).toBe(0.5);
  });
  it("ignores rectangle and polygon position angles", () => {
    for (const position_angle_deg of [0, 37, 90, -143]) {
      expect(footprintCharacteristicScale({ ...rectangle, position_angle_deg })).toBe(1);
      expect(footprintCharacteristicScale({ type: "polygon", position_angle_deg,
        vertices_deg: [[-2, -0.25], [2, -0.25], [2, 0.25], [-2, 0.25]] })).toBe(0.5);
    }
  });
  it("recursively uses the minimum mosaic child scale, ignoring rotations and offsets", () => {
    const mosaic: Footprint = { type: "compound", position_angle_deg: 31, components: [
      { offset_deg: [-1, 0], rotation_deg: 52, footprint: rectangle },
      { offset_deg: [1, 0], footprint: { type: "circle", radius_deg: 0.125 } },
      { offset_deg: [0, 1], footprint: { type: "polygon", vertices_deg: [[0, 0], [1, 0], [0, 0.5]] } },
    ] };
    expect(footprintCharacteristicScale(mosaic)).toBe(0.25);
  });
  it("retains small detector scale across a widely separated mosaic", () => {
    const mosaic: Footprint = { type: "compound", components: [-40, 40].map((x) => ({
      offset_deg: [x, 0], footprint: { type: "rectangle", width_deg: 0.0625, height_deg: 0.03125 },
    })) };
    const bounds = footprintLocalBounds(mosaic);
    expect(bounds.max_east_deg - bounds.min_east_deg).toBeGreaterThan(80);
    expect(footprintCharacteristicScale(mosaic)).toBe(0.03125);
    expect(sampleRegion(box(1), mosaic, policy).sampling!.natural_step_deg).toBe(0.03125 / 8);
  });
  it("rejects invalid resulting scales", () => {
    for (const width_deg of [0, -1, NaN, Infinity]) {
      expect(() => footprintCharacteristicScale({ type: "rectangle", width_deg, height_deg: Infinity })).toThrow(/finite and positive/);
    }
    expect(() => footprintCharacteristicScale({ type: "compound", components: [] })).toThrow(/finite and positive/);
  });
});

describe("scale-aware uniform coverage sampling", () => {
  it.each([0.03125, 1, 8])("derives proportional natural resolution at footprint scale %s degrees", (scale) => {
    const footprint: Footprint = { type: "circle", radius_deg: scale / 2 };
    const grid = sampleRegion(box(scale * 2), footprint, policy);
    expect(grid.sampling!.characteristic_scale_deg).toBe(scale);
    expect(grid.sampling!.natural_step_deg).toBe(scale / 8);
    expect(grid.sampling!.effective_step_deg).toBe(scale / 8);
  });
  it("retains natural pitch below the budget and reports actual array lengths", () => {
    const grid = sampleRegion(box(1), rectangle, policy);
    expect(grid.sampling).toMatchObject({ characteristic_scale_deg: 1, natural_step_deg: 0.125, effective_step_deg: 0.125,
      sample_count: 64, max_samples: 10_000, budget_limited: false, cell_width_deg: 0.125, cell_height_deg: 0.125 });
    expect(grid.ra).toHaveLength(grid.sampling!.sample_count);
    expect(grid.dec).toHaveLength(grid.ra.length);
    expect(grid.weights).toHaveLength(grid.ra.length);
    expect(grid.ra[0]).toBe(0.0625);
    expect(grid.dec[0]).toBe(-0.4375);
    expect(grid.ra[7]).toBe(0.9375);
    expect(grid.dec[8]).toBe(-0.3125);
  });
  it("coarsens deterministically before allocating a budget-limited grid", () => {
    const region = box(8, 5);
    const grid = sampleRegion(region, rectangle, withCap(101));
    expect(grid.sampling!.budget_limited).toBe(true);
    expect(grid.sampling!.effective_step_deg).toBeGreaterThan(grid.sampling!.natural_step_deg);
    expect(grid.ra.length).toBeLessThanOrEqual(101);
    expect(grid.sampling!.sample_count).toBe(grid.ra.length);
    expect(sampleRegion(region, rectangle, withCap(101))).toEqual(grid);
    // Full bounds remain represented: no row/column truncation on one side.
    expect(grid.ra[0] + grid.ra[grid.ra.length - 1]).toBe(8);
    expect(grid.dec[0] + grid.dec[grid.dec.length - 1]).toBe(0);
    expect(grid.sampling!.cell_width_deg).toBeLessThanOrEqual(grid.sampling!.effective_step_deg);
    expect(grid.sampling!.cell_height_deg).toBeLessThanOrEqual(grid.sampling!.effective_step_deg);
  });
  it.each([63, 64, 65])("respects the tight boundary cap %s around a 64-cell natural grid", (cap) => {
    const grid = sampleRegion(box(1), rectangle, withCap(cap));
    expect(grid.ra.length).toBeLessThanOrEqual(cap);
    expect(grid.sampling!.budget_limited).toBe(cap < 64);
    if (cap >= 64) {
      expect(grid.ra.length).toBe(64);
      expect(grid.stepDeg).toBe(0.125);
    } else expect(grid.stepDeg).toBeGreaterThan(0.125);
  });
  it("handles a one-cell cap without applying legacy minimum rows", () => {
    const grid = sampleRegion(box(8, 1), rectangle, withCap(1));
    expect(grid.ra).toEqual(new Float64Array([4]));
    expect(grid.dec).toEqual(new Float64Array([0]));
    expect(grid.sampling!.budget_limited).toBe(true);
  });
  it("corrects ceiling counts for long thin regions", () => {
    const grid = sampleRegion(box(64, 0.03125), { type: "circle", radius_deg: 0.001 }, withCap(7));
    expect(grid.ra.length).toBeLessThanOrEqual(7);
    expect(grid.sampling!.budget_limited).toBe(true);
  });
  it("counts actual principal cells including polygon-exterior zero weights", () => {
    const triangle: SkyPolygon = { vertices: [{ ra_deg: 0, dec_deg: -0.5 }, { ra_deg: 1, dec_deg: -0.5 }, { ra_deg: 0, dec_deg: 0.5 }] };
    const grid = sampleRegion(triangle, rectangle, withCap(64));
    expect(grid.sampling!.sample_count).toBe(64);
    expect(Array.from(grid.weights).filter((weight) => weight > 0).length).toBeLessThan(64);
    expect(tileMask(grid, 0.5, 0, rectangle).filter((hit) => hit > 0).length)
      .toBe(Array.from(grid.weights).filter((weight) => weight > 0).length);
  });
  it("preserves the strict ray boundary mask (lower/left in, upper/right out)", () => {
    const triangle: SkyPolygon = { vertices: [{ ra_deg: 0, dec_deg: -0.5 }, { ra_deg: 1, dec_deg: -0.5 }, { ra_deg: 0, dec_deg: 0.5 }] };
    const grid = sampleRegion(triangle, rectangle, withCap(64));
    expect(grid.weights[0]).toBeGreaterThan(0);
    expect(grid.weights[7]).toBe(0); // Exactly on the triangle's diagonal.
  });
  it("is scale invariant in normalized footprint units across 256-fold scale", () => {
    const normalized = [0.03125, 1, 8].map((scale) => {
      const grid = sampleRegion(box(scale * 2), { type: "circle", radius_deg: scale / 2 }, policy);
      return { east: Array.from(grid.ra, (ra) => ra / scale), north: Array.from(grid.dec, (dec) => dec / scale),
        cellWidth: grid.sampling!.cell_width_deg / scale, cellHeight: grid.sampling!.cell_height_deg / scale,
        effective: grid.sampling!.effective_step_deg / scale };
    });
    expect(normalized[1]).toEqual(normalized[0]);
    expect(normalized[2]).toEqual(normalized[0]);
  });
  it("is also scale invariant when the budget forces coarsening", () => {
    const grids = [0.03125, 1, 8].map((scale) => {
      const grid = sampleRegion(box(scale * 2), { type: "circle", radius_deg: scale / 2 }, withCap(100));
      expect(grid.sampling!.budget_limited).toBe(true);
      return { east: Array.from(grid.ra, (ra) => ra / scale), north: Array.from(grid.dec, (dec) => dec / scale) };
    });
    expect(grids[1]).toEqual(grids[0]);
    expect(grids[2]).toEqual(grids[0]);
  });
  it("preserves RA zero, cyclic starts, reversed windings, and footprint masks", () => {
    const region: SkyPolygon = { vertices: [{ ra_deg: 359.75, dec_deg: -0.25 }, { ra_deg: 0.25, dec_deg: -0.25 },
      { ra_deg: 0.25, dec_deg: 0.25 }, { ra_deg: 359.75, dec_deg: 0.25 }] };
    const grid = sampleRegion(region, rectangle, policy);
    expect(grid.ra.some((ra) => ra < 1)).toBe(true);
    expect(grid.ra.some((ra) => ra > 359)).toBe(true);
    expect(tileMask(grid, 0, 0, rectangle).every((hit) => hit === 1)).toBe(true);
    expect(Array.from(grid.ra, (ra) => wrappedRaDelta(ra, 0))).toEqual([-0.1875, -0.0625, 0.0625, 0.1875,
      -0.1875, -0.0625, 0.0625, 0.1875, -0.1875, -0.0625, 0.0625, 0.1875, -0.1875, -0.0625, 0.0625, 0.1875]);
    for (let start = 0; start < 4; start += 1) {
      const vertices = [...region.vertices.slice(start), ...region.vertices.slice(0, start)];
      expect(sampleRegion({ vertices }, rectangle, policy)).toEqual(grid);
      expect(sampleRegion({ vertices: vertices.reverse() }, rectangle, policy)).toEqual(grid);
    }
  });
  it("retains the existing midpoint cosine scale and per-cell cos(DEC) weighting", () => {
    const grid = sampleRegion(box(2, 1, 0, 60), rectangle, policy);
    expect(grid.sampling!.cell_width_deg).toBeLessThanOrEqual(0.125);
    for (let i = 0; i < grid.weights.length; i += 1) {
      expect(grid.weights[i]).toBe(Math.cos(grid.dec[i] * Math.PI / 180));
    }
  });
  it("retains detector gaps using the Gate 3 containment engine", () => {
    const mosaic: Footprint = { type: "compound", components: [-0.375, 0.375].map((x) => ({
      offset_deg: [x, 0], footprint: { type: "rectangle", width_deg: 0.25, height_deg: 0.5 },
    })) };
    const grid = sampleRegion(box(1, 0.5), mosaic, policy);
    const mask = tileMask(grid, 0.5, 0, mosaic);
    for (let i = 0; i < mask.length; i += 1) {
      expect(mask[i]).toBe(grid.ra[i] < 0.25 || grid.ra[i] > 0.75 ? 1 : 0);
    }
    expect(grid.sampling!.natural_step_deg).toBe(0.25 / 8);
  });
  it("rejects unpaired arguments and underflowed natural resolution", () => {
    expect(() => sampleRegion(box(1), rectangle)).toThrow(/both footprint and policy/);
    expect(() => sampleRegion(box(1), undefined, policy)).toThrow(/both footprint and policy/);
    expect(() => sampleRegion(box(1), { type: "rectangle", width_deg: Number.MIN_VALUE, height_deg: 1 }, policy)).toThrow(/step must be finite and positive/);
  });
  it("reports a clear failure if an extremely coarse grid has no selected cells", () => {
    const triangle: SkyPolygon = { vertices: [{ ra_deg: 0, dec_deg: 0 }, { ra_deg: 1, dec_deg: 0 }, { ra_deg: 0, dec_deg: 0.125 }] };
    expect(sampleRegion(triangle, rectangle, withCap(1)).sampling!.status).toBe("under_resolved");
  });
});

describe("coverage sampling policy validation and integration", () => {
  const invalidNumbers = [NaN, Infinity, -Infinity, 0, -1, 1.5];
  for (const field of ["target_samples_per_footprint_axis", "max_samples"] as const) {
    it.each(invalidNumbers)(`rejects ${field} = %s at schema and engine boundaries`, (value) => {
      const coverage = { sampling: { ...policy.sampling, [field]: value } };
      expect(() => validateSurveyProfileV2({ ...SPLUS_SURVEY_V2, coverage })).toThrow(/finite|positive.*integer/);
      expect(() => sampleRegion(box(1), rectangle, coverage)).toThrow(/finite|positive.*integer/);
    });
  }
  it("passes generic manual-survey policy and metadata through coverage recalculation", () => {
    const registry = genericRegistry({ type: "manual" });
    const metrics = measureActiveCoverage(box(2), [], [], "sampling-survey", undefined, registry);
    expect(metrics.sampling).toEqual(sampleRegion(box(2), rectangle, withCap(100)).sampling);
    expect(metrics.sampling!.sample_count).toBeLessThanOrEqual(100);
    expect(metrics.sampling!.budget_limited).toBe(true);
  });
  it("refuses declared-lattice planning when its required grid exceeds the budget", () => {
    const registry = genericRegistry({ type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "region_center" } });
    expect(() => planRegion(box(2), [], "sampling-survey", undefined, "complete", registry)).toThrow(/under_resolved/);
    const metrics = measureActiveCoverage(box(2), [], [], "sampling-survey", undefined, registry);
    expect(metrics.coverage_status).toBe("under_resolved");
    expect(metrics).not.toHaveProperty("selected_region_coverage");
  });
  it("keeps the frozen legacy adapter's result shape and numerical layout", () => {
    const grid = sampleRegion(box(1));
    expect(grid.sampling).toBeUndefined();
    expect(grid.ra.length).toBe(10_000);
    expect(grid.stepDeg).toBe(0.01);
    expect(measureActiveCoverage(box(1), [], []).sampling).toBeUndefined();
  });
});
