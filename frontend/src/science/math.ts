/** Small numerical helpers shared by the ICRS planner and sampler. */
export const radians = (degrees: number): number => degrees * Math.PI / 180;
export const degrees = (angle: number): number => angle * 180 / Math.PI;

/** Python-compatible positive modulo for finite angular quantities.
 * @param value - Angular displacement or phase.
 * @param period - Positive cycle length in the same units.
 * @returns Value in [0, period).
 */
export function modulo(value: number, period: number): number {
  const remainder = value % period;
  return remainder < 0 ? remainder + period : remainder;
}

/** Shortest signed RA difference in degrees across zero.
 * @param ra - ICRS RA in degrees.
 * @param reference - ICRS reference RA in degrees.
 * @returns Signed difference in [-180, 180) degrees.
 */
export function wrappedRaDelta(ra: number, reference: number): number {
  return modulo(ra - reference + 180, 360) - 180;
}

/** Median with NumPy's even-sample averaging convention.
 * @param values - Non-empty finite numeric sample.
 * @returns Median in the same units as the input.
 */
export function median(values: readonly number[]): number {
  if (!values.length) throw new Error("Median requires values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Round an IEEE-754 value to decimal places using Python's nearest-even rule.
 * @param value - Finite floating-point value.
 * @param digits - Nonnegative decimal places, at most 15.
 * @returns Rounded value, preserving the sign of zero.
 * @throws If value or digits fall outside the supported finite range.
 */
export function roundDecimal(value: number, digits: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 15) {
    throw new Error("Decimal rounding requires a finite value and 0 to 15 places");
  }
  if (value === 0) return value;
  const factor = 10 ** digits;
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(value));
  const high = bits.getUint32(0);
  const low = bits.getUint32(4);
  const exponentBits = (high >>> 20) & 0x7ff;
  const significand = (exponentBits ? 1n << 52n : 0n) |
    (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const exponent = exponentBits ? exponentBits - 1023 - 52 : -1074;
  let numerator = significand * 10n ** BigInt(digits);
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = quotient + (2n * remainder > denominator ||
    (2n * remainder === denominator && quotient % 2n === 1n) ? 1n : 0n);
  return (value < 0 ? -1 : 1) * Number(rounded) / factor;
}

/** Lexicographic numeric tuple comparison for deterministic planner ranking.
 * @param left - First numeric score tuple.
 * @param right - Second numeric score tuple.
 * @returns Negative, zero, or positive ordering result.
 */
export function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}
