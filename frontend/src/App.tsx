import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import AladinMap, { type MapMode } from "./AladinMap";
import { downloadCatalogue, loadDefaultProfile, loadReferenceCatalogue, measureCoverage, parseCenters, planRegion, proposeCenters, uploadCatalogue } from "./api";
import { createDataset } from "./datasets";
import type {
  CenterInput,
  CatalogueDataset,
  CatalogueResponse,
  CoordinateFormat,
  PlanMetrics,
  SkyPolygon,
  RegionPlanResponse,
  TileRecord,
  TilingProfile,
} from "./types";

interface ProposalPreview {
  tiles: TileRecord[];
  candidateCenters: CenterInput[];
  anchorTileIds: string[];
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

const EMPTY_CENTERS: CenterInput[] = [];
const EMPTY_IDS: string[] = [];

/** Render the stateless catalogue, sky planning, proposal, and export workspace. */
export default function App() {
  const [datasets, setDatasets] = useState<CatalogueDataset[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping | null>(null);
  const [profile, setProfile] = useState<TilingProfile | null>(null);
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
  const [showLattice, setShowLattice] = useState(true);
  const [importText, setImportText] = useState("");
  const [parsedCenters, setParsedCenters] = useState<CenterInput[] | null>(null);
  const [exportEpoch, setExportEpoch] = useState("");
  const [coordinateFormat, setCoordinateFormat] = useState<CoordinateFormat>("decimal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLElement>(null);
  const proposalBatchRef = useRef(0);

  const hasCatalogue = datasets.length > 0;
  const originalTiles = useMemo(() => datasets.flatMap((dataset) => dataset.tiles), [datasets]);
  const visibleOriginalTiles = useMemo(() => datasets.filter((dataset) => dataset.visible).flatMap((dataset) => dataset.tiles), [datasets]);
  const enabledProposals = useMemo(() => proposals.filter((tile) => tile.enabled !== false), [proposals]);
  const visibleTiles = useMemo(() => [...visibleOriginalTiles, ...proposals], [visibleOriginalTiles, proposals]);
  const planningTiles = useMemo(() => [
    ...visibleOriginalTiles,
    ...proposals.filter((tile) => tile.enabled !== false),
  ], [visibleOriginalTiles, proposals]);
  const mapTiles = useMemo(
    () => (pending ? [...visibleTiles, ...pending.tiles] : visibleTiles),
    [pending, visibleTiles],
  );
  const activeContext = pending ?? proposalContext;
  const selectedTile = useMemo(
    () => mapTiles.find((tile) => tile.id === selectedTileId) ?? null,
    [mapTiles, selectedTileId],
  );
  const anchors = useMemo(() => {
    const context = pending ?? proposalContext;
    if (!context) return [];
    const ids = new Set(context.anchorTileIds);
    return mapTiles.filter((tile) => ids.has(tile.id));
  }, [pending, proposalContext, mapTiles]);

  useEffect(() => {
    void loadDefaultProfile().then((loaded) => {
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
    void measureCoverage(regionPolygon, visibleOriginalTiles, proposals, profile.id)
      .then((metrics) => { if (!cancelled) setActiveMetrics(metrics); })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not update coverage.");
      });
    return () => { cancelled = true; };
  }, [regionPolygon, profile, proposals, visibleOriginalTiles]);

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
    if (!hasCatalogue) {
      setError("Load a catalogue before adding proposed tiles.");
      return false;
    }
    let staged = false;
    await runBusy(
      () => proposeCenters(centers, method),
      (tiles) => {
        staged = true;
        setPending({
          tiles,
          candidateCenters: centers,
          anchorTileIds: [],
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
    if (!regionPolygon || !hasCatalogue) return;
    await runBusy(
      () => planRegion(
        regionPolygon,
        planningTiles,
        profile?.id,
      ),
      (result: RegionPlanResponse) => {
        setPending({
          tiles: result.tiles,
          candidateCenters: result.candidate_centers,
          anchorTileIds: result.anchor_tile_ids,
          diagnostics: result.diagnostics,
          metrics: result.metrics,
          solution: result.solution,
        });
        setShowLattice(true);
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

  function setAllProposals(enabled: boolean) {
    setProposals((previous) => previous.map((tile) => ({ ...tile, enabled })));
    setNotice(enabled ? "All proposed tiles restored." : "All proposed tiles disabled; none will be exported.");
  }

  async function exportFile() {
    if (!profile || !enabledProposals.length) return;
    await runBusy(
      () => downloadCatalogue(enabledProposals, profile.id, exportEpoch, coordinateFormat),
      () => setNotice("new_tiles.csv downloaded."),
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" /><path d="M5 16h22M16 5v22M8 8l16 16M24 8 8 24" /></svg>
          </div>
          <div>
            <h1>Tile Planner</h1>
            <p>{profile?.display_name ?? "Astronomical tile planning"}</p>
          </div>
        </div>
        <div className="topbar-state">
          <span className={`status-dot ${hasCatalogue ? "is-ready" : ""}`} />
          <span>{datasets.length === 1 ? datasets[0].filename : datasets.length ? `${datasets.length} catalogues loaded` : "No catalogue loaded"}</span>
          {hasCatalogue && <span className="topbar-count">{originalTiles.length.toLocaleString()} original tiles</span>}
        </div>
        <div className="topbar-actions">
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
            <SectionHeading title="Catalogue" trailing={hasCatalogue ? "LOADED" : "WAITING"} />
            <div className="catalogue-summary">
              <span className="summary-number">{hasCatalogue ? originalTiles.length.toLocaleString() : "—"}</span>
              <span className="summary-label">original tile centers</span>
            </div>
            <p className="panel-copy">Original catalogue rows stay unchanged. New tiles remain separate until accepted.</p>
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

          <section className="panel-section">
            <SectionHeading title="Add tiles" />
            <div className="mode-stack">
              <button
                className={`mode-button ${mapMode === "add-tile" ? "is-active" : ""}`}
                onClick={() => {
                  if (!hasCatalogue) setError("Load a catalogue before proposing tiles.");
                  else {
                    setMapMode("add-tile");
                    setNotice("Click a position on the sky to preview one new tile.");
                  }
                }}
                disabled={busy || !hasCatalogue}
              >
                <span className="mode-icon"><Icon name="crosshair" /></span>
                <span><strong>Single tile</strong><small>Click a sky position</small></span>
                <Icon name="chevron" />
              </button>
              <button className="mode-button" onClick={() => { setParsedCenters(null); importRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }} disabled={!hasCatalogue || busy}>
                <span className="mode-icon"><Icon name="list" /></span>
                <span><strong>Import centers</strong><small>Paste RA / DEC pairs</small></span>
                <Icon name="chevron" />
              </button>
              <button
                className="mode-button"
                onClick={() => {
                  if (!hasCatalogue) setError("Load a catalogue before selecting a region.");
                  else {
                    setSelectingRegion(true);
                    setSelectionRequest((previous) => previous + 1);
                    setNotice("Click successive sky points, then double-click to close the polygon.");
                  }
                }}
                disabled={!hasCatalogue || busy}
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
                <button className="text-button" onClick={() => setSelectionRequest((previous) => previous + 1)}>Redraw polygon</button>
              </div>
            ) : (
              <p className="panel-copy">Select a sky polygon to plan coverage around existing tiles.</p>
            )}
            <button className="text-button" onClick={() => { setRegionPolygon(null); setSelectingRegion(false); setNotice("Selected polygon cleared; catalogues and proposals remain."); }} disabled={!regionPolygon}>Clear selection</button>
            <button className="button button-plan" onClick={() => void handlePlanRegion()} disabled={!hasCatalogue || !regionPolygon || busy}>
              {busy ? <span className="spinner" /> : <Icon name="spark" />}Generate plan
            </button>
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
              disabled={!hasCatalogue || busy}
            />
            <button className="button button-outline button-full" onClick={() => void handleParseCenters()} disabled={!hasCatalogue || busy || !importText.trim()}>
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
            {datasets.map((dataset) => (
              <label className="dataset-layer" key={dataset.id}>
                <input type="checkbox" aria-label={`Show ${dataset.filename}`} checked={dataset.visible} onChange={(event) => {
                  setDatasets((previous) => previous.map((item) => item.id === dataset.id ? { ...item, visible: event.target.checked } : item));
                  setPending(null);
                  setSelectedTileId(null);
                }} />
                <span className="layer-swatch" style={{ "--swatch": dataset.color } as CSSProperties} />
                <span title={dataset.filename}>{dataset.filename}</span>
                <strong>{dataset.tiles.length.toLocaleString()}</strong>
              </label>
            ))}
            <LayerLegend
              color="var(--orange)"
              label="Enabled proposals"
              value={(proposals.filter((tile) => tile.enabled !== false).length + (pending?.tiles.length ?? 0)).toString()}
            />
            {proposals.some((tile) => tile.enabled === false) && <LayerLegend color="#8c9799" label="Disabled proposals · crosses" value={proposals.filter((tile) => tile.enabled === false).length.toString()} />}
            {selectedTile && <LayerLegend color="var(--yellow)" label="Current selection" />}
            {activeContext?.anchorTileIds.length ? <LayerLegend color="var(--violet)" label="Inference anchors" value={activeContext.anchorTileIds.length.toString()} /> : null}
            {regionPolygon && <LayerLegend color="var(--yellow)" label="Selected polygon · finalized" />}
            {activeContext?.candidateCenters.length ? (
              <>
                <LayerLegend color="var(--green)" label="Candidate lattice" value={activeContext.candidateCenters.length.toString()} />
                <label className="toggle-row">
                  <span>Show inferred grid</span>
                  <input type="checkbox" checked={showLattice} onChange={(event) => setShowLattice(event.target.checked)} />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
              </>
            ) : null}
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
                pending?.solution && pending.solution.startsWith("legacy_bounds") ? <span className="interaction-pill is-fallback">LEGACY BOUNDS FALLBACK</span> :
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
            selectionRequest={selectionRequest}
            focusRequest={focusRequest}
            selectedTileId={selectedTileId}
            selectedPolygon={regionPolygon}
            anchorTileIds={activeContext?.anchorTileIds ?? EMPTY_IDS}
            candidateCenters={activeContext?.candidateCenters ?? EMPTY_CENTERS}
            showLattice={showLattice}
            onSkyClick={(ra, dec) => void stageCenters([{ ra_deg: ra, dec_deg: dec, label: "Manual sky click" }], "manual")}
            onTileSelect={(tile) => setSelectedTileId(tile.id)}
            onRegionSelect={(polygon) => {
              setSelectingRegion(false);
              setRegionPolygon(polygon);
              setPending(null);
              setNotice("Sky polygon finalized. Generate a plan when ready.");
            }}
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
                <p>Click a center marker or footprint to inspect catalogue metadata.</p>
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
              {pending.metrics ? <MetricsPanel metrics={pending.metrics} /> : <div className="preview-count"><strong>{pending.tiles.length}</strong><span>new centers ready</span></div>}
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
                <button className="text-button" onClick={() => setAllProposals(false)} disabled={!proposals.length}>Remove all</button>
                <button className="text-button" onClick={clearProposals} disabled={!proposals.length && !pending}>Clear proposal</button>
              </div>
            </div>
            {proposals.length > 0 && <p className="panel-copy">{proposals.filter((tile) => tile.enabled !== false).length} enabled · {proposals.filter((tile) => tile.enabled === false).length} disabled</p>}
            {activeMetrics && <MetricsPanel metrics={activeMetrics} />}
            {proposals.length ? (
              <div className="accepted-list">
                {proposals.slice(-8).reverse().map((tile, index) => (
                  <button className={`accepted-row ${tile.id === selectedTileId ? "is-selected" : ""} ${tile.enabled === false ? "is-disabled" : ""}`} key={tile.id} onClick={() => setSelectedTileId(tile.id)}>
                    <span className="accepted-swatch" />
                    <span><strong>{tile.name || `Proposed tile ${proposals.length - index}`}</strong><small>{tile.ra_deg.toFixed(4)}°, {tile.dec_deg.toFixed(4)}°</small></span>
                    <span className="accepted-type">{tile.enabled === false ? "DISABLED" : shortMethod(tile.generation_method)}</span>
                  </button>
                ))}
                {proposals.length > 8 && <p className="more-row">Showing 8 of {proposals.length} accepted tiles</p>}
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

function LayerLegend({ color, label, value }: { color: string; label: string; value?: string }) {
  return <div className="layer-row"><span className="layer-swatch" style={{ "--swatch": color } as CSSProperties} /><span>{label}</span>{value && <strong>{value}</strong>}</div>;
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

function MetricsPanel({ metrics }: { metrics: PlanMetrics }) {
  return (
    <div className="metrics-panel">
      <Metric label="Selected region" value={`${metrics.selected_region_area_deg2.toFixed(2)} deg²`} />
      <Metric label="Existing contributors" value={String(metrics.existing_tiles_contributing)} />
      <Metric label="Inference anchors" value={String(metrics.anchor_tiles_used)} />
      <Metric label="New tiles" value={String(metrics.new_tiles)} emphasis />
      <Metric label="Already covered" value={`${(metrics.already_covered_fraction * 100).toFixed(1)}%`} />
      <Metric label="Final region coverage" value={`${(metrics.selected_region_coverage * 100).toFixed(1)}%`} emphasis />
      <Metric label="Incremental new coverage" value={`${(metrics.incremental_coverage * 100).toFixed(1)}%`} />
      <Metric label="Remaining uncovered" value={`${(metrics.remaining_uncovered_fraction * 100).toFixed(1)}% · ${metrics.remaining_uncovered_area_deg2.toFixed(2)} deg²`} />
      <Metric label="Redundant proposal coverage" value={`${(metrics.redundant_coverage * 100).toFixed(1)}%`} />
      <Metric label="Outside selected area" value={`${metrics.outside_region_coverage_deg2.toFixed(2)} deg²`} />
      <div className="metric-footnote">Dense sample step {metrics.sample_step_deg.toFixed(2)}° · {metrics.candidates_available} available centers</div>
    </div>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <div className={`metric-row ${emphasis ? "is-emphasis" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Icon({ name }: { name: "upload" | "sample" | "crosshair" | "list" | "region" | "chevron" | "spark" | "check" | "undo" | "trash" | "download" | "target" }) {
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
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function solutionLabel(solution: string) {
  if (solution === "extended_existing_grid") return "Existing grid extended";
  if (solution === "legacy_bounds_fallback") return "Legacy bounds fallback";
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
