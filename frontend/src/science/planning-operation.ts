import type { CoverageResult, CoverageStrategy, RegionPlanResponse, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { ProfileRegistry, type AnyInstrumentProfile, type AnySurveyProfile } from "../profiles/registry";
import { planRegion, type ProjectLatticeCandidateSource } from "./planner";
import { measureActiveCoverage } from "./coverage";
import type { PointingGeometryContext } from "./pointing-geometry";

/** Serializable choices for the application's registered PA and sequence lookup.
 * All sky coordinates, footprint angles and plan PA are in ICRS degrees.
 * Arbitrary caller-provided geometry callbacks remain on the synchronous API.
 */
export interface PlanningGeometryChoices {
  coverageBasis: "single_exposure" | "effective_sequence";
  measurementBasis?: PointingGeometryContext["measurementBasis"];
  outputInstrumentId?: string;
  outputStrategyId?: string;
  planPositionAngleDeg?: number;
}

const canonicalContexts = new WeakMap<PointingGeometryContext, {
  choices: PlanningGeometryChoices;
  orientation: PointingGeometryContext["orientationPolicyForTile"];
  sequence: PointingGeometryContext["sequenceForTile"];
}>();

/** Reconstruct the App's canonical lookup from serializable inputs.
 * @param input - Current output association, area/sequence basis and optional PA.
 * @param registry - Immutable operation registry; imported profiles are supported.
 * @returns Geometry callbacks plus their serializable choices; no UI access.
 */
export function planningGeometryContext(input: PlanningGeometryChoices, registry: ProfileRegistry): PointingGeometryContext {
  const choices = { ...input };
  const context: PointingGeometryContext = {
    coverageBasis: choices.coverageBasis,
    ...(choices.measurementBasis === undefined ? {} : { measurementBasis: choices.measurementBasis }),
    orientationPolicyForTile: (tile) => {
      const instrumentId = tile.instrument_profile_id ?? (tile.source === "proposed" ? choices.outputInstrumentId : undefined);
      if (!instrumentId) return undefined;
      let instrument: AnyInstrumentProfile;
      try { instrument = registry.resolveAnyInstrumentProfile(instrumentId); } catch { return undefined; }
      if (instrument.schema_version !== 3) return undefined;
      return { policy: instrument.position_angle.mode, required: instrument.position_angle.required,
        ...(instrument.position_angle.mode === "user_selected" && (tile.output_position_angle_deg !== undefined ||
          (tile.source === "proposed" && !tile.instrument_profile_id && instrument.id === choices.outputInstrumentId && choices.planPositionAngleDeg !== undefined))
          ? { plan_position_angle_deg: tile.output_position_angle_deg ?? choices.planPositionAngleDeg } : {}),
      };
    },
    sequenceForTile: (tile) => {
      const strategyId = tile.output_strategy_id ?? (tile.source === "proposed" ? choices.outputStrategyId : undefined);
      if (!strategyId) return undefined;
      const strategy = registry.findAnySurveyProfile(strategyId);
      return strategy?.schema_version === 3 && strategy.observing_sequence
        ? { id: strategy.observing_sequence.id, exposures: strategy.observing_sequence.exposures } : undefined;
    },
  };
  canonicalContexts.set(context, { choices, orientation: context.orientationPolicyForTile, sequence: context.sequenceForTile });
  return context;
}

/** Obtain transport choices only for an unmodified canonical context.
 * @param context - Geometry lookup created by planningGeometryContext, or a custom callback context.
 * @returns A fresh serializable snapshot, or undefined when callbacks/options changed.
 *   Weak metadata certifies callback identity; it never caches scientific results.
 */
export function serializedPlanningChoices(context?: PointingGeometryContext): PlanningGeometryChoices | undefined {
  const registered = context && canonicalContexts.get(context);
  if (!context || !registered || context.orientationPolicyForTile !== registered.orientation || context.sequenceForTile !== registered.sequence ||
    context.coverageBasis !== registered.choices.coverageBasis || context.measurementBasis !== registered.choices.measurementBasis ||
    context.targetSamplesPerFootprintAxis !== undefined) return undefined;
  return { ...registered.choices };
}

/** Structured-clone-safe operation; profile definitions are snapshots, never persistence. */
export interface PlanningOperation {
  kind: "plan" | "coverage";
  polygon: SkyPolygon;
  existingTiles: TileRecord[];
  proposedTiles?: TileRecord[];
  profileId?: string;
  profile?: TilingProfile;
  strategy?: CoverageStrategy;
  projectSource?: ProjectLatticeCandidateSource;
  geometryChoices?: PlanningGeometryChoices;
  instruments: AnyInstrumentProfile[];
  surveys: AnySurveyProfile[];
}

/** Execute one deterministic operation without React, DOM, Aladin or scheduling.
 * @param request - Canonical ICRS inputs and validated session profile snapshots.
 * @returns One complete plan or coverage result; no partial result is published.
 * @throws The same scientific validation/refusal errors as the synchronous core.
 */
export function executePlanningOperation(request: PlanningOperation): RegionPlanResponse | CoverageResult {
  const registry = new ProfileRegistry();
  for (const instrument of request.instruments) {
    if (instrument.schema_version === 3) registry.registerInstrumentProfileV3(instrument);
    else registry.registerInstrumentProfile(instrument);
  }
  for (const survey of request.surveys) {
    if (survey.schema_version === 3) registry.registerSurveyProfileV3(survey);
    else registry.registerSurveyProfile(survey);
  }
  const context = request.geometryChoices ? planningGeometryContext(request.geometryChoices, registry) : undefined;
  return request.kind === "plan"
    ? planRegion(request.polygon, request.existingTiles, request.profileId, request.profile, request.strategy, registry, context, request.projectSource)
    : measureActiveCoverage(request.polygon, request.existingTiles, request.proposedTiles ?? [], request.profileId, request.profile, registry, context);
}
