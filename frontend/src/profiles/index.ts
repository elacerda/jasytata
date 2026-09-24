import type { TilingProfile } from "../types";

/** Bundled observing profile, equivalent to backend/profiles/splus-t80-south.yaml. */
export const DEFAULT_PROFILE: TilingProfile = {
  id: "splus-t80-south", display_name: "S-PLUS / T80-South", description: "T80-South survey camera",
  tile_width_deg: 1.4, tile_height_deg: 1.4, effective_overlap_arcsec: 120,
  coordinate_frame: "icrs", export_epoch_default: "2000", export_epoch_options: ["2000"],
  algorithm: "SPLUS_LEGACY_GRID_V1",
};

/** Return the locally installed profile by identifier.
 * @param id - Installed profile identifier.
 * @returns Independent validated profile value.
 * @throws If the profile is not installed.
 */
export function loadProfile(id = DEFAULT_PROFILE.id): TilingProfile {
  if (id !== DEFAULT_PROFILE.id) throw new Error(`Profile ${id} is not installed`);
  return { ...DEFAULT_PROFILE, export_epoch_options: [...DEFAULT_PROFILE.export_epoch_options] };
}

/** List the bundled observing profiles in identifier order.
 * @returns Independent profile values with geometry in degrees and overlap in arcseconds.
 */
export function listProfiles(): TilingProfile[] {
  return [loadProfile()];
}

/** Validate a complete ICRS profile and the session-only custom-profile contract.
 * @param profile - Physical tile dimensions in degrees, effective edge overlap in arcseconds, and catalogue epoch labels.
 * @returns Validated copy of the custom rectangular profile.
 * @throws If fields, geometry, algorithm, frame, or epoch contract are invalid.
 */
export function validateProfile(profile: TilingProfile): TilingProfile {
  if (!/^[a-z][a-z0-9-]*$/.test(profile.id)) throw new Error("Invalid profile identifier");
  if (!profile.display_name || profile.display_name.length < 1) throw new Error("Profile display name is required");
  for (const [name, value] of [["tile_width_deg", profile.tile_width_deg], ["tile_height_deg", profile.tile_height_deg], ["effective_overlap_arcsec", profile.effective_overlap_arcsec]] as const) {
    if (!Number.isFinite(value) || (name !== "effective_overlap_arcsec" && (value <= 0 || value > 180)) || (name === "effective_overlap_arcsec" && value < 0)) throw new Error(`Invalid ${name}`);
  }
  if (!["SPLUS_LEGACY_GRID_V1", "RECT_GRID_V1"].includes(profile.algorithm)) throw new Error(`Unsupported tiling algorithm: ${profile.algorithm}`);
  if (profile.coordinate_frame.toLowerCase() !== "icrs") throw new Error("Only ICRS profiles are currently supported");
  if (!Array.isArray(profile.export_epoch_options) || !profile.export_epoch_options.length ||
    !profile.export_epoch_default?.trim() || !profile.export_epoch_options.includes(profile.export_epoch_default) ||
    new Set(profile.export_epoch_options).size !== profile.export_epoch_options.length ||
    profile.export_epoch_options.some((option) => !option.trim())) throw new Error("Export epoch default must be one of the unique allowed options");
  if (profile.effective_overlap_arcsec / 3600 >= Math.min(profile.tile_width_deg, profile.tile_height_deg)) throw new Error("Effective overlap must be smaller than both tile dimensions");
  if (profile.algorithm === "SPLUS_LEGACY_GRID_V1" && (profile.tile_width_deg !== 1.4 || profile.tile_height_deg !== 1.4 || profile.effective_overlap_arcsec !== 120)) throw new Error("SPLUS_LEGACY_GRID_V1 requires its exact reference geometry");
  if (profile.id !== "custom") throw new Error("Inline profiles must use the custom identifier");
  if (profile.algorithm !== "RECT_GRID_V1") throw new Error("Custom profiles must use RECT_GRID_V1");
  return { ...profile, export_epoch_options: [...profile.export_epoch_options] };
}

/** Resolve a bundled preset or a validated inline custom profile.
 * @param id - Preset ID or custom.
 * @param inline - Optional session-only profile.
 * @returns Active geometry with copied epoch options.
 */
export function resolveProfile(id: string, inline?: TilingProfile): TilingProfile {
  if (inline && id !== "custom") throw new Error("Inline profiles must use the custom identifier");
  return inline ? validateProfile(inline) : loadProfile(id);
}
