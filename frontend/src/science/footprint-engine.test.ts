import { describe, expect, it } from "vitest";
import { T80_SOUTH_INSTRUMENT_V2 } from "../profiles/v2";
import type { Footprint } from "../types";
import { tileFootprintBoundaries } from "../sky";
import {
  footprintArea,
  footprintBoundary,
  footprintContainsPoint,
  footprintIntersectsRegion,
  footprintLocalBounds,
  rotateLocalOffset,
  skyToLocalOffset,
} from "./footprint-engine";

describe("generic local footprint geometry", () => {
  it("preserves axis-aligned T80 rectangle containment and PA-zero boundaries", () => {
    const footprint = T80_SOUTH_INSTRUMENT_V2.footprint;
    expect(footprint).toEqual({ type: "rectangle", width_deg: 1.4, height_deg: 1.4 });
    expect(footprintContainsPoint(footprint, [0, 0])).toBe(true);
    expect(footprintContainsPoint(footprint, [0.7, -0.7])).toBe(true);
    expect(footprintContainsPoint(footprint, [0.700001, 0])).toBe(false);
    expect(footprintArea(footprint)).toBeCloseTo(1.96, 14);
    expect(footprintBoundary(footprint)[0]).toEqual([
      [-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7], [-0.7, -0.7],
    ]);
  });

  it("rotates rectangles with positive PA from north toward east", () => {
    const footprint: Footprint = { type: "rectangle", width_deg: 0.8, height_deg: 0.2, position_angle_deg: 90 };
    expect(footprintContainsPoint(footprint, [0, 0.3])).toBe(true);
    expect(footprintContainsPoint(footprint, [0.3, 0])).toBe(false);
    expect(rotateLocalOffset([0, 1], 90)).toEqual([1, 0]);
    expect(footprintArea(footprint)).toBeCloseTo(0.16, 14);
    for (const point of footprintBoundary(footprint)[0]) expect(footprintContainsPoint(footprint, point)).toBe(true);
  });

  it("uses exact circle containment, analytic area, and rotation-invariant distance", () => {
    const circle: Footprint = { type: "circle", radius_deg: 0.2 };
    const point: [number, number] = [0.12, 0.16];
    expect(footprintContainsPoint(circle, [0, 0])).toBe(true);
    expect(footprintContainsPoint(circle, point)).toBe(true);
    expect(footprintContainsPoint(circle, [0.2, 0])).toBe(true);
    expect(footprintContainsPoint(circle, [0.200001, 0])).toBe(false);
    expect(footprintContainsPoint(circle, rotateLocalOffset(point, 73))).toBe(true);
    expect(footprintArea(circle)).toBeCloseTo(Math.PI * 0.04, 14);
    const boundary = footprintBoundary(circle)[0];
    expect(boundary).toHaveLength(97);
    for (const pointOnBoundary of boundary) expect(footprintContainsPoint(circle, pointOnBoundary)).toBe(true);
  });

  it("preserves polygon order and counts edges and vertices as inside", () => {
    const vertices: Array<[number, number]> = [[-1, -0.25], [1, -0.25], [1, 0.25], [-1, 0.25]];
    const polygon: Footprint = { type: "polygon", vertices_deg: vertices };
    expect(footprintContainsPoint(polygon, [0, 0])).toBe(true);
    expect(footprintContainsPoint(polygon, [1, 0.25])).toBe(true);
    expect(footprintContainsPoint(polygon, [1.01, 0])).toBe(false);
    expect(footprintArea(polygon)).toBe(1);
    expect(footprintArea({ type: "polygon", vertices_deg: [...vertices].reverse() })).toBe(1);
    expect(footprintBoundary(polygon)[0]).toEqual([...vertices, vertices[0]]);
  });

  it("rotates polygon containment and projects its boundary across RA zero", () => {
    const polygon: Footprint = {
      type: "polygon",
      vertices_deg: [[-1, -0.25], [1, -0.25], [1, 0.25], [-1, 0.25]],
      position_angle_deg: 90,
    };
    expect(footprintContainsPoint(polygon, [0, 0.8])).toBe(true);
    expect(footprintContainsPoint(polygon, [0.8, 0])).toBe(false);

    const center = { ra_deg: 359.99, dec_deg: 30 };
    const boundary = tileFootprintBoundaries(center, polygon)[0];
    expect(boundary).toHaveLength(5);
    expect(boundary.some(([ra]) => ra < 1)).toBe(true);
    for (const skyPoint of boundary) {
      expect(footprintContainsPoint(polygon, skyToLocalOffset(
        { ra_deg: skyPoint[0], dec_deg: skyPoint[1] },
        center,
      ))).toBe(true);
    }
  });

  it("keeps mosaic detector gaps and composes parent and child rotations", () => {
    const mosaic: Footprint = {
      type: "compound",
      position_angle_deg: 90,
      components: [
        {
          offset_deg: [0.5, 0],
          rotation_deg: 90,
          footprint: { type: "rectangle", width_deg: 0.8, height_deg: 0.2 },
        },
        {
          offset_deg: [-0.5, 0],
          footprint: { type: "rectangle", width_deg: 0.4, height_deg: 0.2 },
        },
      ],
    };
    expect(footprintContainsPoint(mosaic, [0, -0.5])).toBe(true);
    expect(footprintContainsPoint(mosaic, [0.3, -0.5])).toBe(true);
    expect(footprintContainsPoint(mosaic, [0, 0])).toBe(false);
    const paths = footprintBoundary(mosaic);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      for (const point of path) expect(footprintContainsPoint(mosaic, point)).toBe(true);
    }
  });

  it("measures overlapping mosaic children as a union rather than a sum", () => {
    const mosaic: Footprint = {
      type: "compound",
      components: [
        { offset_deg: [0, 0], footprint: { type: "rectangle", width_deg: 1, height_deg: 1 } },
        { offset_deg: [0.5, 0], footprint: { type: "rectangle", width_deg: 1, height_deg: 1 } },
      ],
    };
    expect(footprintArea(mosaic)).toBeCloseTo(1.5, 3);
    expect(footprintArea(mosaic)).toBeLessThan(2);
  });

  it("returns conservative local bounds for rotated and compound component boundaries", () => {
    const footprints: Footprint[] = [
      { type: "rectangle", width_deg: 1, height_deg: 0.4, position_angle_deg: 37 },
      { type: "circle", radius_deg: 0.3 },
      { type: "polygon", vertices_deg: [[-0.5, -0.2], [0.7, -0.1], [0.3, 0.6]], position_angle_deg: -21 },
      {
        type: "compound",
        position_angle_deg: 12,
        components: [
          { offset_deg: [-0.6, 0], rotation_deg: 25, footprint: { type: "rectangle", width_deg: 0.5, height_deg: 0.2 } },
          { offset_deg: [0.6, 0], footprint: { type: "circle", radius_deg: 0.2 } },
        ],
      },
    ];
    for (const footprint of footprints) {
      const bounds = footprintLocalBounds(footprint);
      for (const path of footprintBoundary(footprint)) {
        for (const [east, north] of path) {
          expect(east).toBeGreaterThanOrEqual(bounds.min_east_deg - 1e-12);
          expect(east).toBeLessThanOrEqual(bounds.max_east_deg + 1e-12);
          expect(north).toBeGreaterThanOrEqual(bounds.min_north_deg - 1e-12);
          expect(north).toBeLessThanOrEqual(bounds.max_north_deg + 1e-12);
        }
      }
    }
  });

  it("uses shared footprint semantics for region intersection near RA zero", () => {
    const circle: Footprint = { type: "circle", radius_deg: 0.1 };
    const region = { vertices: [
      { ra_deg: 359.95, dec_deg: -0.05 },
      { ra_deg: 0.05, dec_deg: -0.05 },
      { ra_deg: 0.05, dec_deg: 0.05 },
      { ra_deg: 359.95, dec_deg: 0.05 },
    ] };
    expect(footprintIntersectsRegion(circle, { ra_deg: 0, dec_deg: 0 }, region)).toBe(true);
    expect(footprintIntersectsRegion(circle, { ra_deg: 0.3, dec_deg: 0 }, region)).toBe(false);
  });
});
