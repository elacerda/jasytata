import type { CoverageMeasurementBasis, CoveragePolicy, CoverageResult, CoverageSamplingMetadata, UnavailableCoverage, CoverageStrategy, Footprint, PlanMetrics, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { polygonLocalGeometry, validatePolygon, type PolygonLocalGeometry } from "./geometry";
import { createFootprintContainmentTester, createSkyToLocalProjector, footprintArea, footprintCharacteristicScale, footprintIntersectsRegion, footprintLocalBounds } from "./footprint-engine";
import { coverageBasisForRun, coverageGeometryContext, coverageSemanticsForTile, tileContributesToBasis } from "./coverage-semantics";
import { coverageErrorBound } from "./coverage-error";
import type { Center } from "./grid";
import { modulo, radians, roundDecimal, wrappedRaDelta } from "./math";
import { DEFAULT_PROFILE, SPLUS_SURVEY_V2 } from "../profiles";
import { resolvePlanningProfile } from "../profiles/planning";
import { outputFootprintForProfile } from "../profiles/footprints";
import { profileRegistry, type ProfileRegistry } from "../profiles/registry";
import { pointingGeometriesIntersectRegion, createPointingUnionAreaMeasurer, resolvePointingGeometries, type PointingGeometryContext } from "./pointing-geometry";

// Minimum eight cells per axis is a frozen compatibility algorithm rule.
// Scientific resolution and budget come from the validated survey profile.
const LEGACY_MIN_POLYGON_SAMPLES_PER_AXIS = 8;
type BoundaryGeometry = { center: Center; footprint: Footprint };
const maskGeometries = new WeakMap<Uint8Array, BoundaryGeometry[]>();
const gridPolygons = new WeakMap<CoverageGrid, SkyPolygon>();
const MIN_INCREMENTAL_GAIN = 1e-10;
type FootprintGeometry = Footprint | Pick<TilingProfile, "tile_width_deg" | "tile_height_deg">;

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
  /** Unrounded generic resolution; absent on the compatibility path. */
  sampling?: CoverageSamplingMetadata;
  coverageBasis?: CoverageMeasurementBasis;
  geometryBasis?: "single_exposure" | "effective_sequence";
  contributingSemantics?: PlanMetrics["contributing_semantics"];
  outputSemantics?: { role: CoverageMeasurementBasis; fidelity: "exact" | "approximate" | null };
  /** Boundary geometries used for the deterministic numerical bound. */
  boundaryGeometries?: { center: Center; footprint: Footprint }[];
}

/** One chosen center and its selected-region footprint mask. */
export interface MaskedCenter {
  center: Center;
  mask: Uint8Array;
  /** Exact user-declared lattice identity, retained unchanged by greedy selection. */
  latticeSite?: { i: number; j: number };
  /** Physical area used for outside-region metrics when this is a sequence union. */
  physicalAreaDeg2?: number;
  boundaryGeometries?: { center: Center; footprint: Footprint }[];
}

/** Sample an ICRS region with footprint-relative resolution and a bounded grid.
 *
 * The principal set is the entire rectangular row-major grid, including
 * zero-weight polygon-exterior cells; the policy bounds its actual array length.
 * Cells evenly subdivide the full unwrapped bounds, with centers at half a cell
 * from the southwest edge. Rows increase DEC; columns increase unwrapped RA.
 * The existing strict ray-crossing polygon mask and cos(DEC) weights are retained.
 * Cell widths are at most the effective pitch in every contributing local frame.
 *
 * @param polygon - Validated ordered ICRS vertices in decimal-degree RA/DEC.
 * @param footprint - Output footprint in local degrees. Omit only for frozen legacy callers.
 * @param policy - Validated numerical policy; required with a footprint, density >= 8.
 * @param contributingFootprints - Basis-filtered positive-area footprints, including
 *   individual effective exposures; their minimum scale controls resolution.
 * @returns Weighted grid and unrounded audit metadata for generic sampling.
 *   The one-argument compatibility adapter retains the historical 0.01° layout.
 * @throws If arguments are unpaired, resolution/policy is invalid, or no cell is selected.
 */
export function sampleRegion(polygon: SkyPolygon, footprint?: Footprint, policy?: CoveragePolicy, contributingFootprints?: readonly Footprint[]): CoverageGrid {
  if (Boolean(footprint) !== Boolean(policy)) throw new Error("Coverage sampling requires both footprint and policy");
  const geometry = polygonLocalGeometry(polygon);
  const layout = footprint && policy
    ? scaleAwareSampleLayout(geometry, footprint, policy, contributingFootprints)
    : legacySampleLayout(geometry, DEFAULT_PROFILE.tile_width_deg / SPLUS_SURVEY_V2.coverage.sampling.target_samples_per_footprint_axis, SPLUS_SURVEY_V2.coverage.sampling.max_samples);
  return sampleBounds(geometry, polygon, layout);
}

/** Sample using the historical layout with profile-supplied resolution and budget.
 * @param polygon - Ordered ICRS region vertices in decimal degrees.
 * @param gridExtent - Declared legacy seed [width, height] in degrees, not runtime bounds.
 * @param policy - Validated survey CoveragePolicy; density sets the nominal pitch
 *   relative to the smaller legacy grid axis. The layout retains its eight-cell
 *   minimum and historical metric shape, without generic runtime sampling metadata.
 * @returns Declination-weighted historical sampling grid.
 * @throws If resolution is invalid or the budget cannot fit the eight-by-eight minimum.
 */
export function sampleLegacyRegion(polygon: SkyPolygon, gridExtent: [number, number], policy: CoveragePolicy): CoverageGrid {
  const step = Math.min(...gridExtent) / policy.sampling.target_samples_per_footprint_axis;
  const budget = policy.sampling.max_samples;
  if (!Number.isFinite(step) || step <= 0 || !Number.isSafeInteger(budget) || budget < LEGACY_MIN_POLYGON_SAMPLES_PER_AXIS ** 2) {
    throw new Error("Legacy coverage sampling requires positive resolution and a budget of at least 64 samples");
  }
  const geometry = polygonLocalGeometry(polygon);
  return sampleBounds(geometry, polygon, legacySampleLayout(geometry, step, budget));
}

interface SampleLayout {
  rows: number;
  cols: number;
  step: number;
  sampling?: CoverageSamplingMetadata;
}

/** Fit a diagnostic grid within the cap; flag any loss of required resolution. */
function scaleAwareSampleLayout({ bounds }: PolygonLocalGeometry, footprint: Footprint, policy: CoveragePolicy, contributors: readonly Footprint[] = [footprint]): SampleLayout {
  const { target_samples_per_footprint_axis: density, max_samples: maxSamples } = policy.sampling;
  if (!Number.isSafeInteger(density) || density < 8) throw new Error("Target samples per footprint axis must be a positive finite integer >= 8");
  if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) throw new Error("Maximum coverage samples must be a positive finite integer");
  const scale = contributors.reduce((minimum, item) => Math.min(minimum, footprintCharacteristicScale(item)), Infinity);
  const naturalStep = scale / density;
  if (!Number.isFinite(naturalStep) || naturalStep <= 0) throw new Error("Natural coverage sample step must be finite and positive");
  // A footprint intersecting the region has its center within the region DEC
  // range expanded by its rotated north reach. Use the largest cosine in that
  // interval, so RA cells meet the required east pitch in every contributor's
  // own frame, including pointings outside the polygon. Cos(DEC) weighting and
  // the sky/local mapping are unchanged.
  const northReach = contributors.reduce((maximum, item) => {
    const extent = footprintLocalBounds(item);
    return Math.max(maximum, Math.abs(extent.min_north_deg), Math.abs(extent.max_north_deg));
  }, 0);
  const low = Math.max(-90, bounds.dec_min_deg - northReach);
  const high = Math.min(90, bounds.dec_max_deg + northReach);
  const eastCosine = low <= 0 && high >= 0 ? 1 : Math.max(Math.cos(radians(low)), Math.cos(radians(high)), 0.01);
  const width = bounds.ra_span_deg * eastCosine;
  const height = bounds.dec_max_deg - bounds.dec_min_deg;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Coverage sample bounds must have finite positive extents");
  const dimensions = (step: number) => ({ rows: Math.max(1, Math.ceil(height / step)), cols: Math.max(1, Math.ceil(width / step)) });
  let step = naturalStep;
  let { rows, cols } = dimensions(step);
  const requiredCount = rows * cols;
  const budgetLimited = rows > maxSamples / cols;
  if (budgetLimited) {
    // Inverse-square density estimate, with a separate one-cell case. Taking
    // square roots separately avoids overflowing the initial candidate product.
    step = Math.max(step, maxSamples === 1 ? Math.max(width, height) : Math.sqrt(width) * Math.sqrt(height / maxSamples));
    ({ rows, cols } = dimensions(step));
    while (rows > maxSamples / cols) {
      // Ceilings and long thin regions need correction. Force at least one
      // row/column transition, rather than iterating toward a threshold forever.
      const nextTransition = Math.min(rows > 1 ? height / (rows - 1) : Infinity, cols > 1 ? width / (cols - 1) : Infinity);
      step = Math.max(step * Math.sqrt(rows) * Math.sqrt(cols / maxSamples), nextTransition * (1 + 4 * Number.EPSILON));
      ({ rows, cols } = dimensions(step));
    }
  }
  return { rows, cols, step, sampling: {
    status: budgetLimited ? "under_resolved" : "resolved", required_sample_count: Number.isSafeInteger(requiredCount) ? requiredCount : null, row_count: rows, column_count: cols,
    characteristic_scale_deg: scale, natural_step_deg: naturalStep, effective_step_deg: step,
    sample_count: rows * cols, max_samples: maxSamples, budget_limited: budgetLimited,
    east_projection_cosine: eastCosine, cell_width_deg: width / cols, cell_height_deg: height / rows,
  } };
}

/** Frozen v0.2.0 layout, including its minimum eight cells per axis. */
function legacySampleLayout({ bounds }: PolygonLocalGeometry, nominalStep: number, maxSamples: number): SampleLayout {
  const centerDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const widthDeg = bounds.ra_span_deg * Math.max(Math.cos(radians(centerDec)), 0.01);
  const heightDeg = bounds.dec_max_deg - bounds.dec_min_deg;
  let step = Math.max(nominalStep, Math.sqrt(Math.max(widthDeg * heightDeg, nominalStep ** 2) / maxSamples));
  let rows = Math.max(1, Math.ceil(heightDeg / step));
  let cols = Math.max(1, Math.ceil(bounds.ra_span_deg / step));
  if (rows * cols > maxSamples) {
    step *= Math.sqrt(rows * cols / maxSamples);
    rows = Math.max(1, Math.ceil(heightDeg / step));
    cols = Math.max(1, Math.ceil(bounds.ra_span_deg / step));
  }
  rows = Math.max(rows, LEGACY_MIN_POLYGON_SAMPLES_PER_AXIS);
  cols = Math.max(cols, LEGACY_MIN_POLYGON_SAMPLES_PER_AXIS);
  while (rows * cols > maxSamples) {
    if (rows >= cols) rows -= 1;
    else cols -= 1;
  }
  step = Math.max(heightDeg / rows, bounds.ra_span_deg / cols);
  return { rows, cols, step };
}

function sampleBounds(
  { bounds, originRaDeg, ra: polygonX }: PolygonLocalGeometry,
  polygon: SkyPolygon,
  { rows, cols, step, sampling }: SampleLayout,
): CoverageGrid {
  const centerDec = (bounds.dec_min_deg + bounds.dec_max_deg) / 2;
  const heightDeg = bounds.dec_max_deg - bounds.dec_min_deg;
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
  if (!selectedSamples && sampling?.status !== "under_resolved") throw new Error("Polygon is too small for the coverage sample resolution");
  const grid: CoverageGrid = {
    ra, dec, weights, totalWeight, stepDeg: step,
    ...(sampling ? { sampling: { ...sampling, sample_count: ra.length } } : {}),
    centerRaDeg: modulo(originRaDeg + bounds.ra_span_deg / 2, 360),
    centerDecDeg: centerDec, raSpanDeg: bounds.ra_span_deg,
    decMinDeg: bounds.dec_min_deg, decMaxDeg: bounds.dec_max_deg,
    cellAreaDeg2: (bounds.ra_span_deg / cols) * (heightDeg / rows),
  };
  gridPolygons.set(grid, polygon);
  return grid;
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
  return createTileMasker(grid)(raDeg, decDeg, geometry);
}

/** Prepare immutable footprint testers and bounds for one coverage operation.
 *
 * @param grid - Fixed ICRS RA/DEC degree arrays and selected-region weights.
 * @returns A mask builder taking ICRS center degrees and local-degree geometry.
 *   Structurally identical footprints share preparation only within this closure.
 *   Conservative sample rejection does not change grid density or projection.
 */
export function createTileMasker(grid: CoverageGrid): (raDeg: number, decDeg: number, geometry: FootprintGeometry) => Uint8Array {
  const footprints = new Map<string, { contains: ReturnType<typeof createFootprintContainmentTester>; bounds: ReturnType<typeof footprintLocalBounds>; padding: number }>();
  return (raDeg, decDeg, geometry) => {
    const footprint = toFootprint(geometry);
    const mask = new Uint8Array(grid.ra.length);
    maskGeometries.set(mask, [{ center: [raDeg, decDeg], footprint }]);
    const pointing = { ra_deg: raDeg, dec_deg: decDeg };
    const project = createSkyToLocalProjector(pointing);
    const key = JSON.stringify(footprint);
    let prepared = footprints.get(key);
    if (!prepared) {
      prepared = { contains: createFootprintContainmentTester(footprint), bounds: footprintLocalBounds(footprint), padding: containmentRejectionPadding(footprint) };
      footprints.set(key, prepared);
    }
    const { contains, bounds: footprintBounds } = prepared;
    // Bounds rejection includes the frozen containment predicate's tolerances,
    // including polygon cross/dot tests whose angular reach scales with edge
    // length. The ulp margin protects arithmetic at large local extents.
    const tolerance = prepared.padding + 8 * Number.EPSILON * Math.max(1, ...Object.values(footprintBounds).map(Math.abs));
    const centerRaDelta = wrappedRaDelta(grid.centerRaDeg, raDeg);
    const halfRaSpan = grid.raSpanDeg / 2;
    if (Math.abs(centerRaDelta) + halfRaSpan < 180) {
      const eastScale = Math.max(Math.cos(radians(decDeg)), 0.01);
      const minEast = (centerRaDelta - halfRaSpan) * eastScale;
      const maxEast = (centerRaDelta + halfRaSpan) * eastScale;
      const minNorth = grid.decMinDeg - decDeg;
      const maxNorth = grid.decMaxDeg - decDeg;
      const rejectionTolerance = 1e-12;
      if (maxEast < footprintBounds.min_east_deg - rejectionTolerance || minEast > footprintBounds.max_east_deg + rejectionTolerance ||
        maxNorth < footprintBounds.min_north_deg - rejectionTolerance || minNorth > footprintBounds.max_north_deg + rejectionTolerance) return mask;
    }
    const localPoint: [number, number] = [0, 0];
    for (let index = 0; index < mask.length; index += 1) {
      if (grid.weights[index] > 0) {
        const north = grid.dec[index] - decDeg;
        if (north < footprintBounds.min_north_deg - tolerance || north > footprintBounds.max_north_deg + tolerance) continue;
        project(grid.ra[index], grid.dec[index], localPoint);
        if (localPoint[0] < footprintBounds.min_east_deg - tolerance || localPoint[0] > footprintBounds.max_east_deg + tolerance) continue;
        if (contains(localPoint[0], localPoint[1])) mask[index] = 1;
      }
    }
    return mask;
  };
}

/** Conservative angular allowance for the existing inclusive shape predicates. */
function containmentRejectionPadding(footprint: Footprint): number {
  if (footprint.type === "compound") return Math.max(2e-12, ...footprint.components.map((child) => containmentRejectionPadding(child.footprint)));
  if (footprint.type !== "polygon") return 2e-12;
  let padding = 2e-12;
  for (let index = 0; index < footprint.vertices_deg.length; index += 1) {
    const start = footprint.vertices_deg[index]; const end = footprint.vertices_deg[(index + 1) % footprint.vertices_deg.length];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    // A degenerate edge has unbounded legacy boundary allowance. Refuse to
    // prune it, rather than repairing or altering the scientific predicate.
    if (length * length === 0) return Infinity;
    padding = Math.max(padding, 4e-12 * Math.max(1, length) / length);
  }
  return padding;
}

/** Union enabled existing pointings over weighted selected-region samples.
 * @param grid - Selected polygon sample grid.
 * @param tiles - Enabled original and accepted proposal records.
 * @param profile - Active output planner profile; its linked instrument supplies proposal geometry.
 * @param registry - Session-local registry used to resolve source dataset geometry.
 * @param geometryContext - Optional PA and sequence selection. Omission retains Schema v2 geometry.
 * @returns Binary union mask aligned with the grid.
 * @throws If an associated source or active output instrument is unknown.
 */
export function coveredMask(
  grid: CoverageGrid,
  tiles: readonly TileRecord[],
  profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
  geometryContext?: PointingGeometryContext,
): Uint8Array {
  const covered = new Uint8Array(grid.ra.length);
  const maskForTile = createTileMasker(grid);
  const footprints = new Map<string, Footprint>();
  const outputFootprint = outputFootprintForProfile(profile, registry);
  let selectedSampleCount = 0;
  for (const weight of grid.weights) if (weight > 0) selectedSampleCount += 1;
  let coveredCount = 0;
  const boundaries: BoundaryGeometry[] = [];
  maskGeometries.set(covered, boundaries);
  for (const tile of tiles) {
    if (!tileContributesToBasis(tile, profile, registry, grid.coverageBasis ?? coverageBasisForRun(profile, registry, geometryContext))) continue;
    let footprint = outputFootprint;
    if (tile.source === "original" && tile.instrument_profile_id) {
      const cached = footprints.get(tile.instrument_profile_id);
      footprint = cached ?? registry.resolveInstrumentProfile(tile.instrument_profile_id).footprint;
      footprints.set(tile.instrument_profile_id, footprint);
    }
    const geometries = geometryContext
      ? resolvePointingGeometries(tile, profile, registry, geometryContext)
      : [{ center: [tile.ra_deg, tile.dec_deg] as [number, number], footprint }];
    for (const geometry of geometries) {
      boundaries.push(geometry);
      const mask = maskForTile(geometry.center[0], geometry.center[1], geometry.footprint);
      for (let index = 0; index < mask.length; index += 1) {
        if (mask[index] && !covered[index]) { covered[index] = 1; coveredCount += 1; }
      }
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
 * @param geometryContext - Optional PA and sequence selection. One tile counts once if any exposure intersects.
 * @returns Number of source or proposal footprints intersecting positive polygon area.
 * @throws If an associated source or active output instrument is unknown.
 */
export function contributingTileCountForTiles(
  polygon: SkyPolygon,
  tiles: readonly TileRecord[],
  profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
  geometryContext?: PointingGeometryContext,
): number {
  const footprints = new Map<string, Footprint>();
  const outputFootprint = outputFootprintForProfile(profile, registry);
  let total = 0;
  for (const tile of tiles) {
    if (!tileContributesToBasis(tile, profile, registry, coverageBasisForRun(profile, registry, geometryContext))) continue;
    let footprint = outputFootprint;
    if (tile.source === "original" && tile.instrument_profile_id) {
      const cached = footprints.get(tile.instrument_profile_id);
      footprint = cached ?? registry.resolveInstrumentProfile(tile.instrument_profile_id).footprint;
      footprints.set(tile.instrument_profile_id, footprint);
    }
    if (geometryContext) {
      const geometries = resolvePointingGeometries(tile, profile, registry, geometryContext);
      if (pointingGeometriesIntersectRegion(geometries, polygon)) total += 1;
    } else if (footprintIntersectsRegion(footprint, tile, polygon)) total += 1;
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

/** Subtract sampled in-region area from the operation's physical area in deg². */
function outsideTileArea(mask: Uint8Array, grid: CoverageGrid, physicalAreaDeg2: number): number {
  return Math.max(0, physicalAreaDeg2 - weightSum(grid, mask) * grid.cellAreaDeg2);
}

/** Reasons reported by the unchanged selection stopping conditions. */
export type SelectionStop = "coverage_complete" | "candidate_lattice_exhausted" | "gain_safeguard" | "marginal_efficiency";

/** Greedily select centers by incremental coverage and Python's ordered tie breaks.
 * @param candidates - Unoccupied useful centers in deterministic grid order;
 *   effective-sequence candidates may supply their overlap-aware union area.
 * @param existingMask - Existing selected-region coverage mask.
 * @param grid - Weighted ICRS samples.
 * @param geometry - Schema v2 output footprint or legacy rectangular dimensions.
 * @param automaticTarget - Optional target fraction for automatic region planning.
 * @param strategy - Complete sampled coverage or the efficient policy. The latter
 *   compares declination-weighted new sampled area in square degrees with physical
 *   footprint area in square degrees after the profile coverage floor is reached.
 * @param efficientPolicy - Active survey's stopping thresholds; required for
 *   Efficient, ignored by Complete. Legacy v1 callers resolve these via the
 *   compatibility adapter, never through generic defaults.
 *   Compound area inherits Gate 3's deterministic adaptive union estimate,
 *   preserving detector gaps and counting overlaps once. The same area is
 *   computed once per selection, independent of candidate count.
 * @param onStop - Optional diagnostic callback; does not influence selection or thresholds.
 * @returns Chosen centers in ranking order with their masks. Sparse mask indices
 *   and immutable scores are scoped to this call; weighted sums retain ascending
 *   sample order, with no subtraction-based or parallel floating-point reduction.
 * @throws If Efficient is requested without explicit policy.
 */
export function greedyChoose(candidates: readonly MaskedCenter[], existingMask: Uint8Array, grid: CoverageGrid, geometry: FootprintGeometry, automaticTarget?: number, strategy: CoverageStrategy = "complete", efficientPolicy?: CoveragePolicy["efficient"], onStop?: (reason: SelectionStop) => void): MaskedCenter[] {
  assertResolvedCoverage(grid);
  if (strategy === "efficient" && !efficientPolicy) throw new Error("Efficient selection requires coverage.efficient policy");
  const footprint = toFootprint(geometry);
  const physicalAreaDeg2 = footprintArea(footprint);
  const uncovered = new Uint8Array(existingMask.length);
  for (let index = 0; index < uncovered.length; index += 1) uncovered[index] = existingMask[index] ? 0 : 1;
  const selected: MaskedCenter[] = [];
  // Operation-local sparse indices retain ascending sample order, including
  // zero-weight cells. Static sums are evaluated exactly as in the full scan.
  const remaining = candidates.map((candidate) => {
    const samples: number[] = [];
    let insideWeight = 0;
    for (let sample = 0; sample < candidate.mask.length; sample += 1) {
      if (candidate.mask[sample]) { samples.push(sample); insideWeight += grid.weights[sample]; }
    }
    return { candidate, samples: Uint32Array.from(samples), inside: Math.max(insideWeight, 1e-12),
      outsideArea: Math.max(0, (candidate.physicalAreaDeg2 ?? physicalAreaDeg2) - insideWeight * grid.cellAreaDeg2) };
  });
  let stop: SelectionStop = "candidate_lattice_exhausted";
  while (remaining.length) {
    const currentCoverage = 1 - weightSum(grid, uncovered) / Math.max(grid.totalWeight, 1e-12);
    if (automaticTarget !== undefined && currentCoverage >= automaticTarget) { stop = "coverage_complete"; break; }
    let bestIndex = -1;
    let bestScore: number[] | null = null;
    for (let index = 0; index < remaining.length; index += 1) {
      const { candidate: { center: [ra, dec] }, samples, inside, outsideArea } = remaining[index];
      let gain = 0;
      let overlap = 0;
      for (const sample of samples) {
        if (uncovered[sample]) gain += grid.weights[sample];
        else overlap += grid.weights[sample];
      }
      const score = [gain, -overlap / inside, -outsideArea, -dec, -ra, index];
      if (bestScore === null || compareScore(score, bestScore) > 0) { bestScore = score; bestIndex = index; }
    }
    const { candidate: best, samples } = remaining.splice(bestIndex, 1)[0];
    const gain = bestScore![0];
    if (gain / Math.max(grid.totalWeight, 1e-12) < MIN_INCREMENTAL_GAIN) { stop = "gain_safeguard"; break; }
    const marginalEfficiency = gain * grid.cellAreaDeg2 / (best.physicalAreaDeg2 ?? physicalAreaDeg2);
    if (strategy === "efficient" && efficientPolicy && currentCoverage >= efficientPolicy.min_coverage && marginalEfficiency < efficientPolicy.min_marginal_efficiency) { stop = "marginal_efficiency"; break; }
    selected.push(best);
    for (const sample of samples) uncovered[sample] = 0;
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

/** Measure existing, incremental, redundant, and outside-polygon tile coverage.
 * @param selected - Enabled chosen centers with footprint masks.
 * @param existingMask - Existing field coverage of selected samples.
 * @param grid - Weighted ICRS polygon samples.
 * @param contributing - Number of actual footprints with positive geometric intersection.
 * @param geometry - Schema v2 output footprint or legacy rectangular tile dimensions.
 *   Its physical area is the fallback for each selected mask; effective-sequence
 *   proposals may carry their own overlap-aware union area.
 * @returns Applicable-basis fractions, areas in square degrees, counts and generic
 *   numerical bounds; pure historical grids retain separately labeled metrics.
 * @throws {CoverageUnavailableError} If required generic resolution exceeds the cap.
 */
export function measureMetrics(selected: readonly MaskedCenter[], existingMask: Uint8Array, grid: CoverageGrid, contributing: number, geometry: FootprintGeometry): PlanMetrics {
  assertResolvedCoverage(grid);
  const footprint = toFootprint(geometry);
  const physicalAreaDeg2 = footprintArea(footprint);
  const covered = existingMask.slice();
  const newCovered = new Uint8Array(covered.length);
  let proposedSampleWeight = 0;
  let redundantSampleWeight = 0;
  let outsideArea = 0;
  for (const { mask, physicalAreaDeg2: selectedPhysicalArea } of selected) {
    redundantSampleWeight += weightSum(grid, mask, covered);
    proposedSampleWeight += weightSum(grid, mask);
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index]) { if (!covered[index]) newCovered[index] = 1; covered[index] = 1; }
    }
    outsideArea += outsideTileArea(mask, grid, selectedPhysicalArea ?? physicalAreaDeg2);
  }
  const total = Math.max(grid.totalWeight, 1e-12);
  const totalCoverage = weightSum(grid, covered) / total;
  const alreadyCovered = weightSum(grid, existingMask) / total;
  const incremental = weightSum(grid, newCovered) / total;
  const redundant = selected.length ? redundantSampleWeight / Math.max(proposedSampleWeight, 1e-12) : 0;
  const area = grid.totalWeight * grid.cellAreaDeg2;
  const unknownBoundary = (!maskGeometries.has(existingMask) && existingMask.some(Boolean)) ||
    selected.some((item) => !item.boundaryGeometries && !maskGeometries.has(item.mask) && item.mask.some(Boolean));
  const boundaries = [
    ...(maskGeometries.get(existingMask) ?? grid.boundaryGeometries ?? []),
    ...selected.flatMap((item) => item.boundaryGeometries ?? maskGeometries.get(item.mask) ?? [{ center: item.center, footprint }]),
  ];
  const errorBound = grid.sampling && gridPolygons.has(grid)
    ? coverageErrorBound(grid, gridPolygons.get(grid)!, boundaries, unknownBoundary) : undefined;
  return {
    coverage_basis: grid.coverageBasis ?? "legacy_v2", coverage_status: grid.sampling ? "resolved" : "legacy_compatible",
    authoritative_observed_area: grid.coverageBasis === "observed_area" && grid.sampling?.status === "resolved",
    geometry_basis: grid.geometryBasis ?? "single_exposure",
    ...(grid.contributingSemantics ? { contributing_semantics: uniqueSemantics([...grid.contributingSemantics, ...(selected.length && grid.outputSemantics ? [grid.outputSemantics] : [])]) } : {}),
    ...(errorBound ? { error_bound: errorBound } : {}),
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
    ...(grid.sampling ? { sampling: { ...grid.sampling } } : {}),
  };
}

/** Recalculate sampled coverage after proposal toggles without replacing centers.
 * @param polygon - Validated ICRS selected region in decimal degrees.
 * @param existingTiles - All original and accepted pointings; disabled proposals are ignored.
 * @param proposedTiles - Editable proposal preview; only enabled records contribute.
 * @param profileId - Registered survey, bundled preset, or custom profile ID.
 * @param inlineProfile - Session-only custom rectangle or runtime project coverage
 *   bridge from `projectCoverageProfile`; never a persisted survey declaration.
 * @param registry - Session-local registry used to resolve source instrument profiles.
 * @param geometryContext - Optional PA and single/effective-sequence coverage basis.
 * @returns Resolved basis-labeled metrics, or a machine-readable unavailable result
 *   with no numeric area/fraction fields. Target access is never an area metric.
 * @throws On invalid polygon/profile, unknown instrument ID,
 *   or non-proposal editable record.
 */
export function measureActiveCoverage(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  proposedTiles: TileRecord[],
  profileId = DEFAULT_PROFILE.id,
  inlineProfile?: TilingProfile,
  registry: ProfileRegistry = profileRegistry,
  geometryContext?: PointingGeometryContext,
): CoverageResult {
  validatePolygon(polygon);
  if (existingTiles.length > 20_000 || proposedTiles.length > 500) throw new Error("Too many tile records");
  if (proposedTiles.some((tile) => tile.source !== "proposed")) throw new Error("Coverage edits may contain only proposed tiles");
  const profile = inlineProfile && "project_instrument_id" in inlineProfile
    ? inlineProfile : resolvePlanningProfile(profileId, inlineProfile, registry).profile;
  const outputFootprint = outputFootprintForProfile(profile, registry);
  const activeExisting = existingTiles.filter((tile) => tile.enabled !== false);
  const activeProposed = proposedTiles.filter((tile) => tile.enabled !== false);
  const context = coverageGeometryContext([...activeExisting, ...activeProposed], profile, registry, geometryContext);
  geometryContext = context;
  const basis = coverageBasisForRun(profile, registry, context);
  if (basis === "target_access") return { coverage_basis: basis, coverage_status: "unsupported_basis" };
  if (![...activeExisting, ...activeProposed].some((tile) => tileContributesToBasis(tile, profile, registry, basis)) &&
    ([...activeExisting, ...activeProposed].length || !tileContributesToBasis({ source: "proposed" } as TileRecord, profile, registry, basis))) {
    return { coverage_basis: basis, coverage_status: "no_contributors" };
  }
  const grid = prepareCoverageGrid(polygon, activeExisting, profile, registry, context, activeProposed);
  if (grid.sampling?.status === "under_resolved") return unavailableCoverage(grid);
  const existing = coveredMask(grid, activeExisting, profile, registry, geometryContext);
  const maskForTile = createTileMasker(grid);
  const unionArea = createPointingUnionAreaMeasurer();
  const selected = activeProposed.filter((tile) => tileContributesToBasis(tile, profile, registry, basis)).map((tile) => {
    if (!geometryContext) {
      return { center: [tile.ra_deg, tile.dec_deg] as Center, mask: maskForTile(tile.ra_deg, tile.dec_deg, outputFootprint) };
    }
    const sequence = geometryContext.coverageBasis === "effective_sequence"
      ? geometryContext.sequenceForTile?.(tile)
      : undefined;
    const tileGeometryContext = sequence === undefined
      ? geometryContext
      : { ...geometryContext, sequenceForTile: () => sequence };
    const geometries = resolvePointingGeometries(tile, profile, registry, tileGeometryContext);
    const mask = new Uint8Array(grid.ra.length);
    for (const pointingGeometry of geometries) {
      const exposureMask = maskForTile(pointingGeometry.center[0], pointingGeometry.center[1], pointingGeometry.footprint);
      for (let index = 0; index < mask.length; index += 1) if (exposureMask[index]) mask[index] = 1;
    }
    const physicalAreaDeg2 = sequence
      ? unionArea(geometries, { ra_deg: tile.ra_deg, dec_deg: tile.dec_deg })
      : undefined;
    return { center: [tile.ra_deg, tile.dec_deg] as Center, mask, boundaryGeometries: geometries, ...(physicalAreaDeg2 === undefined ? {} : { physicalAreaDeg2 }) };
  });
  return measureMetrics(selected, existing, grid, contributingTileCountForTiles(polygon, activeExisting, profile, registry, geometryContext), outputFootprint);
}

/** Machine-readable scientific refusal, also used by Complete/Efficient planning. */
export class CoverageUnavailableError extends Error {
  /**
   * @param result - Unavailable metric, containing no numeric coverage claims.
   */
  constructor(public readonly result: UnavailableCoverage) {
    super(`Coverage status: ${result.coverage_status} (${result.coverage_basis}); no authoritative area fraction is available.`);
    this.name = "CoverageUnavailableError";
  }
}

/** Extract budget metadata without publishing diagnostic coarse fractions.
 * @param grid - Generic diagnostic grid.
 * @returns Explicit unavailable result without fraction or completion fields.
 */
export function unavailableCoverage(grid: CoverageGrid): UnavailableCoverage {
  return { coverage_basis: grid.coverageBasis ?? "legacy_v2", coverage_status: "under_resolved", sampling: grid.sampling };
}

/** Refuse using an unresolved grid for metrics or greedy selection.
 * @param grid - Grid whose resolution was decided before allocation.
 * @throws {CoverageUnavailableError} If the correctness pitch exceeds the budget.
 */
export function assertResolvedCoverage(grid: CoverageGrid): void {
  if (grid.sampling?.status === "under_resolved") throw new CoverageUnavailableError(unavailableCoverage(grid));
}

/** Construct a basis-filtered grid from all positive-area effective contributors.
 *
 * Pure compatibility geometry retains its historical layout. Mixed scales and
 * any v3 geometry use the generic hard-budget contract; v2 stays unclassified.
 * Candidate geometry participates for planning, independently of source masks.
 *
 * @param polygon - Validated ICRS region in degrees.
 * @param tiles - Enabled actual pointings, before greedy selection.
 * @param profile - Registered survey bridge or inline legacy rectangle.
 * @param registry - Session profiles; no persisted profile is mutated.
 * @param context - Scientific basis and Gate 5 geometry choices.
 * @param candidates - Optional nominal output pointings for planning resolution.
 * @returns Weighted grid, basis, and boundary geometries for error bounds.
 */
export function prepareCoverageGrid(
  polygon: SkyPolygon, tiles: readonly TileRecord[], profile: TilingProfile,
  registry: ProfileRegistry = profileRegistry, context?: PointingGeometryContext,
  candidates: readonly TileRecord[] = [],
): CoverageGrid {
  const basis = coverageBasisForRun(profile, registry, context);
  context = coverageGeometryContext([...tiles, ...candidates], profile, registry, context);
  const footprint = outputFootprintForProfile(profile, registry);
  const survey = ("project_instrument_id" in profile || (profile.id === "custom" && profile.algorithm === "RECT_GRID_V1")) ? undefined : registry.findAnySurveyProfile(profile.id);
  const all = [...tiles, ...candidates];
  const sourceSet = new Set(tiles);
  const candidateSet = new Set(candidates);
  const eligible = all.filter((tile) => tileContributesToBasis(tile, profile, registry, basis));
  const resolved = eligible.map((tile) => ({ tile, geometries: resolveSamplingGeometries(tile, profile, registry, context, candidateSet.has(tile))
    .filter((geometry) => footprintIntersectsRegion(geometry.footprint, { ra_deg: geometry.center[0], dec_deg: geometry.center[1] }, polygon)) }));
  const geometries = resolved.flatMap((item) => item.geometries);
  const scales = geometries.map((geometry) => footprintCharacteristicScale(geometry.footprint));
  const outputScale = footprintCharacteristicScale(footprint);
  const mixedScale = scales.some((scale) => scale !== outputScale);
  const hasV3 = survey?.schema_version === 3 || coverageSemanticsForTile({ source: "proposed" } as TileRecord, profile, registry) !== undefined ||
    all.some((tile) => coverageSemanticsForTile(tile, profile, registry) !== undefined);
  const compatibility = basis === "legacy_v2" && !mixedScale && !hasV3 && (!survey || survey.tiling.type === "legacy_splus");
  const policy = survey?.coverage ?? SPLUS_SURVEY_V2.coverage;
  if (context?.targetSamplesPerFootprintAxis !== undefined && (!Number.isSafeInteger(context.targetSamplesPerFootprintAxis) || context.targetSamplesPerFootprintAxis < 8)) throw new Error("Run-level coverage density must be an integer >= 8");
  const density = survey?.schema_version === 3 ? survey.coverage.target_samples_per_footprint_axis
    : mixedScale || hasV3 ? Math.max(8, context?.targetSamplesPerFootprintAxis ?? 8)
      : Math.max(8, policy.sampling.target_samples_per_footprint_axis);
  if (!Number.isSafeInteger(density) || density < 8) throw new Error("Coverage density must be an integer >= 8");
  const grid = compatibility
    ? survey?.tiling.type === "legacy_splus" ? sampleLegacyRegion(polygon, survey.tiling.grid_extent_deg, policy) : sampleRegion(polygon)
    : sampleRegion(polygon, footprint, { ...policy, sampling: { ...policy.sampling, target_samples_per_footprint_axis: density } },
      geometries.length ? geometries.map((geometry) => geometry.footprint) : [footprint]);
  grid.coverageBasis = basis;
  grid.geometryBasis = context?.coverageBasis ?? "single_exposure";
  const outputSemantics = coverageSemanticsForTile({ source: "proposed" } as TileRecord, profile, registry);
  grid.outputSemantics = { role: outputSemantics?.role ?? "legacy_v2", fidelity: outputSemantics?.fidelity ?? null };
  grid.contributingSemantics = [...new Map(resolved.filter((item) => item.geometries.length && sourceSet.has(item.tile)).map(({ tile }) => {
    const semantics = coverageSemanticsForTile(tile, profile, registry);
    const value = { role: semantics?.role ?? "legacy_v2" as const, fidelity: semantics?.fidelity ?? null };
    return [JSON.stringify(value), value] as const;
  })).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  grid.boundaryGeometries = resolved.filter((item) => sourceSet.has(item.tile)).flatMap((item) => item.geometries);
  return grid;
}

function resolveSamplingGeometries(tile: TileRecord, profile: TilingProfile, registry: ProfileRegistry, context: PointingGeometryContext | undefined, candidate: boolean) {
  try { return resolvePointingGeometries(tile, profile, registry, context); }
  catch (error) {
    if (candidate && error instanceof Error && /per-pointing PA policy requires/i.test(error.message)) {
      throw new Error("Automatic planner proposals cannot satisfy required per-pointing PA; select PA for each proposed pointing before planning.");
    }
    throw error;
  }
}

function uniqueSemantics(values: NonNullable<PlanMetrics["contributing_semantics"]>): NonNullable<PlanMetrics["contributing_semantics"]> {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
