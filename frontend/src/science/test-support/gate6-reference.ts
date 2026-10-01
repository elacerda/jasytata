import type { CoveragePolicy, CoverageStrategy, Footprint, TilingProfile } from "../../types";
import type { CoverageGrid, MaskedCenter, SelectionStop } from "../coverage";
import { assertResolvedCoverage } from "../coverage";
import { footprintArea } from "../footprint-engine";
type FootprintGeometry = Footprint | Pick<TilingProfile, "tile_width_deg" | "tile_height_deg">;
const MIN_INCREMENTAL_GAIN = 1e-10;
// Test-only transcription of the untouched Gate 5 selector at 8512ac9.
// Deliberately retains full-mask scans and ordered floating-point sums.
/** Frozen Gate 5 selector oracle; intentionally retains exhaustive ordered scans.
 * @param candidates - Ordered centers, binary masks, and optional physical union areas in deg².
 * @param existingMask - Binary existing coverage, aligned with the grid arrays.
 * @param grid - ICRS degree samples and cos(DEC) weights in row-major order.
 * @param geometry - Local-degree footprint or legacy dimensions.
 * @param automaticTarget - Optional sampled coverage fraction.
 * @param strategy - Complete or Efficient stopping policy.
 * @param efficientPolicy - Frozen coverage floor and marginal-area thresholds.
 * @param onStop - Optional stop-reason observer.
 * @returns Selected candidates in tie/ranking order, without mutating inputs.
 * @throws If coverage is under-resolved or Efficient has no explicit policy.
 */
export function referenceGreedyChoose(candidates: readonly MaskedCenter[], existingMask: Uint8Array, grid: CoverageGrid, geometry: FootprintGeometry, automaticTarget?: number, strategy: CoverageStrategy = "complete", efficientPolicy?: CoveragePolicy["efficient"], onStop?: (reason: SelectionStop) => void): MaskedCenter[] {
  assertResolvedCoverage(grid);
  if (strategy === "efficient" && !efficientPolicy) throw new Error("Efficient selection requires coverage.efficient policy");
  const footprint = toFootprint(geometry);
  const physicalAreaDeg2 = footprintArea(footprint);
  const uncovered = new Uint8Array(existingMask.length);
  for (let index = 0; index < uncovered.length; index += 1) uncovered[index] = existingMask[index] ? 0 : 1;
  const selected: MaskedCenter[] = [];
  const remaining = [...candidates];
  let stop: SelectionStop = "candidate_lattice_exhausted";
  while (remaining.length) {
    const currentCoverage = 1 - weightSum(grid, uncovered) / Math.max(grid.totalWeight, 1e-12);
    if (automaticTarget !== undefined && currentCoverage >= automaticTarget) { stop = "coverage_complete"; break; }
    let bestIndex = -1;
    let bestScore: number[] | null = null;
    for (let index = 0; index < remaining.length; index += 1) {
      const { center: [ra, dec], mask, physicalAreaDeg2: candidateArea } = remaining[index];
      const gain = weightSum(grid, mask, uncovered);
      const overlap = weightSum(grid, mask, uncovered, false);
      const inside = Math.max(weightSum(grid, mask), 1e-12);
      const outsideArea = outsideTileArea(mask, grid, candidateArea ?? physicalAreaDeg2);
      const score = [gain, -overlap / inside, -outsideArea, -dec, -ra, index];
      if (bestScore === null || compareScore(score, bestScore) > 0) { bestScore = score; bestIndex = index; }
    }
    const best = remaining.splice(bestIndex, 1)[0];
    const gain = weightSum(grid, best.mask, uncovered);
    if (gain / Math.max(grid.totalWeight, 1e-12) < MIN_INCREMENTAL_GAIN) { stop = "gain_safeguard"; break; }
    const marginalEfficiency = gain * grid.cellAreaDeg2 / (best.physicalAreaDeg2 ?? physicalAreaDeg2);
    if (strategy === "efficient" && efficientPolicy && currentCoverage >= efficientPolicy.min_coverage && marginalEfficiency < efficientPolicy.min_marginal_efficiency) { stop = "marginal_efficiency"; break; }
    selected.push(best);
    for (let index = 0; index < uncovered.length; index += 1) if (best.mask[index]) uncovered[index] = 0;
  }
  if (automaticTarget !== undefined && 1 - weightSum(grid, uncovered) / Math.max(grid.totalWeight, 1e-12) >= automaticTarget) stop = "coverage_complete";
  onStop?.(stop);
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


function weightSum(grid: CoverageGrid, mask: Uint8Array, other?: Uint8Array, includeOther = true): number {
  let total = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && (other === undefined || Boolean(other[index]) === includeOther)) total += grid.weights[index];
  }
  return total;
}

/** Subtract sampled in-region area from the operation's physical area in deg². */
function outsideTileArea(mask: Uint8Array, grid: CoverageGrid, physicalAreaDeg2: number): number {
  return Math.max(0, physicalAreaDeg2 - weightSum(grid, mask) * grid.cellAreaDeg2);
}
