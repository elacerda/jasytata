import type { TilingProfile } from "../types";
import type { RegionBounds } from "./geometry";
import { modulo, radians } from "./math";

/** Ordered ICRS center, [right ascension, declination] in decimal degrees. */
export type Center = readonly [number, number];

/** Generate the Python legacy S-PLUS half-tile seeded grid.
 * @param raBounds - RA endpoints in degrees; wrapsRa chooses the eastward zero-crossing arc.
 * @param decBounds - Declination endpoints in degrees; reversed limits are normalized.
 * @param wrapsRa - Whether RA endpoints span zero eastward.
 * @returns Centers ordered by ascending DEC and then traversal RA.
 * @throws On non-finite bounds or declinations outside [-90, 90].
 */
export function legacyGridCenters(raBounds: Center, decBounds: Center, wrapsRa = false): Center[] {
  const [raA, raB] = raBounds;
  const [decA, decB] = decBounds;
  if (![raA, raB, decA, decB].every(Number.isFinite)) throw new Error("Bounds must be finite");
  if (Math.abs(decA) > 90 || Math.abs(decB) > 90) throw new Error("Declination bounds must be between -90 and 90 degrees");
  const raStart = wrapsRa ? modulo(raA, 360) : Math.min(modulo(raA, 360), modulo(raB, 360));
  const raSpan = wrapsRa ? modulo(raB - raA, 360) : Math.abs(modulo(raB, 360) - modulo(raA, 360));
  const decLow = Math.min(decA, decB);
  const decHigh = Math.max(decA, decB);
  const raFixed = !wrapsRa && raSpan === 0;
  const decFixed = decLow === decHigh;
  const tileSize = 1.4;
  const spacing = tileSize - 120 / 3600;
  const firstRaOffset = raFixed ? 0 : (tileSize / 2) / Math.cos(radians(decLow));
  let dec = decFixed ? decLow : decLow + tileSize / 2;
  const rowLimit = Math.max(1, Math.ceil((decHigh - decLow) / spacing) + 2);
  const colLimit = Math.max(1, Math.ceil(Math.max(raSpan, 0.01) / spacing * 2) + 4);
  const centers: Center[] = [];
  for (let row = 0; row < rowLimit; row += 1) {
    if (dec > decHigh + 1e-12) break;
    const rowStep = spacing / Math.cos(radians(dec));
    let offset = firstRaOffset;
    if (raFixed) centers.push([raStart, dec]);
    else for (let col = 0; col < colLimit; col += 1) {
      if (offset > raSpan + 1e-12) break;
      centers.push([modulo(raStart + offset, 360), dec]);
      offset += rowStep;
    }
    if (decFixed) break;
    dec += spacing;
  }
  return centers;
}

/** Seed a rectangular ICRS grid with profile width/height and edge overlap.
 * @param bounds - Eastward RA and northward DEC limits in degrees.
 * @param profile - Physical tile dimensions in degrees and overlap in arcseconds.
 * @returns Ordered [RA, DEC] center pairs in decimal degrees.
 */
export function rectangularGridCenters(bounds: RegionBounds, profile: TilingProfile): Center[] {
  const centers: Center[] = [];
  let dec = bounds.dec_min_deg + profile.tile_height_deg / 2;
  const raSpacing = profile.tile_width_deg - profile.effective_overlap_arcsec / 3600;
  const decSpacing = profile.tile_height_deg - profile.effective_overlap_arcsec / 3600;
  while (dec <= bounds.dec_max_deg + 1e-12) {
    const cosDec = Math.cos(radians(dec));
    if (cosDec <= 1e-6) break;
    let offset = profile.tile_width_deg / (2 * cosDec);
    const raStep = raSpacing / cosDec;
    while (offset <= bounds.ra_span_deg + 1e-12) {
      centers.push([modulo(bounds.ra_start_deg + offset, 360), dec]);
      offset += raStep;
    }
    dec += decSpacing;
  }
  return centers;
}
