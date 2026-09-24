import type { CoordinateFormat, TileRecord, TilingProfile } from "../types";
import { formatDecDegrees, formatRaDegrees } from "./coordinates";
import { resolveProfile } from "../profiles";

/** Serialize active proposed ICRS centers to the Python-compatible generic CSV.
 * @param proposedTiles - Up to 500 proposals with decimal-degree ICRS centers.
 * @param profileId - Installed profile ID or custom.
 * @param epoch - Descriptive catalogue epoch label; no precession is applied.
 * @param coordinateFormat - Decimal degrees or sexagesimal hour-angle RA and degree DEC.
 * @param inlineProfile - Session-only custom geometry when profileId is custom.
 * @returns UTF-8-ready CSV text with CRLF and RA,DEC,EPOCH fields.
 * @throws On invalid tiles, format, epoch, profile, or no enabled proposal.
 */
export function buildExportCsv(proposedTiles: TileRecord[], profileId = "splus-t80-south", epoch?: string, coordinateFormat: CoordinateFormat = "decimal", inlineProfile?: TilingProfile): string {
  if (proposedTiles.length > 500) throw new Error("Too many proposed tiles");
  const profile = resolveProfile(profileId, inlineProfile);
  const selectedEpoch = epoch ?? profile.export_epoch_default;
  if (!profile.export_epoch_options.includes(selectedEpoch)) throw new Error(`Epoch '${selectedEpoch}' is not allowed by profile ${profile.id}`);
  if (proposedTiles.some((tile) => tile.source !== "proposed")) throw new Error("Generic export accepts only proposed tile centers");
  if (!["decimal", "sexagesimal"].includes(coordinateFormat)) throw new Error("Invalid coordinate format");
  const active = proposedTiles.filter((tile) => tile.enabled !== false);
  if (!active.length) throw new Error("Enable at least one proposed tile before downloading");
  const rows = active.map((tile) => {
    if (!Number.isFinite(tile.ra_deg) || tile.ra_deg < 0 || tile.ra_deg >= 360 || !Number.isFinite(tile.dec_deg) || Math.abs(tile.dec_deg) > 90 || !tile.generation_method) throw new Error(`Invalid proposed tile ${tile.id}`);
    const ra = coordinateFormat === "decimal" ? tile.ra_deg.toFixed(8) : formatRaDegrees(tile.ra_deg, 3);
    const dec = coordinateFormat === "decimal" ? tile.dec_deg.toFixed(8) : formatDecDegrees(tile.dec_deg, 3);
    return `${ra},${dec},${selectedEpoch}`;
  });
  return ["RA,DEC,EPOCH", ...rows, ""].join("\r\n");
}
