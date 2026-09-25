import type { TilingProfile } from "../types";
import { profileRegistry, type ProfileRegistry } from "./registry";

/** Resolve the axis-aligned rectangle used by Gate 2 coverage and inference.
 *
 * @param instrumentProfileId - Registered instrument associated with a source dataset.
 * @param outputProfile - Active output profile whose non-geometric policies are retained.
 * @param registry - Browser-memory profile registry.
 * @returns Output-profile copy with source rectangle dimensions in degrees.
 * @throws If the instrument is unknown, non-rectangular, or rotated beyond Gate 2 support.
 */
export function resolveGate2Rectangle(
  instrumentProfileId: string,
  outputProfile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): TilingProfile {
  const instrument = registry.resolveInstrumentProfile(instrumentProfileId);
  if (instrument.footprint.type !== "rectangle") {
    throw new Error(
      `Unsupported Gate 2 footprint for instrument profile "${instrument.id}": ${instrument.footprint.type}. Only rectangular footprints are supported.`,
    );
  }
  const positionAngle = instrument.footprint.position_angle_deg;
  if (positionAngle !== undefined && Math.abs(((positionAngle % 360) + 360) % 360) > 1e-12) {
    throw new Error(
      `Unsupported Gate 2 footprint rotation for instrument profile "${instrument.id}". Only axis-aligned rectangles are supported.`,
    );
  }
  return {
    ...outputProfile,
    tile_width_deg: instrument.footprint.width_deg,
    tile_height_deg: instrument.footprint.height_deg,
  };
}
