import type { CoverageMeasurementBasis, FootprintSemanticsV3, TileRecord, TilingProfile } from "../types";
import type { ProfileRegistry } from "../profiles/registry";
import type { PointingGeometryContext } from "./pointing-geometry";

/** Resolve declared scientific semantics without assigning a role to v2 geometry.
 * @param tile - Original dataset row or output pointing.
 * @param profile - Active survey bridge; inline v1 is unclassified.
 * @param registry - Validated session instruments and strategies.
 * @returns Persisted v3 semantics, or undefined for the legacy interpretation.
 */
export function coverageSemanticsForTile(tile: TileRecord, profile: TilingProfile, registry: ProfileRegistry): FootprintSemanticsV3 | undefined {
  const survey = profile.id === "custom" && profile.algorithm === "RECT_GRID_V1" ? undefined : registry.findAnySurveyProfile(profile.id);
  const id = tile.source === "original" && tile.instrument_profile_id ? tile.instrument_profile_id : survey?.instrument_id;
  const instrument = id ? registry.resolveInstrumentProfile(id) : undefined;
  return instrument?.schema_version === 3 ? instrument.footprint_semantics : undefined;
}

/** Decide membership before geometry resolution, scale selection or masks.
 * @param tile - Source or output pointing.
 * @param profile - Active output bridge.
 * @param registry - Session registry.
 * @param basis - Explicit requested scientific basis.
 * @returns Whether the geometry may contribute to that basis.
 */
export function tileContributesToBasis(tile: TileRecord, profile: TilingProfile, registry: ProfileRegistry, basis: CoverageMeasurementBasis): boolean {
  const semantics = coverageSemanticsForTile(tile, profile, registry);
  return basis === "legacy_v2" ? !semantics || semantics.role === "observed_area" : semantics?.role === basis;
}

/** Resolve the run's basis, keeping v2 compatibility distinct from explicit roles.
 * @param profile - Active output bridge.
 * @param registry - Session registry.
 * @param context - Caller-selected metric and sequence choices.
 * @returns Requested basis, otherwise observed area for v3 or legacy for v2.
 */
export function coverageBasisForRun(profile: TilingProfile, registry: ProfileRegistry, context?: PointingGeometryContext): CoverageMeasurementBasis {
  if (context?.measurementBasis) return context.measurementBasis;
  const output = { source: "proposed" } as TileRecord;
  return coverageSemanticsForTile(output, profile, registry) ? "observed_area" : "legacy_v2";
}

/** Consume persisted v3 PA/sequence choices through the unchanged Gate 5 resolver.
 * @param tiles - Source pointings, used only to detect explicit v3 semantics.
 * @param profile - Output bridge referencing the selected strategy.
 * @param registry - Versioned registry.
 * @param context - Explicit caller choices take precedence over persisted defaults.
 * @returns Caller context for v2; resolved v3 policy/strategy context otherwise.
 */
export function coverageGeometryContext(tiles: readonly TileRecord[], profile: TilingProfile, registry: ProfileRegistry, context?: PointingGeometryContext): PointingGeometryContext | undefined {
  const survey = profile.id === "custom" && profile.algorithm === "RECT_GRID_V1" ? undefined : registry.findAnySurveyProfile(profile.id);
  const output = survey ? registry.resolveInstrumentProfile(survey.instrument_id) : undefined;
  if (survey?.schema_version !== 3 && output?.schema_version !== 3 && !tiles.some((tile) => coverageSemanticsForTile(tile, profile, registry))) return context;
  return {
    ...context,
    coverageBasis: context?.coverageBasis ?? (survey?.schema_version === 3 ? survey.coverage_basis_default : "single_exposure"),
    orientationPolicyForTile: (tile) => {
      if (context?.orientationPolicyForTile) return context.orientationPolicyForTile(tile);
      const instrument = tile.source === "original" && tile.instrument_profile_id ? registry.resolveInstrumentProfile(tile.instrument_profile_id) : output;
      return instrument?.schema_version === 3 ? { policy: instrument.position_angle.mode, required: instrument.position_angle.required } : undefined;
    },
    sequenceForTile: (tile) => {
      if (context?.sequenceForTile) return context.sequenceForTile(tile);
      return !(tile.source === "original" && tile.instrument_profile_id) && survey?.schema_version === 3 ? survey.observing_sequence : undefined;
    },
  };
}
