import { useEffect, useRef, useState } from "react";
import A from "aladin-lite";
import type {
  AladinLiteCatalogue,
  AladinLiteInstance,
  AladinLiteOverlay,
  AladinLiteSource,
} from "aladin-lite";
import type { CenterInput, RegionBounds, TileRecord } from "./types";
import { regionBoundsFromCorners, tileFootprint } from "./sky";

/** Map click behavior: normal inspection/pan or single-center placement. */
export type MapMode = "idle" | "add-tile";

interface AladinMapProps {
  tiles: TileRecord[];
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
  const cataloguesRef = useRef<AladinLiteCatalogue[]>([]);
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
        instance.on("positionChanged", redrawRef.current);
        instance.on("zoomChanged", redrawRef.current);
        resizeObserver = new ResizeObserver(() => redrawRef.current());
        resizeObserver.observe(containerRef.current);
        rebuildCatalogues(instance, propsRef.current.tiles, cataloguesRef);
        rebuildOverlays(instance, overlaysRef);
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
    rebuildCatalogues(instance, props.tiles, cataloguesRef);
    redrawRef.current();
  }, [props.tiles]);

  useEffect(() => {
    redrawRef.current();
  }, [props.selectedTileId, props.selectedBounds, props.anchorTileIds, props.candidateCenters, props.showLattice]);

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
      const nearest = propsRef.current.tiles
        .map((tile) => {
          const dx = wrappedRaDelta(ra, tile.ra_deg) * Math.cos((tile.dec_deg * Math.PI) / 180);
          const dy = dec - tile.dec_deg;
          return { tile, distance: Math.hypot(dx, dy), inside: Math.abs(dx) <= 0.7 && Math.abs(dy) <= 0.7 };
        })
        .filter((candidate) => candidate.inside)
        .sort((left, right) => left.distance - right.distance)[0];
      if (nearest) propsRef.current.onTileSelect(nearest.tile);
    } catch (error) {
      propsRef.current.onError(error instanceof Error ? error.message : "Could not read the clicked coordinate.");
    }
  };

  objectHandlerRef.current = (value: unknown) => {
    if (propsRef.current.mode === "add-tile") return;
    if (!value || typeof value !== "object") return;
    const source = value as AladinLiteSource;
    const id = source.data?.tileId ?? source.data?.id;
    if (typeof id !== "string") return;
    const tile = propsRef.current.tiles.find((item) => item.id === id);
    if (tile) propsRef.current.onTileSelect(tile);
  };

  redrawRef.current = () => {
    const instance = aladinRef.current;
    if (!instance) return;
    const current = propsRef.current;
    const originals = current.tiles.filter((tile) => tile.source === "original");
    const proposals = current.tiles.filter((tile) => tile.source === "proposed");
    const [centerRa, centerDec] = instance.getRaDec();
    const [fovX, fovY] = instance.getFoV();
    const drawFootprints = fovX <= 36;
    const visible = (tile: SkyPoint) =>
      Math.abs(wrappedRaDelta(tile.ra_deg, centerRa) * Math.cos((centerDec * Math.PI) / 180)) <= fovX * 0.65 + 1.4 &&
      Math.abs(tile.dec_deg - centerDec) <= fovY * 0.65 + 1.4;

    const selected = current.tiles.find((tile) => tile.id === current.selectedTileId) ?? null;
    const anchorSet = new Set(current.anchorTileIds);
    const footprintLayers = overlaysRef.current;
    const originalLayer = footprintLayers[0];
    const proposedLayer = footprintLayers[1];
    const selectedLayer = footprintLayers[2];
    const anchorLayer = footprintLayers[3];
    const candidateLayer = footprintLayers[4];
    for (const layer of footprintLayers) layer.removeAll();
    if (drawFootprints) {
      originals.filter(visible).slice(0, 900).forEach((tile) => originalLayer.add(A.polyline(tileFootprint(tile))));
      proposals.filter(visible).slice(0, 500).forEach((tile) => proposedLayer.add(A.polyline(tileFootprint(tile))));
      current.tiles
        .filter((tile) => anchorSet.has(tile.id) && visible(tile))
        .slice(0, 100)
        .forEach((tile) => anchorLayer.add(A.polyline(tileFootprint(tile))));
      if (selected && visible(selected)) selectedLayer.add(A.polyline(tileFootprint(selected)));
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

function rebuildCatalogues(
  instance: AladinLiteInstance,
  tiles: TileRecord[],
  refs: { current: AladinLiteCatalogue[] },
) {
  refs.current.forEach((catalogue) => {
    if (instance.removeCatalog) instance.removeCatalog(catalogue);
    else catalogue.remove?.();
  });
  refs.current = [];
  const groups: Array<{ source: TileRecord["source"]; name: string; color: string; size: number }> = [
    { source: "original", name: "Original centers", color: "#45cad6", size: 4 },
    { source: "proposed", name: "Accepted proposals", color: "#ff9e54", size: 7 },
  ];
  for (const group of groups) {
    const records = tiles.filter((tile) => tile.source === group.source);
    if (!records.length) continue;
    const catalogue = A.catalog({
      name: group.name,
      color: group.color,
      sourceSize: group.size,
      shape: "circle",
      displayLabel: false,
      lineWidth: 1,
    });
    catalogue.addSources(
      records.map((tile) =>
        A.source(tile.ra_deg, tile.dec_deg, {
          tileId: tile.id,
          name: tile.name,
          tileName: tile.name,
          tileSource: tile.source,
          pid: tile.pid,
          epoch: tile.epoch,
          status: tile.status,
        }),
      ),
    );
    instance.addCatalog(catalogue);
    refs.current.push(catalogue);
  }
}

function rebuildOverlays(instance: AladinLiteInstance, refs: { current: AladinLiteOverlay[] }) {
  const definitions = [
    { name: "Original footprints", color: "#45cad6", lineWidth: 1 },
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
