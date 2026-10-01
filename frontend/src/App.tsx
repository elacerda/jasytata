import { planningGeometryContext } from "./science/planning-operation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import jasytataLogo from "./assets/jasytata_logo.png";
import AladinMap, { type MapMode } from "./AladinMap";
import { RegionAuthoring } from "./RegionAuthoring";
import { ReferenceCoordinate } from "./ReferenceCoordinate";
import { ProjectLatticeAuthoring } from "./ProjectLatticeAuthoring";
import { validatePolygon } from "./science/geometry";
import { buildRegionPlanRequest, downloadCatalogue, downloadInstrumentCoordinates, downloadInstrumentProfileJson, downloadProfileDocument, uploadProfileFile, loadReferenceCatalogue, measureCoverage, parseCenters, planRegion, proposeCenters, uploadCatalogue } from "./api";
import { createDataset } from "./datasets";
import { DEFAULT_PROFILE, loadProfile, profileRegistry } from "./profiles";
import type { AnyProfileDocument, ProfileDocument } from "./profiles/document";
import { InstrumentProfileEditor } from "./profiles/InstrumentProfileEditor";
import type { PointingGeometryContext } from "./science/pointing-geometry";
import type { PointingExportMode } from "./science/export";
import { resolveFootprintForTile } from "./profiles/footprints";
import { CoverageUnavailableError } from "./science/coverage";
import { CoverageReadout as MetricsPanel, PointingAngle, PointingScience, ScientificDetails } from "./ScientificReadouts";
import { footprintSummary, formatDegrees } from "./profiles/presentation";
import { automaticRegionUnavailableMessage, derivePlanningCapabilities, emptyPlanningStateMessage, planningModeLabel, type ProjectPlanningMode } from "./profiles/planning-capabilities";
import type { AnyInstrumentProfile, AnySurveyProfile } from "./profiles/registry";
import { resolveProjectPlacement } from "./science/project-placement";
import { projectCoverageProfile } from "./profiles/planning";
import { previewProjectLattice, type ProjectLatticePreviewResult } from "./science/project-lattice-preview";
import {
  createProjectManifest,
  describeProjectCatalogueDependencies,
  installProjectProfileDependencies,
  matchProjectCatalogueDependencies,
  parseProjectManifest,
  serializeProjectManifest,
  type ProjectCatalogueDependency,
} from "./project-manifest";
import type {
  CenterInput,
  CatalogueDataset,
  CatalogueResponse,
  CoverageStrategy,
  InferenceDiagnostics,
  CoverageResult,
  LatticeProjectPlacement,
  PositionAngleOptions,
  ProjectPlacementPolicy,
  SkyPolygon,
  RegionPlanResponse,
  SurveyProfileV2,
  TileRecord,
} from "./types";

interface ProposalPreview {
  coverageStrategy: CoverageStrategy | null;
  tiles: TileRecord[];
  candidateCenters: CenterInput[];
  inference: InferenceDiagnostics | null;
  diagnostics: string[];
  metrics: CoverageResult | null;
  solution: string;
}

interface ActiveProjectLatticePreview extends ProjectLatticePreviewResult {
  dependencySignature: string;
}

interface ColumnMapping {
  file: File;
  columns: string[];
  raColumn: string;
  decColumn: string;
  raUnit: "auto" | "degrees" | "hours";
}

const EMPTY_CENTERS: CenterInput[] = [];
const EMPTY_IDS: string[] = [];
type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "jasytata-theme";

type OutputContext = { kind: "survey"; id: string } | { kind: "instrument"; id: string };

function outputContextValue(context: OutputContext): string {
  return `${context.kind}:${context.id}`;
}

function roleSummary(instrument: AnyInstrumentProfile): string {
  if (instrument.schema_version !== 3) return "Legacy v2 behavior · role not classified";
  const fidelity = instrument.footprint_semantics.fidelity === "exact" ? "Exact" : "Approximate";
  switch (instrument.footprint_semantics.role) {
    case "observed_area": return `${fidelity} observed-area geometry`;
    case "nominal_envelope": return `Nominal envelope · ${fidelity}`;
    case "target_access": return `${fidelity} target-access field · not observed coverage`;
  }
}

function instrumentChoiceLabel(instrument: AnyInstrumentProfile): string {
  const capabilities = derivePlanningCapabilities(instrument, null);
  return `${instrument.display_name} · Instrument · ${planningModeLabel(capabilities)}`;
}

function surveyChoiceLabel(survey: AnySurveyProfile): string {
  const instrument = profileRegistry.resolveInstrumentProfile(survey.instrument_id);
  const capabilities = derivePlanningCapabilities(instrument, survey);
  const description = capabilities.observingSequenceExposureCount !== null
    ? `${capabilities.observingSequenceExposureCount}-exposure sequence`
    : capabilities.supportsAutomaticRegionPlanning ? "automatic region tiling" : "manual pointings";
  return `${survey.display_name} · Strategy · ${description}`;
}

function tilingSummary(tiling: SurveyProfileV2["tiling"]): string {
  if (tiling.type === "legacy_splus") return "Legacy S-PLUS grid";
  if (tiling.type === "manual") return "Manual coverage";
  if (tiling.origin.type === "region_center") return "Lattice · region centered";
  return `Lattice · fixed anchor ${formatDegrees(tiling.origin.ra_deg)} RA, ${formatDegrees(tiling.origin.dec_deg)} DEC`;
}

/** Render the catalogue, output-profile selection, planning, proposal, and export workspace.
 * @param pointingGeometryContext - Optional runtime Gate 5 policy/sequence context,
 *   primarily for embedding and isolated integration tests. Browser-selected
 *   output profiles provide their own validated instrument and strategy policy.
 * @returns Interactive Jasytata workspace.
 */
export default function App({ pointingGeometryContext }: { pointingGeometryContext?: PointingGeometryContext } = {}) {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [datasets, setDatasets] = useState<CatalogueDataset[]>([]);
  const [instrumentProfiles, setInstrumentProfiles] = useState(() => profileRegistry.listAnyInstrumentProfiles());
  const [surveyProfiles, setSurveyProfiles] = useState(() => profileRegistry.listAnySurveyProfiles());
  const [importedProfileDocuments, setImportedProfileDocuments] = useState<Map<string, AnyProfileDocument>>(() => new Map());
  const [columnMapping, setColumnMapping] = useState<ColumnMapping | null>(null);
  const [outputContext, setOutputContext] = useState<OutputContext>({ kind: "survey", id: DEFAULT_PROFILE.id });
  const [coverageStrategy, setCoverageStrategy] = useState<CoverageStrategy>("complete");
  const [proposals, setProposals] = useState<TileRecord[]>([]);
  const [pending, setPending] = useState<ProposalPreview | null>(null);
  const [proposalContext, setProposalContext] = useState<ProposalPreview | null>(null);
  const [activeMetrics, setActiveMetrics] = useState<CoverageResult | null>(null);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [referenceMarker, setReferenceMarker] = useState<Pick<CenterInput, "ra_deg" | "dec_deg"> | null>(null);
  const [projectSession, setProjectSession] = useState(0);
  const [regionPolygon, setRegionPolygon] = useState<SkyPolygon | null>(null);
  const [projectPlanningMode, setProjectPlanningMode] = useState<ProjectPlanningMode>("manual_pointings");
  const [projectPlacementDirty, setProjectPlacementDirty] = useState(false);
  const [projectPlacement, setProjectPlacement] = useState<ProjectPlacementPolicy | null>(null);
  const [projectLatticePreview, setProjectLatticePreview] = useState<ActiveProjectLatticePreview | null>(null);
  const [projectCatalogueDependencies, setProjectCatalogueDependencies] = useState<ProjectCatalogueDependency[] | null>(null);
  const [matchedProjectCatalogueDatasetIds, setMatchedProjectCatalogueDatasetIds] = useState<string[]>([]);
  const [projectCatalogueDependenciesReady, setProjectCatalogueDependenciesReady] = useState(true);
  const [mapMode, setMapMode] = useState<MapMode>("idle");
  const [selectionRequest, setSelectionRequest] = useState(0);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [planningLayers, setPlanningLayers] = useState({
    proposals: true, region: true, anchors: false, lattice: false,
  });
  const [importText, setImportText] = useState("");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [parsedCenters, setParsedCenters] = useState<CenterInput[] | null>(null);
  const [exportEpoch, setExportEpoch] = useState<string | undefined>();
  const [manualPositionAngle, setManualPositionAngle] = useState("");
  const [applyBatchPa, setApplyBatchPa] = useState(false);
  const [sequenceBasis, setSequenceBasis] = useState<"single_exposure" | "effective_sequence" | null>(null);
  const [scientificRefusal, setScientificRefusal] = useState<CoverageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [planningActive, setPlanningActive] = useState(false);
  const planningAbortRef = useRef<AbortController | null>(null);
  const busyRunRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingNewProject, setConfirmingNewProject] = useState(false);
  const [debugRequestJson, setDebugRequestJson] = useState("");
  const profileFileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newProjectButtonRef = useRef<HTMLButtonElement>(null);
  const cancelNewProjectRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLElement>(null);
  const proposalBatchRef = useRef(0);
  const regionRevisionRef = useRef(0);

  const activeResolution = useMemo(() => {
    try {
      if (outputContext.kind === "instrument") {
        if (!instrumentProfiles.some((instrument) => instrument.id === outputContext.id)) {
          throw new Error(`Unknown instrument profile ID "${outputContext.id}".`);
        }
        const instrument = profileRegistry.resolveAnyInstrumentProfile(outputContext.id);
        if (instrument.schema_version !== 3) {
          throw new Error("Standalone output requires a registered Schema v3 instrument profile.");
        }
        return { survey: null, instrument, profile: null, error: null as string | null };
      }
      if (!surveyProfiles.some((survey) => survey.id === outputContext.id)) {
        throw new Error(`Unknown survey or strategy profile ID "${outputContext.id}".`);
      }
      const survey = profileRegistry.resolveAnySurveyProfile(outputContext.id);
      if (!instrumentProfiles.some((instrument) => instrument.id === survey.instrument_id)) {
        throw new Error(`Unknown instrument profile ID "${survey.instrument_id}".`);
      }
      const instrument = profileRegistry.resolveAnyInstrumentProfile(survey.instrument_id);
      const profile = loadProfile(outputContext.id);
      return { survey, instrument, profile, error: null as string | null };
    } catch (caught) {
      return {
        survey: null,
        instrument: null,
        profile: null,
        error: caught instanceof Error ? caught.message : "The selected output profile could not be resolved.",
      };
    }
  }, [outputContext, instrumentProfiles, surveyProfiles]);
  const activeSurvey = activeResolution.survey;
  const activeInstrument = activeResolution.instrument;
  const profile = activeResolution.profile;
  const paMode = activeInstrument?.schema_version === 3 ? activeInstrument.position_angle.mode : null;
  const profilePa = activeInstrument && "position_angle_deg" in activeInstrument.footprint ? activeInstrument.footprint.position_angle_deg : undefined;
  const observingSequence = activeSurvey?.schema_version === 3 ? activeSurvey.observing_sequence : undefined;
  const geometryBasis = observingSequence && activeSurvey?.schema_version === 3 ? sequenceBasis ?? activeSurvey.coverage_basis_default : "single_exposure";
  const outputStrategyId = activeSurvey?.id ?? null;
  const outputInstrumentId = activeInstrument?.id ?? null;
  const parsedManualPositionAngle = manualPositionAngle.trim() ? Number(manualPositionAngle) : undefined;
  const validManualPositionAngle = parsedManualPositionAngle !== undefined && Number.isFinite(parsedManualPositionAngle);
  const projectFootprintGeometry = useMemo(() => {
    if (!activeInstrument) return null;
    const positionAngleOptions: PositionAngleOptions | undefined = activeInstrument.schema_version === 3
      ? {
        policy: activeInstrument.position_angle.mode,
        required: activeInstrument.position_angle.required,
        ...(activeInstrument.position_angle.mode === "user_selected" && validManualPositionAngle
          ? { plan_position_angle_deg: parsedManualPositionAngle }
          : {}),
      }
      : undefined;
    const orientationTile: TileRecord = {
      id: "project-lattice-orientation",
      name: "Project lattice orientation",
      ra_deg: 0,
      dec_deg: 0,
      source: "proposed",
      generation_method: "manual",
      instrument_profile_id: activeInstrument.id,
      ...(activeInstrument.schema_version === 3 && activeInstrument.position_angle.mode === "per_pointing" && validManualPositionAngle
        ? { position_angle_deg: parsedManualPositionAngle }
        : {}),
      enabled: true,
      original_values: null,
      metadata: {},
    };
    try {
      return resolveFootprintForTile(orientationTile, null, profileRegistry, positionAngleOptions);
    } catch {
      return null;
    }
  }, [activeInstrument, parsedManualPositionAngle, validManualPositionAngle]);
  const effectiveInstrumentPA = projectFootprintGeometry?.resolved_position_angle_deg;
  const projectPreviewDependencySignature = JSON.stringify({
    instrumentId: outputInstrumentId,
    footprint: projectFootprintGeometry?.footprint ?? null,
    effectiveInstrumentPA: effectiveInstrumentPA ?? null,
    region: regionPolygon,
  });
  const currentProjectLatticePreview = projectLatticePreview?.dependencySignature === projectPreviewDependencySignature
    ? projectLatticePreview
    : null;
  const resolvedProjectPlacement = useMemo(() => {
    if (!regionPolygon || !projectPlacement || projectPlacementDirty || !projectFootprintGeometry) return null;
    try { return resolveProjectPlacement(projectPlacement, regionPolygon, effectiveInstrumentPA); }
    catch { return null; }
  }, [regionPolygon, projectPlacement, projectPlacementDirty, projectFootprintGeometry, effectiveInstrumentPA]);
  const usesProjectRegionSource = projectPlanningMode === "regional_mosaic" &&
    activeInstrument?.schema_version === 3 && (activeInstrument.footprint_semantics.role === "observed_area" || activeInstrument.footprint_semantics.role === "nominal_envelope");
  const matchedCatalogueIds = useMemo(() => new Set(matchedProjectCatalogueDatasetIds), [matchedProjectCatalogueDatasetIds]);
  const projectInputDatasets = useMemo(() => projectCatalogueDependencies?.length
    ? datasets.filter((dataset) => matchedCatalogueIds.has(dataset.id))
    : datasets, [datasets, projectCatalogueDependencies, matchedCatalogueIds]);
  const unresolvedDataset = useMemo(() => projectInputDatasets.find((dataset) => {
    if (!dataset.instrument_profile_id) return true;
    if (!instrumentProfiles.some((instrument) => instrument.id === dataset.instrument_profile_id)) return true;
    try {
      profileRegistry.resolveInstrumentProfile(dataset.instrument_profile_id);
      return false;
    } catch {
      return true;
    }
  }) ?? null, [projectInputDatasets, instrumentProfiles]);
  const missingProjectCatalogueCount = Math.max(0,
    (projectCatalogueDependencies?.length ?? 0) - matchedProjectCatalogueDatasetIds.length);
  const projectCatalogueProblem = projectCatalogueDependencies?.length &&
      (!projectCatalogueDependenciesReady || missingProjectCatalogueCount > 0)
    ? `Incomplete project: supply ${missingProjectCatalogueCount || projectCatalogueDependencies.length} matching catalogue file${(missingProjectCatalogueCount || projectCatalogueDependencies.length) === 1 ? "" : "s"} from the manifest before planning.`
    : null;
  const planningCapabilities = derivePlanningCapabilities(activeInstrument, activeSurvey, {
    mode: projectPlanningMode,
    hasSelectedRegion: Boolean(regionPolygon),
    hasValidProjectPlacement: resolvedProjectPlacement?.type === "resolved_lattice_project_placement",
    hasRequiredPlannerInputs: !activeResolution.error && !unresolvedDataset && !projectCatalogueProblem,
    hasResolvedInstrumentPA: Boolean(projectFootprintGeometry) &&
      (!(activeInstrument?.schema_version === 3 && activeInstrument.position_angle.required) || effectiveInstrumentPA !== undefined),
  });
  const requiredPositionAngle = planningCapabilities.requiresUserPositionAngle;
  const planningUnavailableReason = activeResolution.error
    ?? projectCatalogueProblem
    ?? (unresolvedDataset
      ? unresolvedDataset.instrument_profile_id
        ? `Catalogue “${unresolvedDataset.filename}” references an unavailable instrument. Choose a registered instrument profile before planning.`
        : `Choose an instrument profile for “${unresolvedDataset.filename}” before planning.`
      : null)
    ?? (usesProjectRegionSource
      ? !planningCapabilities.canGenerateProjectRegionPlan ? planningCapabilities.projectLatticeUnavailableReason ?? "Apply a valid project placement before generating a plan." : null
      : !planningCapabilities.supportsAutomaticRegionPlanning ? automaticRegionUnavailableMessage(planningCapabilities)
      : null);

  const hasCatalogue = datasets.length > 0;
  const defaultManualPositionAngle = paMode === "user_selected" && profilePa !== undefined ? String(profilePa) : "";
  const hasProjectContent = Boolean(
    datasets.length || columnMapping || proposals.length || pending || proposalContext || regionPolygon || referenceMarker ||
    importText.trim() || parsedCenters || activeMetrics || scientificRefusal || selectedTileId ||
    mapMode !== "idle" || selectingRegion || manualPositionAngle !== defaultManualPositionAngle || exportEpoch !== undefined ||
    sequenceBasis !== null || coverageStrategy !== "complete" || debugRequestJson || projectPlanningMode !== "manual_pointings" ||
    projectPlacement !== null || projectLatticePreview !== null || projectCatalogueDependencies !== null,
  );
  const outputGeometryContext = useMemo<PointingGeometryContext>(() => planningGeometryContext({
    coverageBasis: geometryBasis,
    ...(activeInstrument?.schema_version === 3 ? { measurementBasis: activeInstrument.footprint_semantics.role } : {}),
    outputInstrumentId: activeInstrument?.id,
    outputStrategyId: outputContext.kind === "survey" ? outputContext.id : undefined,
    planPositionAngleDeg: validManualPositionAngle ? parsedManualPositionAngle ?? undefined : undefined,
  }, profileRegistry), [activeInstrument, geometryBasis, outputContext, parsedManualPositionAngle, validManualPositionAngle]);
  const activePointingGeometryContext = pointingGeometryContext ?? outputGeometryContext;
  const originalTiles = useMemo(() => datasets.flatMap((dataset) => dataset.tiles.map((tile) => ({
    ...tile,
    instrument_profile_id: dataset.instrument_profile_id,
    inference_role: dataset.inference_role,
  }))), [datasets]);
  const planningOriginalTiles = useMemo(() => projectInputDatasets.flatMap((dataset) => dataset.tiles.map((tile) => ({
    ...tile,
    instrument_profile_id: dataset.instrument_profile_id,
    inference_role: dataset.inference_role,
  }))), [projectInputDatasets]);
  const visibleOriginalTiles = useMemo(() => datasets.filter((dataset) => dataset.visible).flatMap((dataset) => dataset.tiles.map((tile) => ({
    ...tile,
    instrument_profile_id: dataset.instrument_profile_id,
    inference_role: dataset.inference_role,
  }))), [datasets]);
  const activeOutputProposals = useMemo(() => proposals.filter((tile) =>
    tile.instrument_profile_id === outputInstrumentId && (tile.output_strategy_id ?? null) === outputStrategyId,
  ), [proposals, outputInstrumentId, outputStrategyId]);
  const enabledProposals = useMemo(() => activeOutputProposals.filter((tile) => tile.enabled !== false), [activeOutputProposals]);
  const activeExpandedExposureCount = useMemo(() => enabledProposals.reduce((count, tile) =>
    count + (activePointingGeometryContext.sequenceForTile?.(tile)?.exposures.length ?? 0), 0), [enabledProposals, activePointingGeometryContext]);
  const pendingExpandedExposureCount = useMemo(() => pending?.tiles.reduce((count, tile) =>
    count + (activePointingGeometryContext.sequenceForTile?.(tile)?.exposures.length ?? 0), 0) ?? 0, [pending, activePointingGeometryContext]);
  const visibleTiles = useMemo(() => [
    ...visibleOriginalTiles,
    ...(planningLayers.proposals ? activeOutputProposals : []),
  ], [visibleOriginalTiles, planningLayers.proposals, activeOutputProposals]);
  const planningTiles = useMemo(() => [
    ...planningOriginalTiles,
    ...activeOutputProposals.filter((tile) => tile.enabled !== false),
  ], [planningOriginalTiles, activeOutputProposals]);
  const mapTiles = useMemo(
    () => (pending && planningLayers.proposals ? [...visibleTiles, ...pending.tiles] : visibleTiles),
    [pending, planningLayers.proposals, visibleTiles],
  );
  const activeContext = pending ?? proposalContext;
  const selectedTile = useMemo(
    () => mapTiles.find((tile) => tile.id === selectedTileId) ?? null,
    [mapTiles, selectedTileId],
  );
  const exportProblem = useMemo(() => {
    if (!activeInstrument) return null;
    try {
      for (const tile of enabledProposals) {
        const angle = resolveFootprintForTile(tile, profile, profileRegistry, activePointingGeometryContext.orientationPolicyForTile?.(tile)).resolved_position_angle_deg;
        if (activeSurvey?.export.position_angle_column && angle === undefined) {
          throw new Error(`Pointing has no declared camera position angle required by '${activeSurvey.export.position_angle_column}'`);
        }
      }
      return null;
    } catch (caught) {
      return `Export blocked: ${caught instanceof Error ? caught.message : "Pointing PA is unresolved."}`;
    }
  }, [activeInstrument, activeSurvey, enabledProposals, profile, activePointingGeometryContext]);
  const anchors = useMemo(() => {
    const context = pending ?? proposalContext;
    if (!context) return [];
    const ids = new Set(context.inference?.anchor_tile_ids ?? []);
    return planningTiles.filter((tile) => ids.has(tile.id));
  }, [pending, proposalContext, planningTiles]);
  const mapProjectCandidateCenters = useMemo(
    () => currentProjectLatticePreview?.candidates.map(({ ra_deg, dec_deg }) => ({ ra_deg, dec_deg })) ?? EMPTY_CENTERS,
    [currentProjectLatticePreview],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme selection still works for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    let current = true;
    if (!projectCatalogueDependencies?.length) {
      setMatchedProjectCatalogueDatasetIds((previous) => previous.length ? [] : previous);
      setProjectCatalogueDependenciesReady(true);
      return () => { current = false; };
    }
    void matchProjectCatalogueDependencies(projectCatalogueDependencies, datasets)
      .then((match) => {
        if (!current) return;
        setMatchedProjectCatalogueDatasetIds(match.matchedDatasetIds);
        setProjectCatalogueDependenciesReady(match.complete);
      })
      .catch(() => {
        if (!current) return;
        setMatchedProjectCatalogueDatasetIds([]);
        setProjectCatalogueDependenciesReady(false);
      });
    return () => { current = false; };
  }, [projectCatalogueDependencies, datasets]);

  useEffect(() => {
    if (projectLatticePreview && projectLatticePreview.dependencySignature !== projectPreviewDependencySignature) {
      setProjectLatticePreview(null);
    }
  }, [projectPreviewDependencySignature, projectLatticePreview]);

  const projectPlanDependencySignature = JSON.stringify({
    geometry: projectPreviewDependencySignature, placement: projectPlacement, dirty: projectPlacementDirty,
    mode: projectPlanningMode, strategy: coverageStrategy, outputStrategyId,
  });
  const projectPlanDependencyRef = useRef(projectPlanDependencySignature);
  useEffect(() => {
    if (projectPlanDependencyRef.current === projectPlanDependencySignature) return;
    projectPlanDependencyRef.current = projectPlanDependencySignature;
    regionRevisionRef.current += 1;
    setPending((current) => current?.solution === "project_lattice" ? null : current);
    setProposalContext((current) => current?.solution === "project_lattice" ? null : current);
    if (usesProjectRegionSource || pending?.solution === "project_lattice" || proposalContext?.solution === "project_lattice") {
      setActiveMetrics(null); setScientificRefusal(null); setDebugRequestJson("");
    }
  }, [projectPlanDependencySignature, usesProjectRegionSource, pending?.solution, proposalContext?.solution]);

  useEffect(() => () => { planningAbortRef.current?.abort(); }, [regionPolygon, planningTiles, activePointingGeometryContext,
    coverageStrategy, outputContext, projectPlacement, projectPlacementDirty, projectPlanningMode]);

  const projectCoverageDependency = usesProjectRegionSource ? projectPlanDependencySignature : null;
  useEffect(() => {
    if ((usesProjectRegionSource && !resolvedProjectPlacement) || !regionPolygon || (!activeSurvey && !usesProjectRegionSource) || (!profile && !usesProjectRegionSource) || !activeOutputProposals.length || unresolvedDataset || activeResolution.error) {
      setActiveMetrics(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setActiveMetrics(null);
    void measureCoverage(regionPolygon, planningOriginalTiles, activeOutputProposals, activeSurvey?.id,
      usesProjectRegionSource && activeInstrument?.schema_version === 3 ? projectCoverageProfile(activeInstrument) : undefined,
      activePointingGeometryContext, controller.signal)
      .then((metrics) => { if (!cancelled) setActiveMetrics(metrics); })
      .catch((caught: unknown) => {
        if (!cancelled) {
          if (caught instanceof CoverageUnavailableError) setScientificRefusal(caught.result);
          else setError(caught instanceof Error ? caught.message : "Could not update coverage.");
        }
      });
    return () => { cancelled = true; controller.abort(); };
  }, [regionPolygon, activeSurvey, profile, activeOutputProposals, planningOriginalTiles, unresolvedDataset, activeResolution.error, projectCatalogueProblem, activePointingGeometryContext, usesProjectRegionSource, activeInstrument, projectCoverageDependency, resolvedProjectPlacement]);

  useEffect(() => {
    if (confirmingNewProject) cancelNewProjectRef.current?.focus();
  }, [confirmingNewProject]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirmingNewProject) {
          setConfirmingNewProject(false);
          newProjectButtonRef.current?.focus();
          return;
        }
        setMapMode("idle");
        setSelectingRegion(false);
        setNotice(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmingNewProject]);

  async function runBusy<T>(work: () => Promise<T>, success?: (result: T) => void, isCurrent = () => true) {
    const run = ++busyRunRef.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    setScientificRefusal(null);
    try {
      const result = await work();
      if (isCurrent()) success?.(result);
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught instanceof CoverageUnavailableError) setScientificRefusal(caught.result);
      else setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally {
      if (run === busyRunRef.current) setBusy(false);
    }
  }

  function applyCatalogue(result: CatalogueResponse) {
    if (result.needs_mapping) return;
    setColumnMapping(null);
    setDatasets((previous) => [...previous, createDataset(result, previous.length, crypto.randomUUID())]);
    setFocusRequest((previous) => previous + 1);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setScientificRefusal(null);
    setSelectedTileId(null);
    setNotice(`${result.row_count.toLocaleString()} catalogue rows added from ${result.filename}.`);
    setError(null);
  }

  function updateDatasetSettings(datasetId: string, patch: Partial<Pick<CatalogueDataset, "instrument_profile_id" | "inference_role">>) {
    const current = datasets.find((dataset) => dataset.id === datasetId);
    if (!current || Object.entries(patch).every(([key, value]) => current[key as "instrument_profile_id" | "inference_role"] === value)) return;
    regionRevisionRef.current += 1;
    if (projectCatalogueDependencies?.length) setProjectCatalogueDependenciesReady(false);
    setDatasets((previous) => previous.map((dataset) => dataset.id === datasetId ? { ...dataset, ...patch } : dataset));
    setProposals([]);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setScientificRefusal(null);
    setSelectedTileId(null);
    setDebugRequestJson("");
    setNotice("Catalogue planning settings updated. Generate a new plan for the selected polygon.");
  }

  async function handleUpload(file?: File) {
    if (!file) return;
    await runBusy(() => uploadCatalogue(file), (result) => {
      if (result.needs_mapping) {
        setColumnMapping({ file, columns: result.columns ?? [], raColumn: "", decColumn: "", raUnit: "auto" });
        setNotice("Choose the RA and DEC columns for this catalogue.");
      } else applyCatalogue(result);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function registerAuthoredProfile(document: ProfileDocument) {
    const registered = profileRegistry.registerProfileDocument(document);
    setImportedProfileDocuments((previous) => {
      const next = new Map(previous);
      next.set(`survey:${registered.survey.id}`, document);
      next.set(`instrument:${registered.instrument.id}`, document);
      return next;
    });
    setInstrumentProfiles(profileRegistry.listAnyInstrumentProfiles());
    setSurveyProfiles(profileRegistry.listAnySurveyProfiles());
    setProfileEditorOpen(false);
    setError(null);
    setNotice(`Added survey profile: ${registered.survey.display_name}. Select it in Output profile to use its strategy.`);
  }

  async function handleProfileUpload(file?: File) {
    if (!file) return;
    await runBusy(() => uploadProfileFile(file, profileRegistry), (document) => {
      setImportedProfileDocuments((previous) => {
        const next = new Map(previous);
        if ("instrument" in document && document.instrument) next.set(`instrument:${document.instrument.id}`, document);
        if ("survey" in document && document.survey) next.set(`survey:${document.survey.id}`, document);
        return next;
      });
      setInstrumentProfiles(profileRegistry.listAnyInstrumentProfiles());
      setSurveyProfiles(profileRegistry.listAnySurveyProfiles());
      if ("survey" in document && document.survey) {
        setNotice("instrument" in document && document.instrument && document.instrument.schema_version === 3
          ? `Imported matching pair: ${document.instrument.display_name} + ${document.survey.display_name}. ${roleSummary(document.instrument)}. Select it in Output profile to use it.`
          : document.survey.schema_version === 3
          ? `Imported strategy: ${document.survey.display_name}. Select it as the output profile when you want to use that observing strategy.`
          : `Imported survey profile: ${document.survey.display_name}. Select it in Output profile to use its strategy.`);
      } else if ("instrument" in document && document.instrument) {
        setNotice(`Imported instrument profile: ${document.instrument.display_name}. ${roleSummary(document.instrument)}. Select its standalone mode or assign it to a source catalogue.`);
      }
    });
    if (profileFileInputRef.current) profileFileInputRef.current.value = "";
  }

  async function applyColumnMapping() {
    if (!columnMapping || !columnMapping.raColumn || !columnMapping.decColumn) return;
    await runBusy(
      () => uploadCatalogue(columnMapping.file, columnMapping),
      applyCatalogue,
    );
  }

  async function stageCenters(centers: CenterInput[], method: "manual" | "imported_centers"): Promise<boolean> {
    if (!activeInstrument) {
      setError(activeResolution.error ?? "Select a registered instrument or observing strategy before adding centers.");
      return false;
    }
    if (manualPositionAngle.trim() && !validManualPositionAngle) {
      setError("Pointing PA must be a finite angle in degrees east of north.");
      return false;
    }
    if (requiredPositionAngle && !validManualPositionAngle && profilePa === undefined && centers.some((center) => center.position_angle_deg === undefined)) {
      setError(`Enter a finite position angle in degrees east of north for ${activeInstrument.display_name} before staging centers.`);
      return false;
    }
    if (method === "imported_centers" && paMode === "per_pointing" && validManualPositionAngle && !applyBatchPa && centers.some((center) => center.position_angle_deg === undefined)) {
      setError("Choose ‘Apply pointing PA to this pasted batch’ to use a common PA, or add the pointings individually with their own PA.");
      return false;
    }
    const revision = regionRevisionRef.current;
    const inputCenters = centers.map((center) => activeInstrument.schema_version === 3 &&
      activeInstrument.position_angle.mode === "per_pointing" && validManualPositionAngle
      ? { ...center, position_angle_deg: center.position_angle_deg ?? parsedManualPositionAngle }
      : center);
    let staged = false;
    await runBusy(
      () => proposeCenters(inputCenters, method),
      (tiles) => {
        if (revision !== regionRevisionRef.current) return;
        const contextTiles = tiles.map((tile) => ({
          ...tile,
          instrument_profile_id: activeInstrument.id,
          ...(activeSurvey ? { output_strategy_id: activeSurvey.id } : {}),
          ...(paMode === "user_selected" && (parsedManualPositionAngle ?? profilePa) !== undefined
            ? { output_position_angle_deg: parsedManualPositionAngle ?? profilePa } : {}),
        }));
        // Validate before rendering; the canonical Gate 5 resolver enforces required PA.
        for (const tile of contextTiles) resolveFootprintForTile(tile, profile, profileRegistry, activePointingGeometryContext.orientationPolicyForTile?.(tile));
        staged = true;
        setPending({
          coverageStrategy: null,
          tiles: contextTiles,
          candidateCenters: inputCenters,
          inference: null,
          diagnostics: [method === "manual" ? "Manual sky positions are ready for review." : "Imported centers are ready for review."],
          metrics: null,
          solution: method,
        });
        setMapMode("idle");
        setSelectedTileId(null);
        setNotice(`${tiles.length} center${tiles.length === 1 ? "" : "s"} staged for ${activeInstrument.display_name} review.`);
      },
    );
    return staged;
  }

  async function handleParseCenters() {
    setApplyBatchPa(false);
    await runBusy(() => parseCenters(importText), (result) => {
      setParsedCenters(result);
      setNotice(`${result.length} valid center${result.length === 1 ? "" : "s"} parsed. Review the list, then stage it.`);
    });
  }

  async function handleStageImported() {
    if (!parsedCenters) return;
    if (await stageCenters(parsedCenters, "imported_centers")) setParsedCenters(null);
  }

  function changeSequenceBasis(basis: "single_exposure" | "effective_sequence") {
    regionRevisionRef.current += 1;
    setSequenceBasis(basis);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setScientificRefusal(null);
    setNotice(`Coverage geometry: ${basis === "effective_sequence" ? "full sequence footprint" : "single exposure"}. Plan preview cleared; nominal pointings retained.`);
  }

  async function handleMeasureGeometry() {
    if (!regionPolygon || !activeSurvey) return;
    const revision = regionRevisionRef.current;
    setActiveMetrics(null);
    await runBusy(() => measureCoverage(regionPolygon, planningOriginalTiles, activeOutputProposals, activeSurvey.id, undefined, activePointingGeometryContext), (result) => {
      setActiveMetrics(result);
    }, () => revision === regionRevisionRef.current);
  }

  async function handlePlanRegion() {
    if (!regionPolygon || !activeInstrument || (!usesProjectRegionSource && (!activeSurvey || !profile))) return;
    if (planningUnavailableReason) {
      setError(planningUnavailableReason);
      return;
    }
    const regionRevision = regionRevisionRef.current;
    planningAbortRef.current?.abort();
    const controller = new AbortController();
    planningAbortRef.current = controller;
    setPlanningActive(true);
    setPending(null);
    setSelectingRegion(false);
    if (import.meta.env.DEV && activeSurvey && !usesProjectRegionSource) {
      setDebugRequestJson(JSON.stringify(buildRegionPlanRequest(regionPolygon, planningTiles, activeSurvey.id, undefined, coverageStrategy)));
    }
    await runBusy(
      () => usesProjectRegionSource && projectPlacement?.type === "lattice_project_placement"
        ? planRegion(regionPolygon, planningTiles, activeSurvey?.id, undefined, coverageStrategy, activePointingGeometryContext, {
          type: "project_lattice", instrumentId: activeInstrument.id, placement: projectPlacement,
          positionAngleDeg: effectiveInstrumentPA, ...(activeSurvey ? { strategyId: activeSurvey.id } : {}),
        }, controller.signal)
        : planRegion(regionPolygon, planningTiles, activeSurvey!.id, undefined, coverageStrategy, activePointingGeometryContext, undefined, controller.signal),
      (result: RegionPlanResponse) => {
        if (regionRevision !== regionRevisionRef.current) return;
        setPending({
          coverageStrategy: result.coverage_strategy,
          tiles: result.tiles.map((tile) => ({ ...tile, instrument_profile_id: activeInstrument.id, output_strategy_id: activeSurvey?.id ?? null,
            ...(!usesProjectRegionSource && paMode === "user_selected" && (parsedManualPositionAngle ?? profilePa) !== undefined
              ? { output_position_angle_deg: parsedManualPositionAngle ?? profilePa } : {}) })),
          candidateCenters: result.candidate_centers,
          inference: result.inference,
          diagnostics: result.diagnostics,
          metrics: result.metrics,
          solution: result.solution,
        });
        setSelectedTileId(null);
        setNotice(
          `${result.tiles.length} nominal pointing${result.tiles.length === 1 ? "" : "s"} selected. ${result.metrics.coverage_basis === "nominal_envelope" ? "Approximate nominal-envelope coverage" : result.metrics.coverage_basis === "legacy_v2" ? "Legacy survey coverage" : "Observed-area geometry coverage"}: ${Math.round(result.metrics.selected_region_coverage * 100)}%.`,
        );
      },
      () => regionRevision === regionRevisionRef.current && planningAbortRef.current === controller && !controller.signal.aborted,
    );
    if (planningAbortRef.current === controller) { planningAbortRef.current = null; setPlanningActive(false); }
  }

  /** Terminate the current operation without publishing a partial plan or editing inputs. */
  function cancelPlanningRun() {
    planningAbortRef.current?.abort();
    planningAbortRef.current = null;
    busyRunRef.current += 1;
    setPlanningActive(false);
    setBusy(false);
    setNotice("Planning cancelled; region and project placement retained.");
  }

  function changeCoverageStrategy(strategy: CoverageStrategy) {
    if (strategy === coverageStrategy) return;
    regionRevisionRef.current += 1;
    setCoverageStrategy(strategy);
    setPending((current) => current?.coverageStrategy ? null : current);
    if (usesProjectRegionSource) { setProposalContext(null); setActiveMetrics(null); setScientificRefusal(null); }
    setDebugRequestJson("");
  }

  function acceptPreview() {
    if (!pending || !activeInstrument) return;
    const declaredPa = activeInstrument.footprint.type === "circle" ? undefined : activeInstrument.footprint.position_angle_deg;
    const batch = ++proposalBatchRef.current;
    const proposalsToAdd = pending.tiles.map((tile) => ({
      ...tile,
      id: `proposal-${batch}-${tile.id}`,
      // Camera orientation is declared independently of the lattice basis/inferred rotation.
      ...(pointingGeometryContext || activeInstrument.schema_version === 3 || tile.position_angle_deg !== undefined
        ? {}
        : declaredPa !== undefined ? { position_angle_deg: declaredPa } : {}),
      instrument_profile_id: activeInstrument.id,
      ...(activeSurvey ? { output_strategy_id: activeSurvey.id } : {}),
      source: "proposed" as const,
      enabled: true,
    }));
    setProposals((previous) => [...previous, ...proposalsToAdd]);
    setProposalContext(pending);
    setPending(null);
    setSelectedTileId(null);
    setNotice(`${proposalsToAdd.length} proposed tile${proposalsToAdd.length === 1 ? "" : "s"} accepted.`);
  }

  function cancelPreview() {
    setPending(null);
    setNotice("Proposal preview cancelled.");
  }

  function toggleProposal(id: string) {
    setProposals((previous) => previous.map((tile) => tile.id === id
      ? { ...tile, enabled: tile.enabled === false }
      : tile));
  }

  function clearProposals() {
    const activeIds = new Set(activeOutputProposals.map((tile) => tile.id));
    setProposals((previous) => previous.filter((tile) => !activeIds.has(tile.id)));
    setPending(null);
    setProposalContext(null);
    setSelectedTileId(null);
    setActiveMetrics(null);
    setNotice("Accepted pointings for the selected output profile were cleared. Other output profiles and catalogues remain.");
  }

  function activateOutputContext(nextContext: OutputContext) {
    if (outputContextValue(nextContext) === outputContextValue(outputContext)) return;
    let displayName: string;
    try {
      if (nextContext.kind === "survey") {
        const survey = profileRegistry.resolveAnySurveyProfile(nextContext.id);
        const instrument = profileRegistry.resolveAnyInstrumentProfile(survey.instrument_id);
        loadProfile(nextContext.id);
        displayName = `${survey.display_name} · ${instrument.display_name}`;
      } else {
        const instrument = profileRegistry.resolveAnyInstrumentProfile(nextContext.id);
        if (instrument.schema_version !== 3) throw new Error("Only validated Schema v3 instrument profiles can be selected as standalone output.");
        displayName = `${instrument.display_name} · standalone instrument`;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The selected output profile could not be resolved.");
      return;
    }
    regionRevisionRef.current += 1;
    setOutputContext(nextContext);
    setExportEpoch(undefined);
    const nextInstrument = nextContext.kind === "instrument" ? profileRegistry.resolveAnyInstrumentProfile(nextContext.id)
      : profileRegistry.resolveAnyInstrumentProfile(profileRegistry.resolveAnySurveyProfile(nextContext.id).instrument_id);
    if (nextInstrument.id !== outputInstrumentId) {
      setProjectLatticePreview(null);
      setManualPositionAngle("");
      if (nextInstrument.schema_version === 3 && nextInstrument.position_angle.mode === "user_selected" &&
          "position_angle_deg" in nextInstrument.footprint && nextInstrument.footprint.position_angle_deg !== undefined) {
        setManualPositionAngle(String(nextInstrument.footprint.position_angle_deg));
      }
    }
    setApplyBatchPa(false);
    setParsedCenters(null);
    setImportText("");
    setSequenceBasis(null);
    setScientificRefusal(null);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setScientificRefusal(null);
    setSelectedTileId(null);
    setDebugRequestJson("");
    setMapMode("idle");
    setSelectingRegion(false);
    setNotice(`Selected output: ${displayName}. Pending previews were cleared; accepted pointings remain attached to their original output profile.`);
    setError(null);
  }

  /** Clear project data and drafts in place; retain output context, registry and display preferences. */
  function startNewProject() {
    if (busy && !planningActive) return;
    const contextName = activeSurvey?.display_name ?? activeInstrument?.display_name ?? "the selected output";
    planningAbortRef.current?.abort();
    planningAbortRef.current = null;
    if (planningActive) {
      busyRunRef.current += 1;
      setBusy(false);
      setPlanningActive(false);
    }
    regionRevisionRef.current += 1;
    proposalBatchRef.current = 0;
    setDatasets([]);
    setColumnMapping(null);
    setProposals([]);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setScientificRefusal(null);
    setSelectedTileId(null);
    setRegionPolygon(null);
    setProjectPlanningMode("manual_pointings");
    setProjectPlacement(null); setProjectPlacementDirty(false);
    setProjectLatticePreview(null);
    setProjectCatalogueDependencies(null);
    setMatchedProjectCatalogueDatasetIds([]);
    setProjectCatalogueDependenciesReady(true);
    setMapMode("idle");
    setSelectingRegion(false);
    setImportText("");
    setParsedCenters(null);
    setApplyBatchPa(false);
    setCoverageStrategy("complete");
    setSequenceBasis(null);
    setExportEpoch(undefined);
    setManualPositionAngle(defaultManualPositionAngle);
    setDebugRequestJson("");
    setConfirmingNewProject(false);
    setError(null);
    setReferenceMarker(null);
    setProjectSession((previous) => previous + 1);
    setNotice(`New empty project started with ${contextName}.`);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (profileFileInputRef.current) profileFileInputRef.current.value = "";
    newProjectButtonRef.current?.focus();
  }

  function requestNewProject() {
    if (busy && !planningActive) return;
    if (hasProjectContent) {
      setConfirmingNewProject(true);
      return;
    }
    startNewProject();
  }

  /** Apply canonical region input and invalidate its derived previews/diagnostics.
   * @param region - Validated ICRS polygon, or null when clearing/redrawing.
   * @throws Before mutation if a non-null polygon violates the frozen contract.
   * Accepted pointings remain explicit user data; their coverage is recomputed.
   */
  function applySelectedRegion(region: SkyPolygon | null) {
    if (region) validatePolygon(region);
    regionRevisionRef.current += 1;
    setRegionPolygon(region);
    setProjectLatticePreview(null);
    setSelectingRegion(false);
    setMapMode("idle");
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setScientificRefusal(null);
    setDebugRequestJson("");
    setSelectedTileId((current) => pending?.tiles.some((tile) => tile.id === current) ? null : current);
    setError(null);
    setNotice(region ? (planningCapabilities.supportsAutomaticRegionPlanning
      ? "Sky polygon finalized. Generate a plan when ready."
      : planningCapabilities.canAuthorProjectPlacement
        ? "Sky region set. Apply project placement, then preview lattice sites or generate a plan."
        : "Sky area selected. Measure declared geometry when ready; no regional pointings will be generated.")
      : "Selected polygon cleared; catalogues and proposals remain.");
  }

  function changeProjectPlanningMode(mode: ProjectPlanningMode) {
    if (mode === projectPlanningMode) return;
    setProjectPlanningMode(mode);
    invalidateProjectPlan();
    setProjectLatticePreview(null);
  }

  function invalidateProjectPlan() {
    regionRevisionRef.current += 1;
    setPending((current) => current?.solution === "project_lattice" ? null : current);
    setProposalContext((current) => current?.solution === "project_lattice" ? null : current);
    setActiveMetrics(null); setScientificRefusal(null); setDebugRequestJson("");
  }

  /** Validate and save canonical placement without requiring a candidate preview. */
  function applyProjectPlacement(policy: LatticeProjectPlacement) {
    if (!regionPolygon || !projectFootprintGeometry) throw new Error("Select a region and resolve instrument PA before applying placement.");
    resolveProjectPlacement(policy, regionPolygon, effectiveInstrumentPA);
    invalidateProjectPlan();
    setProjectPlacement(policy); setProjectPlacementDirty(false); setProjectLatticePreview(null);
    setNotice("User-declared project placement applied. Generate plan selects a coverage subset; Preview lattice shows all admissible sites.");
  }

  function applyProjectLatticePreview(policy: LatticeProjectPlacement) {
    if (!regionPolygon) throw new Error("Select a region before previewing project lattice sites.");
    if (!activeInstrument || !projectFootprintGeometry) {
      throw new Error("The active instrument footprint and PA must resolve before project lattice preview.");
    }
    if (!planningCapabilities.canPreviewProjectLattice) {
      throw new Error(planningCapabilities.projectLatticeUnavailableReason ?? "Project lattice preview is unavailable for this output context.");
    }
    const result = previewProjectLattice(
      regionPolygon,
      policy,
      projectFootprintGeometry.footprint,
      effectiveInstrumentPA,
    );
    invalidateProjectPlan();
    setProjectPlacement(policy); setProjectPlacementDirty(false);
    setProjectLatticePreview({ ...result, dependencySignature: projectPreviewDependencySignature });
    setError(null);
    setNotice(`${result.candidates.length} project lattice candidate sites previewed. No plan pointings were created.`);
  }

  function beginRegionSelection() {
    if (!(planningCapabilities.supportsAutomaticRegionPlanning || planningCapabilities.canMeasureSelectedGeometry || planningCapabilities.canAuthorProjectPlacement)) return;
    applySelectedRegion(null);
    setSelectingRegion(true);
    setSelectionRequest((previous) => previous + 1);
    setNotice(planningCapabilities.supportsAutomaticRegionPlanning
      ? "Click successive sky points, then finish the polygon."
      : planningCapabilities.canAuthorProjectPlacement
        ? "Select a region for project lattice preview; this does not create regional pointings."
        : "Select an area for geometry diagnostics; this strategy does not place regional pointings.");
  }

  function cancelRegionDrawing() {
    setSelectingRegion(false);
    setNotice("Polygon drawing cancelled.");
  }

  function clearRegionSelection() {
    applySelectedRegion(null);
  }

  function setAllProposals(enabled: boolean) {
    const activeIds = new Set(activeOutputProposals.map((tile) => tile.id));
    setProposals((previous) => previous.map((tile) => activeIds.has(tile.id) ? { ...tile, enabled } : tile));
    setNotice(enabled ? "All pointings for the selected output profile were restored." : "All pointings for the selected output profile were disabled.");
  }

  async function exportFile(exportMode: PointingExportMode = "nominal") {
    if (!activeInstrument) {
      setError(activeResolution.error ?? "Select a registered instrument or observing strategy before downloading.");
      return;
    }
    if (exportProblem) { setError(exportProblem); return; }
    const fileName = !activeSurvey
      ? "manual_centers.csv"
      : exportMode === "expanded"
        ? "new_tiles_expanded_exposures.csv"
        : observingSequence ? "new_tiles_nominal_pointings.csv" : "new_tiles.csv";
    await runBusy(
      () => activeSurvey
        ? downloadCatalogue(enabledProposals, activeSurvey.id, exportEpoch, profileRegistry, activePointingGeometryContext, exportMode)
        : downloadInstrumentCoordinates(enabledProposals, activeInstrument.id, profileRegistry, activePointingGeometryContext),
      () => setNotice(`${fileName} downloaded.`),
    );
  }

  async function exportProjectManifest() {
    if (!activeInstrument || activeResolution.error) {
      setError(activeResolution.error ?? "Select a registered instrument or observing strategy before exporting a project.");
      return;
    }
    if (projectCatalogueProblem) {
      setError("Cannot export a complete project recipe while a required catalogue dependency is missing.");
      return;
    }
    if (unresolvedDataset) {
      setError(`Cannot export a reproducible project until an instrument profile is assigned to “${unresolvedDataset.filename}”.`);
      return;
    }
    await runBusy(async () => {
      const catalogueDependencies = projectCatalogueDependencies?.length
        ? projectCatalogueDependencies
        : await describeProjectCatalogueDependencies(datasets);
      const manifest = createProjectManifest({
        instrumentId: activeInstrument.id,
        observingStrategyId: activeSurvey?.id ?? null,
        planningMode: projectPlanningMode,
        region: regionPolygon,
        placement: projectPlacement,
        positionAngleInputDeg: manualPositionAngle.trim() ? Number(manualPositionAngle) : null,
        coverageStrategy,
        sequenceCoverageBasis: sequenceBasis,
        catalogueDependencies,
        importedProfileDocuments,
      }, profileRegistry);
      return serializeProjectManifest(manifest, profileRegistry);
    }, (json) => {
      const blob = new Blob([json], { type: "application/json; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "jasytata-project.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice("jasytata-project.json downloaded. Catalogue files remain external dependencies; pointing CSV exports remain separate.");
    });
  }

  async function importProjectManifest(file?: File) {
    if (!file) return;
    const projectRevision = regionRevisionRef.current;
    await runBusy(async () => {
      const manifest = parseProjectManifest(await file.text(), profileRegistry);
      const catalogueMatch = await matchProjectCatalogueDependencies(manifest.project.catalogue_dependencies, datasets);
      const matchedDatasets = catalogueMatch.matchedDatasetIds.flatMap((id) => {
        const dataset = datasets.find((item) => item.id === id);
        return dataset ? [dataset] : [];
      });
      if (projectRevision !== regionRevisionRef.current) {
        throw new Error("Project import was cancelled because the current project changed while the file was being validated. Import it again when ready.");
      }
      // Profile registration follows every parsing, science, reference and catalogue check.
      const profileDependencies = installProjectProfileDependencies(manifest, profileRegistry);
      return { manifest, catalogueMatch, matchedDatasets, profileDependencies };
    }, ({ manifest, catalogueMatch, matchedDatasets, profileDependencies }) => {
      planningAbortRef.current?.abort();
      planningAbortRef.current = null;
      regionRevisionRef.current += 1;
      proposalBatchRef.current = 0;
      setPlanningActive(false);
      setDatasets(matchedDatasets);
      setColumnMapping(null);
      setProposals([]);
      setPending(null);
      setProposalContext(null);
      setActiveMetrics(null);
      setScientificRefusal(null);
      setSelectedTileId(null);
      setReferenceMarker(null);
      setRegionPolygon(manifest.project.region);
      setProjectPlanningMode(manifest.project.planning_mode);
      setProjectPlacement(manifest.project.placement);
      setProjectPlacementDirty(false);
      setProjectLatticePreview(null);
      setProjectCatalogueDependencies(manifest.project.catalogue_dependencies);
      setMatchedProjectCatalogueDatasetIds(catalogueMatch.matchedDatasetIds);
      setProjectCatalogueDependenciesReady(catalogueMatch.complete);
      setCoverageStrategy(manifest.project.coverage_strategy);
      setSequenceBasis(manifest.project.sequence_coverage_basis);
      setOutputContext(manifest.project.observing_strategy
        ? { kind: "survey", id: manifest.project.observing_strategy.id }
        : { kind: "instrument", id: manifest.project.instrument.id });
      setInstrumentProfiles(profileRegistry.listAnyInstrumentProfiles());
      setSurveyProfiles(profileRegistry.listAnySurveyProfiles());
      setImportedProfileDocuments((previous) => {
        const next = new Map(previous);
        for (const dependency of profileDependencies) {
          if ("instrument" in dependency && dependency.instrument) next.set(`instrument:${dependency.instrument.id}`, dependency);
          if ("survey" in dependency && dependency.survey) next.set(`survey:${dependency.survey.id}`, dependency);
        }
        return next;
      });
      setManualPositionAngle(manifest.project.position_angle?.input_deg === null || !manifest.project.position_angle
        ? ""
        : String(manifest.project.position_angle.input_deg));
      setExportEpoch(undefined);
      setImportText("");
      setParsedCenters(null);
      setApplyBatchPa(false);
      setDebugRequestJson("");
      setMapMode("idle");
      setSelectingRegion(false);
      setSelectionRequest((previous) => previous + 1);
      setConfirmingNewProject(false);
      setProjectSession((previous) => previous + 1);
      setError(null);
      setNotice(catalogueMatch.missingCount
        ? `Project imported. ${catalogueMatch.missingCount} external catalogue file${catalogueMatch.missingCount === 1 ? " is" : "s are"} still required before planning.`
        : "Project imported. Candidate preview and plan are empty; generate again from the restored inputs.");
    }, () => projectRevision === regionRevisionRef.current);
    if (projectFileInputRef.current) projectFileInputRef.current.value = "";
  }

  const projectPlacementSummary = projectPlacement?.type === "lattice_project_placement"
    ? `${projectPlacement.authoring.preset} · ${projectPlacement.rotation.mode === "independent" ? "independent rotation" : "follows instrument PA"}`
    : projectPlacement?.type === "manual_project_placement" ? "user-declared manual placement" : "not set";
  const projectPlanStatus = pending
    ? `${pending.tiles.length} pointings ready for review`
    : enabledProposals.length
      ? `${enabledProposals.length} accepted nominal pointings`
      : projectCatalogueProblem ? "catalogue required"
        : !regionPolygon ? "region needed"
          : usesProjectRegionSource && !projectPlacement ? "placement needed"
            : usesProjectRegionSource ? "ready to generate" : "manual mode";
  const catalogueSummary = projectCatalogueDependencies?.length
    ? `${matchedProjectCatalogueDatasetIds.length}/${projectCatalogueDependencies.length} referenced files loaded`
    : datasets.length ? `${datasets.length} optional catalogue${datasets.length === 1 ? "" : "s"}` : "none required";

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand-block">
          <h1 className="brand-title"><img className="brand-logo" src={jasytataLogo} alt="Jasytata" /></h1>
          <span className="brand-profile" title={activeSurvey?.display_name ?? activeInstrument?.display_name ?? "Astronomical tile planning"}>
            {activeSurvey?.display_name ?? activeInstrument?.display_name ?? "Resolving output profile"}
          </span>
        </div>
        <div className="topbar-state">
          <span className={`status-dot ${activeInstrument ? "is-ready" : ""}`} />
          <span>{datasets.length === 1 ? datasets[0].filename : datasets.length ? `${datasets.length} catalogues loaded` : activeSurvey ? "Survey strategy active · no catalogue loaded" : activeInstrument ? usesProjectRegionSource ? "Standalone instrument · Regional mosaic" : "Standalone instrument · manual centers" : "Resolving output profile"}</span>
          {hasCatalogue && <span className="topbar-count">{originalTiles.length.toLocaleString()} original tiles</span>}
        </div>
        <div className="topbar-actions">
          <button
            className="button theme-toggle"
            type="button"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-pressed={theme === "dark"}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
            <span className="theme-toggle-label">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <input ref={projectFileInputRef} className="visually-hidden" type="file" accept=".json,application/json"
            aria-label="Choose Jasytata project JSON" onChange={(event) => void importProjectManifest(event.target.files?.[0])} />
          <button className="button button-outline project-action" type="button" onClick={() => projectFileInputRef.current?.click()} disabled={busy && !planningActive}>
            <Icon name="upload" /> Import project
          </button>
          <button className="button button-outline project-action" type="button" onClick={() => void exportProjectManifest()}
            disabled={busy || !activeInstrument || Boolean(activeResolution.error) || Boolean(projectCatalogueProblem) || Boolean(unresolvedDataset)}>
            <Icon name="download" /> Export project
          </button>
          <button ref={newProjectButtonRef} className="button button-quiet new-project-button" type="button" onClick={requestNewProject} disabled={busy && !planningActive}>
            New project
          </button>
          <button className="button button-quiet" onClick={() => void runBusy(loadReferenceCatalogue, applyCatalogue)} disabled={busy}>
            <Icon name="sample" /> Load reference
          </button>
          <button className="button button-primary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Icon name="upload" /> Load catalogue
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".csv,text/csv"
            aria-label="Choose catalogue CSV"
            onChange={(event) => void handleUpload(event.target.files?.[0])}
          />
        </div>
      </header>

      {confirmingNewProject && (
        <div className="message-bar is-notice new-project-confirmation" role="alertdialog" aria-labelledby="new-project-confirmation-title" aria-describedby="new-project-confirmation-description">
          <span><strong id="new-project-confirmation-title">Discard this project?</strong> <span id="new-project-confirmation-description">Catalogues, pointings, and planning state will be cleared.</span></span>
          <div className="new-project-confirmation-actions">
            <button ref={cancelNewProjectRef} className="button button-outline" type="button" onClick={() => {
              setConfirmingNewProject(false);
              newProjectButtonRef.current?.focus();
            }}>Cancel</button>
            <button className="button button-danger" type="button" onClick={startNewProject} disabled={busy && !planningActive}>Discard and start new</button>
          </div>
        </div>
      )}

      {(error || notice) && (
        <div className={`message-bar ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}>
          <span>{error ?? notice}</span>
          <button aria-label="Dismiss message" onClick={() => { setError(null); setNotice(null); }}>×</button>
        </div>
      )}

      <section className="workspace">
        <aside className="control-panel panel-scroll" aria-label="Catalogue and planning controls" tabIndex={0}>
          <section className="panel-section catalog-section">
            <SectionHeading title="Existing catalogue" trailing={hasCatalogue ? "LOADED" : "OPTIONAL"} />
            <div className="catalogue-summary">
              <span className="summary-number">{originalTiles.length.toLocaleString()}</span>
              <span className="summary-label">original tile centers</span>
            </div>
            <p className="panel-copy">{hasCatalogue
              ? "Original catalogue rows stay unchanged. New tiles remain separate until accepted."
              : activeSurvey
                ? "Load catalogues to extend a project, or start a new plan with the active survey strategy."
                : `Load catalogues to assign source instruments, or add manual centers for ${activeInstrument?.display_name ?? "the selected instrument"}.`}</p>
            {columnMapping && (
              <div className="column-mapping">
                <strong>Map coordinates in {columnMapping.file.name}</strong>
                <label>RA column
                  <select aria-label="RA column" value={columnMapping.raColumn} onChange={(event) => setColumnMapping({ ...columnMapping, raColumn: event.target.value })}>
                    <option value="">Choose RA</option>
                    {columnMapping.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                <label>DEC column
                  <select aria-label="DEC column" value={columnMapping.decColumn} onChange={(event) => setColumnMapping({ ...columnMapping, decColumn: event.target.value })}>
                    <option value="">Choose DEC</option>
                    {columnMapping.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                <label>Numeric RA unit
                  <select aria-label="Numeric RA unit" value={columnMapping.raUnit} onChange={(event) => setColumnMapping({ ...columnMapping, raUnit: event.target.value as ColumnMapping["raUnit"] })}>
                    <option value="auto">Auto: decimal degrees, sexagesimal hours</option>
                    <option value="degrees">Degrees</option>
                    <option value="hours">Hours</option>
                  </select>
                </label>
                <button className="button button-primary button-full" disabled={!columnMapping.raColumn || !columnMapping.decColumn || columnMapping.raColumn === columnMapping.decColumn || busy} onClick={() => void applyColumnMapping()}>Load mapped catalogue</button>
              </div>
            )}
          </section>

          <section className="panel-section tile-profile-section" aria-label="Output profile">
            <SectionHeading title="Output profile" trailing={activeResolution.error ? "UNAVAILABLE" : activeSurvey ? "SURVEY STRATEGY" : "STANDALONE MODE"} />
            <label className="field-label" htmlFor="output-profile-select">Output profile</label>
            <select id="output-profile-select" className="profile-select" value={outputContextValue(outputContext)} disabled={busy}
              onChange={(event) => {
                const separator = event.target.value.indexOf(":");
                const kind = event.target.value.slice(0, separator);
                const id = event.target.value.slice(separator + 1);
                if (kind === "survey" || kind === "instrument") activateOutputContext({ kind, id });
              }}>
              <optgroup label="Survey strategies">
                {surveyProfiles.map((survey) => <option key={`survey:${survey.id}`} value={`survey:${survey.id}`} title={survey.description ?? undefined}>{surveyChoiceLabel(survey)}</option>)}
              </optgroup>
              <optgroup label="Observed-area instruments">
                {instrumentProfiles.filter((instrument) => instrument.schema_version === 3 && instrument.footprint_semantics.role === "observed_area")
                  .map((instrument) => <option key={`instrument:${instrument.id}`} value={`instrument:${instrument.id}`} title={instrument.description ?? undefined}>{instrumentChoiceLabel(instrument)}</option>)}
              </optgroup>
              <optgroup label="Nominal planning envelopes">
                {instrumentProfiles.filter((instrument) => instrument.schema_version === 3 && instrument.footprint_semantics.role === "nominal_envelope")
                  .map((instrument) => <option key={`instrument:${instrument.id}`} value={`instrument:${instrument.id}`} title={instrument.description ?? undefined}>{instrumentChoiceLabel(instrument)}</option>)}
              </optgroup>
              <optgroup label="Target-access fields">
                {instrumentProfiles.filter((instrument) => instrument.schema_version === 3 && instrument.footprint_semantics.role === "target_access")
                  .map((instrument) => <option key={`instrument:${instrument.id}`} value={`instrument:${instrument.id}`} title={instrument.description ?? undefined}>{instrumentChoiceLabel(instrument)}</option>)}
              </optgroup>
            </select>
            <input ref={profileFileInputRef} type="file" accept=".json,application/json" aria-label="Profile JSON file" hidden
              onChange={(event) => void handleProfileUpload(event.target.files?.[0])} />
            <button className="button button-outline button-full" onClick={() => setProfileEditorOpen(true)}>Create profile</button>
            <div className="profile-actions">
              <button className="button button-outline" onClick={() => profileFileInputRef.current?.click()} disabled={busy}>Import profile</button>
              <button className="button button-outline" onClick={() => activeInstrument && void runBusy(
                () => activeSurvey
                  ? downloadProfileDocument(importedProfileDocuments.get(`survey:${activeSurvey.id}`) ?? (
                    activeSurvey.schema_version === 3
                      ? profileRegistry.resolveSurveyProfileDocument(activeSurvey.id)
                      : profileRegistry.resolveAnyProfileDocument(activeSurvey.id)
                  ))
                  : downloadInstrumentProfileJson(activeInstrument.id),
                () => setNotice(activeSurvey
                  ? `Exported ${activeSurvey.display_name} strategy and linked instrument profile JSON.`
                  : `Exported standalone instrument profile: ${activeInstrument.display_name}.`),
              )} disabled={!activeInstrument || busy}>
                {activeSurvey ? activeSurvey.schema_version === 3 ? "Export strategy JSON" : "Export survey JSON" : "Export instrument JSON"}
              </button>
            </div>
            <p className="fine-print">Imports validate v2 pairs and v3 standalone instruments, strategies, or matching pairs. A standalone instrument stays survey-free.</p>
            {activeResolution.error && <p className="profile-validation-error" role="alert">{activeResolution.error}</p>}
            {activeInstrument && (
              <div className="profile-readout scientific-profile" aria-label={activeSurvey ? "Active survey summary" : "Active instrument summary"}>
                <span>Output mode <strong>{activeSurvey ? "Survey strategy" : "Standalone instrument"}</strong></span>
                <span>Planning mode <strong>{planningModeLabel(planningCapabilities)}</strong></span>
                {activeSurvey && <span>Strategy <strong>{activeSurvey.display_name}</strong></span>}
                {activeSurvey && <span>Stable strategy ID <strong>{activeSurvey.id}</strong></span>}
                <span>Instrument <strong>{activeInstrument.display_name}</strong></span>
                <span>Stable mode ID <strong>{activeInstrument.id}</strong></span>
                <span>Footprint <strong>{footprintSummary(activeInstrument.footprint)}</strong></span>
                <span>Geometry <strong>{roleSummary(activeInstrument)}</strong></span>
                {activeInstrument.schema_version === 3 && activeInstrument.footprint_semantics.role === "nominal_envelope" &&
                  <p className="scientific-help">Planning envelope, not exact active area</p>}
                {activeInstrument.schema_version === 3 && <span>PA policy <strong>{paMode === "fixed" ? `Fixed · ${formatDegrees(profilePa!) } east of north` : paMode === "per_pointing" ? `Per pointing${requiredPositionAngle ? " · required" : " · optional"}` : paMode === "user_selected" ? "User selected · plan/session" : "Not applicable · physical PA omitted"}</strong></span>}
                {activeSurvey && <span>Tiling <strong>{tilingSummary(activeSurvey.tiling)}</strong></span>}
                {activeSurvey?.schema_version === 3 && activeSurvey.observing_sequence &&
                  <span>Sequence <strong>{activeSurvey.observing_sequence.exposures.length} ordered exposures per nominal pointing</strong></span>}
                {!observingSequence && <span>Sequence <strong>No observing sequence selected</strong></span>}
                {activeInstrument.schema_version !== 3 && (activeSurvey?.description || activeInstrument.description) &&
                  <p className="fine-print">{activeSurvey?.description ?? activeInstrument.description}</p>}
                {!activeSurvey && <p className="fine-print">Manual centers use this instrument footprint only. Survey overlap, epochs, constants, automatic tiling and coverage-completion metrics are unavailable.</p>}
              </div>
            )}
            {activeInstrument && <ScientificDetails instrument={activeInstrument} strategy={activeSurvey} />}
            {(paMode === "per_pointing" || paMode === "user_selected") && <label className="field-label required-pa-field scientific-control">
              {paMode === "user_selected" ? "Plan/session PA (degrees east of north)" : `${requiredPositionAngle ? "Required pointing" : "Pointing"} PA (degrees east of north)`}
              <input
                type="number"
                step="any"
                required={requiredPositionAngle}
                aria-label={paMode === "user_selected" ? "Plan/session PA in degrees east of north" : `${requiredPositionAngle ? "Required pointing" : "Pointing"} PA in degrees east of north`}
                value={manualPositionAngle}
                disabled={busy}
                onChange={(event) => setManualPositionAngle(event.target.value)}
                aria-invalid={manualPositionAngle.trim().length > 0 && !validManualPositionAngle}
              />
              <span className="scientific-help">{paMode === "user_selected" ? "Used for new pointings. Previewed and accepted pointings retain their PA when this value changes." : "Used for the next sky click. Each pointing retains its PA; pasted batches require an explicit common-PA choice."}</span>
            </label>}
            {observingSequence && <div className="scientific-control">
              <label className="field-label" htmlFor="sequence-basis">Coverage geometry basis</label>
              <select id="sequence-basis" className="profile-select" value={geometryBasis} disabled={busy}
                onChange={(event) => changeSequenceBasis(event.target.value as "single_exposure" | "effective_sequence")}>
                <option value="single_exposure">Single exposure</option>
                <option value="effective_sequence">Full sequence footprint</option>
              </select>
              <p className="scientific-help">Coverage uses the selected geometry. Proposal review stays nominal; export offers separate nominal-pointing and exposure files.</p>
            </div>}
            {activeSurvey && <p className="scientific-help">Measurement basis: {activeInstrument?.schema_version !== 3 ? "Legacy survey coverage" : activeInstrument.footprint_semantics.role === "observed_area" ? "Observed-area geometry" : activeInstrument.footprint_semantics.role === "nominal_envelope" ? "Nominal envelope overlap" : "Target access · area coverage unsupported"}.</p>}
          </section>

          <section className="panel-section">
            <SectionHeading title="Add tiles" />
            <div className="mode-stack">
              <button
                className={`mode-button ${mapMode === "add-tile" ? "is-active" : ""}`}
                onClick={() => {
                  setSelectingRegion(false);
                  setMapMode("add-tile");
                  setNotice("Click a position on the sky to preview one new tile.");
                }}
                disabled={busy || !planningCapabilities.canPlaceManualPointing || (requiredPositionAngle && !validManualPositionAngle)}
              >
                <span className="mode-icon"><Icon name="crosshair" /></span>
                <span><strong>Single tile</strong><small>Click a sky position</small></span>
                <Icon name="chevron" />
              </button>
              <button className="mode-button" onClick={() => { setSelectingRegion(false); setMapMode("idle"); setParsedCenters(null); importRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" }); }} disabled={busy || !planningCapabilities.canImportCenters}>
                <span className="mode-icon"><Icon name="list" /></span>
                <span><strong>Import centers</strong><small>Paste RA / DEC pairs</small></span>
                <Icon name="chevron" />
              </button>
            </div>
            {!planningCapabilities.supportsAutomaticRegionPlanning && !usesProjectRegionSource &&
              <p className="planning-capability-message">{automaticRegionUnavailableMessage(planningCapabilities)}</p>}
            {!hasCatalogue && proposals.length === 0 && !pending &&
              <p className="planning-empty-state">{emptyPlanningStateMessage(planningCapabilities)}</p>}
          </section>

          <section className="panel-section">
            <RegionAuthoring key={`region-${projectSession}`}
              polygonLabel={planningCapabilities.canMeasureSelectedGeometry ? "Measure area" : "Select area"}
              disabled={busy || !(planningCapabilities.supportsAutomaticRegionPlanning || planningCapabilities.canMeasureSelectedGeometry || planningCapabilities.canAuthorProjectPlacement)}
              selecting={selectingRegion} onPolygon={beginRegionSelection}
              onCancelPolygon={cancelRegionDrawing} onApply={applySelectedRegion} />
            <ReferenceCoordinate key={`reference-${projectSession}`} marker={referenceMarker} onChange={setReferenceMarker} />
          </section>

          <section className="panel-section">
            <ProjectLatticeAuthoring
              key={`project-placement-${projectSession}`}
              mode={projectPlanningMode}
              onModeChange={changeProjectPlanningMode}
              canAuthor={planningCapabilities.canAuthorProjectPlacement}
              canPreview={planningCapabilities.canPreviewProjectLattice}
              unavailableReason={planningCapabilities.projectLatticeUnavailableReason}
              footprintNotice={activeInstrument?.schema_version === 3 && activeInstrument.footprint_semantics.role === "nominal_envelope"
                ? "Nominal envelope geometry is approximate; candidate intersections use the declared envelope."
                : activeInstrument?.schema_version === 3 && activeInstrument.footprint_semantics.fidelity === "approximate"
                  ? activeInstrument.footprint_semantics.approximation_notice ?? "Candidate intersections use approximate declared footprint geometry."
                  : null}
              effectiveInstrumentPA={effectiveInstrumentPA}
              placement={projectPlacement}
              preview={currentProjectLatticePreview}
              disabled={busy}
              onDraftChange={() => { setProjectLatticePreview(null); setProjectPlacementDirty(true); invalidateProjectPlan(); }}
              onApply={applyProjectPlacement}
              onPreview={applyProjectLatticePreview}
            />
          </section>

          <section className="panel-section planning-section">
            <SectionHeading title={planningCapabilities.supportsAutomaticRegionPlanning || usesProjectRegionSource ? "Region plan" : planningCapabilities.canAuthorProjectPlacement ? "Project placement" : planningCapabilities.canMeasureSelectedGeometry ? "Region diagnostics" : "Region plan"}
              trailing={regionPolygon ? "AREA SET" : undefined} />
            <p className="fine-print project-workflow-summary" data-testid="project-summary">
              Instrument: {activeInstrument?.display_name ?? "unavailable"} · Strategy: {activeSurvey?.display_name ?? "none"} ·
              {" "}Region: {regionPolygon ? `${regionPolygon.vertices.length} vertices` : "not set"} · Placement: {projectPlacementSummary} ·
              {" "}Coverage: {coverageStrategy === "complete" ? "Complete" : "Efficient"} · Plan: {projectPlanStatus} · Catalogue: {catalogueSummary}
            </p>
            {!planningCapabilities.supportsAutomaticRegionPlanning &&
              <p className="panel-copy planning-capability-message">{planningCapabilities.canAuthorProjectPlacement
                ? "Select Regional mosaic and apply project placement to generate a regional plan. Preview lattice shows all admissible candidate sites."
                : planningCapabilities.canMeasureSelectedGeometry
                  ? "Area selection measures declared geometry only; it does not generate regional pointings."
                  : "Area selection is unavailable for this output context."}</p>}
            {regionPolygon && (planningCapabilities.supportsAutomaticRegionPlanning || planningCapabilities.canMeasureSelectedGeometry || planningCapabilities.canAuthorProjectPlacement) ? (
              <div className="region-summary">
                <div className="coordinate-row"><span>Selected polygon</span><strong>{regionPolygon.vertices.length} vertices · finalized</strong></div>
                <div className="region-actions">
                  <button className="button button-outline" onClick={beginRegionSelection} disabled={busy}>{planningCapabilities.supportsAutomaticRegionPlanning ? "Redraw polygon" : "Redraw area"}</button>
                  <button className="button button-quiet" onClick={clearRegionSelection}>Clear selection</button>
                </div>
                {import.meta.env.DEV && planningCapabilities.supportsAutomaticRegionPlanning && <details className="development-plan-input">
                  <summary>Development: plan input</summary>
                  <pre>{JSON.stringify(regionPolygon.vertices, null, 2)}</pre>
                  <button className="text-button" disabled={!debugRequestJson} onClick={() => {
                    void navigator.clipboard.writeText(debugRequestJson)
                      .then(() => setNotice("Last plan request JSON copied."))
                      .catch(() => setError("Could not copy the plan request JSON."));
                  }}>Copy last plan request JSON</button>
                </details>}
              </div>
            ) : planningCapabilities.supportsAutomaticRegionPlanning ? (
              <p className="panel-copy">Select a sky polygon to plan with the active strategy and assigned catalogue pointings.</p>
            ) : planningCapabilities.canMeasureSelectedGeometry ? (
              <p className="panel-copy">{regionPolygon ? "Measure the declared geometry in this area; no regional pointings will be generated." : "Select an area only to measure declared geometry. Add target centers manually or import centers for this strategy."}</p>
            ) : null}
            {(planningCapabilities.supportsAutomaticRegionPlanning || usesProjectRegionSource) ? <fieldset className="coverage-strategy">
              <legend>Coverage strategy</legend>
              <label><input type="radio" name="coverage-strategy" value="complete" checked={coverageStrategy === "complete"} onChange={() => changeCoverageStrategy("complete")} />
                <span><strong>Complete coverage (default)</strong><small>Attempts to cover every sampled point in the selected region.</small></span></label>
              <label><input type="radio" name="coverage-strategy" value="efficient" checked={coverageStrategy === "efficient"} onChange={() => changeCoverageStrategy("efficient")} />
                <span><strong>Efficient coverage</strong><small>Uses the same planner and candidate order; may stop when the coverage policy's floor is met and new physical area falls below its marginal-efficiency threshold. Requires an Efficient policy.</small></span></label>
              <p className="fine-print">Efficient can leave small residual gaps to save exposures; it does not assess their topology or scientific importance. Choose Complete for exhaustive sampled coverage.</p>
            </fieldset> : null}
            {planningUnavailableReason && (planningCapabilities.supportsAutomaticRegionPlanning || usesProjectRegionSource) &&
              <p className="profile-validation-error" role={usesProjectRegionSource ? "status" : "alert"}>{planningUnavailableReason}</p>}
            {planningCapabilities.canMeasureSelectedGeometry && <button className="button button-outline button-full" disabled={busy || !regionPolygon || Boolean(unresolvedDataset)} onClick={() => void handleMeasureGeometry()}>Measure selected geometry</button>}
            {(planningCapabilities.supportsAutomaticRegionPlanning || usesProjectRegionSource) && <button className="button button-plan" onClick={() => void handlePlanRegion()}
              disabled={!regionPolygon || !activeInstrument || (!usesProjectRegionSource && (!profile || !activeSurvey)) || Boolean(planningUnavailableReason) || busy}>
              {busy ? <span className="spinner" /> : <Icon name="spark" />}Generate plan
            </button>}
            {planningActive && <button className="button button-quiet button-full" onClick={cancelPlanningRun}>Cancel planning</button>}
            {planningCapabilities.supportsAutomaticRegionPlanning && activeSurvey &&
              <p className="fine-print">Tiles can extend beyond the selected area when that preserves the local grid.</p>}
          </section>

          <section ref={importRef} className="panel-section import-section">
            <SectionHeading title="Paste centers" />
            <label className="visually-hidden" htmlFor="centers-text">RA and DEC pairs</label>
            <textarea
              id="centers-text"
              value={importText}
              onChange={(event) => { setImportText(event.target.value); setParsedCenters(null); setApplyBatchPa(false); }}
              placeholder={"RA, DEC\n10:03:05, -23:54:31\n150.5, -24.25"}
              rows={4}
              disabled={busy}
            />
            {paMode === "per_pointing" && <div className="scientific-control">
              <p className="scientific-help">Paste RA/DEC pairs only. For differing PAs, add pointings individually. A common PA uses the pointing input above.</p>
              <label className="scientific-batch-pa"><input type="checkbox" checked={applyBatchPa} disabled={busy}
                onChange={(event) => setApplyBatchPa(event.target.checked)} />Apply pointing PA to this pasted batch</label>
            </div>}
            <button className="button button-outline button-full" onClick={() => void handleParseCenters()} disabled={busy || !importText.trim()}>
              Validate and preview
            </button>
            {parsedCenters && (
              <div className="import-preview">
                <strong>{parsedCenters.length} centers parsed</strong>
                <div className="preview-coordinate-list">
                  {parsedCenters.slice(0, 4).map((center, index) => (
                    <span key={`${center.ra_deg}-${index}`}>{center.ra_deg.toFixed(5)}°, {center.dec_deg.toFixed(5)}°</span>
                  ))}
                  {parsedCenters.length > 4 && <span>and {parsedCenters.length - 4} more</span>}
                </div>
                <button className="button button-primary button-full" onClick={() => void handleStageImported()} disabled={busy}>Stage import preview</button>
              </div>
            )}
          </section>

          <section className="panel-section layers-section">
            <SectionHeading title="Map layers" />
            <div className="layer-group-heading">Data</div>
            {datasets.map((dataset) => (
              <div key={dataset.id}>
                <label className="dataset-layer">
                  <input type="checkbox" aria-label={`Show ${dataset.filename}`} checked={dataset.visible} onChange={(event) => {
                    setDatasets((previous) => previous.map((item) => item.id === dataset.id ? { ...item, visible: event.target.checked } : item));
                    setSelectedTileId(null);
                  }} />
                  <span className="layer-swatch" style={{ "--swatch": dataset.color } as CSSProperties} />
                  <span title={dataset.filename}>{dataset.filename}</span>
                  <strong>{dataset.tiles.length.toLocaleString()}</strong>
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "4px 0 12px 30px" }}>
                  <label style={{ display: "grid", gap: 4 }}>
                <span className="fine-print">Catalogue instrument</span>
                    <select
                      aria-label={`Catalogue instrument for ${dataset.filename}`}
                      value={dataset.instrument_profile_id ?? ""}
                      disabled={busy}
                      onChange={(event) => updateDatasetSettings(dataset.id, { instrument_profile_id: event.target.value })}
                    >
                      <option value="">Choose an instrument…</option>
                      {dataset.instrument_profile_id && !instrumentProfiles.some((instrument) => instrument.id === dataset.instrument_profile_id) &&
                        <option value={dataset.instrument_profile_id}>{dataset.instrument_profile_id} (unavailable)</option>}
                      {instrumentProfiles.map((instrument) => (
                        <option key={instrument.id} value={instrument.id} title={instrument.description ?? footprintSummary(instrument.footprint)}>{instrumentChoiceLabel(instrument)}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="fine-print">Inference participation</span>
                    <select
                      aria-label={`Inference participation for ${dataset.filename}`}
                      value={dataset.inference_role}
                      disabled={busy}
                      onChange={(event) => updateDatasetSettings(dataset.id, { inference_role: event.target.value as CatalogueDataset["inference_role"] })}
                    >
                      <option value="auto">Auto · follow active survey compatibility</option>
                      <option value="include">Include · allow compatible independent lattice</option>
                      <option value="exclude">Exclude · coverage only</option>
                    </select>
                  </label>
                </div>
                {(!dataset.instrument_profile_id || !instrumentProfiles.some((instrument) => instrument.id === dataset.instrument_profile_id)) &&
                  <p className="profile-validation-error" role="alert">
                    {dataset.instrument_profile_id
                      ? `Instrument “${dataset.instrument_profile_id}” is unavailable. Assign a registered profile before planning.`
                      : "Assign a registered instrument profile before planning with this catalogue."}
                  </p>}
              </div>
            ))}
            {datasets.length > 0 && (
              <p className="fine-print">
                Auto follows the selected survey strategy’s compatibility policy. Include permits a compatible independent lattice. Exclude removes a catalogue only from lattice inference; its assigned footprint still contributes to coverage. Map visibility does not change either behavior.
              </p>
            )}
            <div className="layer-group-heading">Planning</div>
            <PlanningLayer label="Proposed tiles" color="var(--orange)" checked={planningLayers.proposals}
              count={activeOutputProposals.length + (pending?.tiles.length ?? 0)} onChange={(checked) => {
                setPlanningLayers((previous) => ({ ...previous, proposals: checked }));
                setSelectedTileId(null);
              }} />
            <PlanningLayer label="Selected region" color="var(--yellow)" checked={planningLayers.region}
              onChange={(checked) => setPlanningLayers((previous) => ({ ...previous, region: checked }))} />
            <PlanningLayer label="Inference anchors" color="var(--violet)" checked={planningLayers.anchors}
              count={activeContext?.inference?.anchor_tile_ids.length ?? 0}
              onChange={(checked) => setPlanningLayers((previous) => ({ ...previous, anchors: checked }))} />
            <PlanningLayer label="Candidate lattice" color="var(--green)" checked={planningLayers.lattice}
              count={(activeContext?.candidateCenters.length ?? 0) + (currentProjectLatticePreview?.candidates.length ?? 0)}
              onChange={(checked) => setPlanningLayers((previous) => ({ ...previous, lattice: checked }))} />
            <p className="fine-print">Visibility affects only the map. Hidden catalogues still contribute to plans. Disabled proposals appear as gray crosses.</p>
          </section>
        </aside>

        <section className="map-column" aria-label="Sky viewer">
          <div className="map-toolbar">
            <div className="map-title-block">
              <span className="map-live-mark"><span /></span>
              <div><strong>Sky footprint</strong><small>ICRS · equatorial</small></div>
            </div>
            <div className="map-toolbar-center">
              {mapMode === "add-tile" ? <span className="interaction-pill is-add">PLACE TILE · CLICK SKY</span> :
                selectingRegion ? <span className="interaction-pill">CLICK POLYGON VERTICES</span> :
                pending?.solution === "profile_fallback" ? <span className="interaction-pill is-fallback">PROFILE FALLBACK</span> :
                pending?.solution === "extended_existing_grid" ? <span className="interaction-pill is-extended">EXISTING GRID EXTENDED</span> :
                pending?.solution === "declared_lattice" ? <span className="interaction-pill">SURVEY LATTICE</span> :
                <span className="interaction-pill is-idle">PAN · ZOOM · INSPECT</span>}
            </div>
            {hasCatalogue && (
              <button className="map-count-button" onClick={() => setFocusRequest((previous) => previous + 1)} title="Center on catalogue footprint">
                <Icon name="target" /> {visibleTiles.length.toLocaleString()} tiles
              </button>
            )}
          </div>
          <AladinMap
            tiles={mapTiles}
            datasets={datasets}
            profile={profile}
            mode={mapMode}
            selectingRegion={selectingRegion}
            selectionRequest={selectionRequest}
            focusRequest={focusRequest}
            selectedTileId={selectedTileId}
            selectedPolygon={regionPolygon}
            referenceMarker={referenceMarker}
            planningLayers={planningLayers}
            anchorTileIds={activeContext?.inference?.anchor_tile_ids ?? EMPTY_IDS}
            candidateCenters={activeContext?.candidateCenters ?? EMPTY_CENTERS}
            projectCandidateCenters={mapProjectCandidateCenters}
            pointingGeometryContext={activePointingGeometryContext}
            onSkyClick={(ra, dec) => void stageCenters([{ ra_deg: ra, dec_deg: dec, label: "Manual sky click" }], "manual")}
            onTileSelect={(tile) => setSelectedTileId(tile.id)}
            onRegionSelect={applySelectedRegion}
            onCancelRegion={cancelRegionDrawing}
            onError={setError}
          />
          <div className="map-footer">
            <span><i className="legend-line legend-cyan" />Tile footprints appear when zoomed in</span>
            <span>{activeInstrument ? `${roleSummary(activeInstrument)} · ${footprintSummary(activeInstrument.footprint)}` : "Resolving output instrument…"}</span>
          </div>
        </section>

        <aside className="inspector-panel panel-scroll" aria-label="Tile and proposal inspector" tabIndex={0}>
          <section className="panel-section inspector-section">
            <SectionHeading title={selectedTile ? "Tile details" : "Inspector"} trailing={selectedTile?.source === "original" ? "ORIGINAL" : selectedTile ? "PROPOSED" : undefined} />
            {selectedTile ? (
              <TileDetails
                tile={selectedTile}
                context={activePointingGeometryContext}
                fallbackInstrument={activeInstrument}
                onToggle={proposals.some((tile) => tile.id === selectedTile.id)
                  ? () => toggleProposal(selectedTile.id)
                  : undefined}
              />
            ) : (
              <div className="inspector-empty">
                <div className="empty-cross"><span /><span /></div>
                <strong>No tile selected</strong>
                <p>Click a tile center marker to inspect its coordinates and metadata.</p>
              </div>
            )}
          </section>

          {pending && (
            <section className="panel-section proposal-section">
              <SectionHeading title="Proposal preview" trailing="REVIEW" />
              <p className="scientific-help">{activeInstrument?.display_name}{activeSurvey ? ` · ${activeSurvey.display_name}` : " · standalone instrument"}{observingSequence ? ` · ${observingSequence.exposures.length} ordered exposures per nominal pointing` : ""}. {pending.tiles.length} nominal pointings{observingSequence ? ` · ${pendingExpandedExposureCount} expanded exposures` : ""}.</p>
              <div className="solution-stamp">
                <span className={pending.solution === "extended_existing_grid" ? "stamp-dot is-extended" : "stamp-dot"} />
                <strong>{solutionLabel(pending.solution)}</strong>
              </div>
              {pending.solution === "profile_fallback" && <p className="diagnostic-line">{hasCatalogue
                ? "No local grid could be inferred from the loaded tiles, so the active survey tiling policy supplies the grid."
                : "No catalogue is loaded; the active survey supplies the grid for this new project."}</p>}
              {pending.coverageStrategy && <p className="strategy-result">{pending.coverageStrategy === "complete" ? "Complete coverage" : "Efficient coverage"}</p>}
              {pending.metrics ? <MetricsPanel metrics={pending.metrics} inference={pending.inference} candidateCount={pending.candidateCenters.length} /> : <div className="preview-count"><strong>{pending.tiles.length}</strong><span>new centers ready</span></div>}
              {pending.diagnostics.map((line) => <p className="diagnostic-line" key={line}>{line}</p>)}
              {anchors.length > 0 && (
                <details className="anchor-list">
                  <summary>Anchor tiles used <span>{anchors.length}</span></summary>
                  <div>{anchors.slice(0, 12).map((tile) => <span key={tile.id}>{tile.name}</span>)}{anchors.length > 12 && <span>+{anchors.length - 12} more</span>}</div>
                </details>
              )}
              <div className="proposal-list-head"><span>NEW TILE CENTERS</span><span>{pending.tiles.length}</span></div>
              <div className="proposal-list">
                {pending.tiles.length ? pending.tiles.slice(0, 8).map((tile, index) => (
                  <div className="proposal-row" key={`${tile.id}-${index}`}>
                    <span className="proposal-index">{String(index + 1).padStart(2, "0")}</span>
                    <span><strong>{tile.ra_deg.toFixed(4)}°</strong><small>{tile.dec_deg.toFixed(4)}°</small></span>
                    <small className="preview-pa"><PointingAngle tile={tile} context={activePointingGeometryContext} /></small>
                  </div>
                )) : <p className="panel-copy">{(pending.metrics?.coverage_status === "resolved" || pending.metrics?.coverage_status === "legacy_compatible") && pending.metrics.remaining_uncovered_fraction === 0 ? "Existing coverage already satisfies this plan." : "No admissible candidate adds sampled coverage; see the scientific diagnostics."}</p>}
                {pending.tiles.length > 8 && <span className="more-row">+{pending.tiles.length - 8} more preview centers</span>}
              </div>
              <div className="proposal-actions">
                <button className="button button-primary button-full" onClick={acceptPreview} disabled={!pending.tiles.length}><Icon name="check" /> Accept proposal</button>
                <button className="button button-quiet button-full" onClick={cancelPreview}>Cancel preview</button>
              </div>
            </section>
          )}

          <section className="panel-section accepted-section">
            <div className="accepted-heading">
              <SectionHeading title="Generated proposal" trailing={String(activeOutputProposals.length)} />
              <div className="accepted-actions">
                <button className="text-button" onClick={() => setAllProposals(true)} disabled={!activeOutputProposals.length}>Restore all</button>
                <button className="text-button" onClick={() => setAllProposals(false)} disabled={!activeOutputProposals.length}>Disable all</button>
                <button className="text-button" onClick={clearProposals} disabled={!activeOutputProposals.length && !pending}>Clear proposal</button>
              </div>
            </div>
            {activeOutputProposals.length > 0 && <p className="panel-copy">{activeOutputProposals.filter((tile) => tile.enabled !== false).length} enabled · {activeOutputProposals.filter((tile) => tile.enabled === false).length} disabled</p>}
            {activeOutputProposals.length > 0 && proposalContext?.coverageStrategy && <p className="strategy-result">{proposalContext.coverageStrategy === "complete" ? "Complete coverage" : "Efficient coverage"}</p>}
            {activeMetrics && <MetricsPanel metrics={activeMetrics} inference={proposalContext?.inference ?? null} candidateCount={proposalContext?.candidateCenters.length ?? 0} />}
            {scientificRefusal && <MetricsPanel metrics={scientificRefusal} />}
            {activeOutputProposals.length ? (
              <div className="accepted-list">
                {[...activeOutputProposals].reverse().map((tile, index) => (
                  <button className={`accepted-row ${tile.id === selectedTileId ? "is-selected" : ""} ${tile.enabled === false ? "is-disabled" : ""}`} key={tile.id} onClick={() => setSelectedTileId(tile.id)}>
                    <span className="accepted-swatch" />
                    <span><strong>{tile.name || `Pointing ${activeOutputProposals.length - index}`}</strong><small>{tile.ra_deg.toFixed(4)}°, {tile.dec_deg.toFixed(4)}°</small></span>
                    <span className="accepted-type">{tile.enabled === false ? "DISABLED" : tile.placement_provenance?.origin === "user_declared" ? "project lattice" : shortMethod(tile.generation_method)}</span>
                  </button>
                ))}
              </div>
            ) : <p className="panel-copy">Accept a proposal to edit and export its tile centers.</p>}
          </section>

          <section className="panel-section export-section">
            <SectionHeading title={observingSequence ? "Export pointings or exposures" : activeSurvey ? "Export new tiles" : "Export instrument centers"} />
            <p className="panel-copy">{activeOutputProposals.length} generated · {enabledProposals.length} enabled · {activeOutputProposals.length - enabledProposals.length} disabled</p>
            <div className="export-fields">
              {observingSequence && <p className="scientific-help">{activeSurvey?.display_name} · {enabledProposals.length} enabled nominal pointings · {activeExpandedExposureCount} ordered exposures.</p>}
              {activeSurvey
                ? <p className="field-label">Coordinates: {activeSurvey.export.coordinate_format === "sexagesimal" ? "Sexagesimal hours / degrees" : "Decimal degrees"} (selected survey policy)</p>
                : <p className="field-label">Coordinates: ICRS decimal degrees · generic instrument-only format</p>}
              {activeSurvey?.export.epoch && <label className="field-label">{activeSurvey.export.epoch.column}
                <select aria-label="Export epoch" value={exportEpoch ?? activeSurvey.export.epoch.default} onChange={(event) => setExportEpoch(event.target.value)}>
                  {activeSurvey.export.epoch.allowed.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>}
            </div>
            {exportProblem && <p className="profile-validation-error" role="alert">{exportProblem}</p>}
            {observingSequence ? <>
              <button className="button button-download button-full" onClick={() => void exportFile("nominal")} disabled={!enabledProposals.length || !activeInstrument || Boolean(exportProblem) || (Boolean(activeSurvey) && !profile) || busy}>
                <Icon name="download" /> Export nominal pointings
              </button>
              <button className="button button-quiet button-full" onClick={() => void exportFile("expanded")} disabled={!enabledProposals.length || !activeInstrument || Boolean(exportProblem) || (Boolean(activeSurvey) && !profile) || busy}>
                <Icon name="download" /> Export expanded exposures
              </button>
            </> : <button className="button button-download button-full" onClick={() => void exportFile("nominal")} disabled={!enabledProposals.length || !activeInstrument || Boolean(exportProblem) || (Boolean(activeSurvey) && !profile) || busy}>
              <Icon name="download" /> Download {activeSurvey ? "new_tiles.csv" : "manual_centers.csv"}
            </button>}
            <p className="fine-print">{activeSurvey
              ? `${activeSurvey.display_name} · ICRS ${activeSurvey.export.ra_column}/${activeSurvey.export.dec_column}${activeSurvey.export.epoch ? ` · ${activeSurvey.export.epoch.column} ${exportEpoch ?? activeSurvey.export.epoch.default}` : " · no epoch column"}. ${observingSequence ? "Nominal and expanded files are separate; exposure rows follow pointing order, then sequence order." : "Enabled pointings for this strategy only."}`
              : `${activeInstrument?.id ?? "Selected instrument"} · includes placement origin and declared PA when applicable. No epoch, survey constants, or exposure-sequence expansion. Enabled pointings for this instrument only.`}</p>
          </section>
        </aside>
      </section>
      {profileEditorOpen && <InstrumentProfileEditor onCancel={() => setProfileEditorOpen(false)} onRegister={registerAuthoredProfile} />}
    </main>
  );
}

function SectionHeading({ title, trailing }: { title: string; trailing?: string }) {
  return <div className="section-heading"><h2>{title}</h2>{trailing && <span>{trailing}</span>}</div>;
}

/** Toggle a display layer without changing any planning or export state. */
function PlanningLayer({ label, color, checked, count, onChange }: {
  label: string; color: string; checked: boolean; count?: number; onChange: (checked: boolean) => void;
}) {
  return <label className="dataset-layer">
    <input type="checkbox" aria-label={`Show ${label}`} checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span className="layer-swatch" style={{ "--swatch": color } as CSSProperties} />
    <span>{label}</span>
    {count !== undefined && <strong>{count.toLocaleString()}</strong>}
  </label>;
}

function TileDetails({ tile, onToggle, context, fallbackInstrument }: { tile: TileRecord; onToggle?: () => void; context: PointingGeometryContext; fallbackInstrument: AnyInstrumentProfile | null }) {
  const metadata = Object.entries(tile.metadata).filter(([, value]) => value !== "");
  return (
    <div className="tile-detail-content">
      <div className="tile-name-block"><strong>{tile.name || (tile.source === "proposed" ? "Proposed tile" : "Catalogue tile")}</strong><span>{tile.dataset_name ?? (tile.source === "proposed" ? "Proposal" : "Catalogue")}</span></div>
      <PointingScience tile={tile} context={context} fallbackInstrument={fallbackInstrument} />
      <div className="detail-grid">
        <DetailField label="RA" value={`${tile.ra_deg.toFixed(6)}°`} />
        <DetailField label="DEC" value={`${tile.dec_deg.toFixed(6)}°`} />
        {tile.ra_column && tile.original_values?.[tile.ra_column] && <DetailField label={`Source ${tile.ra_column}`} value={tile.original_values[tile.ra_column]} />}
        {tile.dec_column && tile.original_values?.[tile.dec_column] && <DetailField label={`Source ${tile.dec_column}`} value={tile.original_values[tile.dec_column]} />}
        {metadata.map(([key, value]) => <DetailField key={key} label={key} value={String(value)} />)}
      </div>
      <div className="decimal-coordinate">ICRS · {formatRa(tile.ra_deg)}, {formatDec(tile.dec_deg)}</div>
      <div className={`source-banner ${tile.source}`}><span className="status-dot" />{tile.source === "original" ? "Original catalogue tile · immutable" : `Proposed · ${tile.enabled === false ? "disabled" : "enabled"}`}</div>
      {onToggle && <button className="button button-outline button-full" onClick={onToggle}>{tile.enabled === false ? "Enable tile" : "Disable tile"}</button>}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return <div className="detail-field"><span>{label}</span><strong>{value}</strong></div>;
}

function Icon({ name }: { name: "upload" | "sample" | "crosshair" | "list" | "region" | "chevron" | "spark" | "check" | "undo" | "trash" | "download" | "target" | "sun" | "moon" }) {
  const paths: Record<string, ReactNode> = {
    upload: <><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" /><path d="M5 14v5h14v-5" /></>,
    sample: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17" /></>,
    crosshair: <><circle cx="12" cy="12" r="7" /><path d="M12 2v5m0 10v5M2 12h5m10 0h5" /></>,
    list: <><path d="M8 6h12M8 12h12M8 18h12" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
    region: <><rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2" /><path d="M8 9h.01M16 15h.01" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    spark: <><path d="m12 2 1.4 6.6L20 11l-6.6 1.4L12 19l-1.4-6.6L4 11l6.6-2.4L12 2Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h9a7 7 0 0 1 0 14h-2" /></>,
    trash: <><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" /></>,
    download: <><path d="M12 3v12m0 0 4.5-4.5M12 15 7.5 10.5" /><path d="M5 17v3h14v-3" /></>,
    target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.5" /><path d="M12 1v3M12 20v3M1 12h3m16 0h3" /></>,
    sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    moon: <path d="M20.2 15.3A8.5 8.5 0 0 1 8.7 3.8a8.5 8.5 0 1 0 11.5 11.5Z" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function solutionLabel(solution: string) {
  if (solution === "extended_existing_grid") return "Existing grid extended";
  if (solution === "profile_fallback") return "Profile fallback";
  if (solution === "project_lattice") return "User-declared project lattice";
  if (solution === "declared_lattice") return "Declared survey lattice";
  if (solution === "manual") return "Manual sky placement";
  return "Imported centers";
}

function shortMethod(method: TileRecord["generation_method"]) {
  if (method === "region_extended") return "grid extension";
  if (method === "region_legacy") return "legacy grid";
  if (method === "region_lattice") return "survey lattice";
  if (method === "imported_centers") return "imported";
  if (method === "manual") return "manual";
  return "proposed";
}

function formatRa(value: number) {
  const totalSeconds = Math.round((((value % 360) + 360) % 360) / 15 * 3600) % (24 * 3600);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDec(value: number) {
  const sign = value < 0 ? "−" : "+";
  const totalSeconds = Math.round(Math.abs(value) * 3600);
  const degrees = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${String(degrees).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
