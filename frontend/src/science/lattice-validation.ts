import type { GenericLatticeTiling, TangentPlaneOffset } from "../types";

/** Frozen dimensionless cutoff for the normalized determinant of two basis vectors. */
export const LATTICE_BASIS_DEGENERACY_TOLERANCE = 1e-12;

type LatticeBasis = GenericLatticeTiling["basis_deg"];

/** Validate the shared canonical two-vector lattice basis.
 *
 * The determinant is formed after normalizing each vector, so this test does
 * not overflow or underflow merely because the authored angular scale is very
 * large or small. The cutoff matches Schema v2 and the pre-existing candidate
 * generator contract.
 *
 * @param value - Untrusted two-vector east/north basis; components are degrees.
 * @returns Nothing when the basis is finite and non-degenerate.
 * @throws If either vector is malformed, non-finite, zero length, or too close
 *   to collinear under the frozen normalized determinant tolerance.
 */
export function validateLatticeBasis(value: unknown): asserts value is LatticeBasis {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Lattice requires two basis vectors");
  const vectors = value as unknown[];
  for (const [index, vector] of vectors.entries()) {
    if (!Array.isArray(vector) || vector.length !== 2) throw new Error(`Lattice basis vector ${index + 1} must have two components`);
    if (!vector.every((component) => typeof component === "number" && Number.isFinite(component))) {
      throw new Error(`Lattice basis vector ${index + 1} components must be finite`);
    }
  }

  const [first, second] = vectors as TangentPlaneOffset[];
  const firstLength = Math.hypot(first[0], first[1]);
  const secondLength = Math.hypot(second[0], second[1]);
  if (!Number.isFinite(firstLength) || !Number.isFinite(secondLength)) throw new Error("Lattice vector lengths must be finite");
  if (firstLength === 0 || secondLength === 0) throw new Error("Lattice basis vectors must be non-zero");

  const normalizedDeterminant = (first[0] / firstLength) * (second[1] / secondLength) -
    (first[1] / firstLength) * (second[0] / secondLength);
  if (!Number.isFinite(normalizedDeterminant) || Math.abs(normalizedDeterminant) <= LATTICE_BASIS_DEGENERACY_TOLERANCE) {
    throw new Error("Lattice basis vectors must not be collinear or degenerate");
  }
}

/** Validate a fixed lattice anchor inside the supported local projection domain.
 *
 * ICRS RA is canonical in [0, 360) degrees. DEC must be strictly between the
 * poles because the local lattice projection is not defined at an exact pole.
 *
 * @param raDeg - Fixed-anchor ICRS right ascension in degrees.
 * @param decDeg - Fixed-anchor ICRS declination in degrees.
 * @returns Nothing when the coordinates are finite and projection-supported.
 * @throws If RA is outside [0, 360), DEC is outside (-90, 90), or either value
 *   is non-finite.
 */
export function validateFixedLatticeAnchor(raDeg: unknown, decDeg: unknown): void {
  if (typeof raDeg !== "number" || !Number.isFinite(raDeg)) throw new Error("Lattice anchor RA must be finite");
  if (typeof decDeg !== "number" || !Number.isFinite(decDeg)) throw new Error("Lattice anchor DEC must be finite");
  if (raDeg < 0 || raDeg >= 360 || Math.abs(decDeg) >= 90) {
    throw new Error("Lattice anchor must have RA in [0, 360) and DEC in (-90, 90)");
  }
}
