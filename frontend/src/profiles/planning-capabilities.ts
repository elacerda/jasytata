import type { AnyInstrumentProfile, AnySurveyProfile } from "./registry";

export type PlanningOutputKind = "strategy" | "instrument";
export type PlanningGeometryRole = "legacy_v2" | "observed_area" | "nominal_envelope" | "target_access" | null;

/** Capabilities derived from one registered instrument and its selected strategy, if any. */
export interface PlanningCapabilities {
  outputKind: PlanningOutputKind;
  canPlaceManualPointing: boolean;
  canImportCenters: boolean;
  supportsAutomaticRegionPlanning: boolean;
  canMeasureSelectedGeometry: boolean;
  canReportAreaCoverage: boolean;
  observingSequenceExposureCount: number | null;
  positionAngleMode: "fixed" | "per_pointing" | "user_selected" | "not_applicable" | null;
  positionAngleRequired: boolean;
  requiresUserPositionAngle: boolean;
  geometryRole: PlanningGeometryRole;
}

/** Derive browser planning actions from the validated profile and strategy semantics.
 *
 * This is presentation/session policy only. It does not change persisted profile
 * data, geometry, sequence handling, coverage calculations, or planner behavior.
 *
 * @param instrument - Active validated instrument profile, or `null` if unresolved.
 * @param strategy - Active survey/observing strategy, or `null` for standalone output.
 * @returns The manual, regional, sequence, PA, and diagnostic actions supported by
 *   the current output context.
 */
export function derivePlanningCapabilities(
  instrument: AnyInstrumentProfile | null,
  strategy: AnySurveyProfile | null,
): PlanningCapabilities {
  const outputKind: PlanningOutputKind = strategy ? "strategy" : "instrument";
  const observingSequenceExposureCount = strategy?.schema_version === 3 && strategy.observing_sequence
    ? strategy.observing_sequence.exposures.length
    : null;
  const geometryRole: PlanningGeometryRole = !instrument
    ? null
    : instrument.schema_version === 3
      ? instrument.footprint_semantics.role
      : "legacy_v2";
  const positionAngleMode = instrument?.schema_version === 3 ? instrument.position_angle.mode : null;
  const positionAngleRequired = instrument?.schema_version === 3 && instrument.position_angle.required;
  const canReportAreaCoverage = Boolean(strategy && instrument && geometryRole !== "target_access");
  const supportsAutomaticRegionPlanning = Boolean(strategy && strategy.tiling.type !== "manual" && canReportAreaCoverage);

  return {
    outputKind,
    canPlaceManualPointing: Boolean(instrument),
    canImportCenters: Boolean(instrument),
    supportsAutomaticRegionPlanning,
    canMeasureSelectedGeometry: Boolean(strategy?.tiling.type === "manual" && canReportAreaCoverage),
    canReportAreaCoverage,
    observingSequenceExposureCount,
    positionAngleMode,
    positionAngleRequired,
    requiresUserPositionAngle: Boolean(positionAngleRequired &&
      (positionAngleMode === "per_pointing" || positionAngleMode === "user_selected")),
    geometryRole,
  };
}

/** Return a concise planning-mode label without referring to profile IDs.
 * @param capabilities - Capabilities derived for the active output context.
 * @returns Human-readable planning mode for the active profile summary.
 */
export function planningModeLabel(capabilities: PlanningCapabilities): string {
  const paLabel = capabilities.requiresUserPositionAngle ? " · PA required" : "";
  if (capabilities.supportsAutomaticRegionPlanning) return `Automatic region tiling + manual pointings${paLabel}`;
  if (capabilities.observingSequenceExposureCount !== null) {
    return `Manual target centers + ${capabilities.observingSequenceExposureCount}-exposure sequence${paLabel}`;
  }
  if (capabilities.geometryRole === "target_access") return `Manual target-access centers${paLabel}`;
  return `Manual pointings${paLabel}`;
}

/** Explain why automatic regional placement is unavailable and what to do instead.
 * @param capabilities - Capabilities derived for the active output context.
 * @returns Short guidance for a manual strategy or standalone instrument.
 */
export function automaticRegionUnavailableMessage(capabilities: PlanningCapabilities): string {
  if (capabilities.observingSequenceExposureCount !== null) {
    return "This strategy defines an exposure sequence, not a regional tiling policy. Add a target center manually or import centers.";
  }
  if (capabilities.outputKind === "strategy") {
    return "Automatic region planning is not defined for this strategy. Add pointings manually or import center coordinates.";
  }
  return "Automatic region planning is not defined for this instrument. Add pointings manually or import center coordinates.";
}

/** Return the next action for an empty output context.
 * @param capabilities - Capabilities derived for the active output context.
 * @returns One-sentence guidance for the selected planning mode.
 */
export function emptyPlanningStateMessage(capabilities: PlanningCapabilities): string {
  if (capabilities.supportsAutomaticRegionPlanning) {
    return "Select an area to generate a plan, add a pointing manually, or import centers.";
  }
  if (capabilities.observingSequenceExposureCount !== null) {
    return "Add a target center to preview the declared exposure sequence, or import centers.";
  }
  if (capabilities.geometryRole === "target_access") {
    return "Add a target-access center on the sky or import center coordinates.";
  }
  return "Add a pointing on the sky or import center coordinates.";
}
