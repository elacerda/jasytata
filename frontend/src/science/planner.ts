import type { CenterInput, CoverageStrategy, Footprint, RegionPlanResponse, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { resolveProfile } from "../profiles";
import { outputFootprintForProfile } from "../profiles/footprints";
import { profileRegistry, type ProfileRegistry } from "../profiles/registry";
import { contributingTileCountForTiles, coveredMask, greedyChoose, measureMetrics, sampleRegion, tileMask, type CoverageGrid, type MaskedCenter } from "./coverage";
import { angularSeparationDeg, polygonBounds, validatePolygon, type RegionBounds } from "./geometry";
import { legacyGridCenters, rectangularGridCenters, type Center } from "./grid";
import { compareNumbers, median, modulo, radians, roundDecimal, wrappedRaDelta } from "./math";

const INFERENCE_TOLERANCE_DEG = 0.05;
const OCCUPIED_CENTER_TOLERANCE_DEG = 0.12;
const MAX_CANDIDATES = 1200;
const AUTOMATIC_COVERAGE_TARGET = 1;

interface Lattice {
  decSpacingDeg: number;
  raSpacingDeg: number;
  rowDecDeg: Map<number, number>;
  rowRaSpacingDeg: Map<number, number>;
  rowRaPhaseFraction: Map<number, number>;
  anchorIds: string[];
  pairCount: number;
}

interface InferenceTileGroup {
  key: string;
  profile: TilingProfile;
  tiles: TileRecord[];
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

function inferenceTileGroups(tiles: readonly TileRecord[], profile: TilingProfile, registry: ProfileRegistry): InferenceTileGroup[] {
  const activeInstrumentId = registry.findSurveyProfile(profile.id)?.instrument_id;
  const sourceProfileCache = new Map<string, TilingProfile | null>();
  const sourceProfileFor = (instrumentProfileId: string): TilingProfile | null => {
    if (sourceProfileCache.has(instrumentProfileId)) return sourceProfileCache.get(instrumentProfileId)!;
    const footprint = registry.resolveInstrumentProfile(instrumentProfileId).footprint;
    if (footprint.type !== "rectangle") {
      sourceProfileCache.set(instrumentProfileId, null);
      return null;
    }
    const normalizedAngle = ((footprint.position_angle_deg ?? 0) % 360 + 360) % 360;
    if (Math.min(normalizedAngle, 360 - normalizedAngle) > 1e-12) {
      sourceProfileCache.set(instrumentProfileId, null);
      return null;
    }
    const sourceProfile = { ...profile, tile_width_deg: footprint.width_deg, tile_height_deg: footprint.height_deg };
    sourceProfileCache.set(instrumentProfileId, sourceProfile);
    return sourceProfile;
  };
  const compatibleInstrumentIds = [...new Set(tiles.flatMap((tile) => {
    if (tile.source !== "original" || !tile.instrument_profile_id || (tile.inference_role ?? "auto") !== "auto") return [];
    const geometry = sourceProfileFor(tile.instrument_profile_id);
    return geometry && geometry.tile_width_deg === profile.tile_width_deg && geometry.tile_height_deg === profile.tile_height_deg
      ? [tile.instrument_profile_id]
      : [];
  }))].sort((left, right) => left.localeCompare(right));
  const unassociatedInstrumentId = activeInstrumentId ?? (compatibleInstrumentIds.length === 1 ? compatibleInstrumentIds[0] : undefined);
  const unassociatedKey = unassociatedInstrumentId ? `instrument:${unassociatedInstrumentId}` : `output:${profile.id}`;
  const groups = new Map<string, InferenceTileGroup>();

  for (const tile of tiles) {
    const role = tile.inference_role ?? "auto";
    if (tile.source === "original" && role === "exclude") continue;

    let key = unassociatedKey;
    let tileProfile = profile;
    if (tile.source === "original" && tile.instrument_profile_id) {
      const sourceProfile = sourceProfileFor(tile.instrument_profile_id);
      tileProfile = sourceProfile ?? profile;
      if (role === "auto") {
        const compatible = activeInstrumentId
          ? tile.instrument_profile_id === activeInstrumentId
          : sourceProfile !== null && sourceProfile.tile_width_deg === profile.tile_width_deg && sourceProfile.tile_height_deg === profile.tile_height_deg;
        if (!compatible) continue;
      }
      key = `instrument:${tile.instrument_profile_id}`;
    }

    const group = groups.get(key) ?? { key, profile: tileProfile, tiles: [] };
    group.tiles.push(tile);
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
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

interface CoverageGap {
  minRaOffsetDeg: number;
  maxRaOffsetDeg: number;
  minDecDeg: number;
  maxDecDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
}

/** Return selected-region sample bounds that remain uncovered, unwrapping RA around the grid center.
 * @param grid - Weighted ICRS sample grid with RA/DEC positions in degrees.
 * @param coverage - Binary mask aligned with the grid; 1 means an existing or planned tile covers the sample.
 * @returns Bounding box of uncovered samples in degrees, or null when every selected sample is covered.
 */
function uncoveredSampleBounds(grid: CoverageGrid, coverage: Uint8Array): CoverageGap | null {
  let minRaOffsetDeg = Infinity;
  let maxRaOffsetDeg = -Infinity;
  let minDecDeg = Infinity;
  let maxDecDeg = -Infinity;
  let raTotal = 0;
  let decTotal = 0;
  let count = 0;
  for (let index = 0; index < coverage.length; index += 1) {
    if (!grid.weights[index] || coverage[index]) continue;
    const raOffsetDeg = wrappedRaDelta(grid.ra[index], grid.centerRaDeg);
    minRaOffsetDeg = Math.min(minRaOffsetDeg, raOffsetDeg);
    maxRaOffsetDeg = Math.max(maxRaOffsetDeg, raOffsetDeg);
    minDecDeg = Math.min(minDecDeg, grid.dec[index]);
    maxDecDeg = Math.max(maxDecDeg, grid.dec[index]);
    raTotal += raOffsetDeg;
    decTotal += grid.dec[index];
    count += 1;
  }
  if (!count) return null;
  return {
    minRaOffsetDeg,
    maxRaOffsetDeg,
    minDecDeg,
    maxDecDeg,
    centerRaDeg: modulo(grid.centerRaDeg + raTotal / count, 360),
    centerDecDeg: decTotal / count,
  };
}

/** Combine selected proposal masks with the actual existing-field mask.
 * @param existingMask - Binary mask for actual existing pointings.
 * @param selected - Greedily selected tile centers and their sampled footprints.
 * @returns Binary union mask matching the selected-region sample grid.
 */
function combinedCoverageMask(existingMask: Uint8Array, selected: readonly MaskedCenter[]): Uint8Array {
  const coverage = existingMask.slice();
  for (const { mask } of selected) {
    for (let index = 0; index < coverage.length; index += 1) {
      if (mask[index]) coverage[index] = 1;
    }
  }
  return coverage;
}

/** Generate a half-phase-shifted supplemental grid around uncovered samples, anchored to a nearby actual tile.
 * This second pass preserves the inferred local cadence where possible and introduces extra overlap only where the primary grid leaves a gap.
 * @param grid - Fine weighted ICRS sample grid.
 * @param gap - Bounds of currently uncovered selected samples in degrees.
 * @param anchor - Nearby existing tile or primary candidate center in ICRS degrees.
 * @param profile - Physical tile dimensions and effective overlap.
 * @param lattice - Optional local spacings inferred from actual catalogue centers.
 * @returns Unique tile centers in ICRS decimal degrees that can cover the remaining bounds.
 */
function gapFillCandidates(grid: CoverageGrid, gap: CoverageGap, anchor: Center, profile: TilingProfile, lattice: Lattice | null): Center[] {
  const profileRaStep = raSpacing(profile);
  const profileDecStep = decSpacing(profile);
  const stepRaPhysical = Math.min(profile.tile_width_deg * 0.9, lattice?.raSpacingDeg ?? profileRaStep);
  const stepDec = Math.min(profile.tile_height_deg * 0.9, lattice?.decSpacingDeg ?? profileDecStep);
  const anchorRa = grid.centerRaDeg + wrappedRaDelta(anchor[0], grid.centerRaDeg);
  const phaseDec = anchor[1] + stepDec / 2;
  const firstRow = Math.ceil((gap.minDecDeg - profile.tile_height_deg / 2 - phaseDec) / stepDec);
  const lastRow = Math.floor((gap.maxDecDeg + profile.tile_height_deg / 2 - phaseDec) / stepDec);
  const minRa = grid.centerRaDeg + gap.minRaOffsetDeg;
  const maxRa = grid.centerRaDeg + gap.maxRaOffsetDeg;
  const centers: Center[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const dec = phaseDec + row * stepDec;
    if (dec <= -90 || dec >= 90) continue;
    const cosDec = Math.max(Math.cos(radians(dec)), 0.01);
    const stepRa = stepRaPhysical / cosDec;
    const halfRa = profile.tile_width_deg / (2 * cosDec);
    const phaseRa = anchorRa + stepRa / 2;
    const firstCol = Math.ceil((minRa - halfRa - phaseRa) / stepRa);
    const lastCol = Math.floor((maxRa + halfRa - phaseRa) / stepRa);
    for (let col = firstCol; col <= lastCol; col += 1) {
      centers.push([modulo(phaseRa + col * stepRa, 360), dec]);
      if (centers.length > MAX_CANDIDATES) throw new Error(`Filling the uncovered area needs more than ${MAX_CANDIDATES} additional tile centers; reduce the selected area.`);
    }
  }
  return uniqueSortedCenters(centers);
}

/** Choose the nearest reliable actual anchor for a remaining gap, falling back to the primary candidate lattice.
 * @param gap - Uncovered-sample bounds in ICRS degrees.
 * @param localTiles - Actual nearby pointings considered for local-grid inference.
 * @param lattice - Optional fitted lattice with stable anchor IDs.
 * @param primaryCandidates - Base lattice centers available to the plan.
 * @returns An ICRS [RA, DEC] center used to phase the overlap-fill grid.
 */
function nearestGapAnchor(gap: CoverageGap, localTiles: readonly TileRecord[], lattice: Lattice | null, primaryCandidates: readonly Center[]): Center {
  const anchorIds = new Set(lattice?.anchorIds ?? []);
  const trustedTiles = anchorIds.size ? localTiles.filter((tile) => anchorIds.has(tile.id)) : [];
  const nearestTile = trustedTiles.reduce<TileRecord | null>((nearest, tile) => {
    if (!nearest || angularSeparationDeg(tile.ra_deg, tile.dec_deg, gap.centerRaDeg, gap.centerDecDeg) <
      angularSeparationDeg(nearest.ra_deg, nearest.dec_deg, gap.centerRaDeg, gap.centerDecDeg)) return tile;
    return nearest;
  }, null);
  if (nearestTile) return [nearestTile.ra_deg, nearestTile.dec_deg];
  const nearestCandidate = primaryCandidates.reduce<Center | null>((nearest, center) => {
    if (!nearest || angularSeparationDeg(center[0], center[1], gap.centerRaDeg, gap.centerDecDeg) <
      angularSeparationDeg(nearest[0], nearest[1], gap.centerRaDeg, gap.centerDecDeg)) return center;
    return nearest;
  }, null);
  if (nearestCandidate) return nearestCandidate;
  return [gap.centerRaDeg, gap.centerDecDeg];
}

/** Build useful masks only for centers that cover at least one still-uncovered selected sample.
 * @param centers - Candidate ICRS centers in decimal degrees.
 * @param coverage - Current actual and planned coverage mask.
 * @param grid - Fine weighted ICRS sample grid.
 * @param footprint - Active output footprint in the local tangent plane.
 * @returns Candidate centers paired with masks that provide positive incremental coverage.
 */
function usefulUncoveredCenters(centers: readonly Center[], coverage: Uint8Array, grid: CoverageGrid, footprint: Footprint): MaskedCenter[] {
  const useful: MaskedCenter[] = [];
  for (const center of centers) {
    const mask = tileMask(grid, center[0], center[1], footprint);
    if (mask.some((covered, index) => Boolean(covered) && !coverage[index])) useful.push({ center, mask });
  }
  return useful;
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

/** Infer or fall back to a lattice, then add overlap-fill tiles if sampled gaps remain.
 * @param polygon - Ordered selected sky polygon in ICRS decimal degrees.
 * @param existingTiles - Original catalogue and accepted proposals, including disabled records.
 * @param profileId - Bundled profile ID or custom.
 * @param inlineProfile - Optional session-only custom geometry in degrees and arcseconds.
 * @param strategy - Sampled-coverage stopping policy; complete by default.
 * @param registry - Session-local registry used to resolve each source instrument.
 * @returns Deterministic proposal, candidate centers, inference audit, and coverage metrics.
 * @throws On invalid geometry, unknown instrument IDs,
 *   too many input/candidate records, or sample limits.
 */
export function planRegion(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  profileId = "splus-t80-south",
  inlineProfile?: TilingProfile,
  strategy: CoverageStrategy = "complete",
  registry: ProfileRegistry = profileRegistry,
): RegionPlanResponse {
  validatePolygon(polygon);
  if (existingTiles.length > 20_000) throw new Error("Too many existing tiles");
  const profile = resolveProfile(profileId, inlineProfile);
  const outputFootprint = outputFootprintForProfile(profile, registry);
  const activeTiles = existingTiles.filter((tile) => tile.enabled !== false);
  const bounds = polygonBounds(polygon);
  const centerRa = modulo(bounds.ra_start_deg + bounds.ra_span_deg / 2, 360);
  const centerDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const localTiles: TileRecord[] = [];
  let lattice: Lattice | null = null;
  let latticeTiles: TileRecord[] = [];
  for (const group of inferenceTileGroups(activeTiles, profile, registry)) {
    const nearby = tilesNearRegion(group.tiles, bounds, centerRa, centerDec, group.profile);
    localTiles.push(...nearby);
    const candidate = inferLattice(nearby, centerRa, centerDec, group.profile);
    if (candidate && (!lattice || compareLattices(candidate, lattice, profile) > 0)) {
      lattice = candidate;
      latticeTiles = nearby;
    }
  }
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
  const existingMask = coveredMask(grid, activeTiles, profile, registry);
  const contributing = contributingTileCountForTiles(polygon, activeTiles, profile, registry);
  const primaryCandidates = usefulUncoveredCenters(uniqueCandidates, existingMask, grid, outputFootprint);
  const primary = greedyChoose(primaryCandidates, existingMask, grid, outputFootprint, AUTOMATIC_COVERAGE_TARGET, strategy);
  const primaryCoverage = combinedCoverageMask(existingMask, primary);
  const remainingGap = uncoveredSampleBounds(grid, primaryCoverage);
  let gapFill: MaskedCenter[] = [];
  if (remainingGap) {
    const anchor = nearestGapAnchor(remainingGap, latticeTiles.length ? latticeTiles : localTiles, lattice, uniqueCandidates);
    const supplementalCenters = gapFillCandidates(grid, remainingGap, anchor, profile, lattice);
    const supplementalCandidates = usefulUncoveredCenters(supplementalCenters, primaryCoverage, grid, outputFootprint);
    gapFill = greedyChoose(supplementalCandidates, primaryCoverage, grid, outputFootprint, AUTOMATIC_COVERAGE_TARGET, strategy);
    if (gapFill.length) diagnostics.push(`Added ${gapFill.length} overlap-fill tile${gapFill.length === 1 ? "" : "s"} around the remaining sampled gaps, phased from ${lattice ? "the inferred existing grid" : "the active tile profile"}.`);
  }
  const chosen = [...primary, ...gapFill];
  const finalCoverage = combinedCoverageMask(existingMask, chosen);
  const finalGap = uncoveredSampleBounds(grid, finalCoverage);
  const tiles: TileRecord[] = chosen.map(({ center: [ra, dec] }, index) => ({
    id: `proposal-region-${String(index + 1).padStart(4, "0")}`, name: "",
    ra_deg: ra, dec_deg: dec, source: "proposed", enabled: true,
    dataset_id: null, group_id: null, ra_column: null, dec_column: null,
    generation_method: method, original_values: null, metadata: { solution, coverage_strategy: strategy },
  }));
  const candidateCenters: CenterInput[] = uniqueCandidates.map(([ra, dec]) => ({ ra_deg: ra, dec_deg: dec, label: null }));
  const metrics = measureMetrics(chosen, existingMask, grid, contributing, outputFootprint);
  if (finalGap) diagnostics.push(`The proposal leaves sampled gaps covering ${(metrics.remaining_uncovered_fraction * 100).toFixed(3)}% of the selected area.`);
  if (!tiles.length) {
    diagnostics.push(finalGap
      ? "No candidate tile centers add coverage to the remaining sampled gaps."
      : "Existing tiles already cover all sampled area in the selected region.");
  }
  return {
    solution, generation_method: method, coverage_strategy: strategy, tiles, candidate_centers: candidateCenters,
    inference: {
      nearby_tile_count: localTiles.length, anchor_tile_ids: anchors,
      compatible_neighbor_pairs: lattice?.pairCount ?? 0,
      dec_spacing_deg: lattice?.decSpacingDeg ?? null, ra_spacing_deg: lattice?.raSpacingDeg ?? null,
    },
    diagnostics, metrics,
  };
}
