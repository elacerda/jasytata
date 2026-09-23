import { useEffect, useRef, useState } from "react";
import A from "aladin-lite";
import type {
  AladinLiteCatalogue,
  AladinLiteInstance,
  AladinLiteOverlay,
  AladinLiteSource,
} from "aladin-lite";
import type { CatalogueDataset, CenterInput, RegionBounds, TileRecord, TilingProfile } from "./types";
import { regionBoundsFromCorners, tileFootprint } from "./sky";

/** Map click behavior: normal inspection/pan or single-center placement. */
export type MapMode = "idle" | "add-tile";

interface AladinMapProps {
  tiles: TileRecord[];
  datasets: CatalogueDataset[];
  profile: TilingProfile | null;
  mode: MapMode;
  selectionRequest: number;
  focusRequest: number;
  selectedTileId: string | null;
  selectedBounds: RegionBounds | null;
  anchorTileIds: string[];
  candidateCenters: CenterInput[];
  showLattice: boolean;
  onSkyClick: (ra: number, dec: number) => void;
  onTileSelect: (tile: TileRecord) => void;
  onRegionSelect: (bounds: RegionBounds) => void;
  onError: (message: string) => void;
}

interface SkyPoint {
  ra_deg: number;
  dec_deg: number;
}

interface SkyEvent {
  x?: number;
  y?: number;
  ra?: number;
  dec?: number;
  isDragging?: boolean;
}

/** Render the interactive Aladin Lite sky and its independently styled overlays.
 *
 * @param props - Catalogue layers, selection state, and map interaction callbacks.
 * @returns The Aladin Lite viewport with overlays for footprints and planning diagnostics.
 */
export default function AladinMap(props: AladinMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinLiteInstance | null>(null);
  const propsRef = useRef(props);
  const cataloguesRef = useRef<Map<string, AladinLiteCatalogue>>(new Map());
  const datasetFootprintsRef = useRef<Map<string, AladinLiteOverlay>>(new Map());
  const proposalCatalogueRef = useRef<AladinLiteCatalogue | null>(null);
  const sourceLookupRef = useRef<WeakMap<AladinLiteSource, TileRecord>>(new WeakMap());
  const overlaysRef = useRef<AladinLiteOverlay[]>([]);
  const clickHandlerRef = useRef<(value: unknown) => void>(() => undefined);
  const objectHandlerRef = useRef<(value: unknown) => void>(() => undefined);
  const redrawRef = useRef<() => void>(() => undefined);
  const selectionHandlerRef = useRef<(instance: AladinLiteInstance, request: number) => void>(
    () => undefined,
  );
  const selectionTokenRef = useRef(0);
  const [isSelecting, setIsSelecting] = useState(false);
  propsRef.current = props;

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const initialize = async () => {
      try {
        await A.init;
        if (disposed || !containerRef.current) return;
        const instance = A.aladin(containerRef.current, {
          survey: "P/DSS2/color",
          target: "143 -30",
          fov: 36,
          cooFrame: "equatorial",
          showCooGrid: true,
          showCooGridControl: true,
          showReticle: false,
          showSimbadPointerControl: false,
          showShareControl: false,
          showStatusBar: true,
          showFov: true,
          showLayersControl: true,
          showProjectionControl: true,
          mode: "dark",
        });
        aladinRef.current = instance;
        instance.on("click", clickHandlerRef.current);
        instance.on("objectClicked", objectHandlerRef.current);
        instance.on("objectHovered", objectHandlerRef.current);
        instance.on("positionChanged", redrawRef.current);
        instance.on("zoomChanged", redrawRef.current);
        resizeObserver = new ResizeObserver(() => redrawRef.current());
        resizeObserver.observe(containerRef.current);
        rebuildOverlays(instance, overlaysRef);
        syncCatalogues(instance, propsRef.current.datasets, propsRef.current.tiles, cataloguesRef.current, datasetFootprintsRef.current, proposalCatalogueRef, sourceLookupRef.current);
        redrawRef.current();
        if (propsRef.current.focusRequest > 0) {
          focusOnCatalogue(instance, propsRef.current.tiles);
        }
        if (propsRef.current.selectionRequest > selectionTokenRef.current) {
          selectionHandlerRef.current(instance, propsRef.current.selectionRequest);
        }
      } catch (error) {
        if (!disposed) {
          propsRef.current.onError(
            error instanceof Error ? `Aladin Lite could not start: ${error.message}` : "Aladin Lite could not start.",
          );
        }
      }
    };
    void initialize();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      const instance = aladinRef.current;
      if (instance) {
        instance.off?.("click");
        instance.off?.("objectClicked");
        instance.off?.("objectHovered");
        instance.off?.("positionChanged");
        instance.off?.("zoomChanged");
        instance.remove();
      }
      aladinRef.current = null;
    };
    // Aladin is intentionally created once; data and callbacks flow through refs.
  }, []);

  useEffect(() => {
    const instance = aladinRef.current;
    if (!instance) return;
    syncCatalogues(instance, props.datasets, props.tiles, cataloguesRef.current, datasetFootprintsRef.current, proposalCatalogueRef, sourceLookupRef.current);
    redrawRef.current();
  }, [props.tiles, props.datasets]);

  useEffect(() => {
    redrawRef.current();
  }, [props.selectedTileId, props.selectedBounds, props.anchorTileIds, props.candidateCenters, props.showLattice, props.profile]);

  useEffect(() => {
    const tiles = propsRef.current.tiles;
    if (!props.focusRequest || !tiles.length) return;
    const instance = aladinRef.current;
    if (!instance) return;
    focusOnCatalogue(instance, tiles);
  }, [props.focusRequest]);

  selectionHandlerRef.current = (instance, request) => {
    if (!request || request === selectionTokenRef.current) return;
    selectionTokenRef.current = request;
    setIsSelecting(true);
    void instance
      .select("rect", (selection) => {
        try {
          const coordinates = [
            instance.pix2world(selection.x, selection.y),
            instance.pix2world(selection.x + selection.w, selection.y),
            instance.pix2world(selection.x + selection.w, selection.y + selection.h),
            instance.pix2world(selection.x, selection.y + selection.h),
          ];
          const corners = coordinates.filter(
            (point): point is [number, number] => point !== undefined,
          );
          if (corners.length !== 4) {
            throw new Error("The selected rectangle extends outside the sky projection.");
          }
          propsRef.current.onRegionSelect(regionBoundsFromCorners(corners));
          setIsSelecting(false);
          redrawRef.current();
        } catch (error) {
          setIsSelecting(false);
          propsRef.current.onError(
            error instanceof Error ? error.message : "Could not read the selected sky rectangle.",
          );
        }
      })
      .catch((error: unknown) => {
        setIsSelecting(false);
        propsRef.current.onError(
          error instanceof Error ? error.message : "Could not start map selection.",
        );
      });
  };

  useEffect(() => {
    if (!props.selectionRequest || props.selectionRequest === selectionTokenRef.current) return;
    const instance = aladinRef.current;
    if (!instance) return;
    selectionHandlerRef.current(instance, props.selectionRequest);
  }, [props.selectionRequest]);

  clickHandlerRef.current = (value: unknown) => {
    const instance = aladinRef.current;
    if (!instance) return;
    try {
      const event = (value ?? {}) as SkyEvent;
      if (event.isDragging) return;
      const position =
        typeof event.ra === "number" && typeof event.dec === "number"
          ? ([event.ra, event.dec] as [number, number])
          : instance.pix2world(event.x ?? 0, event.y ?? 0);
      if (!position) throw new Error("The clicked point is outside the sky projection.");
      const [ra, dec] = position;
      if (propsRef.current.mode === "add-tile") {
        propsRef.current.onSkyClick(ra, dec);
        return;
      }
    } catch (error) {
      propsRef.current.onError(error instanceof Error ? error.message : "Could not read the clicked coordinate.");
    }
  };

  objectHandlerRef.current = (value: unknown) => {
    if (propsRef.current.mode === "add-tile") return;
    if (!value || typeof value !== "object") return;
    const tile = sourceLookupRef.current.get(value as AladinLiteSource);
    if (tile) propsRef.current.onTileSelect(tile);
  };

  redrawRef.current = () => {
    const instance = aladinRef.current;
    if (!instance) return;
    const current = propsRef.current;
    const proposals = current.tiles.filter((tile) => tile.source === "proposed");
    const [centerRa, centerDec] = instance.getRaDec();
    const [fovX, fovY] = instance.getFoV();
    const drawFootprints = !!current.profile && fovX <= 36;
    const profile = current.profile;
    const margin = Math.max(profile?.tile_width_deg ?? 0, profile?.tile_height_deg ?? 0);
    const visible = (tile: SkyPoint) =>
      Math.abs(wrappedRaDelta(tile.ra_deg, centerRa) * Math.cos((centerDec * Math.PI) / 180)) <= fovX * 0.65 + margin &&
      Math.abs(tile.dec_deg - centerDec) <= fovY * 0.65 + margin;

    const selected = current.tiles.find((tile) => tile.id === current.selectedTileId) ?? null;
    const anchorSet = new Set(current.anchorTileIds);
    const footprintLayers = overlaysRef.current;
    const proposedLayer = footprintLayers[1];
    const selectedLayer = footprintLayers[2];
    const anchorLayer = footprintLayers[3];
    const candidateLayer = footprintLayers[4];
    for (const layer of footprintLayers) layer.removeAll();
    for (const layer of datasetFootprintsRef.current.values()) layer.removeAll();
    if (drawFootprints && profile) {
      for (const dataset of current.datasets) {
        if (!dataset.visible) continue;
        const layer = datasetFootprintsRef.current.get(dataset.id);
        dataset.tiles.filter(visible).slice(0, 900).forEach((tile) => layer?.add(A.polyline(tileFootprint(tile, profile))));
      }
      proposals.filter(visible).slice(0, 500).forEach((tile) => proposedLayer.add(A.polyline(tileFootprint(tile, profile))));
      current.tiles
        .filter((tile) => anchorSet.has(tile.id) && visible(tile))
        .slice(0, 100)
        .forEach((tile) => anchorLayer.add(A.polyline(tileFootprint(tile, profile))));
      if (selected && visible(selected)) selectedLayer.add(A.polyline(tileFootprint(selected, profile)));
      current.candidateCenters
        .filter((center) => current.showLattice && visible(center))
        .slice(0, 1200)
        .forEach((center) => candidateLayer.add(A.circle(center.ra_deg, center.dec_deg, 0.045)));
    } else if (selected) {
      selectedLayer.add(A.circle(selected.ra_deg, selected.dec_deg, 0.07));
    }
    if (current.selectedBounds) {
      const bounds = current.selectedBounds;
      const southWest = [bounds.ra_start_deg, bounds.dec_min_deg] as [number, number];
      const southEast = [bounds.ra_end_deg, bounds.dec_min_deg] as [number, number];
      const northEast = [bounds.ra_end_deg, bounds.dec_max_deg] as [number, number];
      const northWest = [bounds.ra_start_deg, bounds.dec_max_deg] as [number, number];
      const regionOverlay = A.polyline([southWest, southEast, northEast, northWest, southWest]);
      selectedLayer.add(regionOverlay);
    }
  };

  return (
    <div className={`aladin-frame ${props.mode === "add-tile" ? "is-adding" : ""}`}>
      <div ref={containerRef} className="aladin-view" aria-label="Interactive sky map" />
      {props.mode === "add-tile" && <div className="map-instruction">Click the sky to place a tile center · Esc to cancel</div>}
      {isSelecting && (
        <div className="map-instruction">Drag a rectangle across the sky to select an area</div>
      )}
    </div>
  );
}

/** Synchronize native Aladin catalogues without recreating imported layers.
 *
 * @param instance - Live Aladin viewport.
 * @param datasets - Imported layers with visibility and display colors.
 * @param tiles - Currently visible originals and proposal tiles.
 * @param catalogues - Persistent imported catalogue handles by dataset ID.
 * @param footprints - Persistent detailed-footprint overlays by dataset ID.
 * @param proposalRef - Native proposal catalogue handle.
 * @param lookup - Native source to full application pointing index.
 */
function syncCatalogues(
  instance: AladinLiteInstance,
  datasets: CatalogueDataset[],
  tiles: TileRecord[],
  catalogues: Map<string, AladinLiteCatalogue>,
  footprints: Map<string, AladinLiteOverlay>,
  proposalRef: { current: AladinLiteCatalogue | null },
  lookup: WeakMap<AladinLiteSource, TileRecord>,
) {
  for (const dataset of datasets) {
    let catalogue = catalogues.get(dataset.id);
    if (!catalogue) {
      catalogue = A.catalog({
        name: dataset.filename,
        color: dataset.color,
        sourceSize: 4,
        shape: "circle",
        displayLabel: false,
      });
      catalogue.addSources(dataset.tiles.map((tile) => {
        const source = A.source(tile.ra_deg, tile.dec_deg, {
          ...tile.metadata,
          RA: tile.ra_deg.toFixed(6),
          DEC: tile.dec_deg.toFixed(6),
          Dataset: dataset.filename,
        });
        lookup.set(source, tile);
        return source;
      }));
      instance.addCatalog(catalogue);
      catalogues.set(dataset.id, catalogue);
      const overlay = A.graphicOverlay({ name: `${dataset.filename} footprints`, color: dataset.color, lineWidth: 1 });
      instance.addOverlay(overlay);
      footprints.set(dataset.id, overlay);
    }
    if (dataset.visible) catalogue.show();
    else catalogue.hide();
  }
  const proposals = tiles.filter((tile) => tile.source === "proposed");
  if (proposals.length && !proposalRef.current) {
    proposalRef.current = A.catalog({
      name: "Proposed tiles",
      color: "#ff9e54",
      sourceSize: 7,
      shape: "circle",
      displayLabel: false,
      lineWidth: 1,
    });
    instance.addCatalog(proposalRef.current);
  }
  if (proposalRef.current) {
    proposalRef.current.removeAll();
    proposalRef.current.addSources(
      proposals.map((tile) => {
        const source = A.source(tile.ra_deg, tile.dec_deg, {
          RA: tile.ra_deg.toFixed(6), DEC: tile.dec_deg.toFixed(6), Dataset: "Proposal",
        });
        lookup.set(source, tile);
        return source;
      }),
    );
  }
}

function rebuildOverlays(instance: AladinLiteInstance, refs: { current: AladinLiteOverlay[] }) {
  const definitions = [
    { name: "Imported footprints", color: "#45cad6", lineWidth: 1 },
    { name: "Proposed footprints", color: "#ff9e54", lineWidth: 1.6 },
    { name: "Selection and selected tile", color: "#f3ec65", lineWidth: 2 },
    { name: "Lattice anchors", color: "#d7a9ff", lineWidth: 2 },
    { name: "Candidate lattice", color: "#b0e47a", lineWidth: 1 },
  ];
  refs.current = definitions.map((definition) => {
    const overlay = A.graphicOverlay(definition);
    instance.addOverlay(overlay);
    return overlay;
  });
}

function wrappedRaDelta(ra: number, reference: number) {
  return ((ra - reference + 540) % 360) - 180;
}

function focusOnCatalogue(instance: AladinLiteInstance, tiles: TileRecord[]) {
  if (!tiles.length) return;
  const ras = [...new Set(tiles.map((tile) => tile.ra_deg))].sort((left, right) => left - right);
  let largestGap = -1;
  let gapIndex = 0;
  for (let index = 0; index < ras.length; index += 1) {
    const next = index === ras.length - 1 ? ras[0] + 360 : ras[index + 1];
    const gap = next - ras[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  const raStart = ras[(gapIndex + 1) % ras.length];
  const raEnd = ras[gapIndex];
  const raSpan = (raEnd - raStart + 360) % 360;
  const centerRa = (raStart + raSpan / 2) % 360;
  const decMin = Math.min(...tiles.map((tile) => tile.dec_deg));
  const decMax = Math.max(...tiles.map((tile) => tile.dec_deg));
  const centerDec = (decMin + decMax) / 2;
  const width = raSpan * Math.cos((centerDec * Math.PI) / 180);
  const height = decMax - decMin;
  const fov = Math.max(4, Math.min(180, Math.max(width, height) * 1.2));
  instance.gotoRaDec(centerRa, centerDec);
  instance.setFoV(fov);
}
