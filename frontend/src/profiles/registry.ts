import type { InstrumentProfileV2, SurveyProfileV2 } from "../types";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";
import { SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "./v2";

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
      throw new Error(`Instrument profile ID "${validated.id}" is already registered`);
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
      throw new Error(`Unknown instrument profile ID "${validated.instrument_id}" referenced by survey profile "${validated.id}"`);
    }
    if (this.surveys.has(validated.id)) {
      throw new Error(`Survey profile ID "${validated.id}" is already registered`);
    }
    const stored = structuredClone(validated);
    this.surveys.set(stored.id, stored);
    return structuredClone(stored);
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

/** Create an independent registry seeded with the bundled T80/S-PLUS pair.
 * @returns Browser-memory registry with validated bundled profiles.
 */
export function createBundledProfileRegistry(): ProfileRegistry {
  const registry = new ProfileRegistry();
  registry.registerInstrumentProfile(T80_SOUTH_INSTRUMENT_V2);
  registry.registerSurveyProfile(SPLUS_SURVEY_V2);
  return registry;
}

/** Shared session-local registry, seeded with bundled T80/S-PLUS profiles. */
export const profileRegistry = createBundledProfileRegistry();
