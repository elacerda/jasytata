import type { SkyPolygon } from "../types";
import { normalizeRa } from "./coordinates";

/** Minimal eastward ICRS bounds of a validated polygon crossing RA zero if needed.
 * @param polygon - Ordered ICRS vertices in decimal degrees, spanning at most 180° in RA.
 * @returns Wrapped RA start/end/span and declination bounds in degrees.
 * @throws If fewer than three vertices are supplied.
 */
export function polygonBounds(polygon: SkyPolygon): {
  ra_start_deg: number; ra_end_deg: number; ra_span_deg: number; dec_min_deg: number; dec_max_deg: number;
} {
  const vertices = polygon.vertices;
  if (vertices.length < 3) throw new Error("Polygon requires at least three vertices");
  const ras = [vertices[0].ra_deg];
  for (let index = 1; index < vertices.length; index += 1) {
    const delta = ((vertices[index].ra_deg - vertices[index - 1].ra_deg + 540) % 360) - 180;
    ras.push(ras[index - 1] + delta);
  }
  const start = normalizeRa(Math.min(...ras));
  const end = normalizeRa(Math.max(...ras));
  return {
    ra_start_deg: start, ra_end_deg: end, ra_span_deg: (end - start + 360) % 360,
    dec_min_deg: Math.min(...vertices.map((vertex) => vertex.dec_deg)),
    dec_max_deg: Math.max(...vertices.map((vertex) => vertex.dec_deg)),
  };
}
