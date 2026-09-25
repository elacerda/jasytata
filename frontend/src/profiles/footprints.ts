import type { Footprint, TileRecord, TilingProfile } from "../types";
import { profileRegistry, type ProfileRegistry } from "./registry";

/** Resolve the physical footprint for the currently selected survey profile.
 *
 * Schema v2 survey profiles link to an instrument geometry by ID. Session-only
 * v1 profiles have no such link and retain their rectangular dimensions.
 *
 * @param profile - Active planner profile, whose ID selects a registered survey when present.
 * @param registry - Browser-memory registry for survey and instrument profiles.
 * @returns The active instrument footprint, or the profile's rectangular footprint.
 * @throws If the survey refers to an unknown instrument.
 */
export function outputFootprintForProfile(
  profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): Footprint {
  const survey = registry.findSurveyProfile(profile.id);
  if (survey) return registry.resolveInstrumentProfile(survey.instrument_id).footprint;
  return { type: "rectangle", width_deg: profile.tile_width_deg, height_deg: profile.tile_height_deg };
}

/** Resolve the footprint used to cover a tile record.
 *
 * Associated original rows use their dataset instrument. Proposals and
 * unassociated rows use the active output instrument.
 *
 * @param tile - Existing source or proposed tile record.
 * @param outputProfile - Active planner profile for proposals and unassociated rows.
 * @param registry - Browser-memory registry for instrument profiles.
 * @returns The source instrument footprint or active output footprint.
 * @throws If an associated source instrument is unknown.
 */
export function footprintForTile(
  tile: TileRecord,
  outputProfile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): Footprint {
  if (tile.source === "original" && tile.instrument_profile_id) {
    return registry.resolveInstrumentProfile(tile.instrument_profile_id).footprint;
  }
  return outputFootprintForProfile(outputProfile, registry);
}
