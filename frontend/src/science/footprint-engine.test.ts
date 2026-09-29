import { describe, expect, it } from "vitest";
import { T80_SOUTH_INSTRUMENT_V2 } from "../profiles/v2";
import type { Footprint } from "../types";
import { tileFootprintBoundaries } from "../sky";
import {
  createFootprintContainmentTester,
  footprintArea,
  footprintBoundary,
  footprintCharacteristicScale,
  footprintContainsPoint,
  footprintIntersectsRegion,
  footprintLocalBounds,
  localOffsetToSky,
  rotateLocalOffset,
  skyToLocalOffset,
} from "./footprint-engine";

type Point = [number, number];

/**
 * Project a local east/north test offset with the documented linear tangent model.
 * Coordinates are degrees, and RA is normalized after dividing east by max(cos(DEC), 0.01).
 */
function skyPositionFromLocalReference(
  pointing: { ra_deg: number; dec_deg: number },
  [eastDeg, northDeg]: Point,
): Point {
  const cosine = Math.max(Math.cos(pointing.dec_deg * Math.PI / 180), 0.01);
  const rawRa = pointing.ra_deg + eastDeg / cosine;
  return [((rawRa % 360) + 360) % 360, pointing.dec_deg + northDeg];
}

/**
 * Build an ICRS region fixture from local east/north degree vertices using the
 * independent reference projection above; the closing vertex is implicit.
 */
function skyRegionFromLocalReference(
  pointing: { ra_deg: number; dec_deg: number },
  vertices: Point[],
): { vertices: Array<{ ra_deg: number; dec_deg: number }> } {
  return {
    vertices: vertices.map((point) => {
      const [ra_deg, dec_deg] = skyPositionFromLocalReference(pointing, point);
      return { ra_deg, dec_deg };
    }),
  };
}

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

  it("matches independent non-square rectangle geometry at 0, ±90, and 180 degree PA", () => {
    const expectedCases = [
      {
        angle: 0,
        vertices: [[-2, -1], [2, -1], [2, 1], [-2, 1]] as Point[],
        bounds: { min_east_deg: -2, max_east_deg: 2, min_north_deg: -1, max_north_deg: 1 },
      },
      {
        angle: 90,
        vertices: [[-1, 2], [-1, -2], [1, -2], [1, 2]] as Point[],
        bounds: { min_east_deg: -1, max_east_deg: 1, min_north_deg: -2, max_north_deg: 2 },
      },
      {
        angle: -90,
        vertices: [[1, -2], [1, 2], [-1, 2], [-1, -2]] as Point[],
        bounds: { min_east_deg: -1, max_east_deg: 1, min_north_deg: -2, max_north_deg: 2 },
      },
      {
        angle: 180,
        vertices: [[2, 1], [-2, 1], [-2, -1], [2, -1]] as Point[],
        bounds: { min_east_deg: -2, max_east_deg: 2, min_north_deg: -1, max_north_deg: 1 },
      },
    ];

    for (const expected of expectedCases) {
      const rectangle: Footprint = {
        type: "rectangle", width_deg: 4, height_deg: 2, position_angle_deg: expected.angle,
      };
      expect(footprintArea(rectangle)).toBe(8);
      expect(footprintLocalBounds(rectangle)).toEqual(expected.bounds);
      expect(footprintBoundary(rectangle)[0]).toEqual([...expected.vertices, expected.vertices[0]]);
      for (const vertex of expected.vertices) expect(footprintContainsPoint(rectangle, vertex)).toBe(true);
    }

    const rectangle: Footprint = { type: "rectangle", width_deg: 4, height_deg: 2 };
    const tester = createFootprintContainmentTester(rectangle);
    expect(tester(0, 0)).toBe(true);
    expect(tester(2, 0)).toBe(true);
    expect(tester(0, 1)).toBe(true);
    expect(tester(2, 1)).toBe(true);
    expect(tester(2.000001, 0)).toBe(false);
    expect(tester(0, 1.000001)).toBe(false);
    expect(footprintCharacteristicScale(rectangle)).toBe(2);
    expect(rotateLocalOffset([0, 1], 90)).toEqual([1, 0]);
    expect(rotateLocalOffset([0, 1], -90)).toEqual([-1, 0]);

    const pointing = { ra_deg: 0, dec_deg: 0 };
    expect(footprintIntersectsRegion(rectangle, pointing, skyRegionFromLocalReference(pointing, [
      [1.5, -0.5], [3, -0.5], [3, 0.5], [1.5, 0.5],
    ]))).toBe(true);
    expect(footprintIntersectsRegion(rectangle, pointing, skyRegionFromLocalReference(pointing, [
      [2, -0.5], [3, -0.5], [3, 0.5], [2, 0.5],
    ]))).toBe(false);
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
    expect(boundary).toHaveLength(101);
    expect(boundary).toEqual(footprintBoundary(circle)[0]);
    expect(boundary).toContainEqual([0.2, 0]);
    expect(boundary).toContainEqual([0, 0.2]);
    expect(boundary).toContainEqual([-0.2, 0]);
    expect(boundary).toContainEqual([0, -0.2]);
    expect(Math.hypot(...boundary[0])).toBeGreaterThan(0.2);
    expect(footprintContainsPoint(circle, boundary[0])).toBe(false);
    expect(footprintLocalBounds(circle)).toEqual({
      min_east_deg: -0.2, max_east_deg: 0.2, min_north_deg: -0.2, max_north_deg: 0.2,
    });
    const renderedOnSky = tileFootprintBoundaries({ ra_deg: 359.99, dec_deg: 60 }, circle)[0]
      .map(([ra_deg, dec_deg]) => skyToLocalOffset({ ra_deg, dec_deg }, { ra_deg: 359.99, dec_deg: 60 }));
    expect(Math.min(...renderedOnSky.map(([east]) => east))).toBeCloseTo(-0.2, 12);
    expect(Math.max(...renderedOnSky.map(([east]) => east))).toBeCloseTo(0.2, 12);
    expect(Math.min(...renderedOnSky.map(([, north]) => north))).toBeCloseTo(-0.2, 12);
    expect(Math.max(...renderedOnSky.map(([, north]) => north))).toBeCloseTo(0.2, 12);
  });

  it("renders a deterministic tangent circle polygon while keeping science analytic", () => {
    const circle: Footprint = { type: "circle", radius_deg: 2 };
    const boundary = footprintBoundary(circle, 12)[0];
    expect(boundary).toHaveLength(17);
    expect(boundary).toEqual(footprintBoundary(circle, 12)[0]);
    expect(boundary).toContainEqual([2, 0]);
    expect(boundary).toContainEqual([0, 2]);
    expect(boundary).toContainEqual([-2, 0]);
    expect(boundary).toContainEqual([0, -2]);
    expect(footprintArea(circle)).toBe(4 * Math.PI);
    expect(footprintContainsPoint(circle, [0, 0])).toBe(true);
    expect(footprintContainsPoint(circle, [1.2, 1.6])).toBe(true);
    expect(footprintContainsPoint(circle, [2, 0])).toBe(true);
    expect(footprintContainsPoint(circle, [2.000001, 0])).toBe(false);

    for (let index = 0; index < boundary.length - 1; index += 1) {
      const start = boundary[index];
      const end = boundary[index + 1];
      const edgeEast = end[0] - start[0];
      const edgeNorth = end[1] - start[1];
      const edgeLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const distanceToSupportingLine = Math.abs(start[0] * end[1] - end[0] * start[1]) / edgeLength;
      expect(distanceToSupportingLine).toBeCloseTo(2, 12);
      expect(edgeEast * -start[1] - edgeNorth * -start[0]).toBeGreaterThan(0);
    }
    expect(Math.min(...boundary.slice(0, -1).map(([east, north]) => Math.hypot(east, north))))
      .toBeCloseTo(2, 14);

    const tangentRegion = skyRegionFromLocalReference({ ra_deg: 0, dec_deg: 0 }, [
      [1, -0.25], [1.5, -0.25], [1.5, 0.25], [1, 0.25],
    ]);
    const overlappingRegion = skyRegionFromLocalReference({ ra_deg: 0, dec_deg: 0 }, [
      [0.999, -0.25], [1.5, -0.25], [1.5, 0.25], [0.999, 0.25],
    ]);
    expect(footprintIntersectsRegion({ type: "circle", radius_deg: 1 }, { ra_deg: 0, dec_deg: 0 }, tangentRegion)).toBe(false);
    expect(footprintIntersectsRegion({ type: "circle", radius_deg: 1 }, { ra_deg: 0, dec_deg: 0 }, overlappingRegion)).toBe(true);

    // This small region encloses a rendered tangent-polygon vertex but remains outside the analytic unit circle.
    const halfStep = Math.PI / 96;
    const displayVertex = [1, Math.tan(halfStep)] as const;
    const displayOnlyRegion = skyRegionFromLocalReference({ ra_deg: 0, dec_deg: 0 }, [
      [displayVertex[0] - 0.0001, displayVertex[1] - 0.0001],
      [displayVertex[0] + 0.0001, displayVertex[1] - 0.0001],
      [displayVertex[0] + 0.0001, displayVertex[1] + 0.0001],
      [displayVertex[0] - 0.0001, displayVertex[1] + 0.0001],
    ]);
    expect(Math.hypot(...displayVertex)).toBeGreaterThan(1);
    expect(footprintIntersectsRegion({ type: "circle", radius_deg: 1 }, { ra_deg: 0, dec_deg: 0 }, displayOnlyRegion)).toBe(false);
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

  it("uses independent shoelace expectations for clockwise, counter-clockwise, and concave polygons", () => {
    const concave: Point[] = [
      [-2, -2], [-1, -2], [-1, -1], [1, -1], [1, -2], [2, -2], [2, 2], [-2, 2],
    ];
    const counterClockwise: Footprint = { type: "polygon", vertices_deg: concave };
    const clockwise: Footprint = { type: "polygon", vertices_deg: [...concave].reverse() };
    // The shape is a 4-by-4 square with a 2-by-1 rectangular notch removed: 16 - 2 = 14 square degrees.
    expect(footprintArea(counterClockwise)).toBe(14);
    expect(footprintArea(clockwise)).toBe(14);
    expect(footprintContainsPoint(counterClockwise, [0, 0])).toBe(true);
    expect(footprintContainsPoint(counterClockwise, [0, -1])).toBe(true);
    expect(footprintContainsPoint(counterClockwise, [1, -1])).toBe(true);
    expect(footprintContainsPoint(counterClockwise, [0, -1.000001])).toBe(false);
    expect(footprintContainsPoint(counterClockwise, [2.000001, 0])).toBe(false);
    expect(footprintBoundary(counterClockwise)[0]).toEqual([...concave, concave[0]]);
    expect(footprintLocalBounds(counterClockwise)).toEqual({
      min_east_deg: -2, max_east_deg: 2, min_north_deg: -2, max_north_deg: 2,
    });
    expect(footprintArea({
      type: "polygon", vertices_deg: [[-2, -1], [2, -1], [2, 1], [-2, 1]], position_angle_deg: 90,
    })).toBe(8);
    expect(footprintLocalBounds({
      type: "polygon", vertices_deg: [[-2, -1], [2, -1], [2, 1], [-2, 1]], position_angle_deg: 90,
    })).toEqual({ min_east_deg: -1, max_east_deg: 1, min_north_deg: -2, max_north_deg: 2 });

    const pointing = { ra_deg: 0, dec_deg: 0 };
    const polygon: Footprint = { type: "polygon", vertices_deg: concave };
    expect(footprintIntersectsRegion(polygon, pointing, skyRegionFromLocalReference(pointing, [
      [1.9, -0.5], [2.5, -0.5], [2.5, 0.5], [1.9, 0.5],
    ]))).toBe(true);
    expect(footprintIntersectsRegion(polygon, pointing, skyRegionFromLocalReference(pointing, [
      [2, -0.5], [2.5, -0.5], [2.5, 0.5], [2, 0.5],
    ]))).toBe(false);
  });

  it("represents regular hexagons as ordinary polygons in two geometric orientations", () => {
    const radius = 2;
    const halfFlat = Math.sqrt(3);
    const vertexOnNorth: Point[] = [
      [0, radius], [halfFlat, 1], [halfFlat, -1], [0, -radius], [-halfFlat, -1], [-halfFlat, 1],
    ];
    const flatOnNorth: Point[] = [
      [1, halfFlat], [radius, 0], [1, -halfFlat], [-1, -halfFlat], [-radius, 0], [-1, halfFlat],
    ];

    for (const vertices of [vertexOnNorth, flatOnNorth]) {
      const hexagon: Footprint = { type: "polygon", vertices_deg: vertices };
      expect(hexagon.type).toBe("polygon");
      expect(footprintArea(hexagon)).toBeCloseTo(3 * Math.sqrt(3) * radius ** 2 / 2, 13);
      expect(footprintCharacteristicScale(hexagon)).toBeCloseTo(2 * halfFlat, 14);
      expect(footprintContainsPoint(hexagon, [0, 0])).toBe(true);
      expect(footprintBoundary(hexagon)[0]).toEqual([...vertices, vertices[0]]);
      for (let index = 0; index < 6; index += 1) {
        const vertex = vertices[index];
        const opposite = vertices[(index + 3) % 6];
        const next = vertices[(index + 1) % 6];
        expect(Math.hypot(vertex[0], vertex[1])).toBeCloseTo(radius, 14);
        expect(vertex[0] + opposite[0]).toBeCloseTo(0, 14);
        expect(vertex[1] + opposite[1]).toBeCloseTo(0, 14);
        expect(Math.hypot(next[0] - vertex[0], next[1] - vertex[1])).toBeCloseTo(radius, 14);
        expect(footprintContainsPoint(hexagon, vertex)).toBe(true);
      }
      expect(footprintLocalBounds(hexagon)).toEqual(vertices === vertexOnNorth
        ? { min_east_deg: -halfFlat, max_east_deg: halfFlat, min_north_deg: -radius, max_north_deg: radius }
        : { min_east_deg: -radius, max_east_deg: radius, min_north_deg: -halfFlat, max_north_deg: halfFlat });
      const bounds = footprintLocalBounds(hexagon);
      const extents = [
        bounds.max_east_deg - bounds.min_east_deg,
        bounds.max_north_deg - bounds.min_north_deg,
      ].sort((first, second) => first - second);
      expect(extents[0]).toBeCloseTo(2 * halfFlat, 14);
      expect(extents[1]).toBeCloseTo(2 * radius, 14);
    }

    const hexagon: Footprint = { type: "polygon", vertices_deg: vertexOnNorth };
    expect(footprintContainsPoint(hexagon, [halfFlat, 0])).toBe(true);
    expect(footprintContainsPoint({ type: "polygon", vertices_deg: flatOnNorth }, [0, halfFlat])).toBe(true);
    expect(footprintContainsPoint(hexagon, [halfFlat + 0.000001, 0])).toBe(false);
    expect(footprintContainsPoint(hexagon, [0, radius + 0.000001])).toBe(false);
    const rotatedBoundary = footprintBoundary({ ...hexagon, position_angle_deg: 30 })[0];
    const expectedRotatedVertices: Point[] = [
      [1, halfFlat], [2, 0], [1, -halfFlat], [-1, -halfFlat], [-2, 0], [-1, halfFlat], [1, halfFlat],
    ];
    expect(rotatedBoundary).toHaveLength(expectedRotatedVertices.length);
    for (let index = 0; index < expectedRotatedVertices.length; index += 1) {
      expect(rotatedBoundary[index][0]).toBeCloseTo(expectedRotatedVertices[index][0], 14);
      expect(rotatedBoundary[index][1]).toBeCloseTo(expectedRotatedVertices[index][1], 14);
    }
    const rotatedBounds = footprintLocalBounds({ ...hexagon, position_angle_deg: 30 });
    expect(rotatedBounds.min_east_deg).toBeCloseTo(-2, 14);
    expect(rotatedBounds.max_east_deg).toBeCloseTo(2, 14);
    expect(rotatedBounds.min_north_deg).toBeCloseTo(-halfFlat, 14);
    expect(rotatedBounds.max_north_deg).toBeCloseTo(halfFlat, 14);

    const pointing = { ra_deg: 0, dec_deg: 0 };
    expect(footprintIntersectsRegion(hexagon, pointing, skyRegionFromLocalReference(pointing, [
      [halfFlat, -0.5], [3, -0.5], [3, 0.5], [halfFlat, 0.5],
    ]))).toBe(false);
    expect(footprintIntersectsRegion(hexagon, pointing, skyRegionFromLocalReference(pointing, [
      [halfFlat - 0.000001, -0.5], [3, -0.5], [3, 0.5], [halfFlat - 0.000001, 0.5],
    ]))).toBe(true);
  });

  it("maps the sourced PFS circumscribed-circle diameter to a nominal polygon envelope", () => {
    // Official source: https://pfs.naoj.org/research/parameters.html
    // Its approximate 1.38 degree circumscribed-circle diameter means R = 0.69 degree.
    const circumscribedDiameterDeg = 1.38;
    const circumradiusDeg = circumscribedDiameterDeg / 2;
    const halfSideDeg = circumradiusDeg * Math.sqrt(3) / 2;
    const vertices: Point[] = [
      [0, circumradiusDeg], [halfSideDeg, circumradiusDeg / 2],
      [halfSideDeg, -circumradiusDeg / 2], [0, -circumradiusDeg],
      [-halfSideDeg, -circumradiusDeg / 2], [-halfSideDeg, circumradiusDeg / 2],
    ];
    const targetAccessEnvelope: Footprint = { type: "polygon", vertices_deg: vertices };

    expect(targetAccessEnvelope.type).toBe("polygon");
    expect(footprintArea(targetAccessEnvelope)).toBeCloseTo(
      3 * Math.sqrt(3) * circumradiusDeg ** 2 / 2,
      14,
    );
    expect(Math.abs(footprintArea(targetAccessEnvelope) - 1.25)).toBeLessThan(0.02);
    expect(2 * circumradiusDeg).toBe(1.38);
    expect(Math.sqrt(3) * circumradiusDeg).toBeCloseTo(1.195, 3);
    expect(footprintContainsPoint(targetAccessEnvelope, [0, 0])).toBe(true);
    for (const vertex of vertices) expect(footprintContainsPoint(targetAccessEnvelope, vertex)).toBe(true);
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

  it("keeps disjoint compound children and overlapping duplicates in their geometric union", () => {
    const mosaic: Footprint = {
      type: "compound",
      position_angle_deg: 90,
      components: [
        {
          offset_deg: [2, 0], rotation_deg: 90,
          footprint: { type: "rectangle", width_deg: 4, height_deg: 1 },
        },
        {
          offset_deg: [-2, 0], rotation_deg: -90,
          footprint: { type: "rectangle", width_deg: 2, height_deg: 1 },
        },
      ],
    };
    const boundaries = footprintBoundary(mosaic);
    expect(boundaries).toEqual([
      [[2, -1.5], [-2, -1.5], [-2, -2.5], [2, -2.5], [2, -1.5]],
      [[-1, 1.5], [1, 1.5], [1, 2.5], [-1, 2.5], [-1, 1.5]],
    ]);
    expect(footprintContainsPoint(mosaic, [0, -2])).toBe(true);
    expect(footprintContainsPoint(mosaic, [0, 2])).toBe(true);
    expect(footprintContainsPoint(mosaic, [0, 0])).toBe(false);
    expect(footprintArea(mosaic)).toBeCloseTo(6, 1);

    const duplicate: Footprint = {
      type: "compound",
      components: [
        { offset_deg: [0, 0], footprint: { type: "rectangle", width_deg: 2, height_deg: 2 } },
        { offset_deg: [0, 0], footprint: { type: "rectangle", width_deg: 2, height_deg: 2 } },
      ],
    };
    expect(footprintArea(duplicate)).toBeCloseTo(4, 10);
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

  it("round-trips the documented tangent projection at wrapped RA and varied declinations", () => {
    const cases = [
      { pointing: { ra_deg: 359.99, dec_deg: 30 }, offset: [0.1, 0.2] as Point },
      { pointing: { ra_deg: 0.02, dec_deg: -45 }, offset: [-0.1, -0.2] as Point },
      { pointing: { ra_deg: 210, dec_deg: 65 }, offset: [0.15, -0.25] as Point },
      { pointing: { ra_deg: 10, dec_deg: -60 }, offset: [-0.2, 0.25] as Point },
    ];

    for (const { pointing, offset } of cases) {
      const expectedSky = skyPositionFromLocalReference(pointing, offset);
      const actualSky = localOffsetToSky(pointing, offset);
      expect(actualSky[0]).toBeCloseTo(expectedSky[0], 13);
      expect(actualSky[1]).toBe(expectedSky[1]);
      const recovered = skyToLocalOffset({ ra_deg: actualSky[0], dec_deg: actualSky[1] }, pointing);
      expect(recovered[0]).toBeCloseTo(offset[0], 12);
      expect(recovered[1]).toBeCloseTo(offset[1], 12);
    }

    const pointing = { ra_deg: 0.2, dec_deg: 30 };
    const rotatedRectangle: Footprint = {
      type: "rectangle", width_deg: 4, height_deg: 2, position_angle_deg: 90,
    };
    const firstLocalCorner: Point = [-1, 2];
    const expectedCorner = skyPositionFromLocalReference(pointing, firstLocalCorner);
    const renderedCorner = tileFootprintBoundaries(pointing, rotatedRectangle)[0][0];
    expect(renderedCorner[0]).toBeCloseTo(expectedCorner[0], 13);
    expect(renderedCorner[1]).toBe(expectedCorner[1]);
    expect(renderedCorner[0]).toBeGreaterThan(350);

    const smallRectangle: Footprint = { type: "rectangle", width_deg: 0.4, height_deg: 0.2 };
    for (const wrapPointing of [
      { ra_deg: 0.02, dec_deg: 30 },
      { ra_deg: 359.98, dec_deg: -45 },
    ]) {
      const wrapRegion = skyRegionFromLocalReference(wrapPointing, [
        [-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05],
      ]);
      expect(wrapRegion.vertices.some(({ ra_deg }) => ra_deg > 359)).toBe(true);
      expect(wrapRegion.vertices.some(({ ra_deg }) => ra_deg < 1)).toBe(true);
      expect(footprintIntersectsRegion(smallRectangle, wrapPointing, wrapRegion)).toBe(true);

      const touchRegion = skyRegionFromLocalReference(wrapPointing, [
        [0.2, -0.05], [0.4, -0.05], [0.4, 0.05], [0.2, 0.05],
      ]);
      expect(footprintIntersectsRegion(smallRectangle, wrapPointing, touchRegion)).toBe(false);
    }
  });
});
