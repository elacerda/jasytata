import type { CenterInput, Footprint, GenericLatticeTiling, SkyPolygon } from "../types";
import { footprintIntersectsRegion, footprintLocalBounds, localOffsetToSky, skyToLocalOffset } from "./footprint-engine";
import { polygonBounds } from "./geometry";
import { modulo, radians } from "./math";

type Basis = GenericLatticeTiling["basis_deg"];

/** Integer lattice coordinates and east/north displacement from its origin, in degrees. */
export interface LatticePoint {
  i: number;
  j: number;
  x_deg: number;
  y_deg: number;
}

/** Inclusive finite integer ranges enclosing potentially intersecting centers. */
export interface LatticeRange {
  i_min: number;
  i_max: number;
  j_min: number;
  j_max: number;
}

/** Candidate retaining both its integer lattice identity and ICRS center. */
export interface LatticeCandidate extends LatticePoint {
  ra_deg: number;
  dec_deg: number;
}

/** Compute `i*b1 + j*b2` without any independent lattice rotation.
 * @param i - Safe integer coefficient of the first basis vector.
 * @param j - Safe integer coefficient of the second basis vector.
 * @param basis - Two validated non-collinear east/north vectors in degrees.
 * @returns Integer coordinates and local east/north displacement in degrees.
 * @throws If coefficients or the computed position cannot be represented finitely.
 */
export function latticePoint(i: number, j: number, basis: Basis): LatticePoint {
  const x = i * basis[0][0] + j * basis[1][0];
  const y = i * basis[0][1] + j * basis[1][1];
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(j) || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Lattice coordinates must be safe integers with finite local positions");
  }
  return { i, j, x_deg: x === 0 ? 0 : x, y_deg: y === 0 ? 0 : y };
}

/** Choose the tangent-plane origin and lattice phase deterministically.
 * @param region - Validated ICRS polygon with a continuous RA span at most 180 degrees.
 * @param tiling - Declared lattice basis and placement.
 * @returns Fixed ICRS anchor, or midpoint of unwrapped RA and DEC region bounds.
 */
export function latticePlanningOrigin(region: SkyPolygon, tiling: GenericLatticeTiling): CenterInput {
  if (tiling.origin.type === "fixed_anchor") return { ra_deg: tiling.origin.ra_deg, dec_deg: tiling.origin.dec_deg };
  const bounds = polygonBounds(region);
  return {
    ra_deg: modulo(bounds.ra_start_deg + bounds.ra_span_deg / 2, 360),
    dec_deg: (bounds.dec_min_deg + bounds.dec_max_deg) / 2,
  };
}

/** Bound lattice coefficients by applying the inverse basis to expanded local corners.
 *
 * Region vertices use the Gate 3 wrapped-RA tangent approximation. Footprint
 * bounds include camera PA, component offsets, and gaps. The east reach is
 * conservatively rescaled by the smallest clamped cosine over possible center
 * declinations, since footprint intersection uses each candidate's local plane.
 *
 * @param region - Validated ICRS polygon in decimal degrees.
 * @param basis - Validated east/north degree vectors, interpreted as matrix columns.
 * @param origin - ICRS origin of the planning tangent plane and coefficient (0,0).
 * @param footprint - Instrument geometry, independent of lattice orientation.
 * @returns Inclusive integer coefficient bounds; enumeration remains finite.
 * @throws If projection crosses the anchor's RA branch or inverse/range is unrepresentable.
 */
export function candidateLatticeRange(region: SkyPolygon, basis: Basis, origin: CenterInput, footprint: Footprint): LatticeRange {
  const vertices = region.vertices.map((point) => skyToLocalOffset(point, origin));
  const cosine = Math.max(Math.cos(radians(origin.dec_deg)), 0.01);
  const east = vertices.map((point) => point[0]);
  const north = vertices.map((point) => point[1]);
  if ((Math.max(...east) - Math.min(...east)) / cosine > 180) {
    throw new Error("Region crosses the fixed anchor's tangent-plane RA branch; use a nearby anchor");
  }
  const reach = footprintLocalBounds(footprint);
  const minY = Math.max(-90 - origin.dec_deg, Math.min(...north) - reach.max_north_deg);
  const maxY = Math.min(90 - origin.dec_deg, Math.max(...north) - reach.min_north_deg);
  const minCosine = Math.max(0.01, Math.min(Math.cos(radians(origin.dec_deg + minY)), Math.cos(radians(origin.dec_deg + maxY))));
  const eastScale = cosine / minCosine;
  const minX = Math.min(...east) - Math.max(0, reach.max_east_deg) * eastScale;
  const maxX = Math.max(...east) - Math.min(0, reach.min_east_deg) * eastScale;
  if (minX <= -180 * cosine || maxX >= 180 * cosine || maxX - minX > 180 * cosine) {
    throw new Error("Region plus footprint reach exceeds the local tangent-plane RA branch; reduce the region or use a nearby anchor");
  }
  // Normalize columns before inversion to avoid determinant overflow/underflow.
  const firstLength = Math.hypot(...basis[0]);
  const secondLength = Math.hypot(...basis[1]);
  const [a, c] = basis[0].map((value) => value / firstLength);
  const [b, d] = basis[1].map((value) => value / secondLength);
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) throw new Error("Lattice basis is degenerate");
  const corners = [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]];
  const indices = corners.map(([x, y]) => [(d * x - b * y) / determinant / firstLength, (a * y - c * x) / determinant / secondLength]);
  // One integer of padding makes boundary rounding conservative.
  const range = {
    i_min: Math.floor(Math.min(...indices.map(([i]) => i))) - 1,
    i_max: Math.ceil(Math.max(...indices.map(([i]) => i))) + 1,
    j_min: Math.floor(Math.min(...indices.map(([, j]) => j))) - 1,
    j_max: Math.ceil(Math.max(...indices.map(([, j]) => j))) + 1,
  };
  if (!Object.values(range).every(Number.isSafeInteger)) throw new Error("Lattice candidate range cannot be represented by safe integers");
  return range;
}

/** Generate finite candidates in canonical order: ascending j, then ascending i.
 *
 * Uses footprint-region positive-area intersection from Gate 3 for retention.
 * No inference, overlap-derived spacing, center perturbation, or gap-fill occurs.
 *
 * @param region - Validated ICRS polygon in decimal degrees.
 * @param tiling - Validated authoritative basis and explicit origin.
 * @param footprint - Validated instrument footprint, including its own PA.
 * @param maxCandidates - Existing planner candidate budget, checked before enumeration.
 * @returns Relevant ICRS centers with integer coefficients and local degree offsets.
 * @throws If the finite bounding range exceeds the budget or is unrepresentable.
 */
export function generateLatticeCandidates(region: SkyPolygon, tiling: GenericLatticeTiling, footprint: Footprint, maxCandidates: number): LatticeCandidate[] {
  const origin = latticePlanningOrigin(region, tiling);
  const range = candidateLatticeRange(region, tiling.basis_deg, origin, footprint);
  const count = (range.i_max - range.i_min + 1) * (range.j_max - range.j_min + 1);
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || !Number.isSafeInteger(count) || count > maxCandidates) {
    throw new Error(`This region produces ${count} lattice search candidates; reduce the selected area to at most ${maxCandidates}.`);
  }
  const candidates: LatticeCandidate[] = [];
  const halfRaBranch = 180 * Math.max(Math.cos(radians(origin.dec_deg)), 0.01);
  for (let j = range.j_min; j <= range.j_max; j += 1) {
    for (let i = range.i_min; i <= range.i_max; i += 1) {
      const point = latticePoint(i, j, tiling.basis_deg);
      // Padding may include remote sites; do not wrap them into duplicate sky centers.
      if (Math.abs(point.x_deg) >= halfRaBranch) continue;
      const [ra, dec] = localOffsetToSky(origin, [point.x_deg, point.y_deg]);
      if (Math.abs(dec) >= 90) continue;
      const candidate = { ...point, ra_deg: ra, dec_deg: dec };
      if (footprintIntersectsRegion(footprint, candidate, region)) candidates.push(candidate);
    }
  }
  return candidates;
}
