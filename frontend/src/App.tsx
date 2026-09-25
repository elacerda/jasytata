import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import jasytataLogo from "./assets/jasytata_logo.png";
import AladinMap, { type MapMode } from "./AladinMap";
import { buildRegionPlanRequest, downloadCatalogue, loadDefaultProfile, loadReferenceCatalogue, measureCoverage, parseCenters, planRegion, proposeCenters, uploadCatalogue, validateCustomProfile } from "./api";
import { createDataset } from "./datasets";
import type {
  CenterInput,
  CatalogueDataset,
  CatalogueResponse,
  CoordinateFormat,
  InferenceDiagnostics,
  PlanMetrics,
  SkyPolygon,
  RegionPlanResponse,
  TileRecord,
  TilingProfile,
} from "./types";

interface ProposalPreview {
  tiles: TileRecord[];
  candidateCenters: CenterInput[];
  inference: InferenceDiagnostics | null;
  diagnostics: string[];
  metrics: PlanMetrics | null;
  solution: string;
}

interface ColumnMapping {
  file: File;
  columns: string[];
  raColumn: string;
  decColumn: string;
  raUnit: "auto" | "degrees" | "hours";
}

interface GeometryDraft {
  width: string;
  height: string;
  overlap: string;
}

const EMPTY_CENTERS: CenterInput[] = [];
const EMPTY_IDS: string[] = [];
type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "jasytata-theme";

/** Render the stateless catalogue, sky planning, proposal, and export workspace. */
export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [datasets, setDatasets] = useState<CatalogueDataset[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping | null>(null);
  const [profile, setProfile] = useState<TilingProfile | null>(null);
  const [defaultProfile, setDefaultProfile] = useState<TilingProfile | null>(null);
  const [geometryDraft, setGeometryDraft] = useState<GeometryDraft | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<TileRecord[]>([]);
  const [pending, setPending] = useState<ProposalPreview | null>(null);
  const [proposalContext, setProposalContext] = useState<ProposalPreview | null>(null);
  const [activeMetrics, setActiveMetrics] = useState<PlanMetrics | null>(null);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [regionPolygon, setRegionPolygon] = useState<SkyPolygon | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("idle");
  const [selectionRequest, setSelectionRequest] = useState(0);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [planningLayers, setPlanningLayers] = useState({
    proposals: true, region: true, anchors: false, lattice: false,
  });
  const [importText, setImportText] = useState("");
  const [parsedCenters, setParsedCenters] = useState<CenterInput[] | null>(null);
  const [exportEpoch, setExportEpoch] = useState("");
  const [coordinateFormat, setCoordinateFormat] = useState<CoordinateFormat>("decimal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [debugRequestJson, setDebugRequestJson] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLElement>(null);
  const proposalBatchRef = useRef(0);
  const regionRevisionRef = useRef(0);

  const hasCatalogue = datasets.length > 0;
  const originalTiles = useMemo(() => datasets.flatMap((dataset) => dataset.tiles), [datasets]);
  const visibleOriginalTiles = useMemo(() => datasets.filter((dataset) => dataset.visible).flatMap((dataset) => dataset.tiles), [datasets]);
  const enabledProposals = useMemo(() => proposals.filter((tile) => tile.enabled !== false), [proposals]);
  const visibleTiles = useMemo(() => [
    ...visibleOriginalTiles,
    ...(planningLayers.proposals ? proposals : []),
  ], [visibleOriginalTiles, planningLayers.proposals, proposals]);
  const planningTiles = useMemo(() => [
    ...originalTiles,
    ...proposals.filter((tile) => tile.enabled !== false),
  ], [originalTiles, proposals]);
  const mapTiles = useMemo(
    () => (pending && planningLayers.proposals ? [...visibleTiles, ...pending.tiles] : visibleTiles),
    [pending, planningLayers.proposals, visibleTiles],
  );
  const activeContext = pending ?? proposalContext;
  const selectedTile = useMemo(
    () => mapTiles.find((tile) => tile.id === selectedTileId) ?? null,
    [mapTiles, selectedTileId],
  );
  const anchors = useMemo(() => {
    const context = pending ?? proposalContext;
    if (!context) return [];
    const ids = new Set(context.inference?.anchor_tile_ids ?? []);
    return planningTiles.filter((tile) => ids.has(tile.id));
  }, [pending, proposalContext, planningTiles]);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme selection still works for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    void loadDefaultProfile().then((loaded) => {
      setDefaultProfile(loaded);
      setProfile(loaded);
      setExportEpoch(loaded.export_epoch_default);
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not load observing profile.");
    });
  }, []);

  useEffect(() => {
    if (!regionPolygon || !profile || !proposals.length) {
      setActiveMetrics(null);
      return;
    }
    let cancelled = false;
    void (profile.id === "custom"
      ? measureCoverage(regionPolygon, originalTiles, proposals, profile.id, profile)
      : measureCoverage(regionPolygon, originalTiles, proposals, profile.id))
      .then((metrics) => { if (!cancelled) setActiveMetrics(metrics); })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not update coverage.");
      });
    return () => { cancelled = true; };
  }, [regionPolygon, profile, proposals, originalTiles]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMapMode("idle");
        setSelectingRegion(false);
        setNotice(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function runBusy<T>(work: () => Promise<T>, success?: (result: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      success?.(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally {
      setBusy(false);
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
    setSelectedTileId(null);
    setNotice(`${result.row_count.toLocaleString()} catalogue rows added from ${result.filename}.`);
    setError(null);
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

  async function applyColumnMapping() {
    if (!columnMapping || !columnMapping.raColumn || !columnMapping.decColumn) return;
    await runBusy(
      () => uploadCatalogue(columnMapping.file, columnMapping),
      applyCatalogue,
    );
  }

  async function stageCenters(centers: CenterInput[], method: "manual" | "imported_centers"): Promise<boolean> {
    let staged = false;
    await runBusy(
      () => proposeCenters(centers, method),
      (tiles) => {
        staged = true;
        setPending({
          tiles,
          candidateCenters: centers,
          inference: null,
          diagnostics: [method === "manual" ? "Manual sky positions are ready for review." : "Imported centers are ready for review."],
          metrics: null,
          solution: method,
        });
        setMapMode("idle");
        setSelectedTileId(null);
        setNotice(`${tiles.length} tile${tiles.length === 1 ? "" : "s"} staged for preview.`);
      },
    );
    return staged;
  }

  async function handleParseCenters() {
    await runBusy(() => parseCenters(importText), (result) => {
      setParsedCenters(result);
      setNotice(`${result.length} valid center${result.length === 1 ? "" : "s"} parsed. Review the list, then stage it.`);
    });
  }

  async function handleStageImported() {
    if (!parsedCenters) return;
    if (await stageCenters(parsedCenters, "imported_centers")) setParsedCenters(null);
  }

  async function handlePlanRegion() {
    if (!regionPolygon) return;
    const regionRevision = regionRevisionRef.current;
    setSelectingRegion(false);
    if (import.meta.env.DEV) {
      setDebugRequestJson(JSON.stringify(profile?.id === "custom"
        ? buildRegionPlanRequest(regionPolygon, planningTiles, profile.id, profile)
        : buildRegionPlanRequest(regionPolygon, planningTiles, profile?.id)));
    }
    await runBusy(
      () => profile?.id === "custom"
        ? planRegion(regionPolygon, planningTiles, profile.id, profile)
        : planRegion(regionPolygon, planningTiles, profile?.id),
      (result: RegionPlanResponse) => {
        if (regionRevision !== regionRevisionRef.current) return;
        setPending({
          tiles: result.tiles,
          candidateCenters: result.candidate_centers,
          inference: result.inference,
          diagnostics: result.diagnostics,
          metrics: result.metrics,
          solution: result.solution,
        });
        setSelectedTileId(null);
        setNotice(
          `${result.tiles.length} new tile${result.tiles.length === 1 ? "" : "s"} selected with ${Math.round(result.metrics.selected_region_coverage * 100)}% estimated area coverage.`,
        );
      },
    );
  }

  function acceptPreview() {
    if (!pending) return;
    const batch = ++proposalBatchRef.current;
    const proposalsToAdd = pending.tiles.map((tile) => ({
      ...tile,
      id: `proposal-${batch}-${tile.id}`,
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
    setProposals([]);
    setPending(null);
    setProposalContext(null);
    setSelectedTileId(null);
    setNotice("Current proposal cleared. Selected polygon and catalogues remain.");
  }

  function activateProfile(nextProfile: TilingProfile) {
    if (profile === nextProfile) {
      setGeometryDraft(null);
      setProfileError(null);
      return;
    }
    regionRevisionRef.current += 1;
    setProfile(nextProfile);
    setExportEpoch(nextProfile.export_epoch_default);
    setGeometryDraft(null);
    setProfileError(null);
    setProposals([]);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setSelectedTileId(null);
    setDebugRequestJson("");
    setNotice(`Active tile profile: ${nextProfile.display_name}. Generate plan again for the selected polygon.`);
    setError(null);
  }

  function createCustomDraft() {
    if (!profile) return;
    setGeometryDraft({
      width: String(profile.tile_width_deg),
      height: String(profile.tile_height_deg),
      overlap: String(profile.effective_overlap_arcsec),
    });
    setProfileError(null);
  }

  async function applyCustomProfile() {
    if (!profile || !geometryDraft) return;
    const width = Number(geometryDraft.width);
    const height = Number(geometryDraft.height);
    const overlap = Number(geometryDraft.overlap);
    if ([geometryDraft.width, geometryDraft.height, geometryDraft.overlap].some((value) => !value.trim())
      || ![width, height, overlap].every(Number.isFinite)) {
      setProfileError("Enter finite numbers for width, height, and overlap.");
      return;
    }
    const candidate: TilingProfile = {
      ...profile,
      id: "custom",
      display_name: "Custom",
      description: "Ad hoc tile geometry for this session",
      tile_width_deg: width,
      tile_height_deg: height,
      effective_overlap_arcsec: overlap,
      algorithm: "RECT_GRID_V1",
    };
    setBusy(true);
    setProfileError(null);
    try {
      activateProfile(await validateCustomProfile(candidate));
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : "Could not validate the custom profile.");
    } finally {
      setBusy(false);
    }
  }

  function beginRegionSelection() {
    regionRevisionRef.current += 1;
    setMapMode("idle");
    setRegionPolygon(null);
    setPending(null);
    setProposalContext(null);
    setActiveMetrics(null);
    setSelectingRegion(true);
    setSelectionRequest((previous) => previous + 1);
    setNotice("Click successive sky points, then double-click to close the polygon.");
  }

  function clearRegionSelection() {
    regionRevisionRef.current += 1;
    setRegionPolygon(null);
    setSelectingRegion(false);
    setProposalContext(null);
    setActiveMetrics(null);
    setNotice("Selected polygon cleared; catalogues and proposals remain.");
  }

  function setAllProposals(enabled: boolean) {
    setProposals((previous) => previous.map((tile) => ({ ...tile, enabled })));
    setNotice(enabled ? "All proposed tiles restored." : "All proposed tiles disabled; none will be exported.");
  }

  async function exportFile() {
    if (!profile || !enabledProposals.length) return;
    await runBusy(
      () => profile.id === "custom"
        ? downloadCatalogue(enabledProposals, profile.id, exportEpoch, coordinateFormat, profile)
        : downloadCatalogue(enabledProposals, profile.id, exportEpoch, coordinateFormat),
      () => setNotice("new_tiles.csv downloaded."),
    );
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand-block">
          <h1 className="brand-title"><img className="brand-logo" src={jasytataLogo} alt="Jasytata" /></h1>
          <span className="brand-profile" title={profile?.display_name ?? "Astronomical tile planning"}>
            {profile?.display_name ?? "Astronomical tile planning"}
          </span>
        </div>
        <div className="topbar-state">
          <span className={`status-dot ${profile ? "is-ready" : ""}`} />
          <span>{datasets.length === 1 ? datasets[0].filename : datasets.length ? `${datasets.length} catalogues loaded` : profile ? "Profile only · no original tiles" : "Loading tile profile"}</span>
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

      {(error || notice) && (
        <div className={`message-bar ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}>
          <span>{error ?? notice}</span>
          <button aria-label="Dismiss message" onClick={() => { setError(null); setNotice(null); }}>×</button>
        </div>
      )}

      <section className="workspace">
        <aside className="control-panel panel-scroll" aria-label="Catalogue and planning controls">
          <section className="panel-section catalog-section">
            <SectionHeading title="Existing catalogue" trailing={hasCatalogue ? "LOADED" : "OPTIONAL"} />
            <div className="catalogue-summary">
              <span className="summary-number">{originalTiles.length.toLocaleString()}</span>
              <span className="summary-label">original tile centers</span>
            </div>
            <p className="panel-copy">{hasCatalogue
              ? "Original catalogue rows stay unchanged. New tiles remain separate until accepted."
              : "Load an existing catalogue to extend a project, or start a new plan from the active tile profile."}</p>
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

          <section className="panel-section tile-profile-section" aria-label="Tile profile">
            <SectionHeading title="Tile profile" trailing={profile?.id === "custom" ? "CUSTOM" : "VALIDATED PRESET"} />
            <label className="field-label" htmlFor="tile-profile-select">Profile</label>
            <select id="tile-profile-select" className="profile-select" value={profile?.id ?? ""} disabled={!profile || busy}
              onChange={(event) => {
                if (event.target.value === defaultProfile?.id && defaultProfile) activateProfile(defaultProfile);
              }}>
              {!profile && <option value="">Loading profile…</option>}
              {defaultProfile && <option value={defaultProfile.id}>{defaultProfile.display_name}</option>}
              {profile?.id === "custom" && <option value="custom">Custom</option>}
            </select>
            {geometryDraft ? <>
              <p className="profile-draft-label">Custom draft · active: {profile?.display_name}</p>
              <div className="profile-geometry">
                <label>Width <span><input aria-label="Tile width" inputMode="decimal" value={geometryDraft.width} onChange={(event) => { setGeometryDraft({ ...geometryDraft, width: event.target.value }); setProfileError(null); }} /> deg</span></label>
                <label>Height <span><input aria-label="Tile height" inputMode="decimal" value={geometryDraft.height} onChange={(event) => { setGeometryDraft({ ...geometryDraft, height: event.target.value }); setProfileError(null); }} /> deg</span></label>
                <label>Overlap <span><input aria-label="Tile overlap" inputMode="decimal" value={geometryDraft.overlap} onChange={(event) => { setGeometryDraft({ ...geometryDraft, overlap: event.target.value }); setProfileError(null); }} /> arcsec</span></label>
              </div>
              {profileError && <p className="profile-validation-error" role="alert">{profileError}</p>}
              <div className="profile-actions">
                <button className="button button-primary" onClick={() => void applyCustomProfile()} disabled={busy}>Apply</button>
                <button className="button button-outline" onClick={() => defaultProfile && activateProfile(defaultProfile)} disabled={!defaultProfile || busy}>Reset to S-PLUS</button>
              </div>
            </> : <>
              <div className="profile-readout">
                <span>Width <strong>{profile?.tile_width_deg.toFixed(3) ?? "…"} deg</strong></span>
                <span>Height <strong>{profile?.tile_height_deg.toFixed(3) ?? "…"} deg</strong></span>
                <span>Overlap <strong>{profile?.effective_overlap_arcsec ?? "…"} arcsec</strong></span>
              </div>
              <button className="button button-outline button-full" onClick={createCustomDraft} disabled={!profile || busy}>{profile?.id === "custom" ? "Edit custom profile" : "Create custom profile"}</button>
              {profile?.id === "custom" && <button className="text-button profile-reset" onClick={() => defaultProfile && activateProfile(defaultProfile)} disabled={!defaultProfile || busy}>Reset to S-PLUS</button>}
            </>}
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
                disabled={busy}
              >
                <span className="mode-icon"><Icon name="crosshair" /></span>
                <span><strong>Single tile</strong><small>Click a sky position</small></span>
                <Icon name="chevron" />
              </button>
              <button className="mode-button" onClick={() => { setSelectingRegion(false); setMapMode("idle"); setParsedCenters(null); importRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" }); }} disabled={busy}>
                <span className="mode-icon"><Icon name="list" /></span>
                <span><strong>Import centers</strong><small>Paste RA / DEC pairs</small></span>
                <Icon name="chevron" />
              </button>
              <button
                className="mode-button"
                onClick={beginRegionSelection}
                disabled={busy}
              >
                <span className="mode-icon"><Icon name="region" /></span>
                <span><strong>Select area</strong><small>Click polygon vertices on the sky</small></span>
                <Icon name="chevron" />
              </button>
            </div>
          </section>

          <section className="panel-section planning-section">
            <SectionHeading title="Region plan" trailing={regionPolygon ? "AREA SET" : undefined} />
            {regionPolygon ? (
              <div className="region-summary">
                <div className="coordinate-row"><span>Selected polygon</span><strong>{regionPolygon.vertices.length} vertices · finalized</strong></div>
                <div className="region-actions">
                  <button className="button button-outline" onClick={beginRegionSelection} disabled={busy}>Redraw polygon</button>
                  <button className="button button-quiet" onClick={clearRegionSelection}>Clear selection</button>
                </div>
                {import.meta.env.DEV && <details className="development-plan-input">
                  <summary>Development: plan input</summary>
                  <pre>{JSON.stringify(regionPolygon.vertices, null, 2)}</pre>
                  <button className="text-button" disabled={!debugRequestJson} onClick={() => {
                    void navigator.clipboard.writeText(debugRequestJson)
                      .then(() => setNotice("Last plan request JSON copied."))
                      .catch(() => setError("Could not copy the plan request JSON."));
                  }}>Copy last plan request JSON</button>
                </details>}
              </div>
            ) : (
              <p className="panel-copy">Select a sky polygon to plan coverage with the active tile profile and any existing tiles.</p>
            )}
            <button className="button button-plan" onClick={() => void handlePlanRegion()} disabled={!regionPolygon || !profile || busy}>
              {busy ? <span className="spinner" /> : <Icon name="spark" />}Generate plan
            </button>
            <p className="fine-print">Active profile: {profile?.display_name ?? "loading…"}</p>
            <p className="fine-print">Tiles can extend beyond the selected area when that preserves the local grid.</p>
          </section>

          <section ref={importRef} className="panel-section import-section">
            <SectionHeading title="Paste centers" />
            <label className="visually-hidden" htmlFor="centers-text">RA and DEC pairs</label>
            <textarea
              id="centers-text"
              value={importText}
              onChange={(event) => { setImportText(event.target.value); setParsedCenters(null); }}
              placeholder={"RA, DEC\n10:03:05, -23:54:31\n150.5, -24.25"}
              rows={4}
              disabled={busy}
            />
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
              <label className="dataset-layer" key={dataset.id}>
                <input type="checkbox" aria-label={`Show ${dataset.filename}`} checked={dataset.visible} onChange={(event) => {
                  setDatasets((previous) => previous.map((item) => item.id === dataset.id ? { ...item, visible: event.target.checked } : item));
                  setSelectedTileId(null);
                }} />
                <span className="layer-swatch" style={{ "--swatch": dataset.color } as CSSProperties} />
                <span title={dataset.filename}>{dataset.filename}</span>
                <strong>{dataset.tiles.length.toLocaleString()}</strong>
              </label>
            ))}
            <div className="layer-group-heading">Planning</div>
            <PlanningLayer label="Proposed tiles" color="var(--orange)" checked={planningLayers.proposals}
              count={proposals.length + (pending?.tiles.length ?? 0)} onChange={(checked) => {
                setPlanningLayers((previous) => ({ ...previous, proposals: checked }));
                setSelectedTileId(null);
              }} />
            <PlanningLayer label="Selected region" color="var(--yellow)" checked={planningLayers.region}
              onChange={(checked) => setPlanningLayers((previous) => ({ ...previous, region: checked }))} />
            <PlanningLayer label="Inference anchors" color="var(--violet)" checked={planningLayers.anchors}
              count={activeContext?.inference?.anchor_tile_ids.length ?? 0}
              onChange={(checked) => setPlanningLayers((previous) => ({ ...previous, anchors: checked }))} />
            <PlanningLayer label="Candidate lattice" color="var(--green)" checked={planningLayers.lattice}
              count={activeContext?.candidateCenters.length ?? 0}
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
            planningLayers={planningLayers}
            anchorTileIds={activeContext?.inference?.anchor_tile_ids ?? EMPTY_IDS}
            candidateCenters={activeContext?.candidateCenters ?? EMPTY_CENTERS}
            onSkyClick={(ra, dec) => void stageCenters([{ ra_deg: ra, dec_deg: dec, label: "Manual sky click" }], "manual")}
            onTileSelect={(tile) => setSelectedTileId(tile.id)}
            onRegionSelect={(polygon) => {
              regionRevisionRef.current += 1;
              setSelectingRegion(false);
              setRegionPolygon(polygon);
              setPending(null);
              setProposalContext(null);
              setActiveMetrics(null);
              setNotice("Sky polygon finalized. Generate a plan when ready.");
            }}
            onCancelRegion={() => { setSelectingRegion(false); setNotice("Polygon drawing cancelled."); }}
            onError={setError}
          />
          <div className="map-footer">
            <span><i className="legend-line legend-cyan" />Tile footprints appear when zoomed in</span>
            <span>{profile ? `Approximate ${profile.tile_width_deg}° × ${profile.tile_height_deg}° coverage` : "Loading geometry…"}</span>
          </div>
        </section>

        <aside className="inspector-panel panel-scroll" aria-label="Tile and proposal inspector">
          <section className="panel-section inspector-section">
            <SectionHeading title={selectedTile ? "Tile details" : "Inspector"} trailing={selectedTile?.source === "original" ? "ORIGINAL" : selectedTile ? "PROPOSED" : undefined} />
            {selectedTile ? (
              <TileDetails
                tile={selectedTile}
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
              <div className="solution-stamp">
                <span className={pending.solution === "extended_existing_grid" ? "stamp-dot is-extended" : "stamp-dot"} />
                <strong>{solutionLabel(pending.solution)}</strong>
              </div>
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
                {pending.tiles.length ? pending.tiles.slice(0, 16).map((tile, index) => (
                  <div className="proposal-row" key={`${tile.id}-${index}`}>
                    <span className="proposal-index">{String(index + 1).padStart(2, "0")}</span>
                    <span><strong>{tile.ra_deg.toFixed(4)}°</strong><small>{tile.dec_deg.toFixed(4)}°</small></span>
                  </div>
                )) : <p className="panel-copy">Existing coverage already satisfies this plan.</p>}
                {pending.tiles.length > 16 && <span className="more-row">+{pending.tiles.length - 16} more preview centers</span>}
              </div>
              <div className="proposal-actions">
                <button className="button button-primary button-full" onClick={acceptPreview} disabled={!pending.tiles.length}><Icon name="check" /> Accept proposal</button>
                <button className="button button-quiet button-full" onClick={cancelPreview}>Cancel preview</button>
              </div>
            </section>
          )}

          <section className="panel-section accepted-section">
            <div className="accepted-heading">
              <SectionHeading title="Generated proposal" trailing={String(proposals.length)} />
              <div className="accepted-actions">
                <button className="text-button" onClick={() => setAllProposals(true)} disabled={!proposals.length}>Restore all</button>
                <button className="text-button" onClick={() => setAllProposals(false)} disabled={!proposals.length}>Disable all</button>
                <button className="text-button" onClick={clearProposals} disabled={!proposals.length && !pending}>Clear proposal</button>
              </div>
            </div>
            {proposals.length > 0 && <p className="panel-copy">{proposals.filter((tile) => tile.enabled !== false).length} enabled · {proposals.filter((tile) => tile.enabled === false).length} disabled</p>}
            {activeMetrics && <MetricsPanel metrics={activeMetrics} inference={proposalContext?.inference ?? null} candidateCount={proposalContext?.candidateCenters.length ?? 0} />}
            {proposals.length ? (
              <div className="accepted-list">
                {[...proposals].reverse().map((tile, index) => (
                  <button className={`accepted-row ${tile.id === selectedTileId ? "is-selected" : ""} ${tile.enabled === false ? "is-disabled" : ""}`} key={tile.id} onClick={() => setSelectedTileId(tile.id)}>
                    <span className="accepted-swatch" />
                    <span><strong>{tile.name || `Proposed tile ${proposals.length - index}`}</strong><small>{tile.ra_deg.toFixed(4)}°, {tile.dec_deg.toFixed(4)}°</small></span>
                    <span className="accepted-type">{tile.enabled === false ? "DISABLED" : shortMethod(tile.generation_method)}</span>
                  </button>
                ))}
              </div>
            ) : <p className="panel-copy">Accept a proposal to edit and export its tile centers.</p>}
          </section>

          <section className="panel-section export-section">
            <SectionHeading title="Export new tiles" />
            <p className="panel-copy">{proposals.length} generated · {enabledProposals.length} enabled · {proposals.length - enabledProposals.length} disabled</p>
            <div className="export-fields">
              <label className="field-label">Coordinates
                <select aria-label="Export coordinates" value={coordinateFormat} onChange={(event) => setCoordinateFormat(event.target.value as CoordinateFormat)}>
                  <option value="decimal">Decimal degrees</option>
                  <option value="sexagesimal">Sexagesimal</option>
                </select>
              </label>
              <label className="field-label">Epoch
                <select aria-label="Export epoch" value={exportEpoch} onChange={(event) => setExportEpoch(event.target.value)}>
                  {profile?.export_epoch_options.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
            </div>
            <button className="button button-download button-full" onClick={() => void exportFile()} disabled={!enabledProposals.length || !profile || busy}><Icon name="download" /> Download new_tiles.csv</button>
            <p className="fine-print">{profile?.display_name ?? "Loading profile"} · ICRS RA/DEC · EPOCH {exportEpoch || "…"}. Export contains enabled proposals only.</p>
          </section>
        </aside>
      </section>
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

function TileDetails({ tile, onToggle }: { tile: TileRecord; onToggle?: () => void }) {
  const metadata = Object.entries(tile.metadata).filter(([, value]) => value !== "");
  return (
    <div className="tile-detail-content">
      <div className="tile-name-block"><strong>{tile.name || (tile.source === "proposed" ? "Proposed tile" : "Catalogue tile")}</strong><span>{tile.dataset_name ?? (tile.source === "proposed" ? "Proposal" : "Catalogue")}</span></div>
      <div className="detail-grid">
        <DetailField label="RA" value={`${tile.ra_deg.toFixed(6)}°`} />
        <DetailField label="DEC" value={`${tile.dec_deg.toFixed(6)}°`} />
        {tile.ra_column && tile.original_values?.[tile.ra_column] && <DetailField label={`Source ${tile.ra_column}`} value={tile.original_values[tile.ra_column]} />}
        {tile.dec_column && tile.original_values?.[tile.dec_column] && <DetailField label={`Source ${tile.dec_column}`} value={tile.original_values[tile.dec_column]} />}
        {metadata.map(([key, value]) => <DetailField key={key} label={key} value={String(value)} />)}
      </div>
      <div className="decimal-coordinate">ICRS · {formatRa(tile.ra_deg)}, {formatDec(tile.dec_deg)}</div>
      <div className={`source-banner ${tile.source}`}><span className="status-dot" />{tile.source === "original" ? "Original catalogue tile · immutable" : `Proposed · ${tile.enabled === false ? "disabled" : "enabled"} · ${shortMethod(tile.generation_method)}`}</div>
      {onToggle && <button className="button button-outline button-full" onClick={onToggle}>{tile.enabled === false ? "Enable tile" : "Disable tile"}</button>}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return <div className="detail-field"><span>{label}</span><strong>{value}</strong></div>;
}

function MetricsPanel({ metrics, inference, candidateCount }: {
  metrics: PlanMetrics; inference: InferenceDiagnostics | null; candidateCount: number;
}) {
  return (
    <div className="metrics-panel">
      <Metric label="Selected region" value={`${metrics.selected_region_area_deg2.toFixed(2)} deg²`} />
      <Metric label="Existing contributors" value={String(metrics.existing_tiles_contributing)} />
      {inference && <>
        <Metric label="Nearby anchor candidates" value={String(inference.nearby_tile_count)} />
        <Metric label="Inference anchors used" value={String(inference.anchor_tile_ids.length)} />
        <Metric label="Compatible neighbor pairs" value={String(inference.compatible_neighbor_pairs)} />
      </>}
      <Metric label="New tiles" value={String(metrics.new_tiles)} emphasis />
      <Metric label="Already covered" value={`${(metrics.already_covered_fraction * 100).toFixed(1)}%`} />
      <Metric label="Final region coverage" value={`${(metrics.selected_region_coverage * 100).toFixed(1)}%`} emphasis />
      <Metric label="Incremental new coverage" value={`${(metrics.incremental_coverage * 100).toFixed(1)}%`} />
      <Metric label="Remaining uncovered" value={`${(metrics.remaining_uncovered_fraction * 100).toFixed(1)}% · ${metrics.remaining_uncovered_area_deg2.toFixed(2)} deg²`} />
      <Metric label="Redundant proposal coverage" value={`${(metrics.redundant_coverage * 100).toFixed(1)}%`} />
      <Metric label="Outside selected area" value={`${metrics.outside_region_coverage_deg2.toFixed(2)} deg²`} />
      <div className="metric-footnote">Dense sample step {metrics.sample_step_deg.toFixed(2)}° · {candidateCount} candidate lattice centers</div>
    </div>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <div className={`metric-row ${emphasis ? "is-emphasis" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
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
  if (solution === "manual") return "Manual sky placement";
  return "Imported centers";
}

function shortMethod(method: TileRecord["generation_method"]) {
  if (method === "region_extended") return "grid extension";
  if (method === "region_legacy") return "legacy grid";
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
