import type { CenterInput, Footprint } from "../types";
import { localOffsetToSky } from "./footprint-engine";

/** One ordered local sky offset and relative rotation in a named sequence.
 *
 * Offsets are tangent-plane east/north arcseconds from the nominal pointing
 * center. `rotation_deg` is an optional rotation east of north relative to the
 * nominal pointing PA.
 */
export interface ExposureOffset {
  order: number;
  east_arcsec: number;
  north_arcsec: number;
  rotation_deg?: number;
}

/** Ordered, stable-identity exposure sequence attached to a strategy. */
export interface ObservingSequence {
  id: string;
  exposures: readonly ExposureOffset[];
}

/** Nominal scientific pointing input for exposure derivation. */
export interface SequencePointing {
  id: string;
  center: Pick<CenterInput, "ra_deg" | "dec_deg">;
  /** Resolved absolute astronomical PA in degrees east of north, when declared. */
  positionAngleDeg?: number;
}

/** One derived exposure placement and its declared/computational orientation.
 *
 * `positionAngleDeg` is absent when the pointing has no scientifically declared
 * PA. A relative rotation nonzero modulo 360° requires a declared nominal PA because it
 * cannot independently establish an absolute exposure orientation.
 */
export interface ExposurePlacement {
  id: string;
  order: number;
  center: [number, number];
  eastOffsetArcsec: number;
  northOffsetArcsec: number;
  relativeRotationDeg: number;
  positionAngleDeg?: number;
  geometryPositionAngleDeg?: number;
}

/** One instrument footprint placed for one derived exposure. */
export interface ExposureFootprint {
  exposure: ExposurePlacement;
  footprint: Footprint;
}

/** Effective sequence geometry as an ordered union of exposure footprints.
 *
 * Geometry consumers must evaluate membership as a union, so overlaps count
 * once. The original instrument footprint remains unmodified.
 */
export interface EffectiveSequenceFootprint {
  type: "exposure_union";
  exposures: readonly ExposureFootprint[];
}

/** Normalize an astronomical angle to `[0, 360)` without changing inputs.
 *
 * @param angleDeg - Finite angle in degrees east of north.
 * @returns Equivalent angle in `[0, 360)`.
 * @throws {RangeError} If the angle is not finite.
 */
export function normalizeSequenceAngle(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) throw new RangeError("Sequence angles must be finite.");
  const normalized = ((angleDeg % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/** Derive deterministic sky placements for a pointing's ordered exposures.
 *
 * Offsets are converted from east/north arcseconds to degrees and passed to
 * Jasytata's canonical tangent-plane-to-ICRS projection. Offset coordinates
 * are independent of pointing PA. With no sequence, one exposure at the
 * nominal center is returned to preserve historical single-exposure behavior.
 *
 * @param pointing - Stable pointing ID, ICRS center, and optional resolved PA.
 * @param sequence - Optional validated-by-this-function observing sequence.
 * @returns Ordered exposure centers, identities, and resolved orientations.
 * @throws {RangeError} If the PA, offsets, or relative rotations are nonfinite,
 *   or if a rotation nonzero modulo 360° has no declared nominal PA.
 * @throws {Error} If the sequence ID or order values are invalid.
 */
export function deriveExposurePlacements(
  pointing: SequencePointing,
  sequence?: ObservingSequence,
): ExposurePlacement[] {
  if (!pointing.id.trim()) throw new Error("Pointing ID must be non-empty.");
  if (pointing.positionAngleDeg !== undefined && !Number.isFinite(pointing.positionAngleDeg)) {
    throw new RangeError("Pointing PA must be finite when supplied.");
  }

  const offsets = sequence === undefined
    ? [{ order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 }]
    : validateSequence(sequence);
  const nominalPA = pointing.positionAngleDeg;

  return offsets.map((offset) => {
    const relativeRotationDeg = offset.rotation_deg ?? 0;
    if (nominalPA === undefined && normalizeSequenceAngle(relativeRotationDeg) !== 0) {
      throw new RangeError("A nonzero exposure rotation requires a declared pointing PA.");
    }
    const center = localOffsetToSky(pointing.center, [
      offset.east_arcsec / 3600,
      offset.north_arcsec / 3600,
    ]);
    const declaredPA = nominalPA === undefined
      ? undefined
      : normalizeSequenceAngle(nominalPA + relativeRotationDeg);
    const geometryPA = declaredPA;

    return {
      id: `${sequence?.id ?? pointing.id}:${offset.order}`,
      order: offset.order,
      center,
      eastOffsetArcsec: offset.east_arcsec,
      northOffsetArcsec: offset.north_arcsec,
      relativeRotationDeg,
      ...(declaredPA === undefined ? {} : { positionAngleDeg: declaredPA }),
      ...(geometryPA === undefined ? {} : { geometryPositionAngleDeg: geometryPA }),
    };
  });
}

/** Pair each ordered exposure placement with the same immutable profile shape.
 *
 * The returned list is the effective sequence-union representation; coverage
 * consumers evaluate the ordered shapes as a geometric union rather than
 * summing their areas. With no sequence, this contains the historical single
 * footprint at the nominal center.
 *
 * @param pointing - Stable pointing ID, ICRS center, and optional resolved PA.
 * @param footprint - Instrument footprint; it is retained by reference and not
 *   modified.
 * @param sequence - Optional ordered exposure sequence.
 * @returns Ordered per-exposure footprint placements representing the union.
 */
export function deriveEffectiveSequenceFootprint(
  pointing: SequencePointing,
  footprint: Footprint,
  sequence?: ObservingSequence,
): EffectiveSequenceFootprint {
  return {
    type: "exposure_union",
    exposures: deriveExposurePlacements(pointing, sequence).map((exposure) => ({
      exposure,
      footprint,
    })),
  };
}

function validateSequence(sequence: ObservingSequence): ExposureOffset[] {
  if (!sequence.id.trim()) throw new Error("Sequence ID must be non-empty.");
  if (sequence.exposures.length === 0) throw new Error("A sequence must contain at least one exposure.");

  const exposures = [...sequence.exposures];
  for (let index = 0; index < exposures.length; index += 1) {
    const exposure = exposures[index];
    if (!Number.isInteger(exposure.order) || exposure.order !== index + 1) {
      throw new Error("Exposure order must be unique, contiguous, and 1-based.");
    }
    if (!Number.isFinite(exposure.east_arcsec) || !Number.isFinite(exposure.north_arcsec)) {
      throw new RangeError("Exposure offsets must be finite arcsecond values.");
    }
    if (exposure.rotation_deg !== undefined && !Number.isFinite(exposure.rotation_deg)) {
      throw new RangeError("Exposure relative rotation must be finite.");
    }
  }
  return exposures;
}
