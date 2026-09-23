import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import AladinMap, { type MapMode } from "./AladinMap";
import { downloadCatalogue, loadDefaultProfile, loadReferenceCatalogue, parseCenters, planRegion, proposeCenters, uploadCatalogue } from "./api";
import { createDataset } from "./datasets";
import type {
  CenterInput,
  CatalogueDataset,
  CatalogueResponse,
  ExportConfig,
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

const EMPTY_EXPORT: ExportConfig = {
  pid: "SPLUS",
  name_prefix: "SPLUS_NEW",
  initial_sequence: 1,
  epoch: "2000",
  status: "-5",
};
const EMPTY_CENTERS: CenterInput[] = [];
const EMPTY_IDS: string[] = [];

/** Render the stateless catalogue, sky planning, proposal, and export workspace. */
export default function App() {
  const [datasets, setDatasets] = useState<CatalogueDataset[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping | null>(null);
  const [profile, setProfile] = useState<TilingProfile | null>(null);
  const [proposals, setProposals] = useState<TileRecord[]>([]);
  const [undoStack, setUndoStack] = useState<TileRecord[][]>([]);
  const [pending, setPending] = useState<ProposalPreview | null>(null);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [regionPolygon, setRegionPolygon] = useState<SkyPolygon | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("idle");
  const [selectionRequest, setSelectionRequest] = useState(0);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [planningMode, setPlanningMode] = useState<"automatic" | "fixed">("automatic");
  const [fixedN, setFixedN] = useState("4");
  const [showLattice, setShowLattice] = useState(true);
  const [importText, setImportText] = useState("");
  const [parsedCenters, setParsedCenters] = useState<CenterInput[] | null>(null);
  const [exportConfig, setExportConfig] = useState(EMPTY_EXPORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLElement>(null);

  const hasCatalogue = datasets.length > 0;
  const originalTiles = useMemo(() => datasets.flatMap((dataset) => dataset.tiles), [datasets]);
  const visibleOriginalTiles = useMemo(() => datasets.filter((dataset) => dataset.visible).flatMap((dataset) => dataset.tiles), [datasets]);
  const legacyExportCompatible = datasets.length === 1 && originalTiles.every((tile) =>
    ["PID", "NAME", "RA", "DEC", "EPOC", "STATUS"].every((key) => !!tile.original_values?.[key]),
  );
  const visibleTiles = useMemo(() => [...visibleOriginalTiles, ...proposals], [visibleOriginalTiles, proposals]);
  const mapTiles = useMemo(
    () => (pending ? [...visibleTiles, ...pending.tiles] : visibleTiles),
    [pending, visibleTiles],
  );
  const selectedTile = useMemo(
    () => mapTiles.find((tile) => tile.id === selectedTileId) ?? null,
    [mapTiles, selectedTileId],
  );
  const anchors = useMemo(() => {
    if (!pending) return [];
    const ids = new Set(pending.anchorTileIds);
    return mapTiles.filter((tile) => ids.has(tile.id));
  }, [pending, mapTiles]);

  useEffect(() => {
    void loadDefaultProfile().then(setProfile).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not load observing profile.");
    });
  }, []);

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
        visibleTiles,
        planningMode,
        planningMode === "fixed" ? normalizedFixedCount(fixedN) : undefined,
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
    const proposalsToAdd = pending.tiles.map((tile) => ({
      ...tile,
      id: `proposal-${crypto.randomUUID()}`,
      source: "proposed" as const,
    }));
    setUndoStack((previous) => [...previous, proposals]);
    setProposals((previous) => [...previous, ...proposalsToAdd]);
    setPending(null);
    setSelectedTileId(null);
    setNotice(`${proposalsToAdd.length} proposed tile${proposalsToAdd.length === 1 ? "" : "s"} accepted.`);
  }

  function cancelPreview() {
    setPending(null);
    setNotice("Proposal preview cancelled.");
  }

  function deleteProposal(id: string) {
    setUndoStack((previous) => [...previous, proposals]);
    setProposals((previous) => previous.filter((tile) => tile.id !== id));
    if (selectedTileId === id) setSelectedTileId(null);
  }

  function clearProposals() {
    if (!proposals.length) return;
    setUndoStack((previous) => [...previous, proposals]);
    setProposals([]);
    setSelectedTileId(null);
    setNotice("Accepted proposals cleared. Undo restores the previous set.");
  }

  function undo() {
    if (!undoStack.length) return;
    setProposals(undoStack[undoStack.length - 1]);
    setUndoStack((previous) => previous.slice(0, -1));
    setNotice("Last proposal edit undone.");
  }

  async function exportFile(kind: "new" | "updated") {
    if (!hasCatalogue) return;
    await runBusy(
      () => downloadCatalogue(kind, originalTiles, proposals, exportConfig),
      () => setNotice(kind === "new" ? "new_tiles.csv downloaded." : "tiles_nc_updated.csv downloaded."),
    );
  }

  function updateExport(field: keyof ExportConfig, value: string) {
    setExportConfig((previous) => ({
      ...previous,
      [field]: field === "initial_sequence" ? Number(value) : value,
    }));
  }

  const planLabel = planningMode === "automatic"
    ? "Generate automatic plan"
    : `Find ${normalizedFixedCount(fixedN)} new tiles`;

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
            <div className="segmented-control" role="group" aria-label="Planning mode">
              <button className={planningMode === "automatic" ? "is-selected" : ""} onClick={() => setPlanningMode("automatic")}>Automatic</button>
              <button className={planningMode === "fixed" ? "is-selected" : ""} onClick={() => setPlanningMode("fixed")}>Fixed N</button>
            </div>
            {planningMode === "fixed" && (
              <label className="field-label fixed-count-field">
                New tiles
                <span className="stepper">
                  <button aria-label="Decrease new tile count" onClick={() => setFixedN((count) => String(Math.max(1, normalizedFixedCount(count) - 1)))} disabled={normalizedFixedCount(fixedN) <= 1}>−</button>
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={fixedN}
                    onChange={(event) => setFixedN(event.target.value)}
                    onBlur={() => setFixedN((count) => String(normalizedFixedCount(count)))}
                    aria-label="Exact number of new tiles"
                  />
                  <button aria-label="Increase new tile count" onClick={() => setFixedN((count) => String(Math.min(500, normalizedFixedCount(count) + 1)))}>+</button>
                </span>
              </label>
            )}
            <button className="button button-plan" onClick={() => void handlePlanRegion()} disabled={!hasCatalogue || !regionPolygon || busy}>
              {busy ? <span className="spinner" /> : <Icon name="spark" />}{planLabel}
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
              label="Proposed tiles"
              value={(proposals.length + (pending?.tiles.length ?? 0)).toString()}
            />
            {selectedTile && <LayerLegend color="var(--yellow)" label="Current selection" />}
            {pending && pending.anchorTileIds.length > 0 && <LayerLegend color="var(--violet)" label="Inference anchors" value={pending.anchorTileIds.length.toString()} />}
            {regionPolygon && <LayerLegend color="var(--yellow)" label="Selected polygon · finalized" />}
            {pending?.candidateCenters.length ? (
              <>
                <LayerLegend color="var(--green)" label="Candidate lattice" value={pending.candidateCenters.length.toString()} />
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
            anchorTileIds={pending?.anchorTileIds ?? EMPTY_IDS}
            candidateCenters={pending?.candidateCenters ?? EMPTY_CENTERS}
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
                onDelete={proposals.some((tile) => tile.id === selectedTile.id)
                  ? () => deleteProposal(selectedTile.id)
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
              <SectionHeading title="Accepted tiles" trailing={String(proposals.length)} />
              <div className="accepted-actions">
                <button className="icon-button" aria-label="Undo last proposal change" onClick={undo} disabled={!undoStack.length} title="Undo"><Icon name="undo" /></button>
                <button className="icon-button danger-icon" aria-label="Clear accepted proposals" onClick={clearProposals} disabled={!proposals.length} title="Clear proposals"><Icon name="trash" /></button>
              </div>
            </div>
            {proposals.length ? (
              <div className="accepted-list">
                {proposals.slice(-8).reverse().map((tile) => (
                  <button className={`accepted-row ${tile.id === selectedTileId ? "is-selected" : ""}`} key={tile.id} onClick={() => setSelectedTileId(tile.id)}>
                    <span className="accepted-swatch" />
                    <span><strong>{tile.name}</strong><small>{tile.ra_deg.toFixed(4)}°, {tile.dec_deg.toFixed(4)}°</small></span>
                    <span className="accepted-type">{shortMethod(tile.generation_method)}</span>
                  </button>
                ))}
                {proposals.length > 8 && <p className="more-row">Showing 8 of {proposals.length} accepted tiles</p>}
              </div>
            ) : <p className="panel-copy">Accept a proposal to add tiles to the export set.</p>}
          </section>

          <section className="panel-section export-section">
            <SectionHeading title="Export catalogue" />
            <div className="export-fields">
              <label className="field-label">PID<input value={exportConfig.pid} onChange={(event) => updateExport("pid", event.target.value)} /></label>
              <label className="field-label">Name prefix<input value={exportConfig.name_prefix} onChange={(event) => updateExport("name_prefix", event.target.value)} /></label>
              <label className="field-label">First sequence<input type="number" min="0" value={exportConfig.initial_sequence} onChange={(event) => updateExport("initial_sequence", event.target.value)} /></label>
              <label className="field-label">EPOC<input value={exportConfig.epoch} onChange={(event) => updateExport("epoch", event.target.value)} /></label>
              <label className="field-label">STATUS<input value={exportConfig.status} onChange={(event) => updateExport("status", event.target.value)} /></label>
            </div>
            <button className="button button-outline button-full" onClick={() => void exportFile("new")} disabled={!hasCatalogue || busy}><Icon name="download" /> Download new_tiles.csv</button>
            <button className="button button-download button-full" onClick={() => void exportFile("updated")} disabled={!hasCatalogue || !legacyExportCompatible || busy}><Icon name="download" /> Download updated catalogue</button>
            <p className="fine-print">Legacy six-column updated export is available for S-PLUS-compatible catalogues. Generic export follows in Run B.</p>
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

function TileDetails({ tile, onDelete }: { tile: TileRecord; onDelete?: () => void }) {
  const metadata = Object.entries(tile.metadata).filter(([, value]) => value !== "");
  return (
    <div className="tile-detail-content">
      <div className="tile-name-block"><strong>{tile.name || tile.id}</strong><span>{tile.dataset_name ?? (tile.source === "proposed" ? "Proposal" : "Catalogue")}</span></div>
      <div className="detail-grid">
        <DetailField label="RA" value={`${tile.ra_deg.toFixed(6)}°`} />
        <DetailField label="DEC" value={`${tile.dec_deg.toFixed(6)}°`} />
        {tile.ra_column && tile.original_values?.[tile.ra_column] && <DetailField label={`Source ${tile.ra_column}`} value={tile.original_values[tile.ra_column]} />}
        {tile.dec_column && tile.original_values?.[tile.dec_column] && <DetailField label={`Source ${tile.dec_column}`} value={tile.original_values[tile.dec_column]} />}
        {metadata.map(([key, value]) => <DetailField key={key} label={key} value={String(value)} />)}
      </div>
      <div className="decimal-coordinate">ICRS · {formatRa(tile.ra_deg)}, {formatDec(tile.dec_deg)}</div>
      <div className={`source-banner ${tile.source}`}><span className="status-dot" />{tile.source === "original" ? "Original catalogue tile · immutable" : `Proposed · ${shortMethod(tile.generation_method)}`}</div>
      {onDelete && <button className="button button-danger button-full" onClick={onDelete}><Icon name="trash" /> Delete proposed tile</button>}
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
      <Metric label="Final region coverage" value={`${(metrics.selected_region_coverage * 100).toFixed(1)}%`} emphasis />
      <Metric label="Incremental new coverage" value={`${(metrics.incremental_coverage * 100).toFixed(1)}%`} />
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

function normalizedFixedCount(value: string) {
  return Math.min(500, Math.max(1, Math.trunc(Number(value) || 1)));
}
