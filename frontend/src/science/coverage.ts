import type { CoverageStrategy, Footprint, PlanMetrics, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { polygonLocalGeometry, validatePolygon, type PolygonLocalGeometry } from "./geometry";
import { createFootprintContainmentTester, createSkyToLocalProjector, footprintArea, footprintIntersectsRegion, footprintLocalBounds } from "./footprint-engine";
import type { Center } from "./grid";
import { modulo, radians, roundDecimal, wrappedRaDelta } from "./math";
import { resolveProfile } from "../profiles";
import { outputFootprintForProfile } from "../profiles/footprints";
import { profileRegistry, type ProfileRegistry } from "../profiles/registry";

const SAMPLE_STEP_DEG = 0.01;
const MAX_REGION_SAMPLES = 90_000;
const MIN_POLYGON_SAMPLES_PER_AXIS = 8;
const MIN_INCREMENTAL_GAIN = 1e-10;
type FootprintGeometry = Footprint | Pick<TilingProfile, "tile_width_deg" | "tile_height_deg">;
export const EFFICIENT_MIN_COVERAGE = 0.995;
export const EFFICIENT_MIN_MARGINAL_EFFICIENCY = 0.03;

/** Row-major, declination-weighted polygon samples in ICRS decimal degrees. */
export interface CoverageGrid {
  ra: Float64Array;
  dec: Float64Array;
  weights: Float64Array;
  totalWeight: number;
  stepDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
  raSpanDeg: number;
  decMinDeg: number;
  decMaxDeg: number;
  cellAreaDeg2: number;
}

/** One chosen center and its selected-region footprint mask. */
export interface MaskedCenter {
  center: Center;
  mask: Uint8Array;
}

/** Sample the selected ICRS polygon using the Python row-major cell convention.
 * @param polygon - Validated ordered vertices in decimal-degree RA/DEC.
 * @returns Weighted samples at a nominal 0.01° pitch, with RA/DEC cell area
 *   and cosine declination weights. Large regions use a coarser pitch to stay
 *   below 90,000 bounding-box samples.
 * @throws If the polygon contains no selected sample cells.
 */
export function sampleRegion(polygon: SkyPolygon): CoverageGrid {
  return sampleBounds(polygonLocalGeometry(polygon), polygon);
}

function sampleBounds({ bounds, originRaDeg, ra: polygonX }: PolygonLocalGeometry, polygon: SkyPolygon): CoverageGrid {
  const centerDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const widthDeg = bounds.ra_span_deg * Math.max(Math.cos(radians(centerDec)), 0.01);
  const heightDeg = bounds.dec_max_deg - bounds.dec_min_deg;
  let step = Math.max(SAMPLE_STEP_DEG, Math.sqrt(Math.max(widthDeg * heightDeg, SAMPLE_STEP_DEG ** 2) / MAX_REGION_SAMPLES));
  let rows = Math.max(1, Math.ceil(heightDeg / step));
  let cols = Math.max(1, Math.ceil(bounds.ra_span_deg / step));
  if (rows * cols > MAX_REGION_SAMPLES) {
    step *= Math.sqrt(rows * cols / MAX_REGION_SAMPLES);
    rows = Math.max(1, Math.ceil(heightDeg / step));
    cols = Math.max(1, Math.ceil(bounds.ra_span_deg / step));
  }
  rows = Math.max(rows, MIN_POLYGON_SAMPLES_PER_AXIS);
  cols = Math.max(cols, MIN_POLYGON_SAMPLES_PER_AXIS);
  while (rows * cols > MAX_REGION_SAMPLES) {
    if (rows >= cols) rows -= 1;
    else cols -= 1;
  }
  step = Math.max(heightDeg / rows, bounds.ra_span_deg / cols);
  const size = rows * cols;
  const ra = new Float64Array(size);
  const dec = new Float64Array(size);
  const weights = new Float64Array(size);
  const polygonY = polygon.vertices.map((vertex) => vertex.dec_deg);
  let totalWeight = 0;
  let selectedSamples = 0;
  for (let row = 0; row < rows; row += 1) {
    const decValue = bounds.dec_min_deg + (row + 0.5) * heightDeg / rows;
    const weight = Math.cos(radians(decValue));
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const offset = (col + 0.5) * bounds.ra_span_deg / cols;
      ra[index] = modulo(originRaDeg + offset, 360);
      dec[index] = decValue;
      const x = offset;
      let inside = false;
      for (let vertex = 0; vertex < polygonX.length; vertex += 1) {
        const next = (vertex + 1) % polygonX.length;
        const x1 = polygonX[vertex]; const y1 = polygonY[vertex];
        const x2 = polygonX[next]; const y2 = polygonY[next];
        if ((y1 > decValue) !== (y2 > decValue) && x < (x2 - x1) * (decValue - y1) / (y2 !== y1 ? y2 - y1 : 1) + x1) inside = !inside;
      }
      if (inside) { weights[index] = weight; totalWeight += weight; selectedSamples += 1; }
    }
  }
  if (!selectedSamples) throw new Error("Polygon is too small for the coverage sample resolution");
  return {
    ra, dec, weights, totalWeight, stepDeg: step,
    centerRaDeg: modulo(originRaDeg + bounds.ra_span_deg / 2, 360),
    centerDecDeg: centerDec, raSpanDeg: bounds.ra_span_deg,
    decMinDeg: bounds.dec_min_deg, decMaxDeg: bounds.dec_max_deg,
    cellAreaDeg2: (bounds.ra_span_deg / cols) * (heightDeg / rows),
  };
}

/** Flag selected sample cells inside a physical Schema v2 footprint.
 * @param grid - Row-major weighted ICRS samples.
 * @param raDeg - Tile center RA in decimal degrees.
 * @param decDeg - Tile center DEC in decimal degrees.
 * @param geometry - Schema v2 footprint or legacy rectangular tile dimensions.
 * @returns Binary mask aligned with the grid's sample arrays.
 */
export function tileMask(
  grid: CoverageGrid,
  raDeg: number,
  decDeg: number,
  geometry: Footprint | Pick<TilingProfile, "tile_width_deg" | "tile_height_deg">,
): Uint8Array {
  const footprint = toFootprint(geometry);
  const mask = new Uint8Array(grid.ra.length);
  const pointing = { ra_deg: raDeg, dec_deg: decDeg };
  const project = createSkyToLocalProjector(pointing);
  const contains = createFootprintContainmentTester(footprint);
  const footprintBounds = footprintLocalBounds(footprint);
  const centerRaDelta = wrappedRaDelta(grid.centerRaDeg, raDeg);
  const halfRaSpan = grid.raSpanDeg / 2;
  if (Math.abs(centerRaDelta) + halfRaSpan < 180) {
    const eastScale = Math.max(Math.cos(radians(decDeg)), 0.01);
    const minEast = (centerRaDelta - halfRaSpan) * eastScale;
    const maxEast = (centerRaDelta + halfRaSpan) * eastScale;
    const minNorth = grid.decMinDeg - decDeg;
    const maxNorth = grid.decMaxDeg - decDeg;
    const tolerance = 1e-12;
    if (maxEast < footprintBounds.min_east_deg - tolerance || minEast > footprintBounds.max_east_deg + tolerance ||
      maxNorth < footprintBounds.min_north_deg - tolerance || minNorth > footprintBounds.max_north_deg + tolerance) return mask;
  }
  const localPoint: [number, number] = [0, 0];
  for (let index = 0; index < mask.length; index += 1) {
    if (grid.weights[index] > 0) {
      project(grid.ra[index], grid.dec[index], localPoint);
      if (contains(localPoint[0], localPoint[1])) mask[index] = 1;
    }
  }
  return mask;
}

/** Union enabled existing pointings over weighted selected-region samples.
 * @param grid - Selected polygon sample grid.
 * @param tiles - Enabled original and accepted proposal records.
 * @param profile - Active output planner profile; its linked instrument supplies proposal geometry.
 * @param registry - Session-local registry used to resolve source dataset geometry.
 * @returns Binary union mask aligned with the grid.
 * @throws If an associated source or active output instrument is unknown.
 */
export function coveredMask(
  grid: CoverageGrid,
  tiles: readonly TileRecord[],
  profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): Uint8Array {
  const covered = new Uint8Array(grid.ra.length);
  const footprints = new Map<string, Footprint>();
  const outputFootprint = outputFootprintForProfile(profile, registry);
  let selectedSampleCount = 0;
  for (const weight of grid.weights) if (weight > 0) selectedSampleCount += 1;
  let coveredCount = 0;
  for (const tile of tiles) {
    let footprint = outputFootprint;
    if (tile.source === "original" && tile.instrument_profile_id) {
      const cached = footprints.get(tile.instrument_profile_id);
      footprint = cached ?? registry.resolveInstrumentProfile(tile.instrument_profile_id).footprint;
      footprints.set(tile.instrument_profile_id, footprint);
    }
    const mask = tileMask(grid, tile.ra_deg, tile.dec_deg, footprint);
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index] && !covered[index]) { covered[index] = 1; coveredCount += 1; }
    }
    if (coveredCount === selectedSampleCount) break;
  }
  return covered;
}

/** Count contributing existing footprints using each associated source footprint.
 * @param polygon - Selected ICRS region in decimal degrees.
 * @param tiles - Enabled source tiles and accepted proposals.
 * @param profile - Active output profile for unassociated tiles and proposals.
 * @param registry - Session-local registry used to resolve source instruments.
 * @returns Number of source or proposal footprints intersecting positive polygon area.
 * @throws If an associated source or active output instrument is unknown.
 */
export function contributingTileCountForTiles(
  polygon: SkyPolygon,
  tiles: readonly TileRecord[],
  profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): number {
  const footprints = new Map<string, Footprint>();
  const outputFootprint = outputFootprintForProfile(profile, registry);
  let total = 0;
  for (const tile of tiles) {
    let footprint = outputFootprint;
    if (tile.source === "original" && tile.instrument_profile_id) {
      const cached = footprints.get(tile.instrument_profile_id);
      footprint = cached ?? registry.resolveInstrumentProfile(tile.instrument_profile_id).footprint;
      footprints.set(tile.instrument_profile_id, footprint);
    }
    if (footprintIntersectsRegion(footprint, tile, polygon)) total += 1;
  }
  return total;
}

function weightSum(grid: CoverageGrid, mask: Uint8Array, other?: Uint8Array, includeOther = true): number {
  let total = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && (other === undefined || Boolean(other[index]) === includeOther)) total += grid.weights[index];
  }
  return total;
}

function outsideTileArea(mask: Uint8Array, grid: CoverageGrid, footprint: Footprint): number {
  return Math.max(0, footprintArea(footprint) - weightSum(grid, mask) * grid.cellAreaDeg2);
}

/** Greedily select centers by incremental coverage and Python's ordered tie breaks.
 * @param candidates - Unoccupied useful centers in deterministic grid order.
 * @param existingMask - Existing selected-region coverage mask.
 * @param grid - Weighted ICRS samples.
 * @param geometry - Schema v2 output footprint or legacy rectangular dimensions.
 * @param automaticTarget - Optional target fraction for automatic region planning.
 * @param strategy - Complete sampled coverage or the efficient policy. The latter
 *   compares declination-weighted new sampled area in square degrees with physical
 *   tile area in square degrees after the 0.995 coverage floor is reached.
 * @returns Chosen centers in ranking order with their masks.
 */
export function greedyChoose(candidates: readonly MaskedCenter[], existingMask: Uint8Array, grid: CoverageGrid, geometry: FootprintGeometry, automaticTarget?: number, strategy: CoverageStrategy = "complete"): MaskedCenter[] {
  const footprint = toFootprint(geometry);
  const uncovered = new Uint8Array(existingMask.length);
  for (let index = 0; index < uncovered.length; index += 1) uncovered[index] = existingMask[index] ? 0 : 1;
  const selected: MaskedCenter[] = [];
  const remaining = [...candidates];
  while (remaining.length) {
    const currentCoverage = 1 - weightSum(grid, uncovered) / Math.max(grid.totalWeight, 1e-12);
    if (automaticTarget !== undefined && currentCoverage >= automaticTarget) break;
    let bestIndex = -1;
    let bestScore: number[] | null = null;
    for (let index = 0; index < remaining.length; index += 1) {
      const { center: [ra, dec], mask } = remaining[index];
      const gain = weightSum(grid, mask, uncovered);
      const overlap = weightSum(grid, mask, uncovered, false);
      const inside = Math.max(weightSum(grid, mask), 1e-12);
      const outsideArea = outsideTileArea(mask, grid, footprint);
      const score = [gain, -overlap / inside, -outsideArea, -dec, -ra, index];
      if (bestScore === null || compareScore(score, bestScore) > 0) { bestScore = score; bestIndex = index; }
    }
    const best = remaining.splice(bestIndex, 1)[0];
    const gain = weightSum(grid, best.mask, uncovered);
    if (gain / Math.max(grid.totalWeight, 1e-12) < MIN_INCREMENTAL_GAIN) break;
    const marginalEfficiency = gain * grid.cellAreaDeg2 / footprintArea(footprint);
    if (strategy === "efficient" && currentCoverage >= EFFICIENT_MIN_COVERAGE && marginalEfficiency < EFFICIENT_MIN_MARGINAL_EFFICIENCY) break;
    selected.push(best);
    for (let index = 0; index < uncovered.length; index += 1) if (best.mask[index]) uncovered[index] = 0;
  }
  return selected;
}

function toFootprint(geometry: FootprintGeometry): Footprint {
  return "type" in geometry
    ? geometry
    : { type: "rectangle", width_deg: geometry.tile_width_deg, height_deg: geometry.tile_height_deg };
}

function compareScore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Measure existing, incremental, redundant, and outside-polygon tile coverage.
 * @param selected - Enabled chosen centers with footprint masks.
 * @param existingMask - Existing field coverage of selected samples.
 * @param grid - Weighted ICRS polygon samples.
 * @param contributing - Number of actual footprints with positive geometric intersection.
 * @param geometry - Schema v2 output footprint or legacy rectangular tile dimensions.
 * @returns Current declination-weighted sampled fractions, areas in square degrees, and counts.
 */
export function measureMetrics(selected: readonly MaskedCenter[], existingMask: Uint8Array, grid: CoverageGrid, contributing: number, geometry: FootprintGeometry): PlanMetrics {
  const footprint = toFootprint(geometry);
  const covered = existingMask.slice();
  const newCovered = new Uint8Array(covered.length);
  let proposedSampleWeight = 0;
  let redundantSampleWeight = 0;
  let outsideArea = 0;
  for (const { mask } of selected) {
    redundantSampleWeight += weightSum(grid, mask, covered);
    proposedSampleWeight += weightSum(grid, mask);
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index]) { if (!covered[index]) newCovered[index] = 1; covered[index] = 1; }
    }
    outsideArea += outsideTileArea(mask, grid, footprint);
  }
  const total = Math.max(grid.totalWeight, 1e-12);
  const totalCoverage = weightSum(grid, covered) / total;
  const alreadyCovered = weightSum(grid, existingMask) / total;
  const incremental = weightSum(grid, newCovered) / total;
  const redundant = selected.length ? redundantSampleWeight / Math.max(proposedSampleWeight, 1e-12) : 0;
  const area = grid.totalWeight * grid.cellAreaDeg2;
  return {
    existing_tiles_contributing: contributing, new_tiles: selected.length,
    selected_region_area_deg2: roundDecimal(area, 4),
    already_covered_fraction: roundDecimal(alreadyCovered, 5),
    selected_region_coverage: roundDecimal(totalCoverage, 5),
    incremental_coverage: roundDecimal(incremental, 5),
    remaining_uncovered_fraction: roundDecimal(Math.max(0, 1 - totalCoverage), 5),
    remaining_uncovered_area_deg2: roundDecimal(Math.max(0, 1 - totalCoverage) * area, 4),
    redundant_coverage: roundDecimal(redundant, 5),
    outside_region_coverage_deg2: roundDecimal(outsideArea, 4),
    sample_step_deg: roundDecimal(grid.stepDeg, 4),
  };
}

/** Recalculate sampled coverage after proposal toggles without replacing centers.
 * @param polygon - Validated ICRS selected region in decimal degrees.
 * @param existingTiles - All original and accepted pointings; disabled proposals are ignored.
 * @param proposedTiles - Editable proposal preview; only enabled records contribute.
 * @param profileId - Installed profile ID or custom.
 * @param inlineProfile - Session-only custom profile, if any.
 * @param registry - Session-local registry used to resolve source instrument profiles.
 * @returns Current sampled-coverage metrics for enabled existing and proposed footprints.
 * @throws On invalid polygon/profile, unknown instrument ID,
 *   or non-proposal editable record.
 */
export function measureActiveCoverage(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  proposedTiles: TileRecord[],
  profileId = "splus-t80-south",
  inlineProfile?: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
): PlanMetrics {
  validatePolygon(polygon);
  if (existingTiles.length > 20_000 || proposedTiles.length > 500) throw new Error("Too many tile records");
  if (proposedTiles.some((tile) => tile.source !== "proposed")) throw new Error("Coverage edits may contain only proposed tiles");
  const profile = resolveProfile(profileId, inlineProfile);
  const outputFootprint = outputFootprintForProfile(profile, registry);
  const grid = sampleRegion(polygon);
  const activeExisting = existingTiles.filter((tile) => tile.enabled !== false);
  const existing = coveredMask(grid, activeExisting, profile, registry);
  const selected = proposedTiles.filter((tile) => tile.enabled !== false).map((tile) => ({
    center: [tile.ra_deg, tile.dec_deg] as Center,
    mask: tileMask(grid, tile.ra_deg, tile.dec_deg, outputFootprint),
  }));
  return measureMetrics(selected, existing, grid, contributingTileCountForTiles(polygon, activeExisting, profile, registry), outputFootprint);
}
