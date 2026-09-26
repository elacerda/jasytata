import type { CatalogueResponse, CenterInput, GenerationMethod, TileRecord } from "../types";
import { parseDecDegrees, parseRaDegrees, type RaUnit } from "./coordinates";

const RA_ALIASES = new Set(["ra", "ra_deg", "radeg", "ra_hours", "ra_icrs", "raj2000", "right_ascension", "rightascension"]);
const DEC_ALIASES = new Set(["dec", "dec_deg", "decdeg", "dec_icrs", "dej2000", "declination"]);
const alias = (header: string) => header.toLowerCase().replaceAll(" ", "_");

/** Read RFC-style CSV cells, including quoted commas, escaped quotes, and multiline fields.
 * @param text - Decoded UTF-8 CSV content.
 * @returns Ordered raw records with source cell strings intact.
 */
export function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"' && (quoted || field === "")) quoted = !quoted;
    else if (char === "," && !quoted) { record.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field); records.push(record); record = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("Unterminated quoted CSV value");
  if (record.length || field) { record.push(field); records.push(record); }
  return records;
}

/** Parse an uploaded ICRS catalogue while preserving every original CSV value.
 * @param contents - UTF-8 CSV bytes, optionally with BOM.
 * @param filename - Source filename used for provenance and group IDs.
 * @param raColumn - Explicit RA header for ambiguous catalogues.
 * @param decColumn - Explicit DEC header for ambiguous catalogues.
 * @param raUnit - Numeric RA convention; ra_hours in auto mode means hours.
 * @returns Canonical decimal-degree tiles or a column mapping request.
 * @throws On invalid UTF-8, headers, units, selected rows, or empty catalogues.
 */
export function parseCatalogueCsv(contents: Uint8Array, filename = "catalogue.csv", raColumn?: string, decColumn?: string, raUnit: RaUnit = "auto"): CatalogueResponse {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(contents).replace(/^\uFEFF/, ""); }
  catch { throw new Error("CSV must be UTF-8 encoded"); }
  const records = readCsv(text);
  const headers = (records[0] ?? []).map((header) => header.trim());
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) throw new Error("CSV must have unique, non-empty column headers");
  if (!["auto", "degrees", "hours"].includes(raUnit)) throw new Error("RA unit must be auto, degrees, or hours");
  if ((raColumn === undefined) !== (decColumn === undefined)) throw new Error("Choose both RA and DEC columns");
  if (raColumn === undefined) {
    const ras = headers.filter((header) => RA_ALIASES.has(alias(header)));
    const decs = headers.filter((header) => DEC_ALIASES.has(alias(header)));
    if (ras.length !== 1 || decs.length !== 1) return {
      filename, row_count: 0, tiles: [], warnings: [], columns: headers,
      ra_column: null, dec_column: null, needs_mapping: true,
    };
    [raColumn] = ras; [decColumn] = decs;
  }
  if (!headers.includes(raColumn) || !headers.includes(decColumn!) || raColumn === decColumn) throw new Error("Selected RA and DEC columns must be distinct CSV headers");
  if (raUnit === "auto" && alias(raColumn) === "ra_hours") raUnit = "hours";
  const tiles: TileRecord[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const fields = records[i];
    if (fields.every((value) => !value.trim())) continue;
    const rowNumber = i + 1;
    if (fields.length > headers.length) throw new Error(`Row ${rowNumber}: too many CSV values`);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { row[header] = fields[index] ?? ""; });
    const missing = [raColumn, decColumn!].filter((key) => !row[key].trim());
    if (missing.length) throw new Error(`Row ${rowNumber}: empty required value in ${missing.join(", ")}`);
    try {
      const metadata = Object.fromEntries(Object.entries(row).filter(([key]) => key !== raColumn && key !== decColumn));
      tiles.push({
        id: `original-${i}`, name: row.NAME ?? `Row ${i}`,
        ra_deg: parseRaDegrees(row[raColumn], raUnit), dec_deg: parseDecDegrees(row[decColumn!]),
        source: "original", enabled: true, dataset_id: filename, group_id: `${filename}:${row.PID ?? ""}`,
        ra_column: raColumn, dec_column: decColumn, generation_method: null,
        original_values: row, metadata,
      });
    } catch (error) { throw new Error(`Row ${rowNumber}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!tiles.length) throw new Error("Catalogue contains no tile rows");
  return { filename, row_count: tiles.length, tiles, warnings: [], columns: headers, ra_column: raColumn, dec_column: decColumn, needs_mapping: false };
}

/** Parse pasted RA/DEC pairs with Python's comma, semicolon, and whitespace conventions.
 * @param text - One coordinate pair per non-empty line; sexagesimal RA denotes hours.
 * @returns ICRS centers in decimal degrees with one-based source line labels.
 * @throws On any malformed non-empty line or an empty import.
 */
export function parseCenterText(text: string): CenterInput[] {
  const centers: CenterInput[] = [];
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    const stripped = line.trim();
    if (!stripped) continue;
    const normalized = stripped.replaceAll(";", ",");
    let fields = normalized.includes(",") ? normalized.split(",").map((part) => part.trim()) : normalized.split(/\s+/);
    if (!normalized.includes(",")) {
      if (fields.length === 6) fields = [fields.slice(0, 3).join(":"), fields.slice(3).join(":")];
      else if (fields.length === 4 && fields[1].startsWith("+")) fields = [fields[0], fields.slice(1).join(":")];
      else if (fields.length === 4 && fields[1].startsWith("-")) fields = [fields[0], fields.slice(1).join(":")];
      else if (fields.length === 4 && fields[0].includes(":")) fields = [fields[0], fields.slice(1).join(":")];
      else if (fields.length === 4) fields = [fields.slice(0, 3).join(":"), fields[3]];
    }
    if (fields.length === 2 && ["RA", "RA_DEG", "RA(HMS)"].includes(fields[0].toUpperCase())) continue;
    if (fields.length !== 2) throw new Error(`Line ${index + 1}: expected exactly two values (RA and DEC)`);
    try { centers.push({ ra_deg: parseRaDegrees(fields[0]), dec_deg: parseDecDegrees(fields[1]), label: `Line ${index + 1}` }); }
    catch (error) { throw new Error(`Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!centers.length) throw new Error("No coordinate pairs found");
  return centers;
}

/** Create deterministic provisional proposal records from browser-side centers.
 * @param centers - Validated ICRS RA/DEC centers in decimal degrees, at most 500.
 * @param generationMethod - Manual, imported, compatibility, or declared lattice provenance.
 * @returns Proposed tiles with stable sequential session IDs.
 * @throws If centers or generation method violate the Python request contract.
 */
export function makeCenterProposals(centers: CenterInput[], generationMethod: GenerationMethod): TileRecord[] {
  if (!centers.length || centers.length > 500) throw new Error("Provide between 1 and 500 centers");
  if (!["manual", "imported_centers", "region_legacy", "region_extended", "region_lattice"].includes(generationMethod)) throw new Error("Invalid generation method");
  return centers.map((center, index) => {
    if (!Number.isFinite(center.ra_deg) || center.ra_deg < 0 || center.ra_deg >= 360 || !Number.isFinite(center.dec_deg) || Math.abs(center.dec_deg) > 90) throw new Error(`Center ${index + 1}: invalid RA or DEC`);
    return {
      id: `proposal-${generationMethod}-${String(index + 1).padStart(4, "0")}`, name: "",
      ra_deg: center.ra_deg, dec_deg: center.dec_deg, source: "proposed", enabled: true,
      dataset_id: null, group_id: null, ra_column: null, dec_column: null,
      generation_method: generationMethod, original_values: null, metadata: { label: center.label ?? "" },
    };
  });
}
