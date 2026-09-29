import { describe, expect, it } from "vitest";
import type { Footprint, GenericLatticeTiling, SkyPolygon, TangentPlaneOffset } from "../types";
import { createBundledProfileRegistry, DEFAULT_PROFILE, SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { footprintIntersectsRegion } from "./footprint-engine";
import { generateLatticeCandidates, latticePlanningOrigin, latticePoint, type LatticePoint } from "./lattice";
import { planRegion } from "./planner";

const anchor = { ra_deg: 150, dec_deg: 0 };
const rectangle: Footprint = { type: "rectangle", width_deg: 0.7, height_deg: 0.6 };
const circle: Footprint = { type: "circle", radius_deg: 0.38 };
const hexagon: Footprint = { type: "polygon", vertices_deg: Array.from({ length: 6 }, (_, index) => {
  const angle = index * Math.PI / 3;
  return [0.4 * Math.cos(angle), 0.4 * Math.sin(angle)] as TangentPlaneOffset;
}) };
const shapes = [rectangle, circle, hexagon];
const square: SkyPolygon = { vertices: [
  { ra_deg: 149.05, dec_deg: -0.95 }, { ra_deg: 150.95, dec_deg: -0.95 },
  { ra_deg: 150.95, dec_deg: 0.95 }, { ra_deg: 149.05, dec_deg: 0.95 },
] };

function fixed(basis_deg: GenericLatticeTiling["basis_deg"], origin = anchor): GenericLatticeTiling {
  return { type: "lattice", basis_deg, origin: { type: "fixed_anchor", ...origin } };
}

function polygonAround(ra: number, dec: number, halfEast: number, halfNorth: number): SkyPolygon {
  const halfRa = halfEast / Math.cos(dec * Math.PI / 180);
  return { vertices: [
    { ra_deg: (ra - halfRa + 360) % 360, dec_deg: dec - halfNorth },
    { ra_deg: (ra + halfRa) % 360, dec_deg: dec - halfNorth },
    { ra_deg: (ra + halfRa) % 360, dec_deg: dec + halfNorth },
    { ra_deg: (ra - halfRa + 360) % 360, dec_deg: dec + halfNorth },
  ] };
}

function registryFor(footprint: Footprint, tiling: GenericLatticeTiling) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "gate4-camera", footprint });
  registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id: "gate4-survey", instrument_id: "gate4-camera", tiling,
    inference: { ...SPLUS_SURVEY_V2.inference, enabled: false } });
  return registry;
}

describe("v0.4 Gate 4 independent lattice coordinates", () => {
  it("keeps orthogonal indices, signed coordinates, phase, and j/i ordering", () => {
    const tiling = fixed([[1.2, 0], [0, 0.8]]);
    expect(latticePoint(-2, 3, tiling.basis_deg)).toEqual({ i: -2, j: 3, x_deg: -2.4, y_deg: 2.4000000000000004 });
    const sites = generateLatticeCandidates(square, tiling, circle, 1200);
    expect(sites.map(({ i, j }) => [i, j])).toEqual([
      [-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
    ]);
    expect(sites.find(({ i, j }) => i === 1 && j === -1)).toMatchObject({ ra_deg: 151.2, dec_deg: -0.8 });
    expect(generateLatticeCandidates(square, tiling, circle, 1200)).toEqual(sites);
  });

  it("preserves rotated orthogonal lengths and footprint PA independently", () => {
    const angle = 25 * Math.PI / 180;
    const east = Math.cos(angle); const north = Math.sin(angle);
    const tiling = fixed([[1.2 * east, 1.2 * north], [-0.8 * north, 0.8 * east]]);
    expect(Math.hypot(...tiling.basis_deg[0])).toBeCloseTo(1.2, 12);
    expect(Math.hypot(...tiling.basis_deg[1])).toBeCloseTo(0.8, 12);
    expect(tiling.basis_deg[0][0] * tiling.basis_deg[1][0] + tiling.basis_deg[0][1] * tiling.basis_deg[1][1]).toBeCloseTo(0, 12);
    const site = latticePoint(0, -1, tiling.basis_deg);
    expect(site.x_deg).toBeCloseTo(0.8 * north, 12);
    expect(site.y_deg).toBeCloseTo(-0.8 * east, 12);
    const first = generateLatticeCandidates(square, tiling, { ...rectangle, position_angle_deg: 0 }, 1200);
    const turnedCamera = generateLatticeCandidates(square, tiling, { ...rectangle, position_angle_deg: 60 }, 1200);
    for (const candidates of [first, turnedCamera]) {
      expect(candidates.find(({ i, j }) => i === 0 && j === -1)).toMatchObject({ x_deg: site.x_deg, y_deg: site.y_deg });
      expect(candidates.map(({ i, j }) => [i, j])).toEqual([...candidates].sort((a, b) => a.j - b.j || a.i - b.i).map(({ i, j }) => [i, j]));
    }
    expect(generateLatticeCandidates(square, tiling, { ...rectangle, position_angle_deg: 0 }, 1200)).toEqual(first);
  });

  it("gets six unit nearest neighbors and staggered rows from a triangular basis", () => {
    const height = Math.sqrt(3) / 2;
    const basis: GenericLatticeTiling["basis_deg"] = [[1, 0], [0.5, height]];
    const expected: TangentPlaneOffset[] = [[1, 0], [-1, 0], [0.5, height], [-0.5, -height], [-0.5, height], [0.5, -height]];
    const indices = [[1, 0], [-1, 0], [0, 1], [0, -1], [-1, 1], [1, -1]];
    for (let index = 0; index < indices.length; index += 1) {
      const [i, j] = indices[index]; const point = latticePoint(i, j, basis);
      expect(point.x_deg).toBeCloseTo(expected[index][0], 12);
      expect(point.y_deg).toBeCloseTo(expected[index][1], 12);
      expect(Math.hypot(point.x_deg, point.y_deg)).toBeCloseTo(1, 12);
    }
    const candidates = generateLatticeCandidates(square, fixed(basis), circle, 1200);
    expect(candidates.map(({ i, j }) => [i, j])).toEqual([...candidates].sort((a, b) => a.j - b.j || a.i - b.i).map(({ i, j }) => [i, j]));
    expect(candidates.some(({ i, j }) => i === 0 && j === 1)).toBe(true);
    expect(generateLatticeCandidates(square, fixed(basis), circle, 1200)).toEqual(candidates);
  });

  it("accepts a nonorthogonal, nontriangular oblique basis and runtime phase", () => {
    const tiling: GenericLatticeTiling = { type: "lattice", basis_deg: [[0.8, 0.3], [-0.2, 0.9]], origin: { type: "region_center" } };
    expect(0.8 * 0.9 - 0.3 * -0.2).toBeCloseTo(0.78, 12);
    expect(latticePoint(2, -1, tiling.basis_deg)).toMatchObject({ i: 2, j: -1, x_deg: 1.8 });
    expect(latticePoint(2, -1, tiling.basis_deg).y_deg).toBeCloseTo(-0.3, 12);
    const alignment = { projection_origin: anchor, phase_offset_deg: [0.12, -0.17] as TangentPlaneOffset };
    const sites = generateLatticeCandidates(square, tiling, circle, 1200, alignment);
    expect(sites.find(({ i, j }) => i === 0 && j === 0)).toMatchObject({ ra_deg: 150.12, dec_deg: -0.17 });
    expect(sites.map(({ i, j }) => [i, j])).toEqual([...sites].sort((a, b) => a.j - b.j || a.i - b.i).map(({ i, j }) => [i, j]));
    expect(generateLatticeCandidates(square, tiling, circle, 1200, alignment)).toEqual(sites);
  });

  it("uses a region-bounds midpoint as local phase but holds fixed anchors across regions", () => {
    const basis: GenericLatticeTiling["basis_deg"] = [[1, 0], [0, 1]];
    const local: GenericLatticeTiling = { type: "lattice", basis_deg: basis, origin: { type: "region_center" } };
    const shifted = { vertices: square.vertices.map(({ ra_deg, dec_deg }) => ({ ra_deg: ra_deg + 0.25, dec_deg: dec_deg + 0.125 })) };
    expect(latticePlanningOrigin(square, local)).toEqual(anchor);
    expect(latticePlanningOrigin(shifted, local)).toEqual({ ra_deg: 150.25, dec_deg: 0.125 });
    expect(generateLatticeCandidates(shifted, local, circle, 1200).find(({ i, j }) => i === 0 && j === 0)).toMatchObject({ ra_deg: 150.25, dec_deg: 0.125 });
    expect(generateLatticeCandidates(shifted, fixed(basis), circle, 1200).find(({ i, j }) => i === 0 && j === 0)).toMatchObject(anchor);
  });

  it.each([0, 30, -45, 70])("projects east/north at DEC %s using the anchor cosine and wraps RA", (dec) => {
    const origin = { ra_deg: 359.6, dec_deg: dec };
    const tiling = fixed([[0.6, 0], [0, 0.4]], origin);
    const region = polygonAround(359.6, dec, 1.1, 0.8);
    const sites = generateLatticeCandidates(region, tiling, circle, 1200);
    const east = sites.find(({ i, j }) => i === 1 && j === 0)!;
    const west = sites.find(({ i, j }) => i === -1 && j === 0)!;
    const north = sites.find(({ i, j }) => i === 0 && j === 1)!;
    expect(east.ra_deg).toBeCloseTo((359.6 + 0.6 / Math.cos(dec * Math.PI / 180)) % 360, 10);
    expect(west.ra_deg).toBeCloseTo((359.6 - 0.6 / Math.cos(dec * Math.PI / 180) + 360) % 360, 10);
    expect(north.dec_deg).toBeCloseTo(dec + 0.4, 10);
    expect(sites.map(({ i, j }) => [i, j])).toEqual([...sites].sort((a, b) => a.j - b.j || a.i - b.i).map(({ i, j }) => [i, j]));
    expect(generateLatticeCandidates(region, tiling, circle, 1200)).toEqual(sites);
  });
});

describe("v0.4 Gate 4 admissible sites and plans", () => {
  it.each([
    ["rectangle", square],
    ["slanted", { vertices: [
      { ra_deg: 149.3, dec_deg: -0.9 }, { ra_deg: 150.8, dec_deg: -0.45 },
      { ra_deg: 150.5, dec_deg: 0.8 }, { ra_deg: 149.1, dec_deg: 0.35 },
    ] }],
    ["thin between rows", polygonAround(150, 0.5, 0.85, 0.025)],
    ["subcell", polygonAround(150.45, 0.45, 0.04, 0.04)],
    ["RA wrap", polygonAround(359.8, 0, 0.85, 0.4)],
  ] as [string, SkyPolygon][])("enumerates every independently computed intersecting site for %s", (_name, region) => {
    const origin = _name === "RA wrap" ? { ra_deg: 359.8, dec_deg: 0 } : anchor;
    const tiling = fixed([[0.8, 0.2], [-0.25, 0.75]], origin);
    for (const footprint of shapes) {
      const expected: { i: number; j: number; ra_deg: number; dec_deg: number }[] = [];
      for (let j = -5; j <= 5; j += 1) for (let i = -5; i <= 5; i += 1) {
        const east = 0.8 * i - 0.25 * j;
        const north = 0.2 * i + 0.75 * j;
        const center = { ra_deg: (origin.ra_deg + east + 360) % 360, dec_deg: origin.dec_deg + north };
        if (footprintIntersectsRegion(footprint, center, region)) expected.push({ i, j, ...center });
      }
      const actual = generateLatticeCandidates(region, tiling, footprint, 1200);
      expect(actual.map(({ i, j }) => [i, j])).toEqual(expected.map(({ i, j }) => [i, j]));
      actual.forEach((site, index) => {
        expect(site.ra_deg).toBeCloseTo(expected[index].ra_deg, 10);
        expect(site.dec_deg).toBeCloseTo(expected[index].dec_deg, 10);
      });
      expect(generateLatticeCandidates(region, tiling, footprint, 1200)).toEqual(actual);
    }
  });

  it("crosses three footprints with orthogonal and triangular placements without coupling raw sites", () => {
    for (const basis of [[[0.75, 0], [0, 0.75]], [[0.75, 0], [0.375, Math.sqrt(3) * 0.375]]] as GenericLatticeTiling["basis_deg"][]) {
      const tiling = fixed(basis);
      const raw: LatticePoint[] = [];
      for (let j = -2; j <= 2; j += 1) for (let i = -2; i <= 2; i += 1) raw.push(latticePoint(i, j, basis));
      expect(raw).toHaveLength(25);
      for (const footprint of shapes) {
        const candidates = generateLatticeCandidates(square, tiling, footprint, 1200);
        expect(candidates.every(({ i, j, x_deg, y_deg }) => raw.some((point) =>
          point.i === i && point.j === j && point.x_deg === x_deg && point.y_deg === y_deg))).toBe(true);
        const registry = registryFor(footprint, tiling);
        const complete = planRegion(square, [], "gate4-survey", undefined, "complete", registry);
        const efficient = planRegion(square, [], "gate4-survey", undefined, "efficient", registry);
        expect(complete.candidate_centers.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]))
          .toEqual(candidates.map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]));
        expect(efficient.candidate_centers).toEqual(complete.candidate_centers);
        for (const plan of [complete, efficient]) {
          expect(plan.tiles.every((tile) => candidates.some(({ ra_deg, dec_deg }) => tile.ra_deg === ra_deg && tile.dec_deg === dec_deg))).toBe(true);
        }
        expect(planRegion(square, [], "gate4-survey", undefined, "complete", registry)).toEqual(complete);
      }
    }
  });

  it("retains centers outside a thin region when their footprints overlap it", () => {
    const region = polygonAround(150, 0.5, 0.2, 0.02);
    const sites = generateLatticeCandidates(region, fixed([[1, 0], [0, 1]]), { type: "circle", radius_deg: 0.55 }, 1200);
    expect(sites.map(({ i, j }) => [i, j])).toEqual([[0, 0], [0, 1]]);
    expect(sites.every(({ dec_deg }) => dec_deg < 0.48 || dec_deg > 0.52)).toBe(true);
  });

  it("reports residual coverage after consuming useful declared sites without off-lattice fill", () => {
    const tiling = fixed([[1, 0], [0, 1]]);
    const registry = registryFor({ type: "circle", radius_deg: 0.2 }, tiling);
    const complete = planRegion(square, [], "gate4-survey", undefined, "complete", registry);
    const efficient = planRegion(square, [], "gate4-survey", undefined, "efficient", registry);
    expect(complete.metrics.remaining_uncovered_fraction).toBeGreaterThan(0);
    expect(complete.diagnostics.some((line) => line.includes("declared lattice leaves sampled gaps"))).toBe(true);
    expect(efficient.candidate_centers).toEqual(complete.candidate_centers);
    for (const plan of [complete, efficient]) {
      expect(plan.tiles.every((tile) => plan.candidate_centers.some((center) => tile.ra_deg === center.ra_deg && tile.dec_deg === center.dec_deg))).toBe(true);
      expect(plan.diagnostics.some((line) => line.startsWith("Added "))).toBe(false);
    }
  });

  it("isolates historical supplemental fill to inline v1 RECT_GRID_V1", () => {
    const region = polygonAround(150, 75, 0.91 * Math.cos(75 * Math.PI / 180) / 2, 1.47 / 2);
    const inline = { ...DEFAULT_PROFILE, id: "custom", algorithm: "RECT_GRID_V1" as const,
      tile_width_deg: 0.4, tile_height_deg: 0.4, effective_overlap_arcsec: 0 };
    const v1 = planRegion(region, [], "custom", inline);
    expect(v1.diagnostics.some((line) => line.startsWith("Added 1 overlap-fill tile"))).toBe(true);
    expect(v1.tiles).toHaveLength(10);
    expect(v1.candidate_centers).toHaveLength(9);
    expect(v1.tiles.some((tile) => !v1.candidate_centers.some((center) => tile.ra_deg === center.ra_deg && tile.dec_deg === center.dec_deg))).toBe(true);

    const registered = createBundledProfileRegistry();
    registered.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "gate4-small-camera", footprint: { type: "rectangle", width_deg: 0.4, height_deg: 0.4 } });
    registered.registerSurveyProfile({ ...SPLUS_SURVEY_V2, id: "gate4-legacy", instrument_id: "gate4-small-camera",
      tiling: { type: "legacy_splus", grid_extent_deg: [0.4, 0.4], effective_overlap_arcsec: 0 },
      inference: { ...SPLUS_SURVEY_V2.inference, enabled: false } });
    const v2 = planRegion(region, [], "gate4-legacy", undefined, "complete", registered);
    expect(v2.diagnostics.some((line) => line.startsWith("Added "))).toBe(false);
    expect(v2.tiles.every((tile) => v2.candidate_centers.some((center) => tile.ra_deg === center.ra_deg && tile.dec_deg === center.dec_deg))).toBe(true);
    const generic = planRegion(region, [], "gate4-survey", undefined, "complete",
      registryFor({ type: "rectangle", width_deg: 0.4, height_deg: 0.4 }, fixed([[0.4, 0], [0, 0.4]], { ra_deg: 150, dec_deg: 75 })));
    expect(generic.diagnostics.some((line) => line.startsWith("Added "))).toBe(false);
    expect(generic.tiles.every((tile) => generic.candidate_centers.some((center) => tile.ra_deg === center.ra_deg && tile.dec_deg === center.dec_deg))).toBe(true);
  });
});
