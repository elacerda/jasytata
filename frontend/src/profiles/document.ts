import type { InstrumentProfileV2, SurveyProfileV2 } from "../types";
import { ProfileError, profileValidation } from "./errors";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";

/** Existing bundled-file contract: one instrument and its associated survey.
 * Each member declares schema_version: 2; there is no additional manifest.
 */
export interface ProfileDocument {
  instrument: InstrumentProfileV2;
  survey: SurveyProfileV2;
}

/** Validate a complete profile file, normalizing it through the scientific validators.
 * @param value - Untrusted JSON-compatible object with instrument and survey members.
 * @returns Independent Schema v2 configuration after every declared object has
 *   passed strict field validation.
 * @throws ProfileError for invalid structure, version, science, or mismatched reference.
 */
export function validateProfileDocument(value: unknown): ProfileDocument {
  return profileValidation("invalid_structure", () => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProfileError("invalid_structure", "Profile document must be an object containing instrument and survey");
    }
    const document = value as Record<string, unknown>;
    const unknownFields = Object.keys(document).filter((field) => field !== "instrument" && field !== "survey");
    if (unknownFields.length > 0) {
      throw new Error(`Profile document contains unsupported field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`);
    }
    const instrument = validateInstrumentProfileV2(document.instrument);
    const survey = validateSurveyProfileV2(document.survey);
    if (survey.instrument_id !== instrument.id) {
      throw new ProfileError("unresolved_reference", `Survey instrument_id "${survey.instrument_id}" does not match document instrument "${instrument.id}"`);
    }
    return { instrument, survey };
  });
}

/** Parse a user profile JSON file without executing code or mutating a registry.
 * @param text - UTF-8-decoded JSON text in the established instrument/survey format.
 * @returns Typed, normalized scientific configuration after full validation.
 * @throws ProfileError distinguishing JSON, version, structure, geometry, tiling,
 *   policy, and reference failures. Scientific values are never coerced.
 */
export function parseProfileJson(text: string): ProfileDocument {
  const value: unknown = profileValidation("invalid_json", () => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProfileError("invalid_json", "Malformed profile JSON: check JSON syntax");
    }
  });
  return validateProfileDocument(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, member]) => [key, stableValue(member)]));
  }
  return value;
}

/** Canonically serialize configuration only, through the same validation as import.
 * @param document - Instrument/survey configuration using only declared Schema v2 fields.
 * @returns Deterministic pretty JSON with sorted object keys and a final newline.
 *   Arrays retain order, and scientific numbers retain their JSON representation.
 * @throws ProfileError if the configuration would not pass ordinary file import.
 */
export function serializeProfile(document: ProfileDocument): string {
  return `${JSON.stringify(stableValue(validateProfileDocument(document)), null, 2)}\n`;
}
