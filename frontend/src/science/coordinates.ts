/** ICRS coordinate conversion compatible with the Python Astropy entry points. */
export type RaUnit = "auto" | "degrees" | "hours";

/** Normalize a finite right ascension to [0, 360) degrees.
 * @param degrees - ICRS right ascension in decimal degrees.
 * @returns Equivalent longitude in [0, 360) degrees.
 * @throws If the coordinate is not finite.
 */
export function normalizeRa(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new Error("RA must be finite");
  if (degrees >= 0 && degrees < 360) return degrees;
  return ((degrees % 360) + 360) % 360;
}

function angleParts(text: string, sexagesimal: boolean): number | null {
  const cleaned = text.trim().replace(/([hHdD°])\s*/g, ":").replace(/([mM′'])\s*/g, ":").replace(/[sS″"]/g, "").replace(/:+$/, "");
  const parts = cleaned.split(sexagesimal || /[:\s]/.test(cleaned) ? /[:\s]+/ : /\s+/);
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part))) return null;
  if (numbers.length > 1 && (numbers.slice(1).some((part) => part < 0 || part > 60) || !Number.isInteger(numbers[0]))) return null;
  if (numbers.length > 2 && !Number.isInteger(numbers[1])) return null;
  const sign = parts[0].startsWith("-") ? -1 : 1;
  return sign * (Math.abs(numbers[0]) + (numbers[1] ?? 0) / 60 + (numbers[2] ?? 0) / 3600);
}

function explicitUnitFactor(text: string): number | null {
  if (/[hH]/.test(text)) return 15;
  if (/[dD°]/.test(text)) return 1;
  if (/[mM′']/.test(text)) return 1 / 60;
  if (/[sS″"]/.test(text)) return 1 / 3600;
  return null;
}

/** Parse decimal degrees or sexagesimal hours as ICRS RA.
 * @param value - Decimal degrees, numeric hours in hours mode, sexagesimal fields, or explicit h/d/m/s angular units.
 * @param unit - Interpretation of numeric values; auto uses degrees except for sexagesimal input.
 * @returns Normalized right ascension in decimal degrees.
 * @throws If the value, unit, or angular range is invalid.
 */
export function parseRaDegrees(value: string, unit: RaUnit = "auto"): number {
  const text = value.trim();
  if (!["auto", "degrees", "hours"].includes(unit)) throw new Error("RA unit must be auto, degrees, or hours");
  const sexagesimal = text.includes(":") || text.split(/\s+/).length === 3;
  if (unit === "degrees" && sexagesimal) throw new Error(`Invalid RA '${value}'; sexagesimal hours conflict with degrees mode`);
  const angle = angleParts(text, sexagesimal);
  const factor = explicitUnitFactor(text) ?? (sexagesimal || unit === "hours" ? 15 : 1);
  if (angle === null || (sexagesimal && factor === 15 && Math.abs(angle) > 24)) throw new Error(`Invalid RA '${value}'; use sexagesimal hours or decimal degrees`);
  const degrees = angle * factor;
  if (!sexagesimal && unit !== "hours" && (degrees < 0 || degrees > 360)) throw new Error(`Invalid RA '${value}'; decimal degrees must be between 0 and 360`);
  if (unit === "hours" && (degrees < 0 || degrees > 360)) throw new Error(`Invalid RA '${value}'; hours must be between 0 and 24`);
  return normalizeRa(degrees);
}

/** Parse signed decimal or sexagesimal ICRS declination.
 * @param value - Declination in degrees, optionally with sexagesimal or explicit angular units.
 * @returns Declination in decimal degrees within [-90, 90].
 * @throws If the coordinate is malformed or outside the physical range.
 */
export function parseDecDegrees(value: string): number {
  const angle = angleParts(value, /[:\sdD°′'″"]/.test(value.trim()));
  if (angle === null) throw new Error(`Invalid DEC '${value}'; use sexagesimal degrees or decimal degrees`);
  const degrees = angle * (explicitUnitFactor(value) ?? 1);
  if (degrees < -90 || degrees > 90) throw new Error(`Invalid DEC '${value}'; degrees must be between -90 and 90`);
  return degrees;
}

function formatAngle(value: number, precision: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(precision) || precision < 0 || precision > 12) throw new Error("Invalid coordinate or precision");
  const scale = 10 ** precision;
  const ticks = Math.round(Math.abs(value) * 3600 * scale);
  const field = Math.floor(ticks / (3600 * scale));
  const minutes = Math.floor(ticks / (60 * scale)) % 60;
  const seconds = (ticks % (60 * scale)) / scale;
  const secondsText = seconds.toFixed(precision).padStart(precision ? precision + 3 : 2, "0");
  return `${String(field).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secondsText}`;
}

/** Format ICRS RA degrees as padded sexagesimal hours.
 * @param raDeg - Right ascension in decimal degrees.
 * @param precision - Decimal places in the seconds field.
 * @returns HH:MM:SS string, with fractional seconds when requested.
 */
export function formatRaDegrees(raDeg: number, precision = 0): string {
  return formatAngle(normalizeRa(raDeg) / 15, precision);
}

/** Format ICRS declination as padded signed sexagesimal degrees.
 * @param decDeg - Declination in decimal degrees.
 * @param precision - Decimal places in the seconds field.
 * @returns [+|-]DD:MM:SS string, with fractional seconds when requested.
 */
export function formatDecDegrees(decDeg: number, precision = 0): string {
  return `${decDeg < 0 || Object.is(decDeg, -0) ? "-" : ""}${formatAngle(decDeg, precision)}`;
}
