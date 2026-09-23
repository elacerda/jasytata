import type {
  CenterInput,
  CatalogueResponse,
  ExportConfig,
  SkyPolygon,
  RegionPlanResponse,
  TileRecord,
  TilingProfile,
} from "./types";

/** Load the installed default observing profile and its physical tile geometry.
 *
 * @returns The backend-selected default profile.
 */
export async function loadDefaultProfile(): Promise<TilingProfile> {
  const response = await checked<{ default_profile_id: string; profiles: TilingProfile[] }>(
    await fetch("/api/profiles"),
  );
  const profile = response.profiles.find((item) => item.id === response.default_profile_id);
  if (!profile) throw new Error("The default observing profile is not installed.");
  return profile;
}

async function checked<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const message = typeof body?.detail === "string" ? body.detail : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
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
  const form = new FormData();
  form.append("file", file);
  if (mapping) {
    form.append("ra_column", mapping.raColumn);
    form.append("dec_column", mapping.decColumn);
    form.append("ra_unit", mapping.raUnit);
  }
  return checked(await fetch("/api/catalogue/parse", { method: "POST", body: form }));
}

/** Load the representative catalogue shipped with the repository.
 *
 * @returns Parsed bundled S-PLUS reference catalogue rows.
 */
export async function loadReferenceCatalogue(): Promise<CatalogueResponse> {
  return checked(await fetch("/api/catalogue/reference"));
}

/** Parse pasted RA/DEC rows for review before proposal creation.
 *
 * @param text - One sexagesimal-hour or decimal-degree RA/DEC pair per line.
 * @returns Valid centers in decimal degrees.
 */
export async function parseCenters(text: string): Promise<CenterInput[]> {
  const response = await checked<{ centers: CenterInput[] }>(
    await fetch("/api/centers/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
  return response.centers;
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
  const response = await checked<{ tiles: TileRecord[] }>(
    await fetch("/api/proposals/centers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ centers, generation_method: generationMethod }),
    }),
  );
  return response.tiles;
}

/** Plan a selected region against original and already accepted proposed tiles.
 *
 * @param polygon - Ordered ICRS vertices in decimal degrees.
 * @param existingTiles - Original catalogue plus accepted proposals.
 * @param profileId - Active observing profile identifier.
 * @returns Auditable solution with selected centers, anchors, diagnostics, and metrics.
 */
export async function planRegion(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  profileId?: string,
): Promise<RegionPlanResponse> {
  return checked(
    await fetch("/api/plan/region", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        polygon,
        existing_tiles: existingTiles,
        profile_id: profileId,
      }),
    }),
  );
}

/** Request a server-validated CSV and trigger a browser download.
 *
 * @param kind - New-only proposal rows or complete original-plus-proposal catalogue.
 * @param originalTiles - Immutable original rows with their raw CSV field values.
 * @param proposedTiles - Accepted proposal rows.
 * @param config - PID, name sequence, EPOC, and STATUS controls.
 * @returns A promise that resolves after the browser download is triggered.
 */
export async function downloadCatalogue(
  kind: "new" | "updated",
  originalTiles: TileRecord[],
  proposedTiles: TileRecord[],
  config: ExportConfig,
): Promise<void> {
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, original_tiles: originalTiles, proposed_tiles: proposedTiles, config }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `Export failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = kind === "new" ? "new_tiles.csv" : "tiles_nc_updated.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
