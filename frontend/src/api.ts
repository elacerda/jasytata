import type {
  CenterInput,
  CatalogueResponse,
  CoverageStrategy,
  PlanMetrics,
  RegionPlanResponse,
  SkyPolygon,
  TileRecord,
  TilingProfile,
} from "./types";
import { loadProfile, listProfiles, validateProfile, parseProfileJson, serializeProfile, profileRegistry, type ProfileRegistry, type ProfileDocument, ProfileError } from "./profiles";
import { T80_SOUTH_INSTRUMENT_V2 } from "./profiles/v2";
import { makeCenterProposals, parseCatalogueCsv, parseCenterText } from "./science/catalogue";
import { buildExportCsv } from "./science/export";
import type { PointingExportOptions } from "./science/export";
import { resolvePointingGeometries, type PointingGeometryContext } from "./science/pointing-geometry";
import { resolvePlanningProfile } from "./profiles/planning";
import { planRegion as planRegionLocal } from "./science/planner";
import { measureActiveCoverage } from "./science/coverage";

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
 * @returns Parsed S-PLUS reference rows explicitly associated with the T80-South instrument.
 */
export async function loadReferenceCatalogue(): Promise<CatalogueResponse> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/tiles_nc.csv`);
  if (!response.ok) throw new Error("The supplied reference catalogue is not installed");
  return {
    ...parseCatalogueCsv(new Uint8Array(await response.arrayBuffer()), "tiles_nc.csv"),
    instrument_profile_id: T80_SOUTH_INSTRUMENT_V2.id,
  };
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

/** Resolve the governing survey, serialize its policy and download locally.
 * @param proposedTiles - Accepted proposals in acceptance order; disabled rows are omitted.
 * @param surveyId - Exact active Schema v2 survey ID, never a source instrument ID.
 * @param epoch - Optional allowed descriptive epoch; the policy supplies its default.
 * @param registry - Validated session registry, injectable for isolated tests.
 * @param geometryContext - Optional Gate 5 runtime orientation and strategy choice.
 * @returns Resolves after triggering new_tiles.csv in the browser.
 * @throws For unresolved/invalid surveys or export rows. No backend or fallback is used.
 */
export async function downloadCatalogue(
  proposedTiles: TileRecord[],
  surveyId: string,
  epoch?: string,
  registry: ProfileRegistry = profileRegistry,
  geometryContext?: PointingGeometryContext,
): Promise<void> {
  const survey = registry.resolveSurveyProfile(surveyId);
  let options: PointingExportOptions | undefined;
  if (geometryContext) {
    const profile = resolvePlanningProfile(surveyId, undefined, registry).profile;
    const nominal = { ...geometryContext, coverageBasis: "single_exposure" as const };
    const sequences = new Map(proposedTiles.filter((tile) => tile.enabled !== false).map((tile) => [
      tile, geometryContext.sequenceForTile?.(tile),
    ] as const));
    const effective = {
      ...geometryContext,
      coverageBasis: "effective_sequence" as const,
      sequenceForTile: (tile: TileRecord) => sequences.get(tile),
    };
    const hasSequence = [...sequences.values()].some((sequence) => sequence !== undefined);
    options = {
      resolvePositionAngle: (tile) => resolvePointingGeometries(tile, profile, registry, nominal)[0].position_angle_deg,
      ...(hasSequence ? { resolveExposures: (tile: TileRecord) => sequences.get(tile) === undefined ? undefined : resolvePointingGeometries(tile, profile, registry, effective).map((geometry) => ({
        id: geometry.id,
        order: geometry.order,
        ra_deg: geometry.center[0],
        dec_deg: geometry.center[1],
        ...(geometry.position_angle_deg === undefined ? {} : { position_angle_deg: geometry.position_angle_deg }),
      })) } : {}),
    };
  }
  const blob = new Blob([buildExportCsv(proposedTiles, survey, epoch, options)], { type: "text/csv; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "new_tiles.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Plan a selected ICRS region entirely in the browser.
 * @param polygon - Ordered selected vertices in decimal degrees.
 * @param existingTiles - Original and accepted pointings.
 * @param profileId - Bundled or custom profile ID.
 * @param profile - Inline custom geometry when selected.
 * @param strategy - Sampled-coverage stopping policy.
 * @param geometryContext - Optional runtime pointing orientation and sequence geometry.
 * @returns Auditable proposal and sampled metrics.
 */
export async function planRegion(polygon: SkyPolygon, existingTiles: TileRecord[], profileId?: string, profile?: TilingProfile, strategy: CoverageStrategy = "complete", geometryContext?: PointingGeometryContext): Promise<RegionPlanResponse> {
  return planRegionLocal(polygon, existingTiles, profileId, profile, strategy, profileRegistry, geometryContext);
}

/** Build the scientific planning input shared with development diagnostics.
 * @param polygon - Ordered ICRS vertices in decimal degrees.
 * @param existingTiles - Actual loaded centers and enabled accepted proposals.
 * @param profileId - Active footprint profile ID.
 * @param profile - Optional inline custom profile.
 * @param strategy - Sampled-coverage stopping policy.
 * @returns JSON-compatible planning request shape.
 */
export function buildRegionPlanRequest(polygon: SkyPolygon, existingTiles: TileRecord[], profileId?: string, profile?: TilingProfile, strategy: CoverageStrategy = "complete") {
  return { polygon, existing_tiles: existingTiles, profile_id: profileId, ...(profile ? { profile } : {}), coverage_strategy: strategy };
}

/** Recompute sampled coverage from enabled proposals without HTTP.
 * @param polygon - Ordered selected ICRS vertices in decimal degrees.
 * @param existingTiles - All original and accepted pointings.
 * @param proposedTiles - Editable proposal records.
 * @param profileId - Active observing profile ID.
 * @param profile - Optional inline custom profile.
 * @param geometryContext - Optional Gate 5 nominal/effective geometry selection.
 * @returns Existing, incremental, and total coverage measurements.
 */
export async function measureCoverage(polygon: SkyPolygon, existingTiles: TileRecord[], proposedTiles: TileRecord[], profileId?: string, profile?: TilingProfile, geometryContext?: PointingGeometryContext): Promise<PlanMetrics> {
  return measureActiveCoverage(polygon, existingTiles, proposedTiles, profileId, profile, profileRegistry, geometryContext);
}

/** Read and atomically register a browser-selected Schema v2 profile file.
 * @param file - User-selected JSON file; its bytes are read only in the browser.
 * @param registry - Session registry, injectable for isolated tests.
 * @param occupiedInlineId - Optional ID held by an active legacy inline draft;
 *   ordinary file import must not create a conflicting active identity.
 * @returns Validated instrument/survey configuration registered as defensive copies.
 * @throws For non-JSON filenames, read failures, invalid data, or duplicate IDs.
 *   No registry entries are added unless the entire document passes.
 */
export async function uploadProfileFile(file: File, registry: ProfileRegistry = profileRegistry, occupiedInlineId?: string): Promise<ProfileDocument> {
  if (!file.name.toLowerCase().endsWith(".json")) throw new Error("Choose a .json profile file");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  const document = parseProfileJson(text);
  if (document.survey.id === occupiedInlineId) {
    throw new ProfileError("duplicate_id", `Survey profile ID "${document.survey.id}" is already used by the active custom draft`);
  }
  return registry.registerProfileDocument(document);
}

/** Download a registered survey and instrument using the canonical serializer.
 * @param id - Exact registered survey ID; Schema v2 IDs are safe filename stems.
 * @param registry - Session registry, injectable for isolated tests.
 * @returns Resolves after triggering the local JSON download; no storage is written.
 * @throws If the profile is unknown or serialization fails.
 */
export async function downloadProfileJson(id: string, registry: ProfileRegistry = profileRegistry): Promise<void> {
  return downloadProfileDocument(registry.resolveProfileDocument(id));
}

/** Download a complete authored document without registering it.
 * @param profileDocument - Declarative instrument/survey configuration only.
 * @returns Resolves after canonical validation and browser JSON download.
 * @throws If strict document validation or download fails. No registry is mutated.
 */
export async function downloadProfileDocument(profileDocument: ProfileDocument): Promise<void> {
  const blob = new Blob([serializeProfile(profileDocument)], { type: "application/json; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${profileDocument.survey.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
