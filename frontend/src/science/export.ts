import type { InstrumentProfileV3, PlacementProvenance, SurveyProfileV2, SurveyProfileV3, TileRecord } from "../types";
import { validateInstrumentProfileV3 } from "../profiles/schema-v3";
import { validateSurveyProfileV2 } from "../profiles/schema-v2";
import { validateSurveyProfileV3 } from "../profiles/schema-v3";
import { formatDecDegrees, formatRaDegrees } from "./coordinates";

type CsvValue = string | number | boolean;

/** Ordered output cells after scientific coordinates have been formatted. */
export interface PointingExportTable {
  columns: string[];
  rows: CsvValue[][];
}

/** Representation requested from a sequence-bearing pointing export. */
export type PointingExportMode = "nominal" | "expanded";

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

/** Caller-resolved orientation for generic instrument-only center export. */
export interface InstrumentCoordinateExportOptions {
  /** Gate 5 resolution of the declared physical PA, when one exists. */
  resolvePositionAngle: (tile: TileRecord) => number | undefined;
}

/** Convert accepted ICRS pointings using the governing v2 survey or v3 strategy policy.
 * @param proposedTiles - At most 500 proposals, in acceptance order. Disabled rows
 *   are omitted; coordinates remain ICRS degrees and source rows are rejected.
 * @param survey - Governing validated Schema v2 survey or v3 strategy; profile data selects export policy.
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
export function buildPointingExportTable(proposedTiles: readonly TileRecord[], survey: SurveyProfileV2 | SurveyProfileV3, epoch?: string, options: PointingExportOptions = {}): PointingExportTable {
  const validated = survey.schema_version === 3 ? validateSurveyProfileV3(survey) : validateSurveyProfileV2(survey);
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

/** Export accepted nominal centers for one standalone Schema v3 instrument.
 *
 * The document has no survey policy, so this path writes only ICRS coordinates,
 * stable instrument identity, known placement origin, and physically resolved
 * PA/source provenance when declared. It never adds an epoch, survey constants,
 * a strategy, or derived exposure rows.
 *
 * @param proposedTiles - Accepted proposal rows in stable acceptance order;
 *   disabled rows are omitted.
 * @param instrument - Validated Schema v3 instrument profile selected for output.
 * @param options - Gate 5 absolute-PA resolution using the instrument policy.
 * @returns CSV table with deterministic generic Jasytata coordinate columns.
 * @throws If rows do not belong to this instrument, placement origin is unknown,
 *   PA resolution fails, or no enabled proposals remain.
 */
export function buildInstrumentCoordinateTable(
  proposedTiles: readonly TileRecord[],
  instrument: InstrumentProfileV3,
  options: InstrumentCoordinateExportOptions,
): PointingExportTable {
  const validated = validateInstrumentProfileV3(instrument);
  if (proposedTiles.length > 500) throw new Error("Too many proposed tiles");
  if (proposedTiles.some((tile) => tile.source !== "proposed")) throw new Error("Generic export accepts only proposed tile centers");
  const enabled = proposedTiles.filter((tile) => tile.enabled !== false);
  if (!enabled.length) throw new Error("Enable at least one proposed tile before downloading");

  const prepared = enabled.map((tile, index) => {
    if (!Number.isFinite(tile.ra_deg) || tile.ra_deg < 0 || tile.ra_deg >= 360 ||
      !Number.isFinite(tile.dec_deg) || Math.abs(tile.dec_deg) > 90 || !tile.generation_method) {
      throw new Error(`Invalid proposed tile ${tile.id}`);
    }
    if (tile.instrument_profile_id !== validated.id) {
      throw new Error(`Pointing ${index + 1} is not assigned to instrument ${validated.id}`);
    }
    const provenance = tile.placement_provenance;
    if (!provenance) throw new Error(`Pointing ${index + 1} has no declared placement origin`);
    const sourceReference = formatPlacementSourceReference(provenance);
    const positionAngle = options.resolvePositionAngle(tile);
    if (positionAngle !== undefined && !Number.isFinite(positionAngle)) {
      throw new Error(`Pointing ${index + 1} has a nonfinite camera position angle`);
    }
    if (validated.position_angle.required && positionAngle === undefined) {
      throw new Error(`Pointing ${index + 1} has no declared camera position angle required by ${validated.display_name}`);
    }
    if (validated.position_angle.mode === "not_applicable" && positionAngle !== undefined) {
      throw new Error(`Instrument ${validated.display_name} does not declare a physical position angle`);
    }
    return {
      tile,
      pointingId: `POINTING_${String(index + 1).padStart(4, "0")}`,
      provenance,
      sourceReference,
      positionAngle,
    };
  });
  const includePositionAngle = validated.position_angle.mode !== "not_applicable" &&
    (validated.position_angle.required || validated.position_angle.mode === "fixed" || prepared.some((row) => row.positionAngle !== undefined));
  const includeSourceReference = prepared.some((row) => row.sourceReference !== undefined);
  const columns = ["POINTING_ID", "RA_ICRS_DEG", "DEC_ICRS_DEG", "INSTRUMENT_PROFILE_ID", "PLACEMENT_ORIGIN",
    ...(includePositionAngle ? ["POSITION_ANGLE_DEG"] : []),
    ...(includeSourceReference ? ["PLACEMENT_SOURCE_REFERENCE"] : [])];
  const rows = prepared.map(({ tile, pointingId, provenance, sourceReference, positionAngle }) => [
    pointingId,
    tile.ra_deg.toFixed(8),
    tile.dec_deg.toFixed(8),
    validated.id,
    provenance.origin,
    ...(includePositionAngle ? [positionAngle === undefined ? "" : positionAngle.toFixed(8)] : []),
    ...(includeSourceReference ? [sourceReference ?? ""] : []),
  ]);
  return { columns, rows };
}

/** Serialize the generic instrument-only ICRS center table as deterministic CSV.
 * @param proposedTiles - Accepted nominal pointing centers.
 * @param instrument - Validated standalone Schema v3 instrument.
 * @param options - Gate 5 PA resolver for the selected instrument policy.
 * @returns UTF-8-ready CSV with CRLF line endings.
 */
export function buildInstrumentCoordinateCsv(
  proposedTiles: readonly TileRecord[],
  instrument: InstrumentProfileV3,
  options: InstrumentCoordinateExportOptions,
): string {
  return serializePointingCsv(buildInstrumentCoordinateTable(proposedTiles, instrument, options));
}

function formatPlacementSourceReference(provenance: PlacementProvenance): string | undefined {
  if (provenance.origin !== "authoritative_import") return undefined;
  const reference = provenance.source_reference;
  if (!reference) throw new Error("Authoritative imported centers require a source reference");
  const locator = reference.url ?? reference.doi;
  if (!locator) throw new Error("Authoritative imported centers require a source reference URL or DOI");
  return reference.locator ? `${locator} (${reference.locator})` : locator;
}

/** Export accepted ICRS centers through a validated v2 survey or v3 strategy policy.
 * @param proposedTiles - Canonical accepted proposals in stable input order.
 * @param survey - Validated governing survey/strategy, including its export policy.
 * @param epoch - Optional allowed epoch label; omitted to use the declared default.
 * @param options - Optional caller-owned PA or ordered exposure resolution. Exposure
 *   rows change coordinates/row count only when `resolveExposures` is supplied.
 * @returns UTF-8-ready CSV with CRLF, preserving established T80 formatting precision.
 * @throws If canonical row conversion fails; no fallback profile or format is used.
 */
export function buildExportCsv(proposedTiles: readonly TileRecord[], survey: SurveyProfileV2 | SurveyProfileV3, epoch?: string, options: PointingExportOptions = {}): string {
  return serializePointingCsv(buildPointingExportTable(proposedTiles, survey, epoch, options));
}
