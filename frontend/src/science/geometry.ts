import type { Footprint, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { footprintIntersectsRegion } from "./footprint-engine";
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

/** Continuous RA coordinates of an ICRS polygon, relative to its western edge. */
export interface PolygonLocalGeometry {
  bounds: RegionBounds;
  originRaDeg: number;
  ra: number[];
}

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

/** Unwrap polygon RA once and place every vertex in the same local frame.
 * @param polygon - Ordered ICRS vertices in decimal degrees, spanning at most 180° in RA.
 * @returns Continuous local RA coordinates in [0, ra_span_deg], their unwrapped
 *   origin, and canonical ICRS bounds; declinations remain in degrees.
 * @throws If fewer than three vertices are supplied.
 */
export function polygonLocalGeometry(polygon: SkyPolygon): PolygonLocalGeometry {
  if (polygon.vertices.length < 3) throw new Error("Polygon requires at least three vertices");
  const ras = unwrapRas(polygon);
  const originRaDeg = Math.min(...ras);
  const maxRa = Math.max(...ras);
  return {
    originRaDeg,
    ra: ras.map((ra) => ra - originRaDeg),
    bounds: {
      ra_start_deg: modulo(originRaDeg, 360), ra_end_deg: modulo(maxRa, 360),
      ra_span_deg: maxRa - originRaDeg,
      dec_min_deg: Math.min(...polygon.vertices.map((vertex) => vertex.dec_deg)),
      dec_max_deg: Math.max(...polygon.vertices.map((vertex) => vertex.dec_deg)),
    },
  };
}

/** Minimal eastward ICRS bounds of a validated polygon.
 * @param polygon - Ordered ICRS vertices in decimal degrees, spanning at most 180° in RA.
 * @returns Canonical RA start/end, continuous RA span, and declination bounds in degrees.
 * @throws If fewer than three vertices are supplied.
 */
export function polygonBounds(polygon: SkyPolygon): RegionBounds {
  return polygonLocalGeometry(polygon).bounds;
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

/** Count real tile footprints intersecting positive polygon area, independent of samples.
 * @param polygon - Validated ordered ICRS polygon in degrees.
 * @param tiles - Enabled original or accepted pointings in ICRS degrees.
 * @param geometry - Schema v2 footprint or legacy rectangular tile dimensions.
 * @returns Number of actual footprints with positive selected-area overlap.
 */
export function contributingTileCount(
  polygon: SkyPolygon,
  tiles: readonly TileRecord[],
  geometry: Footprint | Pick<TilingProfile, "tile_width_deg" | "tile_height_deg">,
): number {
  const footprint: Footprint = "type" in geometry
    ? geometry
    : { type: "rectangle", width_deg: geometry.tile_width_deg, height_deg: geometry.tile_height_deg };
  let contributing = 0;
  for (const tile of tiles) {
    if (footprintIntersectsRegion(footprint, tile, polygon)) contributing += 1;
  }
  return contributing;
}
