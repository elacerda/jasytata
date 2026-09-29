import type { SurveyProfileV2, TileRecord } from "../types";
import { validateSurveyProfileV2 } from "../profiles/schema-v2";
import { formatDecDegrees, formatRaDegrees } from "./coordinates";

type CsvValue = string | number | boolean;

/** Ordered output cells after scientific coordinates have been formatted. */
export interface PointingExportTable {
  columns: string[];
  rows: CsvValue[][];
}

/** One ordered exposure coordinate supplied to the optional sequence exporter. */
export interface PointingExposureExport {
  /** Stable runtime identity, unique within this pointing's returned sequence. */
  id: string;
  /** Contiguous 1-based order within the pointing. */
  order: number;
  /** Exposure-center ICRS right ascension in decimal degrees. */
  ra_deg: number;
  /** Exposure-center ICRS declination in decimal degrees. */
  dec_deg: number;
  /** Declared absolute camera PA in degrees east of north, when meaningful. */
  position_angle_deg?: number;
}

/** Optional caller-owned resolution for effective absolute pointing PA.
 * @property resolvePositionAngle - Resolve scientifically declared PA for each
 *   pointing. This callback owns profile/tile/plan precedence; export only
 *   validates and formats its result.
 * @property resolveExposures - Resolve ordered exposure centers, absolute PA,
 *   and runtime identity for each pointing. Return `undefined` for a pointing
 *   without a sequence so it retains its established single-row export.
 *   For sequence rows, export does not call `resolvePositionAngle`.
 */
export interface PointingExportOptions {
  resolvePositionAngle?: (tile: TileRecord) => number | undefined;
  resolveExposures?: (tile: TileRecord) => readonly PointingExposureExport[] | undefined;
}

/** Convert accepted ICRS pointings using the governing survey's validated policy.
 * @param proposedTiles - At most 500 proposals, in acceptance order. Disabled rows
 *   are omitted; coordinates remain ICRS degrees and source rows are rejected.
 * @param survey - Governing Schema v2 survey; no source headers or instrument select export policy.
 * @param epoch - Optional descriptive label from policy.epoch.allowed; defaults
 *   to policy.epoch.default. This performs no coordinate precession.
 * @returns Columns ordered RA, DEC, optional epoch, PA, ID/name/group, then constants
 *   sorted by code-unit key order. Without `resolveExposures`, IDs remain
 *   PROPOSED_0001, etc. in input order. With it, exposure IDs use
 *   PROPOSED_0001_EXP_0001 when the survey configures an ID column. Names use
 *   the declared proposal name or pointing ID, and group is the survey ID.
 * @throws For invalid policy/coordinates/provenance, missing requested camera PA,
 *   disallowed epoch, or an empty enabled set. Inputs are never modified.
 */
export function buildPointingExportTable(proposedTiles: readonly TileRecord[], survey: SurveyProfileV2, epoch?: string, options: PointingExportOptions = {}): PointingExportTable {
  const validated = validateSurveyProfileV2(survey);
  const policy = validated.export;
  if (proposedTiles.length > 500) throw new Error("Too many proposed tiles");
  if (proposedTiles.some((tile) => tile.source !== "proposed")) throw new Error("Generic export accepts only proposed tile centers");
  const selectedEpoch = epoch ?? policy.epoch?.default;
  if (policy.epoch && !policy.epoch.allowed.includes(selectedEpoch!)) throw new Error(`Epoch '${selectedEpoch}' is not allowed by survey ${validated.id}`);
  if (!policy.epoch && epoch !== undefined) throw new Error("This survey does not declare an export epoch");
  const constants = Object.entries(policy.constant_fields ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const identifiers = policy.identifiers;
  const columns = [policy.ra_column, policy.dec_column,
    ...(policy.epoch ? [policy.epoch.column] : []),
    ...(policy.position_angle_column ? [policy.position_angle_column] : []),
    ...(identifiers?.id_column ? [identifiers.id_column] : []),
    ...(identifiers?.name_column ? [identifiers.name_column] : []),
    ...(identifiers?.group_column ? [identifiers.group_column] : []),
    ...constants.map(([key]) => key)];
  const rows: CsvValue[][] = [];
  proposedTiles.forEach((tile, index) => {
    if (tile.enabled === false) return;
    if (!Number.isFinite(tile.ra_deg) || tile.ra_deg < 0 || tile.ra_deg >= 360 || !Number.isFinite(tile.dec_deg) || Math.abs(tile.dec_deg) > 90 || !tile.generation_method) throw new Error(`Invalid proposed tile ${tile.id}`);
    const observerId = `PROPOSED_${String(index + 1).padStart(4, "0")}`;
    const resolvedExposures = options.resolveExposures?.(tile);
    if (resolvedExposures !== undefined) {
      const exposures = validateExposureRows(resolvedExposures, index + 1);
      if (exposures.length > 1 && !identifiers?.id_column) {
        throw new Error("An ID column is required to identify multiple exposure rows per pointing");
      }
      exposures.forEach((exposure) => {
        if (policy.position_angle_column && !Number.isFinite(exposure.position_angle_deg)) {
          throw new Error(`Pointing ${index + 1} exposure ${exposure.order} has no declared camera position angle required by '${policy.position_angle_column}'`);
        }
        const ra = policy.coordinate_format === "decimal" ? exposure.ra_deg.toFixed(8) : formatRaDegrees(exposure.ra_deg, 3);
        const dec = policy.coordinate_format === "decimal" ? exposure.dec_deg.toFixed(8) : formatDecDegrees(exposure.dec_deg, 3);
        const exposureId = `${observerId}_EXP_${String(exposure.order).padStart(4, "0")}`;
        rows.push([ra, dec,
          ...(policy.epoch ? [selectedEpoch!] : []),
          ...(policy.position_angle_column ? [exposure.position_angle_deg!.toFixed(8)] : []),
          ...(identifiers?.id_column ? [exposureId] : []),
          ...(identifiers?.name_column ? [tile.name || observerId] : []),
          ...(identifiers?.group_column ? [validated.id] : []),
          ...constants.map(([, value]) => value)]);
      });
      return;
    }

    const positionAngle = policy.position_angle_column
      ? (options.resolvePositionAngle ? options.resolvePositionAngle(tile) : tile.position_angle_deg)
      : undefined;
    if (policy.position_angle_column && !Number.isFinite(positionAngle)) throw new Error(`Pointing ${index + 1} has no declared camera position angle required by '${policy.position_angle_column}'`);
    const ra = policy.coordinate_format === "decimal" ? tile.ra_deg.toFixed(8) : formatRaDegrees(tile.ra_deg, 3);
    const dec = policy.coordinate_format === "decimal" ? tile.dec_deg.toFixed(8) : formatDecDegrees(tile.dec_deg, 3);
    rows.push([ra, dec,
      ...(policy.epoch ? [selectedEpoch!] : []),
      ...(policy.position_angle_column ? [positionAngle!.toFixed(8)] : []),
      ...(identifiers?.id_column ? [observerId] : []),
      ...(identifiers?.name_column ? [tile.name || observerId] : []),
      ...(identifiers?.group_column ? [validated.id] : []),
      ...constants.map(([, value]) => value)]);
  });
  if (!rows.length) throw new Error("Enable at least one proposed tile before downloading");
  return { columns, rows };
}

function validateExposureRows(exposures: readonly PointingExposureExport[], pointingIndex: number): PointingExposureExport[] {
  if (!Array.isArray(exposures) || exposures.length === 0) {
    throw new Error(`Pointing ${pointingIndex} exposure resolver must return at least one exposure`);
  }
  const ids = new Set<string>();
  exposures.forEach((exposure, index) => {
    if (typeof exposure.id !== "string" || !exposure.id.trim() || ids.has(exposure.id)) {
      throw new Error(`Pointing ${pointingIndex} exposures must have unique non-empty identities`);
    }
    ids.add(exposure.id);
    if (exposure.order !== index + 1) {
      throw new Error(`Pointing ${pointingIndex} exposure order must be contiguous and 1-based`);
    }
    if (!Number.isInteger(exposure.order)) {
      throw new Error(`Pointing ${pointingIndex} exposure order must be contiguous and 1-based`);
    }
    if (!Number.isFinite(exposure.ra_deg) || exposure.ra_deg < 0 || exposure.ra_deg >= 360 ||
      !Number.isFinite(exposure.dec_deg) || Math.abs(exposure.dec_deg) > 90) {
      throw new Error(`Pointing ${pointingIndex} exposure ${exposure.order} has invalid ICRS coordinates`);
    }
    if (exposure.position_angle_deg !== undefined && !Number.isFinite(exposure.position_angle_deg)) {
      throw new Error(`Pointing ${pointingIndex} exposure ${exposure.order} has nonfinite camera position angle`);
    }
  });
  return [...exposures];
}

/** Serialize ordered primitive cells as escaped CSV with CRLF and a final newline.
 * @param table - Canonical output columns and rows; primitive types use String conversion.
 * @returns Deterministic CSV, quoting commas, double quotes, CR and LF in every cell.
 */
export function serializePointingCsv(table: PointingExportTable): string {
  const escape = (value: CsvValue) => {
    const text = String(value);
    return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [...[table.columns, ...table.rows].map((row) => row.map(escape).join(",")), ""].join("\r\n");
}

/** Export accepted ICRS centers through the survey policy and escaped CSV serializer.
 * @param proposedTiles - Canonical accepted proposals in stable input order.
 * @param survey - Validated governing survey, including its authoritative export policy.
 * @param epoch - Optional allowed epoch label; omitted to use the declared default.
 * @param options - Optional caller-owned PA or ordered exposure resolution. Exposure
 *   rows change coordinates/row count only when `resolveExposures` is supplied.
 * @returns UTF-8-ready CSV with CRLF, preserving established T80 formatting precision.
 * @throws If canonical row conversion fails; no fallback profile or format is used.
 */
export function buildExportCsv(proposedTiles: readonly TileRecord[], survey: SurveyProfileV2, epoch?: string, options: PointingExportOptions = {}): string {
  return serializePointingCsv(buildPointingExportTable(proposedTiles, survey, epoch, options));
}
