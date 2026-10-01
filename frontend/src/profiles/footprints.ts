import type {
  Footprint,
  PositionAngleOptions,
  ResolvedFootprintOrientation,
  TileRecord,
  TilingProfile,
} from "../types";
import { profileRegistry, type ProfileRegistry } from "./registry";

/** Resolve the physical footprint for the currently selected survey profile.
 *
 * Schema v2/v3 survey profiles link to an instrument geometry by ID. Session-only
 * v1 profiles have no such link and retain their rectangular dimensions.
 *
 * @param profile - Active planner bridge: registered survey, inline rectangle, or
 *   runtime project bridge explicitly identifying its registered instrument.
 * @param registry - Browser-memory registry for survey and instrument profiles.
 * @returns The active instrument footprint, or the profile's rectangular footprint.
 * @throws If the survey refers to an unknown instrument.
 */
export function outputFootprintForProfile(
  profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): Footprint {
  if ("project_instrument_id" in profile && typeof profile.project_instrument_id === "string") {
    return registry.resolveInstrumentProfile(profile.project_instrument_id).footprint;
  }
  // An explicit v1 bridge is geometry, independent of any equal registry ID.
  const survey = (profile.id === "custom" && profile.algorithm === "RECT_GRID_V1") ? undefined : registry.findAnySurveyProfile(profile.id);
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
  outputProfile: TilingProfile | null,
  registry: ProfileRegistry = profileRegistry,
): Footprint {
  const hasPinnedOutputInstrument = tile.source === "proposed" &&
    (tile.output_strategy_id !== undefined || outputProfile === null);
  if (tile.instrument_profile_id && (tile.source === "original" || hasPinnedOutputInstrument)) {
    return registry.resolveInstrumentProfile(tile.instrument_profile_id).footprint;
  }
  if (!outputProfile) throw new Error(`Pointing "${tile.id}" has no associated instrument or active output profile`);
  return outputFootprintForProfile(outputProfile, registry);
}

/** Resolve immutable effective pointing geometry using one runtime PA policy.
 *
 * With no options this retains Schema v2 behavior: the profile footprint is
 * returned unchanged and any tile-level PA is ignored. Explicit policies use
 * astronomical PA (degrees east of north) and normalize only the effective
 * runtime angle to [0, 360); source profile and tile values are preserved.
 *
 * @param tile - Source or proposed tile record.
 * @param outputProfile - Active planner profile for proposals and unassociated rows.
 * @param registry - Browser-memory registry for instrument profiles.
 * @param options - Caller-owned policy and optional plan PA; never persisted.
 * @returns Effective footprint and separately declared PA, if physically meaningful.
 * @throws If the selected policy has conflicting, missing required, or non-finite PA.
 */
export function resolveFootprintForTile(
  tile: TileRecord,
  outputProfile: TilingProfile | null,
  registry: ProfileRegistry = profileRegistry,
  options?: PositionAngleOptions,
): ResolvedFootprintOrientation {
  const footprint = footprintForTile(tile, outputProfile, registry);
  const profileAngle = topLevelPositionAngle(footprint);
  const rowAngle = tile.position_angle_deg;
  const planAngle = options?.plan_position_angle_deg;

  if (!options) {
    return { footprint, ...(profileAngle !== undefined ? { resolved_position_angle_deg: profileAngle } : {}) };
  }

  assertFiniteAngle(profileAngle, "Profile position angle");
  assertFiniteAngle(rowAngle, "Tile position angle");
  assertFiniteAngle(planAngle, "Plan position angle");

  let selectedAngle: number | undefined;
  switch (options.policy) {
    case "fixed":
      if (rowAngle !== undefined) throw new Error("Tile position angle is not allowed by the fixed PA policy");
      if (planAngle !== undefined) throw new Error("Plan position angle is not allowed by the fixed PA policy");
      if (profileAngle === undefined) throw new Error("Fixed PA policy requires a profile position angle");
      selectedAngle = profileAngle;
      break;
    case "per_pointing":
      if (planAngle !== undefined) throw new Error("Plan position angle is not allowed by the per-pointing PA policy");
      selectedAngle = rowAngle ?? profileAngle;
      requireAngleIfNeeded(selectedAngle, options.required, "Per-pointing PA policy requires a tile or profile position angle");
      break;
    case "user_selected":
      if (rowAngle !== undefined) throw new Error("Tile position angle is not allowed by the user-selected PA policy");
      selectedAngle = planAngle ?? profileAngle;
      requireAngleIfNeeded(selectedAngle, options.required, "User-selected PA policy requires a plan or profile position angle");
      break;
    case "not_applicable":
      if (profileAngle !== undefined || rowAngle !== undefined || planAngle !== undefined) {
        throw new Error("Position angle is not applicable; profile, tile, and plan PA values must be absent");
      }
      selectedAngle = undefined;
      break;
    default: {
      const exhaustive: never = options.policy;
      throw new Error(`Unsupported position angle policy: ${String(exhaustive)}`);
    }
  }

  // Circular geometry is rotation-invariant and must not acquire a physical PA claim.
  if (footprint.type === "circle") return { footprint };
  const normalizedAngle = selectedAngle === undefined ? undefined : normalizePositionAngle(selectedAngle);
  return {
    footprint: withFootprintPositionAngle(footprint, normalizedAngle),
    ...(normalizedAngle !== undefined ? { resolved_position_angle_deg: normalizedAngle } : {}),
  };
}

/** Return a new top-level footprint with an absolute PA, leaving the input untouched.
 *
 * Rectangles and polygons use their top-level PA directly; compounds use it as
 * the parent rotation. Circles are invariant under rotation and retain no PA.
 *
 * @param footprint - Validated local instrument geometry.
 * @param positionAngleDeg - Absolute astronomical PA, or undefined for canonical orientation.
 * @returns A fresh immutable-shape copy with the requested top-level orientation.
 * @throws If a supplied angle is non-finite.
 */
export function withFootprintPositionAngle(footprint: Footprint, positionAngleDeg?: number): Footprint {
  assertFiniteAngle(positionAngleDeg, "Effective position angle");
  if (footprint.type === "circle") return footprint;
  const withoutPreviousAngle = { ...footprint } as Footprint & { position_angle_deg?: number };
  delete withoutPreviousAngle.position_angle_deg;
  return positionAngleDeg === undefined
    ? withoutPreviousAngle
    : { ...withoutPreviousAngle, position_angle_deg: positionAngleDeg };
}

function topLevelPositionAngle(footprint: Footprint): number | undefined {
  return footprint.type === "circle" ? undefined : footprint.position_angle_deg;
}

function assertFiniteAngle(angle: number | undefined, label: string): void {
  if (angle !== undefined && !Number.isFinite(angle)) throw new Error(`${label} must be finite`);
}

function requireAngleIfNeeded(angle: number | undefined, required: boolean | undefined, message: string): void {
  if (required && angle === undefined) throw new Error(message);
}

function normalizePositionAngle(angle: number): number {
  const normalized = ((angle % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}
