import type {
  CenterInput,
  CatalogueResponse,
  CoordinateFormat,
  TileRecord,
  TilingProfile,
} from "./types";
import { loadProfile, listProfiles, validateProfile } from "./profiles";
import { makeCenterProposals, parseCatalogueCsv, parseCenterText } from "./science/catalogue";
import { buildExportCsv } from "./science/export";

/** Load the installed default observing profile and its physical tile geometry.
 *
 * @returns The bundled default profile.
 */
export async function loadDefaultProfile(): Promise<TilingProfile> {
  return loadProfile();
}

/** Validate an ad hoc profile with the locally ported canonical profile model.
 *
 * @param profile - Complete canonical profile with custom rectangular geometry.
 * @returns Validated profile for the current browser session.
 */
export async function validateCustomProfile(profile: TilingProfile): Promise<TilingProfile> {
  return validateProfile(profile);
}

/** List local observing profiles with the historical API response shape.
 * @returns Default profile identifier and installed validated definitions.
 */
export async function getProfiles(): Promise<{ default_profile_id: string; profiles: TilingProfile[] }> {
  return { default_profile_id: loadProfile().id, profiles: listProfiles() };
}

/** Upload a catalogue and preserve original CSV field values.
 *
 * @param file - CSV selected by the user.
 * @param mapping - Optional user-selected coordinate headers and RA unit.
 * @returns Parsed catalogue with decimal-degree coordinates.
 */
export async function uploadCatalogue(
  file: File,
  mapping?: { raColumn: string; decColumn: string; raUnit: "auto" | "degrees" | "hours" },
): Promise<CatalogueResponse> {
  if (file.name && !file.name.toLowerCase().endsWith(".csv")) throw new Error("Upload a CSV file");
  return parseCatalogueCsv(new Uint8Array(await file.arrayBuffer()), file.name || "catalogue.csv", mapping?.raColumn, mapping?.decColumn, mapping?.raUnit);
}

/** Load the representative catalogue shipped with the repository.
 *
 * @returns Parsed bundled S-PLUS reference catalogue rows.
 */
export async function loadReferenceCatalogue(): Promise<CatalogueResponse> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/tiles_nc.csv`);
  if (!response.ok) throw new Error("The supplied reference catalogue is not installed");
  return parseCatalogueCsv(new Uint8Array(await response.arrayBuffer()), "tiles_nc.csv");
}

/** Parse pasted RA/DEC rows for review before proposal creation.
 *
 * @param text - One sexagesimal-hour or decimal-degree RA/DEC pair per line.
 * @returns Valid centers in decimal degrees.
 */
export async function parseCenters(text: string): Promise<CenterInput[]> {
  if (!text.length || text.length > 500_000) throw new Error("Invalid center text length");
  return parseCenterText(text);
}

/** Convert parsed centers into provisional proposal records.
 *
 * @param centers - Validated RA/DEC positions in decimal degrees.
 * @param generationMethod - Manual click or pasted-center origin.
 * @returns Proposal records that remain separate until accepted.
 */
export async function proposeCenters(
  centers: CenterInput[],
  generationMethod: "manual" | "imported_centers",
): Promise<TileRecord[]> {
  return makeCenterProposals(centers, generationMethod);
}

/** Serialize an ICRS CSV locally and trigger a browser download.
 *
 * @param proposedTiles - Accepted enabled proposal positions.
 * @param profileId - Active observing profile.
 * @param epoch - Profile-approved descriptive catalogue epoch.
 * @param coordinateFormat - Decimal degrees or sexagesimal RA/DEC.
 * @param profile - Inline canonical profile for custom geometry.
 * @returns A promise that resolves after the browser download is triggered.
 */
export async function downloadCatalogue(
  proposedTiles: TileRecord[],
  profileId: string,
  epoch: string,
  coordinateFormat: CoordinateFormat,
  profile?: TilingProfile,
): Promise<void> {
  const blob = new Blob([buildExportCsv(proposedTiles, profileId, epoch, coordinateFormat, profile)], { type: "text/csv; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "new_tiles.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export { buildRegionPlanRequest, planRegion, measureCoverage } from "./legacyBackend";
