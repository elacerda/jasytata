import { modulo } from "./science/math";
import { polygonBounds } from "./science/geometry";
import type { SkyPolygon } from "./types";

/** Angular center and field of view needed to make a canonical sky region visible. */
export interface RegionViewport {
  centerRaDeg: number;
  centerDecDeg: number;
  fieldOfViewDeg: number;
}

/** Fit a canonical selected region using its shortest unwrapped ICRS RA bounds.
 *
 * @param region - Validated ICRS polygon with RA/Dec coordinates in degrees.
 * @returns Wrapped center RA, midpoint declination, and padded Aladin field of view.
 *   RA width is projected onto the local sky with cos(center Dec), matching the
 *   application's local ICRS convention.
 */
export function regionViewport(region: SkyPolygon): RegionViewport {
  const bounds = polygonBounds(region);
  const centerDecDeg = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const centerRaDeg = modulo(bounds.ra_start_deg + bounds.ra_span_deg / 2, 360);
  const widthDeg = bounds.ra_span_deg * Math.cos((centerDecDeg * Math.PI) / 180);
  const heightDeg = bounds.dec_max_deg - bounds.dec_min_deg;
  const fieldOfViewDeg = Math.max(0.05, Math.min(180, Math.max(widthDeg, heightDeg) * 1.4));
  return { centerRaDeg, centerDecDeg, fieldOfViewDeg };
}
