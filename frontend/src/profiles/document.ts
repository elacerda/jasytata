import type {
  InstrumentProfileV2,
  InstrumentProfileV3,
  SurveyProfileV2,
  SurveyProfileV3,
} from "../types";
import { ProfileError, profileValidation } from "./errors";
import {
  validateInstrumentProfileV2,
  validateSurveyProfileV2,
} from "./schema-v2";
import {
  validateInstrumentProfileV3,
  validateSurveyProfileV3,
} from "./schema-v3";

/** Existing Schema v2 file contract: one instrument and its associated survey. */
export interface ProfileDocument {
  instrument: InstrumentProfileV2;
  survey: SurveyProfileV2;
}

/** Schema v3 standalone instrument document. */
export interface InstrumentProfileDocumentV3 {
  instrument: InstrumentProfileV3;
  survey?: never;
}

/** Schema v3 standalone survey document, referencing an already registered instrument. */
export interface SurveyProfileDocumentV3 {
  survey: SurveyProfileV3;
  instrument?: never;
}

/** Schema v3 document containing an explicitly matching instrument and survey. */
export interface ProfilePairDocumentV3 {
  instrument: InstrumentProfileV3;
  survey: SurveyProfileV3;
}

/** Any valid v2 or v3 profile document accepted by the reader. */
export type AnyProfileDocument = ProfileDocument
  | InstrumentProfileDocumentV3
  | SurveyProfileDocumentV3
  | ProfilePairDocumentV3;

/** Validate a complete Schema v2 profile file for legacy typed callers.
 * @param value - Untrusted JSON-compatible object with instrument and survey members.
 * @returns Independent Schema v2 configuration after strict field validation.
 * @throws ProfileError for invalid structure, version, science, or mismatched reference.
 */
export function validateProfileDocument(value: ProfileDocument): ProfileDocument;
/** Validate and explicitly dispatch an untrusted v2 or v3 profile document.
 * @param value - JSON-compatible object with the exact members allowed by its versions.
 * @returns A normalized v2 pair or an explicit v3 standalone/matching document.
 * @throws ProfileError for invalid structure, unsupported versions, or invalid science.
 */
export function validateProfileDocument(value: unknown): AnyProfileDocument;
export function validateProfileDocument(value: unknown): AnyProfileDocument {
  return profileValidation("invalid_structure", () => {
    const document = requireRecord(value, "Profile document must be an object");
    const keys = Object.keys(document);
    const unknownFields = keys.filter((field) => field !== "instrument" && field !== "survey");
    if (unknownFields.length > 0) {
      throw new Error(`Profile document contains unsupported field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`);
    }

    const hasInstrument = Object.hasOwn(document, "instrument");
    const hasSurvey = Object.hasOwn(document, "survey");
    if (!hasInstrument && !hasSurvey) {
      throw new ProfileError("invalid_structure", "Profile document must contain an instrument, a survey, or a matching pair");
    }

    const instrumentVersion = hasInstrument ? schemaVersionOf(document.instrument, "instrument") : undefined;
    const surveyVersion = hasSurvey ? schemaVersionOf(document.survey, "survey") : undefined;

    if (hasInstrument && hasSurvey && instrumentVersion !== surveyVersion) {
      throw new ProfileError("invalid_structure", "Profile document cannot mix Schema v2 and v3 members");
    }

    if (instrumentVersion === 2 || surveyVersion === 2) {
      if (!hasInstrument || !hasSurvey) {
        throw new ProfileError("invalid_structure", "Schema v2 profile documents require both instrument and survey members");
      }
      return validateV2Pair(document);
    }

    if (instrumentVersion === 3 && surveyVersion === 3) {
      return validateV3Pair(document);
    }
    if (instrumentVersion === 3) {
      return { instrument: validateInstrumentProfileV3(document.instrument) };
    }
    if (surveyVersion === 3) {
      return { survey: validateSurveyProfileV3(document.survey) };
    }

    // The no-version and invalid-version cases are reported by schemaVersionOf.
    throw new ProfileError("unsupported_schema", "Profile document has no supported schema version");
  });
}

/** Validate a Schema v2 pair for code paths whose contract requires the legacy shape.
 * @param value - Untrusted two-member Schema v2 profile document.
 * @returns An independently validated v2 instrument/survey pair.
 * @throws ProfileError for malformed structure, unsupported versions, science, or references.
 */
export function validateProfileDocumentV2(value: unknown): ProfileDocument {
  return profileValidation("invalid_structure", () => {
    const document = requireRecord(value, "Profile document must be an object");
    const keys = Object.keys(document);
    const unknownFields = keys.filter((field) => field !== "instrument" && field !== "survey");
    if (unknownFields.length > 0) {
      throw new Error(`Profile document contains unsupported field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`);
    }
    if (keys.length !== 2 || !Object.hasOwn(document, "instrument") || !Object.hasOwn(document, "survey")) {
      throw new ProfileError("invalid_structure", "Schema v2 profile documents require both instrument and survey members");
    }
    const instrumentVersion = schemaVersionOf(document.instrument, "instrument");
    const surveyVersion = schemaVersionOf(document.survey, "survey");
    if (instrumentVersion !== 2 || surveyVersion !== 2) {
      throw new ProfileError("unsupported_schema", "Schema v2 profile documents require Schema v2 members");
    }
    return validateV2Pair(document);
  });
}

/** Parse a user profile JSON file without executing code or mutating a registry.
 * @param text - UTF-8-decoded JSON text in a supported profile document shape.
 * @returns Typed, normalized v2 or v3 scientific configuration after validation.
 * @throws ProfileError distinguishing JSON, version, structure, science, and reference failures.
 */
export function parseProfileJson(text: string): AnyProfileDocument {
  const value: unknown = profileValidation("invalid_json", () => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProfileError("invalid_json", "Malformed profile JSON: check JSON syntax");
    }
  });
  return validateProfileDocument(value);
}

/** Parse and require an established Schema v2 pair.
 * @param text - UTF-8-decoded JSON text containing a v2 instrument/survey pair.
 * @returns Typed, normalized Schema v2 configuration.
 * @throws ProfileError for malformed JSON, v3 input, invalid values, or references.
 */
export function parseProfileJsonV2(text: string): ProfileDocument {
  const value: unknown = profileValidation("invalid_json", () => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProfileError("invalid_json", "Malformed profile JSON: check JSON syntax");
    }
  });
  return validateProfileDocumentV2(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, member]) => [key, stableValue(member)]));
  }
  return value;
}

/** Canonically serialize a validated v2 or v3 profile document.
 * @param document - Declarative profile configuration, without runtime planner state.
 * @returns Deterministic pretty JSON with sorted object keys and a final newline.
 *   Arrays retain order, including the scientifically meaningful exposure sequence order.
 * @throws ProfileError if the configuration would not pass ordinary file import.
 */
export function serializeProfile(document: AnyProfileDocument): string {
  return `${JSON.stringify(stableValue(validateProfileDocument(document)), null, 2)}\n`;
}

function validateV2Pair(document: Record<string, unknown>): ProfileDocument {
  const instrument = validateInstrumentProfileV2(document.instrument);
  const survey = validateSurveyProfileV2(document.survey);
  if (survey.instrument_id !== instrument.id) {
    throw new ProfileError("unresolved_reference", `Survey instrument_id "${survey.instrument_id}" does not match document instrument "${instrument.id}"`);
  }
  return { instrument, survey };
}

function validateV3Pair(document: Record<string, unknown>): ProfilePairDocumentV3 {
  const instrument = validateInstrumentProfileV3(document.instrument);
  const survey = validateSurveyProfileV3(document.survey);
  if (survey.instrument_id !== instrument.id) {
    throw new ProfileError("unresolved_reference", `Survey instrument_id "${survey.instrument_id}" does not match document instrument "${instrument.id}"`);
  }
  return { instrument, survey };
}

function schemaVersionOf(value: unknown, member: string): 2 | 3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError("invalid_structure", `Profile document ${member} must be an object`);
  }
  const version = (value as Record<string, unknown>).schema_version;
  if (version !== 2 && version !== 3) {
    throw new ProfileError("unsupported_schema", `Unsupported or missing ${member} schema_version; supported versions are 2 and 3`);
  }
  return version;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError("invalid_structure", message);
  }
  return value as Record<string, unknown>;
}
