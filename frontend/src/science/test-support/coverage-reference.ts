import type { CenterInput, Footprint, SkyPolygon } from "../../types";
import type { CoverageGrid } from "../coverage";
import { polygonLocalGeometry } from "../geometry";
import { createFootprintContainmentTester, createSkyToLocalProjector } from "../footprint-engine";
import { modulo, radians } from "../math";

/** Test-only uniform midpoint quadrature, independent of production layout/policy.
 *
 * @param polygon - Ordered ICRS RA/DEC vertices in degrees, spanning <180° RA.
 * @param pitchDeg - Explicit positive local-degree pitch at midpoint DEC; no cap.
 * @returns Full row-major grid with strict ray-crossing region mask and cos(DEC)
 *   weights. Reuses only coordinate conventions, never sampleRegion or policy.
 * @throws If pitch is invalid or the selected grid has no positive weight.
 * @remarks This allocates test arrays; it must never be imported by application code.
 */
export function referenceGrid(polygon: SkyPolygon, pitchDeg: number): CoverageGrid {
  if (!Number.isFinite(pitchDeg) || pitchDeg <= 0) throw new Error("Invalid reference pitch");
  const { bounds, originRaDeg, ra: x } = polygonLocalGeometry(polygon);
  const middleDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const height = bounds.dec_max_deg - bounds.dec_min_deg;
  const cols = Math.ceil(bounds.ra_span_deg * Math.max(Math.cos(radians(middleDec)), 0.01) / pitchDeg);
  const rows = Math.ceil(height / pitchDeg);
  const ra = new Float64Array(cols * rows);
  const dec = new Float64Array(cols * rows);
  const weights = new Float64Array(cols * rows);
  let totalWeight = 0;
  for (let row = 0; row < rows; row += 1) {
    const north = bounds.dec_min_deg + (row + 0.5) * height / rows;
    for (let col = 0; col < cols; col += 1) {
      const east = (col + 0.5) * bounds.ra_span_deg / cols;
      const i = row * cols + col;
      ra[i] = modulo(originRaDeg + east, 360);
      dec[i] = north;
      // Deliberately implemented here, not through production sampleBounds.
      let crossings = 0;
      for (let a = 0, b = x.length - 1; a < x.length; b = a++) {
        const ya = polygon.vertices[a].dec_deg;
        const yb = polygon.vertices[b].dec_deg;
        if ((ya > north) !== (yb > north) && east < x[a] + (north - ya) * (x[b] - x[a]) / (yb - ya)) crossings += 1;
      }
      if (crossings % 2) { weights[i] = Math.cos(radians(north)); totalWeight += weights[i]; }
    }
  }
  if (!(totalWeight > 0)) throw new Error("Empty reference region");
  return { ra, dec, weights, totalWeight, stepDeg: pitchDeg,
    centerRaDeg: modulo(originRaDeg + bounds.ra_span_deg / 2, 360), centerDecDeg: middleDec,
    raSpanDeg: bounds.ra_span_deg, decMinDeg: bounds.dec_min_deg, decMaxDeg: bounds.dec_max_deg,
    cellAreaDeg2: bounds.ra_span_deg / cols * height / rows };
}

/** Test-only containment union without production tileMask culling.
 * @param grid - Independent reference grid in ICRS degrees.
 * @param footprint - Shared physical local east/north geometry in degrees.
 * @param pointings - Centers in ICRS degrees; their physical footprints are unioned.
 * @returns Binary union on selected cells; gaps and overlaps retain shared semantics.
 */
export function referenceMask(grid: CoverageGrid, footprint: Footprint, pointings: readonly CenterInput[]): Uint8Array {
  const contains = createFootprintContainmentTester(footprint);
  const projects = pointings.map(createSkyToLocalProjector);
  const mask = new Uint8Array(grid.ra.length);
  const local: [number, number] = [0, 0];
  for (let i = 0; i < mask.length; i += 1) {
    if (!grid.weights[i]) continue;
    for (const project of projects) {
      project(grid.ra[i], grid.dec[i], local);
      if (contains(local[0], local[1])) { mask[i] = 1; break; }
    }
  }
  return mask;
}

/** Unrounded declination-weighted fraction of selected cells covered by a mask.
 * @param grid - ICRS quadrature grid with positive selected weight.
 * @param mask - Binary array of the same length as the grid.
 * @returns Dimensionless coverage fraction in [0,1].
 */
export function coverageFraction(grid: CoverageGrid, mask: Uint8Array): number {
  let weight = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) weight += grid.weights[i];
  return weight / grid.totalWeight;
}
