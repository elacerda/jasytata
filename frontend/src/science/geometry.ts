import type { SkyPolygon, TileRecord, TilingProfile } from "../types";
import { modulo, radians, degrees, wrappedRaDelta } from "./math";

/** Eastward ICRS bounds of an ordered sky polygon, with RA crossing zero if needed. */
export interface RegionBounds {
  ra_start_deg: number;
  ra_end_deg: number;
  ra_span_deg: number;
  dec_min_deg: number;
  dec_max_deg: number;
}

type Point = readonly [number, number];

/** Validate the Python SkyPolygon contract before browser planning or coverage.
 * @param polygon - Ordered ICRS vertices in decimal degrees, without repeated closure.
 * @throws On invalid coordinates, duplicate/crossing edges, zero area, or RA span above 180°.
 */
export function validatePolygon(polygon: SkyPolygon): void {
  const vertices = polygon.vertices;
  if (vertices.length < 3 || vertices.length > 200) throw new Error("Polygon requires 3 to 200 vertices");
  if (vertices.some((vertex) => !Number.isFinite(vertex.ra_deg) || vertex.ra_deg < 0 || vertex.ra_deg >= 360 || !Number.isFinite(vertex.dec_deg) || Math.abs(vertex.dec_deg) >= 90)) {
    throw new Error("Polygon vertices must be finite ICRS coordinates away from the poles");
  }
  const ras = unwrapRas(polygon);
  if (Math.max(...ras) - Math.min(...ras) > 180) throw new Error("Polygon RA span must be 180 degrees or less");
  for (let index = 0; index < vertices.length; index += 1) {
    for (let other = 0; other < index; other += 1) {
      if (Math.hypot(ras[index] - ras[other], vertices[index].dec_deg - vertices[other].dec_deg) < 1e-6) throw new Error("Polygon vertices must be distinct");
    }
  }
  const cosDec = Math.cos(radians(vertices.reduce((sum, point) => sum + point.dec_deg, 0) / vertices.length));
  const points: Point[] = vertices.map((vertex, index) => [ras[index] * cosDec, vertex.dec_deg]);
  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    doubledArea += points[index][0] * next[1] - next[0] * points[index][1];
  }
  if (Math.abs(doubledArea) / 2 < 1e-5) throw new Error("Polygon has effectively zero area");
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === points.length - 1)) continue;
      const a = points[first]; const b = points[(first + 1) % points.length];
      const c = points[second]; const d = points[(second + 1) % points.length];
      const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) throw new Error("Polygon edges cross");
    }
  }
}

function unwrapRas(polygon: SkyPolygon): number[] {
  const ras = [polygon.vertices[0].ra_deg];
  for (let index = 1; index < polygon.vertices.length; index += 1) {
    ras.push(ras[index - 1] + wrappedRaDelta(polygon.vertices[index].ra_deg, polygon.vertices[index - 1].ra_deg));
  }
  return ras;
}

/** Minimal eastward ICRS bounds of a validated polygon.
 * @param polygon - Ordered ICRS vertices in decimal degrees, spanning at most 180° in RA.
 * @returns Wrapped RA start/end/span and declination bounds in degrees.
 * @throws If fewer than three vertices are supplied.
 */
export function polygonBounds(polygon: SkyPolygon): RegionBounds {
  if (polygon.vertices.length < 3) throw new Error("Polygon requires at least three vertices");
  const ras = unwrapRas(polygon);
  const start = modulo(Math.min(...ras), 360);
  const end = modulo(Math.max(...ras), 360);
  return {
    ra_start_deg: start, ra_end_deg: end, ra_span_deg: modulo(end - start, 360),
    dec_min_deg: Math.min(...polygon.vertices.map((vertex) => vertex.dec_deg)),
    dec_max_deg: Math.max(...polygon.vertices.map((vertex) => vertex.dec_deg)),
  };
}

/** Stable great-circle distance between ICRS centers.
 * @param raA - First right ascension in decimal degrees.
 * @param decA - First declination in decimal degrees.
 * @param raB - Second right ascension in decimal degrees.
 * @param decB - Second declination in decimal degrees.
 * @returns Haversine angular separation in degrees.
 */
export function angularSeparationDeg(raA: number, decA: number, raB: number, decB: number): number {
  const deltaDec = radians(decB - decA);
  const deltaRa = radians(wrappedRaDelta(raB, raA));
  const haversine = Math.sin(deltaDec / 2) ** 2 + Math.cos(radians(decA)) * Math.cos(radians(decB)) * Math.sin(deltaRa / 2) ** 2;
  return degrees(2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine)))));
}

/** Planar positive-area intersection of an ICRS polygon and one tile footprint.
 * @param vertices - Polygon vertices locally unwrapped around centerRa, [RA, DEC] degrees.
 * @param tile - Actual ICRS tile center in decimal degrees.
 * @param profile - Axis-aligned physical footprint width/height in degrees.
 * @param centerRa - RA unwrap reference in degrees.
 * @returns Clipped planar RA/DEC area in square degrees; only positivity is used.
 */
export function clippedFootprintArea(vertices: readonly Point[], tile: Pick<TileRecord, "ra_deg" | "dec_deg">, profile: TilingProfile, centerRa: number): number {
  const ra = centerRa + wrappedRaDelta(tile.ra_deg, centerRa);
  const halfRa = profile.tile_width_deg / (2 * Math.max(Math.cos(radians(tile.dec_deg)), 0.01));
  const boundaries: Array<[0 | 1, number, boolean]> = [
    [0, ra - halfRa, true], [0, ra + halfRa, false],
    [1, tile.dec_deg - profile.tile_height_deg / 2, true], [1, tile.dec_deg + profile.tile_height_deg / 2, false],
  ];
  let clipped: Point[] = [...vertices];
  for (const [axis, boundary, keepGreater] of boundaries) {
    if (!clipped.length) return 0;
    const result: Point[] = [];
    let previous = clipped[clipped.length - 1];
    let previousInside = keepGreater ? previous[axis] >= boundary : previous[axis] <= boundary;
    for (const current of clipped) {
      const currentInside = keepGreater ? current[axis] >= boundary : current[axis] <= boundary;
      if (currentInside !== previousInside) {
        const fraction = (boundary - previous[axis]) / (current[axis] - previous[axis]);
        result.push([
          previous[0] + fraction * (current[0] - previous[0]),
          previous[1] + fraction * (current[1] - previous[1]),
        ]);
      }
      if (currentInside) result.push(current);
      previous = current; previousInside = currentInside;
    }
    clipped = result;
  }
  if (clipped.length < 3) return 0;
  const [originX, originY] = clipped[0];
  let doubledArea = 0;
  for (let index = 0; index < clipped.length; index += 1) {
    const point = clipped[index]; const next = clipped[(index + 1) % clipped.length];
    doubledArea += (point[0] - originX) * (next[1] - originY) - (next[0] - originX) * (point[1] - originY);
  }
  return Math.abs(doubledArea) / 2;
}

/** Count real tile footprints intersecting positive polygon area, independent of samples.
 * @param polygon - Validated ordered ICRS polygon in degrees.
 * @param tiles - Enabled original or accepted pointings in ICRS degrees.
 * @param profile - Physical tile geometry in degrees.
 * @returns Number of actual footprints with positive selected-area overlap.
 */
export function contributingTileCount(polygon: SkyPolygon, tiles: readonly TileRecord[], profile: TilingProfile): number {
  const bounds = polygonBounds(polygon);
  const centerRa = modulo(bounds.ra_start_deg + bounds.ra_span_deg / 2, 360);
  const vertices: Point[] = polygon.vertices.map((vertex) => [centerRa + wrappedRaDelta(vertex.ra_deg, centerRa), vertex.dec_deg]);
  let contributing = 0;
  for (const tile of tiles) {
    if (clippedFootprintArea(vertices, tile, profile, centerRa) > 1e-12) contributing += 1;
  }
  return contributing;
}
