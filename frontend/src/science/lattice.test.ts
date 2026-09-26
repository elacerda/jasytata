import { describe, expect, it } from "vitest";
import type { Footprint, GenericLatticeTiling, SkyPolygon } from "../types";
import { footprintIntersectsRegion, localOffsetToSky } from "./footprint-engine";
import { candidateLatticeRange, generateLatticeCandidates, latticePlanningOrigin, latticePoint } from "./lattice";

const region: SkyPolygon = { vertices: [
  { ra_deg: 148.9, dec_deg: -1.1 }, { ra_deg: 151.1, dec_deg: -1.1 },
  { ra_deg: 151.1, dec_deg: 1.1 }, { ra_deg: 148.9, dec_deg: 1.1 },
] };
const circle: Footprint = { type: "circle", radius_deg: 0.1 };
const axis: GenericLatticeTiling = { type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "region_center" } };
const generate = (tiling: GenericLatticeTiling, footprint: Footprint = circle, polygon = region) => generateLatticeCandidates(polygon, tiling, footprint, 1200);
const coordinates = (tiling: GenericLatticeTiling) => generate(tiling).map(({ i, j, x_deg, y_deg }) => [i, j, x_deg, y_deg]);

describe("Gate 4 pure declared lattice engine", () => {
  it("enumerates exact axis-aligned centers and integer coefficients in j/i order", () => {
    expect(coordinates(axis)).toEqual([
      [-1, -1, -1, -1], [0, -1, 0, -1], [1, -1, 1, -1],
      [-1, 0, -1, 0], [0, 0, 0, 0], [1, 0, 1, 0],
      [-1, 1, -1, 1], [0, 1, 0, 1], [1, 1, 1, 1],
    ]);
    expect(generate(axis).map(({ ra_deg, dec_deg }) => [ra_deg, dec_deg]))
      .toEqual([[149, -1], [150, -1], [151, -1], [149, 0], [150, 0], [151, 0], [149, 1], [150, 1], [151, 1]]);
  });

  it("rotates a rectangular lattice entirely through its basis vectors", () => {
    const angle = 25 * Math.PI / 180;
    const rotated: GenericLatticeTiling = { ...axis, basis_deg: [[Math.cos(angle), Math.sin(angle)], [-Math.sin(angle), Math.cos(angle)]] };
    expect(latticePoint(2, -1, rotated.basis_deg)).toEqual({
      i: 2, j: -1, x_deg: 2 * Math.cos(angle) + Math.sin(angle), y_deg: 2 * Math.sin(angle) - Math.cos(angle),
    });
    const quarterTurn: GenericLatticeTiling = { ...axis, basis_deg: [[0, 1], [-1, 0]] };
    expect(coordinates(quarterTurn)).toEqual([
      [-1, -1, 1, -1], [0, -1, 1, 0], [1, -1, 1, 1],
      [-1, 0, 0, -1], [0, 0, 0, 0], [1, 0, 0, 1],
      [-1, 1, -1, -1], [0, 1, -1, 0], [1, 1, -1, 1],
    ]);
    expect(generate(rotated)).toEqual(generate(rotated));
    for (const point of generate(rotated)) expect(point).toMatchObject(latticePoint(point.i, point.j, rotated.basis_deg));
  });

  it("expresses staggered centers with the same engine", () => {
    expect(coordinates({ ...axis, basis_deg: [[1, 0], [0.5, 1]] })).toEqual([
      [0, -1, -0.5, -1], [1, -1, 0.5, -1],
      [-1, 0, -1, 0], [0, 0, 0, 0], [1, 0, 1, 0],
      [-1, 1, -0.5, 1], [0, 1, 0.5, 1],
    ]);
  });

  it("generates a triangular/hexagonal-center lattice deterministically", () => {
    const h = Math.sqrt(3) / 2;
    const tiling: GenericLatticeTiling = { ...axis, basis_deg: [[1, 0], [0.5, h]] };
    expect(coordinates(tiling)).toEqual([
      [0, -1, -0.5, -h], [1, -1, 0.5, -h],
      [-1, 0, -1, 0], [0, 0, 0, 0], [1, 0, 1, 0],
      [-1, 1, -0.5, h], [0, 1, 0.5, h],
    ]);
    expect(generate(tiling)).toEqual(generate(tiling));
  });

  it("uses a reproducible region-bounds midpoint for phase, independent of vertex traversal", () => {
    expect(latticePlanningOrigin(region, axis)).toEqual({ ra_deg: 150, dec_deg: 0 });
    expect(generate(axis)).toEqual(generate(axis));
    const reordered = { vertices: [...region.vertices.slice(2), ...region.vertices.slice(0, 2)] };
    expect(generate(axis, circle, reordered)).toEqual(generate(axis));
  });

  it("shifts fixed-anchor phase predictably and reproduces the same anchor", () => {
    const fixed: GenericLatticeTiling = { ...axis, origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 } };
    const shifted: GenericLatticeTiling = { ...axis, origin: { type: "fixed_anchor", ra_deg: 150.25, dec_deg: 0 } };
    expect(generate(fixed)).toEqual(generate(fixed));
    const zero = (tiling: GenericLatticeTiling) => generate(tiling).find(({ i, j }) => i === 0 && j === 0)!;
    expect(zero(shifted).ra_deg - zero(fixed).ra_deg).toBe(0.25);
    expect(zero(shifted).x_deg).toBe(0);
    const larger = { vertices: region.vertices.map((point) => ({ ...point, ra_deg: point.ra_deg + 0.1 })) };
    const sameSite = generate(fixed, circle, larger).find(({ i, j }) => i === 1 && j === 0)!;
    expect(sameSite).toEqual(generate(fixed).find(({ i, j }) => i === 1 && j === 0));
  });

  it("wraps RA zero without changing integer ordering or phase", () => {
    const wrap: SkyPolygon = { vertices: [
      { ra_deg: 358.9, dec_deg: -1.1 }, { ra_deg: 1.1, dec_deg: -1.1 },
      { ra_deg: 1.1, dec_deg: 1.1 }, { ra_deg: 358.9, dec_deg: 1.1 },
    ] };
    expect(latticePlanningOrigin(wrap, axis)).toEqual({ ra_deg: 0, dec_deg: 0 });
    expect(generate(axis, circle, wrap).map(({ ra_deg }) => ra_deg)).toEqual([359, 0, 1, 359, 0, 1, 359, 0, 1]);
  });

  it("retains circle intersections and excludes bounding-box-only corner hits", () => {
    const corner: SkyPolygon = { vertices: [
      { ra_deg: 150.8, dec_deg: 0.8 }, { ra_deg: 150.9, dec_deg: 0.8 },
      { ra_deg: 150.9, dec_deg: 0.9 }, { ra_deg: 150.8, dec_deg: 0.9 },
    ] };
    const tiling: GenericLatticeTiling = { ...axis, basis_deg: [[5, 0], [0, 5]], origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 } };
    expect(generate(tiling, { type: "circle", radius_deg: 1 }, corner)).toEqual([]);
    expect(generate(tiling, { type: "rectangle", width_deg: 2, height_deg: 2 }, corner)).toHaveLength(1);
  });

  it("uses footprint offsets to retain mosaic centers outside the region", () => {
    const mosaic: Footprint = { type: "compound", components: [{ offset_deg: [2, 0], footprint: { type: "circle", radius_deg: 0.1 } }] };
    const result = generate(axis, mosaic);
    expect(result.map(({ i }) => i)).toEqual([-3, -2, -1, -3, -2, -1, -3, -2, -1]);
  });

  it("keeps footprint PA independent of axis-aligned lattice basis", () => {
    const camera: Footprint = { type: "rectangle", width_deg: 1.8, height_deg: 0.2, position_angle_deg: 30 };
    for (const candidate of generate(axis, camera)) {
      expect(candidate.x_deg).toBe(candidate.i);
      expect(candidate.y_deg).toBe(candidate.j);
      expect(footprintIntersectsRegion(camera, candidate, region)).toBe(true);
    }
  });

  it("bounds skewed negative-determinant candidates conservatively at high declination", () => {
    const high: SkyPolygon = { vertices: [
      { ra_deg: 149, dec_deg: 68 }, { ra_deg: 151, dec_deg: 68 },
      { ra_deg: 151, dec_deg: 72 }, { ra_deg: 149, dec_deg: 72 },
    ] };
    const tiling: GenericLatticeTiling = { ...axis, basis_deg: [[0.4, 0.2], [0.3, -0.6]] };
    const footprint: Footprint = { type: "rectangle", width_deg: 0.7, height_deg: 0.3, position_angle_deg: 40 };
    const origin = latticePlanningOrigin(high, tiling);
    const exhaustive = [];
    for (let j = -15; j <= 15; j += 1) for (let i = -15; i <= 15; i += 1) {
      const point = latticePoint(i, j, tiling.basis_deg);
      const [ra_deg, dec_deg] = localOffsetToSky(origin, [point.x_deg, point.y_deg]);
      const candidate = { ...point, ra_deg, dec_deg };
      if (footprintIntersectsRegion(footprint, candidate, high)) exhaustive.push(candidate);
    }
    expect(generate(tiling, footprint, high)).toEqual(exhaustive);
    const range = candidateLatticeRange(high, tiling.basis_deg, origin, footprint);
    expect(Object.values(range).every(Number.isSafeInteger)).toBe(true);
  });

  it("rejects excessive finite ranges before enumerating them", () => {
    expect(() => generate({ ...axis, basis_deg: [[0.000001, 0], [0, 0.000001]] })).toThrow(/search candidates/);
    expect(() => generate({ ...axis, basis_deg: [[1e-30, 0], [0, 1e-30]] })).toThrow(/safe integers/);
    expect(() => latticePoint(0.5, 0, axis.basis_deg)).toThrow(/safe integers/);
  });

  it("does not wrap padded remote lattice sites into duplicate ICRS centers", () => {
    expect(coordinates({ ...axis, basis_deg: [[360, 0], [0, 180]] })).toEqual([[0, 0, 0, 0]]);
  });

  it("rejects a distant fixed anchor whose RA branch cuts the selected region", () => {
    expect(() => generate({ ...axis, origin: { type: "fixed_anchor", ra_deg: 330, dec_deg: 0 } })).toThrow(/RA branch/);
  });
});
