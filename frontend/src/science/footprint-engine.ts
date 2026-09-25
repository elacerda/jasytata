import type {
  CenterInput,
  Footprint,
  NonCompoundFootprint,
  SkyPolygon,
  TangentPlaneOffset,
} from "../types";
import { modulo, radians, wrappedRaDelta } from "./math";

/** Local east/north point in tangent-plane degrees. */
export type LocalFootprintPoint = TangentPlaneOffset;

/** One closed local boundary, in east/north degrees. */
export type LocalFootprintBoundary = LocalFootprintPoint[];

interface PrimitiveFootprint {
  footprint: NonCompoundFootprint;
  center: LocalFootprintPoint;
  positionAngleDeg: number;
}

interface Bounds {
  minEast: number;
  maxEast: number;
  minNorth: number;
  maxNorth: number;
}

/** Axis-aligned local bounds enclosing a footprint's physical components. */
export interface FootprintLocalBounds {
  min_east_deg: number;
  max_east_deg: number;
  min_north_deg: number;
  max_north_deg: number;
}

const GEOMETRY_EPSILON = 1e-12;
const DEFAULT_CIRCLE_SEGMENTS = 96;
const COMPOUND_AREA_MAX_DEPTH = 12;

/** Rotate a local offset using astronomical PA: zero is north, positive is eastward.
 *
 * A positive quarter turn maps intrinsic north to east. The returned tuple is
 * still `[east, north]` in degrees.
 *
 * @param point - Local east/north offset in degrees.
 * @param positionAngleDeg - Position angle in degrees east of north.
 * @returns Rotated local east/north offset in degrees.
 */
export function rotateLocalOffset(point: LocalFootprintPoint, positionAngleDeg: number): LocalFootprintPoint {
  const angle = normalizedAngle(positionAngleDeg);
  if (angle === 0) return [point[0], point[1]];
  const angleRad = radians(angle);
  let cosine = Math.cos(angleRad);
  let sine = Math.sin(angleRad);
  if (Math.abs(cosine) < 1e-15) cosine = 0;
  if (Math.abs(sine) < 1e-15) sine = 0;
  return [point[0] * cosine + point[1] * sine, point[1] * cosine - point[0] * sine];
}

/** Test a local point against a Schema v2 footprint, including its boundary.
 *
 * Polygon edges and vertices count as inside. Compound footprints use the
 * union of child detector footprints, so empty gaps remain uncovered.
 *
 * @param footprint - Validated Schema v2 footprint centered on `(0, 0)`.
 * @param point - Local east/north offset from the pointing center, in degrees.
 * @returns Whether the point lies inside at least one physical component.
 */
export function footprintContainsPoint(footprint: Footprint, point: LocalFootprintPoint): boolean {
  return createFootprintContainmentTester(footprint)(point[0], point[1]);
}

/** Create a reusable scalar containment predicate for repeated local samples.
 *
 * This compiles component transforms once and avoids allocating a point tuple
 * for every coverage-grid cell. The returned predicate has the same inclusive
 * boundaries and compound-union semantics as {@link footprintContainsPoint}.
 *
 * @param footprint - Validated Schema v2 footprint centered on `(0, 0)`.
 * @returns Predicate accepting east and north offsets in degrees.
 */
export function createFootprintContainmentTester(
  footprint: Footprint,
): (eastDeg: number, northDeg: number) => boolean {
  if (footprint.type !== "compound") {
    const angle = "position_angle_deg" in footprint ? footprint.position_angle_deg ?? 0 : 0;
    return createShapeContainmentTester(footprint, angle, true);
  }
  const primitives = flattenFootprint(footprint);
  const componentTesters = primitives.map((primitive) => {
    const testShape = createShapeContainmentTester(primitive.footprint, primitive.positionAngleDeg, true);
    return (eastDeg: number, northDeg: number) => testShape(
      eastDeg - primitive.center[0],
      northDeg - primitive.center[1],
    );
  });
  return (eastDeg, northDeg) => componentTesters.some((test) => test(eastDeg, northDeg));
}

/** Generate closed local boundary paths for rendering each physical component.
 *
 * Circles use a deterministic display-only polygon with at least 12 segments;
 * containment and area remain analytic and do not use this sampling.
 *
 * @param footprint - Validated Schema v2 footprint centered on `(0, 0)`.
 * @param circleSegments - Requested circle display sampling; rounded down to a
 *   multiple of four so the cardinal extrema are included.
 * @returns One closed `[east, north]` boundary path per detector component.
 */
export function footprintBoundary(
  footprint: Footprint,
  circleSegments = DEFAULT_CIRCLE_SEGMENTS,
): LocalFootprintBoundary[] {
  const segments = Math.max(12, Math.floor(circleSegments / 4) * 4);
  return flattenFootprint(footprint).map((primitive) => primitiveBoundary(primitive, segments));
}

/** Calculate physical local-plane area in square degrees.
 *
 * Rectangles, circles, and simple polygons use their analytic area. A compound
 * footprint uses deterministic adaptive integration of the union, which avoids
 * double-counting overlapping detectors and has a boundary-cell resolution of
 * 1/4096 of its local bounding-box scale.
 *
 * @param footprint - Validated Schema v2 footprint centered on `(0, 0)`.
 * @returns Physical footprint area in square degrees.
 */
export function footprintArea(footprint: Footprint): number {
  if (footprint.type === "rectangle") return footprint.width_deg * footprint.height_deg;
  if (footprint.type === "circle") return Math.PI * footprint.radius_deg ** 2;
  if (footprint.type === "polygon") return Math.abs(signedPolygonArea(footprint.vertices_deg));
  return compoundUnionArea(flattenFootprint(footprint));
}

/** Enclose every physical footprint component in its intrinsic local plane.
 *
 * @param footprint - Validated Schema v2 footprint centered on `(0, 0)`.
 * @returns Conservative east/north bounds in degrees, including rotation and offsets.
 */
export function footprintLocalBounds(footprint: Footprint): FootprintLocalBounds {
  const bounds: Bounds = {
    minEast: Number.POSITIVE_INFINITY,
    maxEast: Number.NEGATIVE_INFINITY,
    minNorth: Number.POSITIVE_INFINITY,
    maxNorth: Number.NEGATIVE_INFINITY,
  };
  for (const primitive of flattenFootprint(footprint)) {
    const shape = primitive.footprint;
    if (shape.type === "circle") {
      extendBounds(bounds, primitive.center[0] - shape.radius_deg, primitive.center[1] - shape.radius_deg);
      extendBounds(bounds, primitive.center[0] + shape.radius_deg, primitive.center[1] + shape.radius_deg);
    } else if (shape.type === "rectangle") {
      const eastAxis = rotateLocalOffset([1, 0], primitive.positionAngleDeg);
      const northAxis = rotateLocalOffset([0, 1], primitive.positionAngleDeg);
      const halfWidth = shape.width_deg / 2;
      const halfHeight = shape.height_deg / 2;
      const eastExtent = Math.abs(eastAxis[0]) * halfWidth + Math.abs(northAxis[0]) * halfHeight;
      const northExtent = Math.abs(eastAxis[1]) * halfWidth + Math.abs(northAxis[1]) * halfHeight;
      extendBounds(bounds, primitive.center[0] - eastExtent, primitive.center[1] - northExtent);
      extendBounds(bounds, primitive.center[0] + eastExtent, primitive.center[1] + northExtent);
    } else {
      for (const vertex of shape.vertices_deg) {
        const rotated = rotateLocalOffset(vertex, primitive.positionAngleDeg);
        extendBounds(bounds, primitive.center[0] + rotated[0], primitive.center[1] + rotated[1]);
      }
    }
  }
  return {
    min_east_deg: bounds.minEast,
    max_east_deg: bounds.maxEast,
    min_north_deg: bounds.minNorth,
    max_north_deg: bounds.maxNorth,
  };
}

/** Test positive-area overlap between a pointing footprint and an ICRS region.
 *
 * The selected region vertices are projected into the pointing's local
 * tangent-plane frame. Rectangle and polygon boundaries are tested exactly in
 * that plane; circle/edge overlap uses point-to-segment distance rather than
 * the sampled display boundary.
 *
 * @param footprint - Validated Schema v2 footprint centered on the pointing.
 * @param pointing - ICRS center in decimal-degree RA/DEC.
 * @param region - Ordered ICRS polygon in decimal degrees; closure is implicit.
 * @returns Whether the two interiors overlap with positive area.
 */
export function footprintIntersectsRegion(
  footprint: Footprint,
  pointing: Pick<CenterInput, "ra_deg" | "dec_deg">,
  region: SkyPolygon,
): boolean {
  if (region.vertices.length < 3) return false;
  const localRegion = region.vertices.map((vertex) => skyToLocalOffset(vertex, pointing));
  return flattenFootprint(footprint).some((primitive) => primitiveIntersectsPolygon(primitive, localRegion));
}

/** Project a local east/north offset to ICRS with the project's tangent approximation.
 *
 * Right ascension is scaled by `max(cos(DEC), 0.01)` and wrapped to `[0, 360)`.
 * The clamp avoids a singular RA scale near the poles; this is not spherical
 * polygon projection.
 *
 * @param pointing - ICRS center in decimal-degree RA/DEC.
 * @param offset - Local east/north offset in degrees.
 * @returns ICRS `[RA, DEC]` in decimal degrees.
 */
export function localOffsetToSky(
  pointing: Pick<CenterInput, "ra_deg" | "dec_deg">,
  offset: LocalFootprintPoint,
): [number, number] {
  const cosine = Math.max(Math.cos(radians(pointing.dec_deg)), 0.01);
  return [modulo(pointing.ra_deg + offset[0] / cosine, 360), pointing.dec_deg + offset[1]];
}

/** Project ICRS coordinates into a pointing-centered east/north tangent plane.
 *
 * Uses the same wrapped-RA and clamped cosine convention as
 * {@link localOffsetToSky}.
 *
 * @param sky - ICRS position in decimal-degree RA/DEC.
 * @param pointing - ICRS center in decimal-degree RA/DEC.
 * @returns Local east/north offset in degrees.
 */
export function skyToLocalOffset(
  sky: Pick<CenterInput, "ra_deg" | "dec_deg">,
  pointing: Pick<CenterInput, "ra_deg" | "dec_deg">,
): LocalFootprintPoint {
  return createSkyToLocalProjector(pointing)(sky.ra_deg, sky.dec_deg);
}

/** Create a reusable local projector with the pointing's cosine scale precomputed.
 *
 * This is the same transform as {@link skyToLocalOffset} and is intended for
 * sample loops that project many ICRS cells around one pointing.
 *
 * @param pointing - ICRS center in decimal-degree RA/DEC.
 * @returns Projector accepting ICRS RA and DEC degrees and returning east/north degrees.
 */
export function createSkyToLocalProjector(
  pointing: Pick<CenterInput, "ra_deg" | "dec_deg">,
): (raDeg: number, decDeg: number, target?: LocalFootprintPoint) => LocalFootprintPoint {
  const cosine = Math.max(Math.cos(radians(pointing.dec_deg)), 0.01);
  return (raDeg, decDeg, target = [0, 0]) => {
    target[0] = wrappedRaDelta(raDeg, pointing.ra_deg) * cosine;
    target[1] = decDeg - pointing.dec_deg;
    return target;
  };
}

function flattenFootprint(footprint: Footprint): PrimitiveFootprint[] {
  if (footprint.type !== "compound") {
    return [{
      footprint,
      center: [0, 0],
      positionAngleDeg: "position_angle_deg" in footprint ? footprint.position_angle_deg ?? 0 : 0,
    }];
  }
  const parentAngle = footprint.position_angle_deg ?? 0;
  return footprint.components.map((component) => ({
    footprint: component.footprint,
    center: rotateLocalOffset(component.offset_deg, parentAngle),
    positionAngleDeg: normalizedAngle(parentAngle) + normalizedAngle(component.rotation_deg ?? 0) +
      normalizedAngle("position_angle_deg" in component.footprint ? component.footprint.position_angle_deg ?? 0 : 0),
  }));
}

function containsPrimitive(primitive: PrimitiveFootprint, point: LocalFootprintPoint, includeBoundary: boolean): boolean {
  return containsShape(
    primitive.footprint,
    subtract(point, primitive.center),
    primitive.positionAngleDeg,
    includeBoundary,
  );
}

function containsShape(
  shape: NonCompoundFootprint,
  point: LocalFootprintPoint,
  positionAngleDeg: number,
  includeBoundary: boolean,
): boolean {
  const intrinsic = shape.type === "circle" || isWholeTurn(positionAngleDeg)
    ? point
    : rotateLocalOffset(point, -positionAngleDeg);
  if (shape.type === "rectangle") {
    const eastLimit = shape.width_deg / 2;
    const northLimit = shape.height_deg / 2;
    // Keep the legacy PA=0 comparisons exact: the frozen T80 coverage path
    // used inclusive `<=` tests without an epsilon. Rotated transforms need a
    // tiny allowance for roundoff at edges after the inverse rotation.
    const boundaryTolerance = isWholeTurn(positionAngleDeg) ? 0 : GEOMETRY_EPSILON;
    return includeBoundary
      ? Math.abs(intrinsic[0]) <= eastLimit + boundaryTolerance && Math.abs(intrinsic[1]) <= northLimit + boundaryTolerance
      : Math.abs(intrinsic[0]) < eastLimit - boundaryTolerance && Math.abs(intrinsic[1]) < northLimit - boundaryTolerance;
  }
  if (shape.type === "circle") {
    const radius = shape.radius_deg;
    const distance = Math.hypot(intrinsic[0], intrinsic[1]);
    return includeBoundary ? distance <= radius + GEOMETRY_EPSILON : distance < radius - GEOMETRY_EPSILON;
  }
  return pointInPolygon(intrinsic, shape.vertices_deg, includeBoundary);
}

function createShapeContainmentTester(
  shape: NonCompoundFootprint,
  positionAngleDeg: number,
  includeBoundary: boolean,
): (eastDeg: number, northDeg: number) => boolean {
  if (shape.type === "circle") {
    const radius = shape.radius_deg;
    const limit = radius + (includeBoundary ? GEOMETRY_EPSILON : -GEOMETRY_EPSILON);
    const squaredLimit = limit * limit;
    return (eastDeg, northDeg) => eastDeg * eastDeg + northDeg * northDeg <= squaredLimit;
  }

  const inverseAngleDeg = modulo(-positionAngleDeg + 180, 360) - 180;
  const angle = inverseAngleDeg === 0 ? 0 : radians(inverseAngleDeg);
  let cosine = Math.cos(angle);
  let sine = Math.sin(angle);
  if (Math.abs(cosine) < 1e-15) cosine = 0;
  if (Math.abs(sine) < 1e-15) sine = 0;
  const eastLimit = shape.type === "rectangle" ? shape.width_deg / 2 : 0;
  const northLimit = shape.type === "rectangle" ? shape.height_deg / 2 : 0;
  const tolerance = isWholeTurn(positionAngleDeg) ? 0 : GEOMETRY_EPSILON;
  return (eastDeg, northDeg) => {
    const east = eastDeg * cosine - northDeg * sine;
    const north = northDeg * cosine + eastDeg * sine;
    if (shape.type === "rectangle") {
      return includeBoundary
        ? Math.abs(east) <= eastLimit + tolerance && Math.abs(north) <= northLimit + tolerance
        : Math.abs(east) < eastLimit - tolerance && Math.abs(north) < northLimit - tolerance;
    }
    return pointInPolygonCoordinates(east, north, shape.vertices_deg, includeBoundary);
  };
}

function isWholeTurn(angleDeg: number): boolean {
  return angleDeg % 360 === 0;
}

function normalizedAngle(angleDeg: number): number {
  return modulo(angleDeg + 180, 360) - 180;
}

function primitiveBoundary(primitive: PrimitiveFootprint, circleSegments: number): LocalFootprintBoundary {
  const shape = primitive.footprint;
  if (shape.type === "circle") {
    const points: LocalFootprintBoundary = [];
    for (let index = 0; index <= circleSegments; index += 1) {
      const angle = 2 * Math.PI * index / circleSegments;
      points.push([
        primitive.center[0] + shape.radius_deg * Math.cos(angle),
        primitive.center[1] + shape.radius_deg * Math.sin(angle),
      ]);
    }
    return points;
  }
  const intrinsic: LocalFootprintPoint[] = shape.type === "rectangle"
    ? [
        [-shape.width_deg / 2, -shape.height_deg / 2],
        [shape.width_deg / 2, -shape.height_deg / 2],
        [shape.width_deg / 2, shape.height_deg / 2],
        [-shape.width_deg / 2, shape.height_deg / 2],
      ]
    : shape.vertices_deg;
  const points = intrinsic.map((point) =>
    add(rotateLocalOffset(point, primitive.positionAngleDeg), primitive.center),
  );
  if (points.length) points.push([...points[0]]);
  return points;
}

function primitiveIntersectsPolygon(primitive: PrimitiveFootprint, polygon: readonly LocalFootprintPoint[]): boolean {
  if (polygon.some((point) => containsPrimitive(primitive, point, false))) return true;

  const boundary = primitiveBoundary(primitive, DEFAULT_CIRCLE_SEGMENTS);
  if (boundary.slice(0, -1).some((point) => pointInPolygon(point, polygon, false))) return true;
  if (pointInPolygon(primitive.center, polygon, false)) return true;

  if (primitive.footprint.type === "circle") {
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      if (distanceToSegment(primitive.center, start, end) < primitive.footprint.radius_deg - GEOMETRY_EPSILON) return true;
    }
    return false;
  }

  for (let first = 0; first < boundary.length - 1; first += 1) {
    const firstStart = boundary[first];
    const firstEnd = boundary[first + 1];
    for (let second = 0; second < polygon.length; second += 1) {
      if (segmentsProperlyIntersect(
        firstStart,
        firstEnd,
        polygon[second],
        polygon[(second + 1) % polygon.length],
      )) return true;
    }
  }
  return false;
}

function pointInPolygon(
  point: LocalFootprintPoint,
  vertices: readonly LocalFootprintPoint[],
  includeBoundary: boolean,
): boolean {
  return pointInPolygonCoordinates(point[0], point[1], vertices, includeBoundary);
}

function pointInPolygonCoordinates(
  eastDeg: number,
  northDeg: number,
  vertices: readonly LocalFootprintPoint[],
  includeBoundary: boolean,
): boolean {
  let inside = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    if (pointOnSegmentCoordinates(eastDeg, northDeg, start, end)) return includeBoundary;
    if ((start[1] > northDeg) !== (end[1] > northDeg)) {
      const crossingEast = start[0] + (end[0] - start[0]) * (northDeg - start[1]) / (end[1] - start[1]);
      if (eastDeg < crossingEast) inside = !inside;
    }
  }
  return inside;
}

function pointOnSegmentCoordinates(
  eastDeg: number,
  northDeg: number,
  start: LocalFootprintPoint,
  end: LocalFootprintPoint,
): boolean {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const px = eastDeg - start[0];
  const py = northDeg - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const cross = dx * py - dy * px;
  if (Math.abs(cross) > GEOMETRY_EPSILON * Math.max(1, Math.sqrt(lengthSquared))) return false;
  const dot = px * dx + py * dy;
  return dot >= -GEOMETRY_EPSILON && dot <= lengthSquared + GEOMETRY_EPSILON;
}

function segmentsProperlyIntersect(
  a: LocalFootprintPoint,
  b: LocalFootprintPoint,
  c: LocalFootprintPoint,
  d: LocalFootprintPoint,
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return abC * abD < -GEOMETRY_EPSILON && cdA * cdB < -GEOMETRY_EPSILON;
}

function orientation(a: LocalFootprintPoint, b: LocalFootprintPoint, c: LocalFootprintPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function distanceToSegment(point: LocalFootprintPoint, start: LocalFootprintPoint, end: LocalFootprintPoint): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const fraction = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared,
  ));
  return Math.hypot(point[0] - (start[0] + fraction * dx), point[1] - (start[1] + fraction * dy));
}

function signedClearance(primitive: PrimitiveFootprint, point: LocalFootprintPoint): number {
  const intrinsic = rotateLocalOffset(subtract(point, primitive.center), -primitive.positionAngleDeg);
  const shape = primitive.footprint;
  if (shape.type === "circle") return shape.radius_deg - Math.hypot(intrinsic[0], intrinsic[1]);
  if (shape.type === "rectangle") {
    const east = shape.width_deg / 2 - Math.abs(intrinsic[0]);
    const north = shape.height_deg / 2 - Math.abs(intrinsic[1]);
    if (east >= 0 && north >= 0) return Math.min(east, north);
    return -Math.hypot(Math.max(0, -east), Math.max(0, -north));
  }
  let distance = Infinity;
  for (let index = 0; index < shape.vertices_deg.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(
      intrinsic,
      shape.vertices_deg[index],
      shape.vertices_deg[(index + 1) % shape.vertices_deg.length],
    ));
  }
  return (pointInPolygon(intrinsic, shape.vertices_deg, false) ? 1 : -1) * distance;
}

function primitiveBounds(primitive: PrimitiveFootprint): Bounds {
  if (primitive.footprint.type === "circle") {
    const radius = primitive.footprint.radius_deg;
    return {
      minEast: primitive.center[0] - radius,
      maxEast: primitive.center[0] + radius,
      minNorth: primitive.center[1] - radius,
      maxNorth: primitive.center[1] + radius,
    };
  }
  const path = primitiveBoundary(primitive, DEFAULT_CIRCLE_SEGMENTS).slice(0, -1);
  return path.reduce<Bounds>((bounds, point) => ({
    minEast: Math.min(bounds.minEast, point[0]),
    maxEast: Math.max(bounds.maxEast, point[0]),
    minNorth: Math.min(bounds.minNorth, point[1]),
    maxNorth: Math.max(bounds.maxNorth, point[1]),
  }), { minEast: Infinity, maxEast: -Infinity, minNorth: Infinity, maxNorth: -Infinity });
}

function compoundUnionArea(primitives: readonly PrimitiveFootprint[]): number {
  if (!primitives.length) return 0;
  const bounds = primitives.map(primitiveBounds).reduce<Bounds>((all, item) => ({
    minEast: Math.min(all.minEast, item.minEast),
    maxEast: Math.max(all.maxEast, item.maxEast),
    minNorth: Math.min(all.minNorth, item.minNorth),
    maxNorth: Math.max(all.maxNorth, item.maxNorth),
  }), { minEast: Infinity, maxEast: -Infinity, minNorth: Infinity, maxNorth: -Infinity });
  const width = bounds.maxEast - bounds.minEast;
  const height = bounds.maxNorth - bounds.minNorth;
  if (width <= 0 || height <= 0) return 0;

  const integrate = (minEast: number, minNorth: number, maxEast: number, maxNorth: number, depth: number): number => {
    const center: LocalFootprintPoint = [(minEast + maxEast) / 2, (minNorth + maxNorth) / 2];
    const halfDiagonal = Math.hypot((maxEast - minEast) / 2, (maxNorth - minNorth) / 2);
    const clearance = Math.max(...primitives.map((primitive) => signedClearance(primitive, center)));
    const area = (maxEast - minEast) * (maxNorth - minNorth);
    if (clearance >= halfDiagonal) return area;
    if (clearance <= -halfDiagonal) return 0;
    if (depth >= COMPOUND_AREA_MAX_DEPTH) {
      return primitives.some((primitive) => containsPrimitive(primitive, center, true)) ? area : 0;
    }
    const midEast = center[0];
    const midNorth = center[1];
    return integrate(minEast, minNorth, midEast, midNorth, depth + 1) +
      integrate(midEast, minNorth, maxEast, midNorth, depth + 1) +
      integrate(minEast, midNorth, midEast, maxNorth, depth + 1) +
      integrate(midEast, midNorth, maxEast, maxNorth, depth + 1);
  };

  return integrate(bounds.minEast, bounds.minNorth, bounds.maxEast, bounds.maxNorth, 0);
}

function signedPolygonArea(vertices: readonly LocalFootprintPoint[]): number {
  let doubledArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const point = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    doubledArea += point[0] * next[1] - next[0] * point[1];
  }
  return doubledArea / 2;
}

function add(left: LocalFootprintPoint, right: LocalFootprintPoint): LocalFootprintPoint {
  return [left[0] + right[0], left[1] + right[1]];
}

function extendBounds(bounds: Bounds, eastDeg: number, northDeg: number): void {
  bounds.minEast = Math.min(bounds.minEast, eastDeg);
  bounds.maxEast = Math.max(bounds.maxEast, eastDeg);
  bounds.minNorth = Math.min(bounds.minNorth, northDeg);
  bounds.maxNorth = Math.max(bounds.maxNorth, northDeg);
}

function subtract(left: LocalFootprintPoint, right: LocalFootprintPoint): LocalFootprintPoint {
  return [left[0] - right[0], left[1] - right[1]];
}
