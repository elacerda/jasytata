import type { CenterInput, RegionPlanResponse, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { resolveProfile } from "../profiles";
import { coveredMask, greedyChoose, measureMetrics, sampleRegion, tileMask, type MaskedCenter } from "./coverage";
import { angularSeparationDeg, contributingTileCount, polygonBounds, validatePolygon, type RegionBounds } from "./geometry";
import { legacyGridCenters, rectangularGridCenters, type Center } from "./grid";
import { compareNumbers, median, modulo, radians, roundDecimal, wrappedRaDelta } from "./math";

const INFERENCE_TOLERANCE_DEG = 0.05;
const OCCUPIED_CENTER_TOLERANCE_DEG = 0.12;
const MAX_CANDIDATES = 1200;
const AUTOMATIC_COVERAGE_TARGET = 0.995;

interface Lattice {
  decSpacingDeg: number;
  raSpacingDeg: number;
  rowDecDeg: Map<number, number>;
  rowRaSpacingDeg: Map<number, number>;
  rowRaPhaseFraction: Map<number, number>;
  anchorIds: string[];
  pairCount: number;
}

function raSpacing(profile: TilingProfile): number {
  return profile.tile_width_deg - profile.effective_overlap_arcsec / 3600;
}

function decSpacing(profile: TilingProfile): number {
  return profile.tile_height_deg - profile.effective_overlap_arcsec / 3600;
}

function expandedBounds(bounds: RegionBounds, profile: TilingProfile): RegionBounds {
  const centerDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const raMargin = profile.tile_width_deg / (2 * Math.max(Math.cos(radians(centerDec)), 0.01));
  if (bounds.ra_span_deg + 2 * raMargin > 180) throw new Error("Polygon plus tile margin spans more than 180 degrees in RA");
  const start = modulo(bounds.ra_start_deg - raMargin, 360);
  const end = modulo(bounds.ra_end_deg + raMargin, 360);
  return {
    ra_start_deg: start, ra_end_deg: end, ra_span_deg: modulo(end - start, 360),
    dec_min_deg: Math.max(-89.999, bounds.dec_min_deg - profile.tile_height_deg / 2),
    dec_max_deg: Math.min(89.999, bounds.dec_max_deg + profile.tile_height_deg / 2),
  };
}

/** Filter actual enabled pointings to the Python planner's physical search margin.
 * @param tiles - Original and accepted ICRS centers in decimal degrees.
 * @param bounds - Selected polygon bounds in degrees.
 * @param centerRa - Wrapped selected-region RA midpoint in degrees.
 * @param centerDec - Selected-region declination midpoint in degrees.
 * @param profile - Physical tile dimensions in degrees.
 * @returns Nearby input pointings in original order.
 */
export function tilesNearRegion(tiles: readonly TileRecord[], bounds: RegionBounds, centerRa: number, centerDec: number, profile: TilingProfile): TileRecord[] {
  const halfHeight = (bounds.dec_max_deg - bounds.dec_min_deg) / 2;
  return tiles.filter((tile) => {
    const raMargin = 3 * profile.tile_width_deg / Math.max(Math.cos(radians(tile.dec_deg)), 0.01);
    return Math.abs(wrappedRaDelta(tile.ra_deg, centerRa)) <= bounds.ra_span_deg / 2 + raMargin &&
      Math.abs(tile.dec_deg - centerDec) <= halfHeight + 3 * profile.tile_height_deg;
  });
}

function groupAnchorRows(tiles: readonly TileRecord[]): TileRecord[][] {
  const rows: TileRecord[][] = [];
  const sorted = [...tiles].sort((a, b) => a.dec_deg - b.dec_deg || a.ra_deg - b.ra_deg || a.id.localeCompare(b.id));
  for (const tile of sorted) {
    const rowCenter = rows.length ? median(rows[rows.length - 1].map((item) => item.dec_deg)) : null;
    if (rowCenter === null || tile.dec_deg - rowCenter > INFERENCE_TOLERANCE_DEG) rows.push([tile]);
    else rows[rows.length - 1].push(tile);
  }
  return rows;
}

function circularPhase(values: readonly number[]): number {
  let real = 0; let imaginary = 0;
  for (const value of values) { const angle = value * 2 * Math.PI; real += Math.cos(angle); imaginary += Math.sin(angle); }
  return modulo(Math.atan2(imaginary / values.length, real / values.length), 2 * Math.PI) / (2 * Math.PI);
}

function modularDistance(value: number, phase: number): number {
  return Math.abs(modulo(value - phase + 0.5, 1) - 0.5);
}

function inferLatticeGroup(tiles: readonly TileRecord[], centerRa: number, _centerDec: number, profile: TilingProfile): Lattice | null {
  if (tiles.length < 3) return null;
  const points = [...tiles].sort((a, b) => a.dec_deg - b.dec_deg ||
    wrappedRaDelta(a.ra_deg, centerRa) - wrappedRaDelta(b.ra_deg, centerRa) || a.id.localeCompare(b.id));
  const horizontalSteps: number[] = [];
  const verticalSteps: number[] = [];
  const pairKeys = new Set<string>();
  const pairIds: Array<[string, string]> = [];
  const profileDecSpacing = decSpacing(profile);
  const profileRaSpacing = raSpacing(profile);
  for (let first = 0; first < points.length; first += 1) {
    const left = points[first];
    for (let second = first + 1; second < points.length; second += 1) {
      const right = points[second];
      const dy = Math.abs(right.dec_deg - left.dec_deg);
      if (dy > profileDecSpacing + INFERENCE_TOLERANCE_DEG) break;
      const meanDec = (left.dec_deg + right.dec_deg) / 2;
      const dx = Math.abs(wrappedRaDelta(right.ra_deg, left.ra_deg)) * Math.cos(radians(meanDec));
      if (dx > 1.6 * profileRaSpacing) continue;
      let compatible = false;
      if (dy <= INFERENCE_TOLERANCE_DEG && Math.abs(dx - profileRaSpacing) <= INFERENCE_TOLERANCE_DEG) {
        horizontalSteps.push(dx); compatible = true;
      } else if (Math.abs(dy - profileDecSpacing) <= INFERENCE_TOLERANCE_DEG && dx <= 0.75 * profileRaSpacing) {
        verticalSteps.push(dy); compatible = true;
      }
      if (compatible) {
        const ids = [left.id, right.id].sort() as [string, string];
        const key = JSON.stringify(ids);
        if (!pairKeys.has(key)) { pairKeys.add(key); pairIds.push(ids); }
      }
    }
  }
  const anchorIds = [...new Set(pairIds.flat())].sort();
  if (pairIds.length < 2 || anchorIds.length < 3 || horizontalSteps.length < 2) return null;
  const inferredDecSpacing = verticalSteps.length ? median(verticalSteps) : profileDecSpacing;
  const inferredRaSpacing = median(horizontalSteps);
  if (Math.abs(inferredDecSpacing - profileDecSpacing) > INFERENCE_TOLERANCE_DEG ||
    Math.abs(inferredRaSpacing - profileRaSpacing) > INFERENCE_TOLERANCE_DEG) return null;
  const anchorSet = new Set(anchorIds);
  const rowGroups = groupAnchorRows(tiles.filter((tile) => anchorSet.has(tile.id)));
  const rowDecDeg = new Map<number, number>();
  const rowIndices = new Map<number, TileRecord[]>();
  let rowIndex = 0;
  let previousDec: number | null = null;
  for (const rowTiles of rowGroups) {
    const rowDec = median(rowTiles.map((tile) => tile.dec_deg));
    if (previousDec !== null) rowIndex += Math.max(1, roundDecimal((rowDec - previousDec) / inferredDecSpacing, 0));
    rowDecDeg.set(rowIndex, rowDec); rowIndices.set(rowIndex, rowTiles); previousDec = rowDec;
  }
  const rowPhases = new Map<number, number>();
  const rowRaSpacings = new Map<number, number>();
  const phaseResiduals: number[] = [];
  for (const [row, rowTiles] of rowIndices) {
    const ordered = [...rowTiles].sort((a, b) => a.ra_deg - b.ra_deg);
    const localSteps: number[] = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const left = ordered[index]; const right = ordered[index + 1];
      localSteps.push(Math.abs(wrappedRaDelta(right.ra_deg, left.ra_deg)) * Math.cos(radians((left.dec_deg + right.dec_deg) / 2)));
    }
    const compatibleSteps = localSteps.filter((step) => Math.abs(step - profileRaSpacing) <= INFERENCE_TOLERANCE_DEG);
    const rowSpacing = compatibleSteps.length ? median(compatibleSteps) : inferredRaSpacing;
    rowRaSpacings.set(row, rowSpacing);
    const fractions: number[] = [];
    for (const tile of rowTiles) {
      const stepRa = rowSpacing / Math.max(Math.cos(radians(tile.dec_deg)), 1e-6);
      const unwrappedRa = tile.ra_deg + 360 * roundDecimal((centerRa - tile.ra_deg) / 360, 0);
      fractions.push(modulo(unwrappedRa - centerRa, stepRa) / stepRa);
    }
    const rowPhase = circularPhase(fractions);
    rowPhases.set(row, rowPhase);
    phaseResiduals.push(...fractions.map((fraction) => modularDistance(fraction, rowPhase) * rowSpacing));
  }
  if (median(phaseResiduals) > INFERENCE_TOLERANCE_DEG || Math.max(...phaseResiduals) > 2 * INFERENCE_TOLERANCE_DEG) return null;
  return {
    decSpacingDeg: inferredDecSpacing, raSpacingDeg: inferredRaSpacing,
    rowDecDeg, rowRaSpacingDeg: rowRaSpacings, rowRaPhaseFraction: rowPhases,
    anchorIds, pairCount: pairIds.length,
  };
}

function compareLattices(left: Lattice, right: Lattice, profile: TilingProfile): number {
  const leftScore = [left.pairCount, left.anchorIds.length,
    -Math.abs(left.decSpacingDeg - decSpacing(profile)) - Math.abs(left.raSpacingDeg - raSpacing(profile))];
  const rightScore = [right.pairCount, right.anchorIds.length,
    -Math.abs(right.decSpacingDeg - decSpacing(profile)) - Math.abs(right.raSpacingDeg - raSpacing(profile))];
  const first = compareNumbers(leftScore, rightScore);
  if (first) return first;
  for (let index = 0; index < Math.min(left.anchorIds.length, right.anchorIds.length); index += 1) {
    if (left.anchorIds[index] !== right.anchorIds[index]) return left.anchorIds[index] < right.anchorIds[index] ? -1 : 1;
  }
  return left.anchorIds.length - right.anchorIds.length;
}

function inferLattice(tiles: readonly TileRecord[], centerRa: number, centerDec: number, profile: TilingProfile): Lattice | null {
  const groups = new Map<string, TileRecord[]>();
  for (const tile of tiles) {
    const group = tile.source === "original"
      ? `original:${tile.group_id || tile.dataset_id || tile.id}`
      : `proposed:${tile.generation_method}`;
    const current = groups.get(group) ?? [];
    current.push(tile); groups.set(group, current);
  }
  if (groups.size > 1) groups.set("all-visible-pointings", [...tiles]);
  let best: Lattice | null = null;
  for (const groupTiles of groups.values()) {
    const lattice = inferLatticeGroup(groupTiles, centerRa, centerDec, profile);
    if (lattice && (!best || compareLattices(lattice, best, profile) > 0)) best = lattice;
  }
  return best;
}

function rowDecAt(row: number, lattice: Lattice): number {
  const direct = lattice.rowDecDeg.get(row);
  if (direct !== undefined) return direct;
  const known = [...lattice.rowDecDeg.keys()].sort((a, b) => a - b);
  const lower = known.filter((item) => item < row);
  const upper = known.filter((item) => item > row);
  if (lower.length && upper.length) {
    const left = lower[lower.length - 1]; const right = upper[0];
    const fraction = (row - left) / (right - left);
    return lattice.rowDecDeg.get(left)! + fraction * (lattice.rowDecDeg.get(right)! - lattice.rowDecDeg.get(left)!);
  }
  if (lower.length) {
    const left = known.length >= 2 ? known[known.length - 2] : known[known.length - 1];
    const right = known.length >= 2 ? known[known.length - 1] : null;
    const spacing = right === null ? lattice.decSpacingDeg :
      (lattice.rowDecDeg.get(right)! - lattice.rowDecDeg.get(left)!) / (right - left);
    return lattice.rowDecDeg.get(left)! + (row - left) * spacing;
  }
  const right = known[0];
  const spacing = known.length >= 2 ?
    (lattice.rowDecDeg.get(known[1])! - lattice.rowDecDeg.get(right)!) / (known[1] - right) : lattice.decSpacingDeg;
  return lattice.rowDecDeg.get(right)! + (row - right) * spacing;
}

function interpolatePhase(phases: Map<number, number>, row: number, known: number[]): number {
  const direct = phases.get(row);
  if (direct !== undefined) return direct;
  const lower = known.filter((item) => item < row);
  const upper = known.filter((item) => item > row);
  let left: number; let right: number;
  if (lower.length && upper.length) { left = lower[lower.length - 1]; right = upper[0]; }
  else if (known.length >= 2 && !lower.length) { [left, right] = known.slice(0, 2); }
  else if (known.length >= 2) { [left, right] = known.slice(-2); }
  else return phases.get(known[0])!;
  const fraction = (row - left) / (right - left);
  const delta = modulo(phases.get(right)! - phases.get(left)! + 0.5, 1) - 0.5;
  return modulo(phases.get(left)! + fraction * delta, 1);
}

function interpolateSpacing(spacings: Map<number, number>, row: number, fallback: number): number {
  const direct = spacings.get(row);
  if (direct !== undefined) return direct;
  const known = [...spacings.keys()].sort((a, b) => a - b);
  if (!known.length) return fallback;
  const lower = known.filter((item) => item < row);
  const upper = known.filter((item) => item > row);
  if (lower.length && upper.length) {
    const left = lower[lower.length - 1]; const right = upper[0];
    return spacings.get(left)! + (row - left) * (spacings.get(right)! - spacings.get(left)!) / (right - left);
  }
  return spacings.get(!lower.length ? known[0] : known[known.length - 1])!;
}

function latticeCandidates(bounds: RegionBounds, lattice: Lattice, profile: TilingProfile): Center[] {
  const decMin = bounds.dec_min_deg - profile.tile_height_deg / 2;
  const decMax = bounds.dec_max_deg + profile.tile_height_deg / 2;
  const knownRows = [...lattice.rowDecDeg.keys()].sort((a, b) => a - b);
  let firstRow = knownRows[0];
  while (rowDecAt(firstRow - 1, lattice) >= decMin) firstRow -= 1;
  while (rowDecAt(firstRow, lattice) < decMin) firstRow += 1;
  let lastRow = firstRow;
  while (rowDecAt(lastRow + 1, lattice) <= decMax) lastRow += 1;
  const raStart = bounds.ra_start_deg;
  const raEnd = raStart + bounds.ra_span_deg;
  const centerRa = raStart + bounds.ra_span_deg / 2;
  const knownPhaseRows = [...lattice.rowRaPhaseFraction.keys()].sort((a, b) => a - b);
  const candidates: Center[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const dec = rowDecAt(row, lattice);
    if (dec <= -90 || dec >= 90) continue;
    const phaseFraction = interpolatePhase(lattice.rowRaPhaseFraction, row, knownPhaseRows);
    const rowSpacing = interpolateSpacing(lattice.rowRaSpacingDeg, row, lattice.raSpacingDeg);
    const stepRa = rowSpacing / Math.cos(radians(dec));
    const phaseRa = centerRa + phaseFraction * stepRa;
    const marginRa = profile.tile_width_deg / 2 / Math.max(Math.cos(radians(dec)), 1e-6);
    const firstCol = Math.ceil((raStart - marginRa - phaseRa) / stepRa);
    const lastCol = Math.floor((raEnd + marginRa - phaseRa) / stepRa);
    for (let col = firstCol; col <= lastCol; col += 1) {
      const unwrappedRa = phaseRa + col * stepRa;
      if (Math.abs(wrappedRaDelta(modulo(unwrappedRa, 360), modulo(centerRa, 360)) * Math.cos(radians(dec))) <=
        bounds.ra_span_deg * Math.cos(radians(dec)) / 2 + profile.tile_width_deg / 2) {
        candidates.push([modulo(unwrappedRa, 360), dec]);
      }
    }
  }
  return uniqueSortedCenters(candidates);
}

function uniqueSortedCenters(centers: readonly Center[]): Center[] {
  const seen = new Set<string>();
  const unique: Center[] = [];
  for (const center of centers) {
    const key = `${center[0]},${center[1]}`;
    if (!seen.has(key)) { seen.add(key); unique.push(center); }
  }
  return unique.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** Remove centers within 0.12° great-circle distance of actual input pointings.
 * @param centers - Candidate ICRS [RA, DEC] positions in decimal degrees.
 * @param tiles - All enabled actual catalogue and accepted proposal centers.
 * @returns Unique, sorted unoccupied centers in decimal degrees.
 */
export function excludeOccupied(centers: readonly Center[], tiles: readonly TileRecord[]): Center[] {
  return uniqueSortedCenters(centers).filter(([ra, dec]) =>
    !tiles.some((tile) => angularSeparationDeg(ra, dec, tile.ra_deg, tile.dec_deg) < OCCUPIED_CENTER_TOLERANCE_DEG));
}

/** Infer or fall back to a lattice and select useful ICRS tile centers.
 * @param polygon - Ordered selected sky polygon in ICRS decimal degrees.
 * @param existingTiles - Original catalogue and accepted proposals, including disabled records.
 * @param profileId - Bundled profile ID or custom.
 * @param inlineProfile - Optional session-only custom geometry in degrees and arcseconds.
 * @returns Deterministic proposal, candidate centers, inference audit, and coverage metrics.
 * @throws On invalid geometry, too many input/candidate records, or sample limits.
 */
export function planRegion(polygon: SkyPolygon, existingTiles: TileRecord[], profileId = "splus-t80-south", inlineProfile?: TilingProfile): RegionPlanResponse {
  validatePolygon(polygon);
  if (existingTiles.length > 20_000) throw new Error("Too many existing tiles");
  const profile = resolveProfile(profileId, inlineProfile);
  const activeTiles = existingTiles.filter((tile) => tile.enabled !== false);
  const bounds = polygonBounds(polygon);
  const centerRa = modulo(bounds.ra_start_deg + bounds.ra_span_deg / 2, 360);
  const centerDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const localTiles = tilesNearRegion(activeTiles, bounds, centerRa, centerDec, profile);
  const lattice = inferLattice(localTiles, centerRa, centerDec, profile);
  let solution: RegionPlanResponse["solution"];
  let method: RegionPlanResponse["generation_method"];
  let rawCandidates: Center[];
  let anchors: string[];
  const diagnostics: string[] = [];
  if (lattice === null) {
    solution = "profile_fallback"; method = "region_legacy";
    const expanded = expandedBounds(bounds, profile);
    rawCandidates = profile.algorithm === "SPLUS_LEGACY_GRID_V1"
      ? legacyGridCenters([expanded.ra_start_deg, expanded.ra_end_deg], [expanded.dec_min_deg, expanded.dec_max_deg], expanded.ra_start_deg > expanded.ra_end_deg)
      : rectangularGridCenters(expanded, profile);
    anchors = [];
    diagnostics.push(`No reliable local lattice was found from ${localTiles.length} nearby tiles; used ${profile.algorithm} around the selected polygon.`);
  } else {
    solution = "extended_existing_grid"; method = "region_extended";
    rawCandidates = latticeCandidates(bounds, lattice, profile);
    anchors = lattice.anchorIds;
    diagnostics.push(`Extended the local grid using ${lattice.pairCount} compatible neighbor pairs and ${anchors.length} anchor tiles.`);
    diagnostics.push(`Median DEC spacing ${lattice.decSpacingDeg.toFixed(4)} deg and inferred physical RA spacing ${lattice.raSpacingDeg.toFixed(4)} deg; compatibility tolerance is ${INFERENCE_TOLERANCE_DEG.toFixed(2)} deg.`);
  }
  if (rawCandidates.length > MAX_CANDIDATES) throw new Error(`This region produces ${rawCandidates.length} lattice candidates; reduce the selected area to at most ${MAX_CANDIDATES}.`);
  const uniqueCandidates = excludeOccupied(rawCandidates, activeTiles);
  const grid = sampleRegion(polygon);
  const existingMask = coveredMask(grid, activeTiles, profile);
  const contributing = contributingTileCount(polygon, activeTiles, profile);
  const useful: MaskedCenter[] = [];
  for (const center of uniqueCandidates) {
    const mask = tileMask(grid, center[0], center[1], profile);
    if (mask.some((covered, index) => Boolean(covered) && !existingMask[index])) useful.push({ center, mask });
  }
  const chosen = greedyChoose(useful, existingMask, grid, profile, AUTOMATIC_COVERAGE_TARGET);
  const tiles: TileRecord[] = chosen.map(({ center: [ra, dec] }, index) => ({
    id: `proposal-region-${String(index + 1).padStart(4, "0")}`, name: "",
    ra_deg: ra, dec_deg: dec, source: "proposed", enabled: true,
    dataset_id: null, group_id: null, ra_column: null, dec_column: null,
    generation_method: method, original_values: null, metadata: { solution },
  }));
  const candidateCenters: CenterInput[] = uniqueCandidates.map(([ra, dec]) => ({ ra_deg: ra, dec_deg: dec, label: null }));
  const metrics = measureMetrics(chosen, existingMask, grid, contributing, profile);
  if (!tiles.length && metrics.selected_region_coverage >= AUTOMATIC_COVERAGE_TARGET) diagnostics.push("Existing tiles already meet the 99.5% sampled coverage target.");
  else if (!tiles.length) diagnostics.push("No unoccupied lattice centers add sampled coverage to this region.");
  return {
    solution, generation_method: method, tiles, candidate_centers: candidateCenters,
    inference: {
      nearby_tile_count: localTiles.length, anchor_tile_ids: anchors,
      compatible_neighbor_pairs: lattice?.pairCount ?? 0,
      dec_spacing_deg: lattice?.decSpacingDeg ?? null, ra_spacing_deg: lattice?.raSpacingDeg ?? null,
    },
    diagnostics, metrics,
  };
}
