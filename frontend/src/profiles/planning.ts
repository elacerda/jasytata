import type { TilingModel, TilingProfile } from "../types";
import { footprintLocalBounds } from "../science/footprint-engine";
import { resolveProfile } from "./index";
import { profileRegistry, type ProfileRegistry } from "./registry";

/** Resolve declared survey tiling and the transitional coverage profile together.
 *
 * Registered Schema v2 surveys supply physical geometry through their instrument.
 * A v1 custom rectangle is an authoring convenience: its dimensions and overlap
 * construct an axis-aligned basis once, with region-center placement.
 *
 * @param id - Registered survey ID, bundled preset ID, or custom.
 * @param inline - Optional validated v1 custom rectangle.
 * @param registry - Session-local validated profile registry.
 * @returns Tiling geometry and a coverage bridge; generic spacing uses only the basis.
 * @throws If profiles are unknown or inline validation fails.
 */
export function resolvePlanningProfile(
  id: string,
  inline?: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): { profile: TilingProfile; tiling: TilingModel } {
  if (inline) {
    const profile = resolveProfile(id, inline);
    const overlap = profile.effective_overlap_arcsec / 3600;
    return { profile, tiling: {
      type: "lattice",
      basis_deg: [[profile.tile_width_deg - overlap, 0], [0, profile.tile_height_deg - overlap]],
      origin: { type: "region_center" },
    } };
  }
  const survey = registry.findSurveyProfile(id);
  if (!survey) {
    const profile = resolveProfile(id);
    return { profile, tiling: { type: "legacy_splus", grid_extent_deg: [profile.tile_width_deg, profile.tile_height_deg], effective_overlap_arcsec: profile.effective_overlap_arcsec } };
  }
  const instrument = registry.resolveInstrumentProfile(survey.instrument_id);
  const footprint = instrument.footprint;
  const bounds = footprintLocalBounds(footprint);
  let width = bounds.max_east_deg - bounds.min_east_deg;
  let height = bounds.max_north_deg - bounds.min_north_deg;
  let overlap = 0;
  if (survey.tiling.type === "legacy_splus") {
    // Historical seed extents/pitches are survey geometry, independent of the
    // linked camera shape; inherited compatibility surveys must retain phase.
    [width, height] = survey.tiling.grid_extent_deg;
    overlap = survey.tiling.effective_overlap_arcsec;
  }
  const epoch = survey.export.epoch;
  const profile: TilingProfile = {
    id: survey.id, display_name: survey.display_name, description: survey.description,
    tile_width_deg: width, tile_height_deg: height, effective_overlap_arcsec: overlap,
    coordinate_frame: instrument.coordinate_frame,
    export_epoch_default: epoch?.default ?? "", export_epoch_options: epoch ? [...epoch.allowed] : [],
    algorithm: survey.tiling.type === "legacy_splus" ? "SPLUS_LEGACY_GRID_V1" : survey.tiling.type,
  };
  return { profile, tiling: survey.tiling };
}
