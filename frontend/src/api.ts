import { serializedPlanningChoices } from "./science/planning-operation";
import { runPlanningOperation } from "./planning-execution";
import type {
  CenterInput,
  CatalogueResponse,
  CoverageStrategy,
  CoverageResult,
  InstrumentProfileV3,
  RegionPlanResponse,
  SkyPolygon,
  TileRecord,
  TilingProfile,
} from "./types";
import { loadProfile, listProfiles, validateProfile, parseProfileJson, serializeProfile, profileRegistry, type ProfileRegistry, type AnyProfileDocument, ProfileError } from "./profiles";
import { T80_SOUTH_INSTRUMENT_V2 } from "./profiles/v2";
import { makeCenterProposals, parseCatalogueCsv, parseCenterText } from "./science/catalogue";
import { buildExportCsv, buildInstrumentCoordinateCsv } from "./science/export";
import type { PointingExportMode, PointingExportOptions } from "./science/export";
import { expandPointingExposures, resolvePointingGeometries, type PointingGeometryContext } from "./science/pointing-geometry";
import { resolvePlanningProfile } from "./profiles/planning";
import { planRegion as planRegionLocal, type ProjectLatticeCandidateSource } from "./science/planner";
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

/** Resolve the governing v2 survey or v3 strategy, serialize its policy and download locally.
 * @param proposedTiles - Accepted proposals in acceptance order; disabled rows are omitted.
 * @param surveyId - Exact active Schema v2 survey or v3 strategy ID, never a source instrument ID.
 * @param epoch - Optional allowed descriptive epoch; the policy supplies its default.
 * @param registry - Validated session registry, injectable for isolated tests.
 * @param geometryContext - Optional runtime orientation and strategy choice.
 * @param exportMode - Nominal centers or ordered physical exposures. Expanded
 *   output requires a registered sequence on the selected strategy.
 * @returns Resolves after triggering the policy-appropriate local CSV download.
 * @throws For unresolved/invalid surveys or export rows. No backend or fallback is used.
 */
export async function downloadCatalogue(
  proposedTiles: TileRecord[],
  surveyId: string,
  epoch?: string,
  registry: ProfileRegistry = profileRegistry,
  geometryContext?: PointingGeometryContext,
  exportMode: PointingExportMode = "nominal",
): Promise<void> {
  const survey = registry.resolveAnySurveyProfile(surveyId);
  if (exportMode === "expanded" && (survey.schema_version !== 3 || !survey.observing_sequence)) {
    throw new Error("Expanded exposure export requires a registered observing sequence on the selected strategy.");
  }
  if (exportMode === "expanded" && proposedTiles.some((tile) =>
    tile.enabled !== false && tile.output_strategy_id !== undefined &&
    tile.output_strategy_id !== null && tile.output_strategy_id !== survey.id,
  )) {
    throw new Error("Expanded exposure export cannot mix pointings associated with another observing strategy.");
  }
  let options: PointingExportOptions | undefined;
  if (geometryContext || exportMode === "expanded") {
    const profile = resolvePlanningProfile(surveyId, undefined, registry).profile;
    const context: PointingGeometryContext = {
      ...geometryContext,
      orientationPolicyForTile: geometryContext?.orientationPolicyForTile ?? ((tile) => {
        const instrumentId = tile.instrument_profile_id ?? (tile.source === "proposed" && survey.schema_version === 3
          ? survey.instrument_id
          : undefined);
        if (!instrumentId) return undefined;
        const instrument = registry.resolveInstrumentProfile(instrumentId);
        if (instrument.schema_version !== 3) return undefined;
        return {
          policy: instrument.position_angle.mode,
          required: instrument.position_angle.required,
          ...(instrument.position_angle.mode === "user_selected" && tile.output_position_angle_deg !== undefined
            ? { plan_position_angle_deg: tile.output_position_angle_deg }
            : {}),
        };
      }),
      sequenceForTile: geometryContext?.sequenceForTile ?? ((tile) => {
        const tileStrategyId = tile.output_strategy_id ?? (tile.source === "proposed" ? survey.id : undefined);
        const strategy = tileStrategyId ? registry.findAnySurveyProfile(tileStrategyId) : undefined;
        return strategy?.schema_version === 3 && strategy.observing_sequence
          ? { id: strategy.observing_sequence.id, exposures: strategy.observing_sequence.exposures }
          : undefined;
      }),
    };
    if (exportMode === "nominal") {
      const nominal = { ...context, coverageBasis: "single_exposure" as const };
      options = {
        resolvePositionAngle: (tile) => resolvePointingGeometries(tile, profile, registry, nominal)[0].position_angle_deg,
      };
    } else {
      const effective = { ...context, coverageBasis: "effective_sequence" as const };
      const exposuresByTile = new Map<TileRecord, ReturnType<typeof expandPointingExposures>>();
      for (const tile of proposedTiles.filter((item) => item.enabled !== false)) {
        const exposures = expandPointingExposures(tile, profile, registry, effective, survey.id);
        if (!exposures.length) throw new Error(`Pointing ${tile.id} has no registered exposure sequence to export.`);
        exposuresByTile.set(tile, exposures);
      }
      options = {
        resolveExposures: (tile) => exposuresByTile.get(tile)?.map((exposure) => ({
          id: exposure.id,
          order: exposure.order,
          ra_deg: exposure.center[0],
          dec_deg: exposure.center[1],
          ...(exposure.positionAngleDeg === undefined ? {} : { position_angle_deg: exposure.positionAngleDeg }),
        })),
      };
    }
  }
  const blob = new Blob([buildExportCsv(proposedTiles, survey, epoch, options)], { type: "text/csv; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exportMode === "expanded"
    ? "new_tiles_expanded_exposures.csv"
    : survey.schema_version === 3 && survey.observing_sequence
      ? "new_tiles_nominal_pointings.csv"
      : "new_tiles.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download accepted nominal centers for a standalone Schema v3 instrument.
 *
 * The instrument-only path uses generic ICRS coordinate fields and resolves PA
 * through the Gate 5 geometry resolver. It has no survey epoch/constants and
 * deliberately emits one nominal center per accepted pointing without adding
 * any strategy sequence.
 *
 * @param proposedTiles - Accepted proposal rows; disabled rows are omitted.
 * @param instrumentId - Stable ID of the selected standalone instrument mode.
 * @param registry - Session registry containing the selected validated profile.
 * @param geometryContext - Optional caller-owned PA choice, such as required
 *   per-pointing input. Sequence settings are ignored for standalone output.
 * @returns Resolves after triggering a local CSV download.
 * @throws If the instrument is unknown/v2, required PA is absent, or a row is
 *   invalid or belongs to another instrument. No session state is mutated.
 */
export async function downloadInstrumentCoordinates(
  proposedTiles: TileRecord[],
  instrumentId: string,
  registry: ProfileRegistry = profileRegistry,
  geometryContext?: PointingGeometryContext,
): Promise<void> {
  const instrument = registry.resolveAnyInstrumentProfile(instrumentId);
  if (instrument.schema_version !== 3) {
    throw new Error(`Instrument-only coordinate export requires a Schema v3 instrument profile: ${instrumentId}`);
  }
  const instrumentProfile = instrument as InstrumentProfileV3;
  const boundTiles = proposedTiles.map((tile) => tile.instrument_profile_id
    ? tile
    : { ...tile, instrument_profile_id: instrumentProfile.id });
  const context: PointingGeometryContext = {
    ...geometryContext,
    coverageBasis: "single_exposure",
    sequenceForTile: () => undefined,
    orientationPolicyForTile: (tile) => geometryContext?.orientationPolicyForTile?.(tile) ?? {
      policy: instrumentProfile.position_angle.mode,
      required: instrumentProfile.position_angle.required,
    },
  };
  const csv = buildInstrumentCoordinateCsv(boundTiles, instrumentProfile, {
    resolvePositionAngle: (tile) => resolvePointingGeometries(tile, null, registry, context)[0].position_angle_deg,
  });
  const blob = new Blob([csv], { type: "text/csv; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "manual_centers.csv";
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
 * @param projectSource - Canonical project placement and real instrument association; preview is optional.
 * @param signal - Optional cancellation of canonical worker execution.
 * @returns Auditable proposal and sampled metrics; canonical App choices run in a
 *   dedicated local Worker when available, with the same synchronous core.
 */
export async function planRegion(polygon: SkyPolygon, existingTiles: TileRecord[], profileId?: string, profile?: TilingProfile, strategy: CoverageStrategy = "complete", geometryContext?: PointingGeometryContext, projectSource?: ProjectLatticeCandidateSource, signal?: AbortSignal): Promise<RegionPlanResponse> {
  const geometryChoices = serializedPlanningChoices(geometryContext);
  if (geometryChoices) return await runPlanningOperation({
    kind: "plan", polygon, existingTiles, profileId, profile, strategy, projectSource,
    geometryChoices, instruments: profileRegistry.listAnyInstrumentProfiles(), surveys: profileRegistry.listAnySurveyProfiles(),
  }, signal) as RegionPlanResponse;
  return planRegionLocal(polygon, existingTiles, profileId, profile, strategy, profileRegistry, geometryContext, projectSource);
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
 * @param geometryContext - Scientific measurement basis and Gate 5 single/effective
 *   exposure geometry; v2 retains its separate legacy interpretation.
 * @param signal - Optional cancellation of canonical worker execution.
 * @returns Basis-labeled resolved measurements, or unavailable coverage without
 *   numeric fractions when the requested basis/resolution cannot be measured.
 * @throws On invalid region/profile, unknown instruments or invalid editable rows.
 */
export async function measureCoverage(polygon: SkyPolygon, existingTiles: TileRecord[], proposedTiles: TileRecord[], profileId?: string, profile?: TilingProfile, geometryContext?: PointingGeometryContext, signal?: AbortSignal): Promise<CoverageResult> {
  const geometryChoices = serializedPlanningChoices(geometryContext);
  if (geometryChoices) return await runPlanningOperation({
    kind: "coverage", polygon, existingTiles, proposedTiles, profileId, profile,
    geometryChoices, instruments: profileRegistry.listAnyInstrumentProfiles(), surveys: profileRegistry.listAnySurveyProfiles(),
  }, signal) as CoverageResult;
  return measureActiveCoverage(polygon, existingTiles, proposedTiles, profileId, profile, profileRegistry, geometryContext);
}

/** Read and atomically register a browser-selected Schema v2 or v3 profile file.
 * @param file - User-selected JSON file; its bytes are read only in the browser.
 * @param registry - Session registry, injectable for isolated tests.
 * @param occupiedInlineId - Optional ID held by an active legacy inline draft;
 *   ordinary file import must not create a conflicting active identity.
 * @returns Validated profile document registered as defensive copies.
 * @throws For non-JSON filenames, read failures, invalid data, or duplicate IDs.
 *   No registry entries are added unless the entire document passes.
 */
export async function uploadProfileFile(file: File, registry: ProfileRegistry = profileRegistry, occupiedInlineId?: string): Promise<AnyProfileDocument> {
  if (!file.name.toLowerCase().endsWith(".json")) throw new Error("Choose a .json profile file");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  const document = parseProfileJson(text);
  if ("survey" in document && document.survey && document.survey.id === occupiedInlineId) {
    throw new ProfileError("duplicate_id", `Survey profile ID "${document.survey.id}" is already used by the active custom draft`);
  }
  return registry.registerProfileDocument(document);
}

/** Download a registered survey and its compatible instrument using canonical serialization.
 * @param id - Exact registered survey ID.
 * @param registry - Session registry, injectable for isolated tests.
 * @returns Resolves after triggering the local JSON download; no storage is written.
 * @throws If the profile is unknown or serialization fails.
 */
export async function downloadProfileJson(id: string, registry: ProfileRegistry = profileRegistry): Promise<void> {
  return downloadProfileDocument(registry.resolveAnyProfileDocument(id));
}

/** Download a registered v3 instrument as a standalone canonical JSON document.
 * @param id - Exact registered v3 instrument ID.
 * @param registry - Session registry, injectable for isolated tests.
 * @returns Resolves after triggering the local JSON download.
 * @throws If the ID is unknown or the instrument is v2 and therefore requires a survey document.
 */
export async function downloadInstrumentProfileJson(id: string, registry: ProfileRegistry = profileRegistry): Promise<void> {
  return downloadProfileDocument(registry.resolveInstrumentProfileDocument(id));
}

/** Download a complete authored document without registering it.
 * @param profileDocument - Declarative v2 pair or v3 standalone/matching document.
 * @returns Resolves after canonical validation and browser JSON download.
 * @throws If strict document validation or download fails. No registry is mutated.
 */
export async function downloadProfileDocument(profileDocument: AnyProfileDocument): Promise<void> {
  const blob = new Blob([serializeProfile(profileDocument)], { type: "application/json; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const profileId = "survey" in profileDocument && profileDocument.survey
    ? profileDocument.survey.id
    : profileDocument.instrument.id;
  link.download = `${profileId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
