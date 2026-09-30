import type {
  InstrumentProfileV2,
  InstrumentProfileV3,
  SurveyProfileV2,
  SurveyProfileV3,
} from "../types";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";
import { validateInstrumentProfileV3, validateSurveyProfileV3 } from "./schema-v3";
import { deriveExposurePlacements } from "../science/exposure-sequence";
import { BUNDLED_PROFILE_DOCUMENT } from "./v2";
import kcwiInstruments from "./kcwi-slicers.json";

import {
  validateProfileDocument,
  type AnyProfileDocument,
  type ProfileDocument,
  type ProfilePairDocumentV3,
  type InstrumentProfileDocumentV3,
  type SurveyProfileDocumentV3,
} from "./document";
import { ProfileError } from "./errors";

export type AnyInstrumentProfile = InstrumentProfileV2 | InstrumentProfileV3;
export type AnySurveyProfile = SurveyProfileV2 | SurveyProfileV3;

/** Browser-memory registry for validated instrument and survey profiles.
 *
 * IDs are unique within each profile kind. Registration validates and stores a
 * private copy; lookups return fresh copies. Version-aware methods expose v3
 * documents while the legacy methods retain their v2 return contracts.
 */
export class ProfileRegistry {
  private readonly instruments = new Map<string, AnyInstrumentProfile>();
  private readonly surveys = new Map<string, AnySurveyProfile>();

  /** Register a validated v2 instrument profile.
   * @param profile - Schema v2 instrument geometry in ICRS.
   * @returns A copy of the registered profile.
   * @throws If validation fails or the instrument ID is already registered.
   */
  registerInstrumentProfile(profile: unknown): InstrumentProfileV2 {
    const validated = validateInstrumentProfileV2(profile);
    this.assertInstrumentIdAvailable(validated.id);
    const stored = structuredClone(validated);
    this.instruments.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Register a validated v3 instrument profile.
   * @param profile - Schema v3 instrument profile with explicit semantics.
   * @returns A defensive copy of the registered profile.
   * @throws If validation fails or its stable ID is already registered.
   */
  registerInstrumentProfileV3(profile: unknown): InstrumentProfileV3 {
    const validated = validateInstrumentProfileV3(profile);
    this.assertInstrumentIdAvailable(validated.id);
    const stored = structuredClone(validated);
    this.instruments.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Register a validated v2 survey after its v2 instrument is available.
   * @param profile - Schema v2 tiling, inference, coverage, and export policy.
   * @returns A copy of the registered profile.
   * @throws If its instrument is unknown or v3, validation fails, or its ID is duplicate.
   */
  registerSurveyProfile(profile: unknown): SurveyProfileV2 {
    const validated = validateSurveyProfileV2(profile);
    const instrument = this.instruments.get(validated.instrument_id);
    if (!instrument) {
      throw new ProfileError("unresolved_reference", `Unknown instrument profile ID "${validated.instrument_id}" referenced by survey profile "${validated.id}"`);
    }
    if (instrument.schema_version !== 2) {
      throw new ProfileError("invalid_structure", `Schema v2 survey profile "${validated.id}" cannot reference a Schema v3 instrument`);
    }
    this.assertSurveyIdAvailable(validated.id);
    const stored = structuredClone(validated);
    this.surveys.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Register a validated v3 survey after its referenced instrument is available.
   * @param profile - Schema v3 strategy and explicit observing semantics.
   * @returns A copy of the registered profile.
   * @throws If its instrument is unknown, validation fails, or its ID is duplicate.
   */
  registerSurveyProfileV3(profile: unknown): SurveyProfileV3 {
    const validated = validateSurveyProfileV3(profile);
    const instrument = this.instruments.get(validated.instrument_id);
    if (!instrument) {
      throw new ProfileError("unresolved_reference", `Unknown instrument profile ID "${validated.instrument_id}" referenced by survey profile "${validated.id}"`);
    }
    validateStrategyForInstrument(instrument, validated);
    this.assertSurveyIdAvailable(validated.id);
    const stored = structuredClone(validated);
    this.surveys.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Register an entire valid profile document atomically.
   * @param document - A strict v2 pair or valid v3 standalone/matching document.
   * @returns Defensive copies of all profiles present in the document.
   * @throws ProfileError for validation, dangling references, or duplicate IDs;
   *   the registry is unchanged if any check fails.
   */
  registerProfileDocument(document: ProfileDocument): ProfileDocument;
  registerProfileDocument(document: unknown): AnyProfileDocument;
  registerProfileDocument(document: unknown): AnyProfileDocument {
    const validated = validateProfileDocument(document);
    if ("instrument" in validated && validated.instrument) this.assertInstrumentIdAvailable(validated.instrument.id);
    if ("survey" in validated && validated.survey) this.assertSurveyIdAvailable(validated.survey.id);

    const instrument = "instrument" in validated ? validated.instrument : undefined;
    const survey = "survey" in validated ? validated.survey : undefined;
    if (survey && instrument) validateStrategyForInstrument(instrument, survey);
    if (survey && !instrument) this.assertSurveyReferenceAvailable(survey);

    // All potentially failing validation and collision checks precede mutation.
    if (instrument) this.instruments.set(instrument.id, structuredClone(instrument));
    if (survey) this.surveys.set(survey.id, structuredClone(survey));
    return structuredClone(validated);
  }

  /** Resolve a legacy v2 survey and instrument pair for existing planning callers.
   * @param id - Exact registered survey ID.
   * @returns Fresh v2 configuration copies.
   * @throws If either member is unknown or the survey is v3.
   */
  resolveProfileDocument(id: string): ProfileDocument {
    const survey = this.resolveSurveyProfile(id);
    const instrument = this.resolveInstrumentProfile(survey.instrument_id);
    if (instrument.schema_version !== 2) {
      throw new ProfileError("invalid_structure", `Schema v2 survey profile "${survey.id}" cannot be paired with a Schema v3 instrument`);
    }
    return { instrument, survey };
  }

  /** Resolve the document representation for a registered survey.
   * @param id - Exact registered survey ID.
   * @returns A v2 pair, v3 matching pair, or v3 survey-only document. A v3
   *   survey referencing a v2 instrument remains survey-only.
   * @throws If the survey or any required instrument is unknown.
   */
  resolveAnyProfileDocument(id: string): AnyProfileDocument {
    const survey = this.resolveAnySurveyProfile(id);
    const instrument = this.instruments.get(survey.instrument_id);
    if (!instrument) {
      throw new ProfileError("unresolved_reference", `Unknown instrument profile ID "${survey.instrument_id}" referenced by survey profile "${survey.id}"`);
    }
    if (survey.schema_version === 2) {
      if (instrument.schema_version !== 2) {
        throw new ProfileError("invalid_structure", `Schema v2 survey profile "${survey.id}" cannot be paired with a Schema v3 instrument`);
      }
      return { instrument: structuredClone(instrument), survey: structuredClone(survey) } as ProfileDocument;
    }
    if (instrument.schema_version === 3) {
      return { instrument: structuredClone(instrument), survey: structuredClone(survey) } as ProfilePairDocumentV3;
    }
    return { survey: structuredClone(survey) } as SurveyProfileDocumentV3;
  }

  /** Resolve an instrument-only v3 document for canonical export.
   * @param id - Exact registered instrument ID.
   * @returns A fresh standalone Schema v3 document.
   * @throws If the instrument is unknown or is v2, which cannot be exported standalone.
   */
  resolveInstrumentProfileDocument(id: string): InstrumentProfileDocumentV3 {
    const instrument = this.resolveAnyInstrumentProfile(id);
    if (instrument.schema_version !== 3) {
      throw new ProfileError("invalid_structure", `Schema v2 instrument profile "${id}" requires its survey for export`);
    }
    return { instrument };
  }

  /** Resolve a survey-only v3 document for canonical export.
   * @param id - Exact registered survey ID.
   * @returns A fresh standalone Schema v3 document.
   * @throws If the survey is unknown or is v2, which requires its instrument for export.
   */
  resolveSurveyProfileDocument(id: string): SurveyProfileDocumentV3 {
    const survey = this.resolveAnySurveyProfile(id);
    if (survey.schema_version !== 3) {
      throw new ProfileError("invalid_structure", `Schema v2 survey profile "${id}" requires its instrument for export`);
    }
    return { survey };
  }

  /** Resolve an instrument profile by its stable ID.
   * @param id - Exact instrument profile ID.
   * @returns A fresh profile copy preserving its schema version and semantics.
   * @throws If the ID is unknown.
   */
  resolveInstrumentProfile(id: string): AnyInstrumentProfile {
    return this.resolveAnyInstrumentProfile(id);
  }

  /** Resolve a survey profile by its stable ID for legacy planning callers.
   * @param id - Exact survey profile ID.
   * @returns A fresh v2 profile copy.
   * @throws If the ID is unknown or identifies a v3 strategy.
   */
  resolveSurveyProfile(id: string): SurveyProfileV2 {
    const profile = this.resolveAnySurveyProfile(id);
    if (profile.schema_version !== 2) {
      throw new ProfileError("unsupported_schema", `Survey profile "${id}" is Schema v3; use resolveAnySurveyProfile`);
    }
    return profile;
  }

  /** Resolve an instrument profile regardless of schema version.
   * @param id - Exact instrument profile ID.
   * @returns A defensive copy retaining its original schema semantics.
   * @throws If the ID is unknown.
   */
  resolveAnyInstrumentProfile(id: string): AnyInstrumentProfile {
    const profile = this.instruments.get(id);
    if (!profile) throw new Error(`Unknown instrument profile ID "${id}"`);
    return structuredClone(profile);
  }

  /** Resolve a survey profile regardless of schema version.
   * @param id - Exact survey profile ID.
   * @returns A defensive copy retaining its original schema semantics.
   * @throws If the ID is unknown.
   */
  resolveAnySurveyProfile(id: string): AnySurveyProfile {
    const profile = this.surveys.get(id);
    if (!profile) throw new Error(`Unknown survey profile ID "${id}"`);
    return structuredClone(profile);
  }

  /** Look up a survey profile without treating an unknown ID as an error.
   * @param id - Exact survey profile ID.
   * @returns A defensive v2 copy, or undefined if the ID is unknown or v3.
   */
  findSurveyProfile(id: string): SurveyProfileV2 | undefined {
    const profile = this.surveys.get(id);
    return profile?.schema_version === 2 ? structuredClone(profile) : undefined;
  }

  /** Look up a survey profile without treating an unknown ID as an error.
   * @param id - Exact survey profile ID.
   * @returns A defensive copy in its original schema, or undefined if absent.
   */
  findAnySurveyProfile(id: string): AnySurveyProfile | undefined {
    const profile = this.surveys.get(id);
    return profile ? structuredClone(profile) : undefined;
  }

  /** List v2 instrument profiles in deterministic ID order for legacy callers.
   * @returns Fresh v2 copies sorted lexically by ID.
   */
  listInstrumentProfiles(): InstrumentProfileV2[] {
    return this.listAnyInstrumentProfiles().filter((profile): profile is InstrumentProfileV2 => profile.schema_version === 2);
  }

  /** List all registered instrument profiles in deterministic ID order.
   * @returns Fresh v2/v3 profile copies sorted lexically by ID.
   */
  listAnyInstrumentProfiles(): AnyInstrumentProfile[] {
    return [...this.instruments.values()]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((profile) => structuredClone(profile));
  }

  /** List v2 survey profiles in deterministic ID order for legacy callers.
   * @returns Fresh v2 copies sorted lexically by ID.
   */
  listSurveyProfiles(): SurveyProfileV2[] {
    return this.listAnySurveyProfiles().filter((profile): profile is SurveyProfileV2 => profile.schema_version === 2);
  }

  /** List all registered survey profiles in deterministic ID order.
   * @returns Fresh v2/v3 profile copies sorted lexically by ID.
   */
  listAnySurveyProfiles(): AnySurveyProfile[] {
    return [...this.surveys.values()]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((profile) => structuredClone(profile));
  }

  private assertInstrumentIdAvailable(id: string): void {
    if (this.instruments.has(id)) {
      throw new ProfileError("duplicate_id", `Instrument profile ID "${id}" is already registered`);
    }
  }

  private assertSurveyIdAvailable(id: string): void {
    if (this.surveys.has(id)) {
      throw new ProfileError("duplicate_id", `Survey profile ID "${id}" is already registered`);
    }
  }

  private assertSurveyReferenceAvailable(survey: AnySurveyProfile): void {
    const instrument = this.instruments.get(survey.instrument_id);
    if (!instrument) {
      throw new ProfileError("unresolved_reference", `Unknown instrument profile ID "${survey.instrument_id}" referenced by survey profile "${survey.id}"`);
    }
    if (survey.schema_version === 2 && instrument.schema_version !== 2) {
      throw new ProfileError("invalid_structure", `Schema v2 survey profile "${survey.id}" cannot reference a Schema v3 instrument`);
    }
    validateStrategyForInstrument(instrument, survey);
  }
}

/** Reuse Gate 5 exposure resolution to check absent-angle sequence compatibility.
 * @param instrument - Registered or document-local source instrument.
 * @param survey - Survey strategy whose sequence is being registered.
 * @throws When a not-applicable PA strategy contains a rotation requiring a PA.
 */
function validateStrategyForInstrument(instrument: AnyInstrumentProfile, survey: AnySurveyProfile): void {
  if (instrument.schema_version !== 3 || survey.schema_version !== 3 || !survey.observing_sequence) return;
  if (instrument.position_angle.mode !== "not_applicable") return;
  deriveExposurePlacements(
    { id: survey.id, center: { ra_deg: 0, dec_deg: 0 } },
    { id: survey.observing_sequence.id, exposures: survey.observing_sequence.exposures },
  );
}

/** Create an independent registry with T80/S-PLUS and standard KCWI instruments.
 * @returns Fresh registry with the existing protected v2 profiles.
 * @throws If a bundled configuration fails ordinary profile validation.
 */
export function createBundledProfileRegistry(): ProfileRegistry {
  const registry = new ProfileRegistry();
  registry.registerProfileDocument(BUNDLED_PROFILE_DOCUMENT);
  for (const instrument of kcwiInstruments) registry.registerInstrumentProfile(instrument);
  return registry;
}

/** Shared session-local registry with the bundled survey and instrument library. */
export const profileRegistry = createBundledProfileRegistry();
