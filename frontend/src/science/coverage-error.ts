import type { CoverageErrorBound, Footprint, SkyPolygon } from "../types";
import type { CoverageGrid } from "./coverage";
import { footprintBoundary } from "./footprint-engine";
import { wrappedRaDelta } from "./math";
import { polygonLocalGeometry } from "./geometry";

/** Conservative boundary-cell and midpoint-weight error in the modeled plane.
 *
 * Every cell touching a boundary lies in its full-diagonal tubular neighborhood.
 * Polygon edges are covered by capsules of area 2*d*L + pi*d². Circular
 * primitives use an analytic perimeter/stretch bound; display chords never
 * substitute for a scientific circle. Compound/sequence sums overcount overlap.
 * See the Gate 6B validation record for the proof and fraction propagation.
 *
 * @param grid - Resolved RA/DEC midpoint grid with cos(DEC) weights.
 * @param polygon - Ordered ICRS selected-region boundary in degrees.
 * @param geometries - All applicable effective footprint boundaries and centers.
 * @param unknownBoundary - Use the entire domain when external masks lack geometry.
 * @returns Guaranteed numerical error; physical/projection error is unquantified.
 */
export function coverageErrorBound(grid: CoverageGrid, polygon: SkyPolygon, geometries: readonly { center: readonly [number, number]; footprint: Footprint }[], unknownBoundary = false): CoverageErrorBound {
  const { bounds, ra } = polygonLocalGeometry(polygon);
  const rows = grid.sampling!.row_count;
  const cols = grid.sampling!.column_count;
  const dx = bounds.ra_span_deg / cols;
  const dy = (bounds.dec_max_deg - bounds.dec_min_deg) / rows;
  const diagonal = Math.hypot(dx, dy) + 2e-12;
  const capsule = (length: number) => 2 * diagonal * length + Math.PI * diagonal ** 2;
  let boundary = 0;
  for (let i = 0; i < ra.length; i += 1) {
    const j = (i + 1) % ra.length;
    boundary += capsule(Math.hypot(ra[j] - ra[i], polygon.vertices[j].dec_deg - polygon.vertices[i].dec_deg));
  }
  for (const geometry of geometries) {
    const stretch = 1 / Math.max(Math.cos(geometry.center[1] * Math.PI / 180), 0.01);
    if (Math.abs(wrappedRaDelta(grid.centerRaDeg, geometry.center[0])) + grid.raSpanDeg / 2 >= 180) unknownBoundary = true;
    boundary += footprintTube(geometry.footprint, stretch, diagonal);
  }
  const boxArea = bounds.ra_span_deg * (bounds.dec_max_deg - bounds.dec_min_deg);
  boundary = unknownBoundary ? boxArea : Math.min(boxArea, boundary);
  // cos has global derivative <= pi/180 per degree. A cell midpoint is at
  // most dy/2 away in DEC; exterior cells are included in the safe upper bound.
  const weightError = boxArea * Math.PI / 180 * dy / 2;
  const numericalError = Math.min(boxArea, boundary + weightError);
  const error = numericalError + 0.00005; // Four-decimal historical area reporting.
  const sampledArea = grid.totalWeight * grid.cellAreaDeg2;
  const fractionError = sampledArea > numericalError ? Math.min(1, 2 * numericalError / (sampledArea - numericalError) + 0.000005) : 1;
  return { boundary_cell_area_upper_bound_deg2: boundary,
    area_error_upper_bound_deg2: error, fraction_error_upper_bound: fractionError,
    geometry_projection_error_bound_deg2: null, model: "cos_dec_weighted_ra_dec" };
}

function footprintTube(footprint: Footprint, stretch: number, diagonal: number): number {
  if (footprint.type === "compound") return footprint.components.reduce((sum, child) => sum + footprintTube(child.footprint, stretch, diagonal), 0);
  if (footprint.type === "circle") {
    // The affine sky adapter sends a circle to an ellipse. Its curve length is
    // <= stretch*2*pi*R; a closed convex curve's tube has area <= 2*d*L+pi*d².
    const radius = diagonal + 1e-12 * stretch;
    return 4 * Math.PI * radius * footprint.radius_deg * stretch + Math.PI * radius ** 2;
  }
  const path = footprintBoundary(footprint)[0];
  let area = 0;
  for (let i = 1; i < path.length; i += 1) {
    const localLength = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    const length = localLength * stretch;
    // Polygon segment containment's frozen cross/dot tolerances depend on
    // edge length; include their possible displacement in the capsule radius.
    const tolerance = footprint.type === "polygon" ? 2e-12 * Math.max(1, localLength) / localLength : 2e-12;
    const radius = diagonal + tolerance * stretch;
    area += 2 * radius * length + Math.PI * radius ** 2;
  }
  return area;
}
