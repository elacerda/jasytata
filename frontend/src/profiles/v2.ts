import type { InstrumentProfileV2, SurveyProfileV2, TilingProfile } from "../types";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";
import { validateProfileDocument } from "./document";
import bundledProfile from "./splus-t80-south.json";

/** Bundled file normalized by the same document validator as user imports. */
export const BUNDLED_PROFILE_DOCUMENT = validateProfileDocument(bundledProfile);

/** Bundled camera data loaded through the ordinary Schema v2 validator. */
export const T80_SOUTH_INSTRUMENT_V2: InstrumentProfileV2 = BUNDLED_PROFILE_DOCUMENT.instrument;

/** Bundled survey data loaded through the ordinary Schema v2 validator. */
export const SPLUS_SURVEY_V2: SurveyProfileV2 = BUNDLED_PROFILE_DOCUMENT.survey;

/** Adapt a v2 legacy_splus pair into the historical planner contract.
 *
 * Transitional compatibility infrastructure: this mapping is structural and
 * contains no geometry calculations. Dimensions and effective overlap are read
 * from the validated bundled/imported profiles. The scientific planner resolves
 * the original Schema v2 survey from the registry;
 * this adapter supplies the historical UI/CSV shape only. No profile ID selects
 * scientific behavior.
 *
 * @param instrument - Validated or JSON-parsed instrument profile.
 * @param survey - Validated or JSON-parsed survey profile.
 * @returns A fresh v1 profile with the same fields as the bundled default.
 * @throws If references, rectangle geometry, strategy, or the historical CSV contract are incompatible.
 */
export function adaptT80SplusV2ToV1(instrument: unknown, survey: unknown): TilingProfile {
  const checkedInstrument = validateInstrumentProfileV2(instrument);
  const checkedSurvey = validateSurveyProfileV2(survey);
  if (checkedSurvey.instrument_id !== checkedInstrument.id) throw new Error("Survey instrument_id does not match the supplied instrument");
  if (checkedInstrument.footprint.type !== "rectangle" || checkedInstrument.footprint.position_angle_deg !== undefined) {
    throw new Error("The v1 compatibility adapter requires an unrotated rectangle");
  }
  if (checkedSurvey.tiling.type !== "legacy_splus") throw new Error("The v1 compatibility adapter requires legacy_splus tiling");
  const exportPolicy = checkedSurvey.export;
  if (exportPolicy.ra_column !== "RA" || exportPolicy.dec_column !== "DEC" || exportPolicy.coordinate_format !== "decimal" ||
      !exportPolicy.epoch || exportPolicy.epoch.column !== "EPOCH" || exportPolicy.position_angle_column !== undefined ||
      (exportPolicy.constant_fields && Object.keys(exportPolicy.constant_fields).length > 0)) {
    throw new Error("The v1 compatibility adapter requires the historical RA,DEC,EPOCH export contract");
  }
  return {
    id: checkedSurvey.id,
    display_name: checkedSurvey.display_name,
    ...(checkedSurvey.description !== undefined ? { description: checkedSurvey.description } : {}),
    tile_width_deg: checkedSurvey.tiling.grid_extent_deg[0],
    tile_height_deg: checkedSurvey.tiling.grid_extent_deg[1],
    effective_overlap_arcsec: checkedSurvey.tiling.effective_overlap_arcsec,
    coordinate_frame: checkedInstrument.coordinate_frame,
    export_epoch_default: exportPolicy.epoch.default,
    export_epoch_options: [...exportPolicy.epoch.allowed],
    algorithm: "SPLUS_LEGACY_GRID_V1",
  };
}
