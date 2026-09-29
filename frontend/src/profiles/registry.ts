import type { InstrumentProfileV2, SurveyProfileV2 } from "../types";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";
import { BUNDLED_PROFILE_DOCUMENT } from "./v2";
import kcwiInstruments from "./kcwi-slicers.json";

import { validateProfileDocument, type ProfileDocument } from "./document";
import { ProfileError } from "./errors";

/** Browser-memory registry for validated instrument and survey profiles.
 *
 * IDs are unique within each profile kind. Registration validates and stores a
 * private copy; lookups return fresh copies so callers cannot mutate registry
 * state. Survey registration requires its instrument to have been registered.
 */
export class ProfileRegistry {
  private readonly instruments = new Map<string, InstrumentProfileV2>();
  private readonly surveys = new Map<string, SurveyProfileV2>();

  /** Register a validated instrument profile.
   * @param profile - Schema v2 instrument geometry in ICRS.
   * @returns A copy of the registered profile.
   * @throws If validation fails or the instrument ID is already registered.
   */
  registerInstrumentProfile(profile: unknown): InstrumentProfileV2 {
    const validated = validateInstrumentProfileV2(profile);
    if (this.instruments.has(validated.id)) {
      throw new ProfileError("duplicate_id", `Instrument profile ID "${validated.id}" is already registered`);
    }
    const stored = structuredClone(validated);
    this.instruments.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Register a validated survey profile after its instrument is available.
   * @param profile - Schema v2 tiling, inference, coverage, and export policy.
   * @returns A copy of the registered profile.
   * @throws If validation fails, its instrument is unknown, or the survey ID is duplicated.
   */
  registerSurveyProfile(profile: unknown): SurveyProfileV2 {
    const validated = validateSurveyProfileV2(profile);
    if (!this.instruments.has(validated.instrument_id)) {
      throw new ProfileError("unresolved_reference", `Unknown instrument profile ID "${validated.instrument_id}" referenced by survey profile "${validated.id}"`);
    }
    if (this.surveys.has(validated.id)) {
      throw new ProfileError("duplicate_id", `Survey profile ID "${validated.id}" is already registered`);
    }
    const stored = structuredClone(validated);
    this.surveys.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Register an entire instrument/survey document atomically.
   * @param document - Untrusted established profile document.
   * @returns Defensive copies of both registered profiles.
   * @throws ProfileError for validation or any duplicate ID; no state changes on failure.
   */
  registerProfileDocument(document: unknown): ProfileDocument {
    const validated = validateProfileDocument(document);
    if (this.instruments.has(validated.instrument.id)) {
      throw new ProfileError("duplicate_id", `Instrument profile ID "${validated.instrument.id}" is already registered`);
    }
    if (this.surveys.has(validated.survey.id)) {
      throw new ProfileError("duplicate_id", `Survey profile ID "${validated.survey.id}" is already registered`);
    }
    const stored = structuredClone(validated);
    this.instruments.set(stored.instrument.id, stored.instrument);
    this.surveys.set(stored.survey.id, stored.survey);
    return structuredClone(stored);
  }

  /** Resolve a survey and its instrument for canonical configuration export.
   * @param id - Exact registered survey ID.
   * @returns Fresh configuration copies without planning or catalogue state.
   * @throws If the survey or its instrument is unknown.
   */
  resolveProfileDocument(id: string): ProfileDocument {
    const survey = this.resolveSurveyProfile(id);
    return { instrument: this.resolveInstrumentProfile(survey.instrument_id), survey };
  }

  /** Resolve an instrument profile by its stable ID.
   * @param id - Exact instrument profile ID.
   * @returns A fresh profile copy.
   * @throws If the ID is unknown.
   */
  resolveInstrumentProfile(id: string): InstrumentProfileV2 {
    const profile = this.instruments.get(id);
    if (!profile) throw new Error(`Unknown instrument profile ID "${id}"`);
    return structuredClone(profile);
  }

  /** Resolve a survey profile by its stable ID.
   * @param id - Exact survey profile ID.
   * @returns A fresh profile copy.
   * @throws If the ID is unknown.
   */
  resolveSurveyProfile(id: string): SurveyProfileV2 {
    const profile = this.surveys.get(id);
    if (!profile) throw new Error(`Unknown survey profile ID "${id}"`);
    return structuredClone(profile);
  }

  /** Look up a survey profile without treating an unknown ID as an error.
   * @param id - Exact survey profile ID.
   * @returns A fresh profile copy, or undefined when the ID is not registered.
   */
  findSurveyProfile(id: string): SurveyProfileV2 | undefined {
    const profile = this.surveys.get(id);
    return profile ? structuredClone(profile) : undefined;
  }

  /** List instrument profiles in deterministic ID order.
   * @returns Fresh profile copies sorted lexically by ID.
   */
  listInstrumentProfiles(): InstrumentProfileV2[] {
    return [...this.instruments.values()]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((profile) => structuredClone(profile));
  }

  /** List survey profiles in deterministic ID order.
   * @returns Fresh profile copies sorted lexically by ID.
   */
  listSurveyProfiles(): SurveyProfileV2[] {
    return [...this.surveys.values()]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((profile) => structuredClone(profile));
  }
}

/** Create an independent registry with T80/S-PLUS and standard KCWI instruments.
 *
 * KCWI fields are instrument-only, at a declared PA; no survey, placement,
 * overlap, sampling or export policy is inferred. See the v0.4 instrument matrix
 * for measured angular dimensions, axis conventions, provenance and limits.
 * Every bundled object uses the same validators as ordinary registration.
 *
 * @returns Fresh browser-memory registry with validated bundled profiles.
 * @throws If any bundled configuration fails ordinary profile validation.
 */
export function createBundledProfileRegistry(): ProfileRegistry {
  const registry = new ProfileRegistry();
  registry.registerProfileDocument(BUNDLED_PROFILE_DOCUMENT);
  for (const instrument of kcwiInstruments) registry.registerInstrumentProfile(instrument);
  return registry;
}

/** Shared session-local registry with the bundled survey and instrument library. */
export const profileRegistry = createBundledProfileRegistry();
