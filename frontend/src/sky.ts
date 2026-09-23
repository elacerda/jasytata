import type { RegionBounds, SkyPolygon, TileRecord, TilingProfile } from "./types";

/** Validate a small celestial polygon, including wrap and crossing edges.
 *
 * @param points - Ordered ICRS [RA, DEC] vertices in degrees, without a closing repeat.
 * @returns Canonical polygon with RA normalized to [0, 360).
 * @throws For duplicate, crossing, polar, or effectively zero-area selections.
 */
export function skyPolygonFromVertices(points: Array<[number, number]>): SkyPolygon {
  const vertices = points.map(([ra, dec]) => ({ ra_deg: ra >= 0 && ra < 360 ? ra : ((ra % 360) + 360) % 360, dec_deg: dec }));
  if (vertices.length > 3 && distance(vertices[0], vertices[vertices.length - 1]) < 1e-6) vertices.pop();
  if (vertices.length < 3) throw new Error("Select at least three distinct sky points.");
  if (vertices.some(({ ra_deg, dec_deg }) => !Number.isFinite(ra_deg) || !Number.isFinite(dec_deg) || Math.abs(dec_deg) >= 90)) {
    throw new Error("Polygon vertices must have finite RA and DEC away from the poles.");
  }
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      if (distance(vertices[i], vertices[j]) < 1e-6) throw new Error("Polygon points must be distinct.");
    }
  }
  const unwrapped = [vertices[0].ra_deg];
  for (let i = 1; i < vertices.length; i += 1) {
    unwrapped.push(unwrapped[i - 1] + wrappedDelta(vertices[i].ra_deg, vertices[i - 1].ra_deg));
  }
  const span = Math.max(...unwrapped) - Math.min(...unwrapped);
  if (span > 180) throw new Error("Selected polygon spans more than 180° in RA.");
  const meanDec = vertices.reduce((sum, point) => sum + point.dec_deg, 0) / vertices.length;
  const cosine = Math.cos(meanDec * Math.PI / 180);
  const xy = vertices.map((point, index) => [unwrapped[index] * cosine, point.dec_deg] as const);
  let doubledArea = 0;
  for (let i = 0; i < xy.length; i += 1) {
    const next = (i + 1) % xy.length;
    doubledArea += xy[i][0] * xy[next][1] - xy[next][0] * xy[i][1];
  }
  if (Math.abs(doubledArea) / 2 < 1e-5) throw new Error("Selected polygon has effectively zero area.");
  for (let i = 0; i < xy.length; i += 1) {
    for (let j = i + 1; j < xy.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === xy.length - 1)) continue;
      if (intersects(xy[i], xy[(i + 1) % xy.length], xy[j], xy[(j + 1) % xy.length])) {
        throw new Error("Selected polygon crosses itself.");
      }
    }
  }
  return { vertices };
}

function wrappedDelta(ra: number, reference: number): number {
  return ((ra - reference + 540) % 360) - 180;
}

function distance(a: { ra_deg: number; dec_deg: number }, b: { ra_deg: number; dec_deg: number }): number {
  return Math.hypot(wrappedDelta(a.ra_deg, b.ra_deg), a.dec_deg - b.dec_deg);
}

function intersects(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): boolean {
  const cross = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

/**
 * Convert Aladin's ICRS rectangle corners to an eastward interval that crosses RA zero safely.
 *
 * @param corners - At least four `[ra_deg, dec_deg]` world-coordinate corners.
 * @returns Bounds in decimal degrees, with RA traversed eastward from the left edge.
 * @throws If Aladin returned too few corners or the rectangle has zero area.
 */
export function regionBoundsFromCorners(corners: Array<[number, number]>): RegionBounds {
  if (corners.length < 4) throw new Error("The map did not return all four selection corners.");
  const ras = [...new Set(corners.map(([ra]) => ((ra % 360) + 360) % 360))].sort((a, b) => a - b);
  let largestGap = -1;
  let gapIndex = 0;
  for (let index = 0; index < ras.length; index += 1) {
    const next = index === ras.length - 1 ? ras[0] + 360 : ras[index + 1];
    const gap = next - ras[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  const start = ras[(gapIndex + 1) % ras.length];
  const end = ras[gapIndex];
  const decs = corners.map(([, dec]) => dec);
  const bounds = {
    ra_start_deg: start,
    ra_end_deg: end,
    dec_min_deg: Math.min(...decs),
    dec_max_deg: Math.max(...decs),
  };
  if (bounds.dec_min_deg === bounds.dec_max_deg || start === end) {
    throw new Error("Drag a larger rectangle to select a non-empty sky area.");
  }
  return bounds;
}

/** Return the approximate tile footprint, correcting RA width at the center declination.
 *
 * @param tile - Center RA/DEC in degrees.
 * @param profile - Physical tile width and height in on-sky degrees.
 * @returns Closed five-vertex footprint in ICRS degrees.
 */
export function tileFootprint(tile: Pick<TileRecord, "ra_deg" | "dec_deg">, profile: Pick<TilingProfile, "tile_width_deg" | "tile_height_deg">): Array<[number, number]> {
  const halfHeight = profile.tile_height_deg / 2;
  const cosine = Math.max(Math.cos((tile.dec_deg * Math.PI) / 180), 0.01);
  const halfRa = profile.tile_width_deg / 2 / cosine;
  return [
    [(tile.ra_deg - halfRa + 360) % 360, tile.dec_deg - halfHeight],
    [(tile.ra_deg + halfRa) % 360, tile.dec_deg - halfHeight],
    [(tile.ra_deg + halfRa) % 360, tile.dec_deg + halfHeight],
    [(tile.ra_deg - halfRa + 360) % 360, tile.dec_deg + halfHeight],
    [(tile.ra_deg - halfRa + 360) % 360, tile.dec_deg - halfHeight],
  ];
}
