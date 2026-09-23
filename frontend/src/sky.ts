import type { RegionBounds, TileRecord, TilingProfile } from "./types";

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
