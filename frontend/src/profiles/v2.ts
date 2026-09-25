import type { InstrumentProfileV2, SurveyProfileV2, TilingProfile } from "../types";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";

/** Bundled Schema v2 geometry for the S-PLUS T80-South camera. */
export const T80_SOUTH_INSTRUMENT_V2: InstrumentProfileV2 = {
  schema_version: 2,
  id: "t80-south",
  display_name: "T80-South camera",
  description: "S-PLUS / T80-South imaging camera",
  coordinate_frame: "icrs",
  footprint: { type: "rectangle", width_deg: 1.4, height_deg: 1.4 },
};

/** Bundled Schema v2 S-PLUS survey policy associated with T80-South. */
export const SPLUS_SURVEY_V2: SurveyProfileV2 = {
  schema_version: 2,
  id: "splus-t80-south",
  display_name: "S-PLUS / T80-South",
  description: "T80-South survey camera",
  instrument_id: "t80-south",
  tiling: { type: "legacy_splus" },
  inference: {
    enabled: true,
    // Fractions use the 1.4 degree T80 footprint as their reference scale. The
    // production planner continues to use its existing fixed degree values.
    spacing_tolerance_fraction: 0.05 / 1.4,
    phase_tolerance_fraction: 0.1 / 1.4,
    occupancy_tolerance_fraction: 0.12 / 1.4,
    min_anchor_tiles: 3,
    min_neighbor_pairs: 2,
    allow_rotation: false,
  },
  coverage: {
    sampling: { target_samples_per_footprint_axis: 140, max_samples: 90_000 },
    efficient: { min_coverage: 0.995, min_marginal_efficiency: 0.03 },
  },
  export: {
    ra_column: "RA",
    dec_column: "DEC",
    coordinate_format: "decimal",
    epoch: { column: "EPOCH", default: "2000", allowed: ["2000"] },
  },
};

const LEGACY_SPLUS_EFFECTIVE_OVERLAP_ARCSEC = 120;

/** Adapt the bundled v2 T80/S-PLUS pair into the historical planner contract.
 *
 * Transitional compatibility infrastructure: this mapping is structural and
 * contains no geometry calculations. The legacy tiling discriminator has the
 * fixed 120 arcsecond effective overlap used by the v1 T80 planner. Survey
 * inference and coverage policies remain declarative; the production planner
 * continues to consume its existing v1 constants.
 *
 * @param instrument - Validated or JSON-parsed instrument profile.
 * @param survey - Validated or JSON-parsed survey profile.
 * @returns A fresh v1 profile with the same fields as the bundled default.
 * @throws If the profiles are not the supported bundled T80/S-PLUS mapping.
 */
export function adaptT80SplusV2ToV1(instrument: unknown, survey: unknown): TilingProfile {
  const checkedInstrument = validateInstrumentProfileV2(instrument);
  const checkedSurvey = validateSurveyProfileV2(survey);
  if (checkedSurvey.instrument_id !== checkedInstrument.id) throw new Error("Survey instrument_id does not match the supplied instrument");
  if (checkedInstrument.id !== T80_SOUTH_INSTRUMENT_V2.id || checkedSurvey.id !== SPLUS_SURVEY_V2.id) {
    throw new Error("Only the bundled T80-South / S-PLUS v2 pair can be adapted to the v1 planner");
  }
  if (checkedInstrument.coordinate_frame !== "icrs" || checkedInstrument.footprint.type !== "rectangle" ||
      checkedInstrument.footprint.width_deg !== 1.4 || checkedInstrument.footprint.height_deg !== 1.4 ||
      checkedInstrument.footprint.position_angle_deg !== undefined) {
    throw new Error("The v1 T80 planner requires its unrotated 1.4 by 1.4 degree rectangle");
  }
  if (checkedSurvey.tiling.type !== "legacy_splus") throw new Error("The v1 T80 planner requires legacy_splus tiling");
  const exportPolicy = checkedSurvey.export;
  if (exportPolicy.ra_column !== "RA" || exportPolicy.dec_column !== "DEC" || exportPolicy.coordinate_format !== "decimal" ||
      !exportPolicy.epoch || exportPolicy.epoch.column !== "EPOCH" || exportPolicy.position_angle_column !== undefined ||
      (exportPolicy.constant_fields && Object.keys(exportPolicy.constant_fields).length > 0)) {
    throw new Error("The v1 T80 planner requires the historical RA,DEC,EPOCH export contract");
  }
  return {
    id: checkedSurvey.id,
    display_name: checkedSurvey.display_name,
    ...(checkedSurvey.description !== undefined ? { description: checkedSurvey.description } : {}),
    tile_width_deg: checkedInstrument.footprint.width_deg,
    tile_height_deg: checkedInstrument.footprint.height_deg,
    effective_overlap_arcsec: LEGACY_SPLUS_EFFECTIVE_OVERLAP_ARCSEC,
    coordinate_frame: checkedInstrument.coordinate_frame,
    export_epoch_default: exportPolicy.epoch.default,
    export_epoch_options: [...exportPolicy.epoch.allowed],
    algorithm: "SPLUS_LEGACY_GRID_V1",
  };
}
