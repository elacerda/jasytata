import type {
  CenterInput, GenericLatticeTiling, InferencePolicy, LatticeAssignment, LatticeInferenceOutcome,
  LatticeInferenceResult, SurveyProfileV2, TangentPlaneOffset, TileRecord,
} from "../types";
import { localOffsetToSky, rotateLocalOffset, skyToLocalOffset } from "./footprint-engine";
import { modulo } from "./math";

type Basis = GenericLatticeTiling["basis_deg"];
type Point = { tile: TileRecord; p: TangentPlaneOffset };
type Pair = { a: number; b: number; delta: TangentPlaneOffset; offsets: TangentPlaneOffset[] };
const TAU = 2 * Math.PI;
// Dimensionless roundoff allowance, not an angular or scientific acceptance threshold.
const EPSILON = 1e-10;
const NEIGHBOR_ORDER = 2;
const MAX_CONSENSUS_SEEDS = 32;

/** Bound local neighbor search using the declared basis and the internal integer order.
 * @param basis - Authoritative east/north vectors in degrees (or consistently normalized units).
 * @param toleranceFraction - Spacing residual tolerance relative to the shortest basis vector.
 * @returns Maximum bounded displacement length plus the policy margin, in basis units.
 */
export function latticeInferenceSearchRadius(basis: Basis, toleranceFraction: number): number {
  const scale = Math.min(Math.hypot(...basis[0]), Math.hypot(...basis[1]));
  const extent = Math.max(Math.hypot(basis[0][0] + basis[1][0], basis[0][1] + basis[1][1]),
    Math.hypot(basis[0][0] - basis[1][0], basis[0][1] - basis[1][1]));
  return NEIGHBOR_ORDER * extent + (toleranceFraction + EPSILON) * scale;
}

function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function signedAngle(angle: number): number { return modulo(angle + Math.PI, TAU) - Math.PI; }
function circularMean(values: number[], period: number): number {
  let x = 0; let y = 0;
  for (const value of values) { x += Math.cos(value * TAU / period); y += Math.sin(value * TAU / period); }
  return modulo(Math.atan2(y, x), TAU) * period / TAU;
}
function modular(value: number): number {
  const phase = modulo(value, 1);
  return Math.min(phase, 1 - phase) <= EPSILON ? 0 : phase;
}
function inverse(basis: Basis, p: TangentPlaneOffset): TangentPlaneOffset {
  const first = Math.hypot(...basis[0]); const second = Math.hypot(...basis[1]);
  const a = basis[0][0] / first; const c = basis[0][1] / first;
  const b = basis[1][0] / second; const d = basis[1][1] / second;
  const det = a * d - b * c;
  return [(d * p[0] - b * p[1]) / det / first, (a * p[1] - c * p[0]) / det / second];
}
function position(basis: Basis, u: TangentPlaneOffset): TangentPlaneOffset {
  return [basis[0][0] * u[0] + basis[1][0] * u[1], basis[0][1] * u[0] + basis[1][1] * u[1]];
}
function rotatedBasis(basis: Basis, angle: number): Basis {
  return [rotateLocalOffset(basis[0], angle * 180 / Math.PI), rotateLocalOffset(basis[1], angle * 180 / Math.PI)];
}

// Hash local positions at the bounded search radius: remote groups never form pairs.
function localPairs(points: Point[], basis: Basis, tolerance: number): Pair[] {
  const offsets: TangentPlaneOffset[] = [];
  for (let i = -NEIGHBOR_ORDER; i <= NEIGHBOR_ORDER; i += 1) {
    for (let j = -NEIGHBOR_ORDER; j <= NEIGHBOR_ORDER; j += 1) {
      if (i || j) offsets.push(position(basis, [i, j]));
    }
  }
  const radius = latticeInferenceSearchRadius(basis, tolerance);
  const buckets = new Map<string, number[]>();
  const seenCenters = new Set<string>();
  const pairs: Pair[] = [];
  for (let b = 0; b < points.length; b += 1) {
    const p = points[b].p;
    const centerKey = JSON.stringify(p);
    if (seenCenters.has(centerKey)) continue;
    seenCenters.add(centerKey);
    const x = Math.floor(p[0] / radius); const y = Math.floor(p[1] / radius);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const a of buckets.get(`${x + dx},${y + dy}`) ?? []) {
        const delta: TangentPlaneOffset = [p[0] - points[a].p[0], p[1] - points[a].p[1]];
        const length = Math.hypot(...delta);
        if (length <= EPSILON || length > radius) continue;
        const compatible = offsets.filter((offset) => Math.abs(Math.hypot(...offset) - length) <= tolerance + EPSILON);
        if (compatible.length) pairs.push({ a, b, delta, offsets: compatible });
      }
    }
    const key = `${x},${y}`;
    const bucket = buckets.get(key) ?? []; bucket.push(b); buckets.set(key, bucket);
  }
  return pairs;
}

function pairAngle(pair: Pair, angle: number, tolerance: number): number | null {
  let best: number | null = null; let residual = Infinity;
  for (const offset of pair.offsets) {
    const predicted = rotateLocalOffset(offset, angle * 180 / Math.PI);
    const error = Math.hypot(pair.delta[0] - predicted[0], pair.delta[1] - predicted[1]);
    if (error <= tolerance + EPSILON && error < residual) {
      residual = error;
      // Astronomical PA is clockwise in an east/north coordinate plot.
      best = signedAngle(Math.atan2(offset[1], offset[0]) - Math.atan2(pair.delta[1], pair.delta[0]));
    }
  }
  return best;
}

// Deterministic circular consensus. Buckets are policy-derived; each pair votes once
// in a neighborhood, regardless of how many equal-length integer offsets it admits.
function rotationSeeds(pairs: Pair[], tolerance: number): number[] {
  const shortest = pairs.reduce((minimum, pair) => pair.offsets.reduce((value, p) => Math.min(value, Math.hypot(...p)), minimum), Infinity);
  const bins = Math.max(1, Math.floor(TAU / Math.max(EPSILON, Math.atan2(tolerance, shortest))));
  const buckets = new Map<number, Array<{ pair: number; angle: number }>>();
  pairs.forEach((pair, index) => pair.offsets.forEach((offset) => {
    const angle = modulo(Math.atan2(offset[1], offset[0]) - Math.atan2(pair.delta[1], pair.delta[0]), TAU);
    const bin = Math.floor(angle / TAU * bins);
    const bucket = buckets.get(bin) ?? []; bucket.push({ pair: index, angle }); buckets.set(bin, bucket);
  }));
  const ranked = [...buckets.entries()].map(([bin, values]) => {
    const nearby = [...new Set([-1, 0, 1].map((step) => modulo(bin + step, bins)))].flatMap((key) => buckets.get(key) ?? []);
    return { bin, values, nearby, support: new Set(nearby.map((item) => item.pair)).size };
  }).sort((a, b) => b.support - a.support || a.bin - b.bin).slice(0, MAX_CONSENSUS_SEEDS);
  const seeds = [0];
  for (const bucket of ranked) {
    seeds.push(signedAngle(circularMean(bucket.nearby.map((item) => item.angle), TAU)), signedAngle(bucket.values[0].angle));
  }
  const refined = seeds.map((seed) => {
    let angle = seed;
    for (let step = 0; step < 3; step += 1) {
      const votes = pairs.flatMap((pair) => { const vote = pairAngle(pair, angle, tolerance); return vote === null ? [] : [vote]; });
      if (!votes.length) break;
      angle = signedAngle(circularMean(votes, TAU));
    }
    return angle;
  });
  return [...new Map(refined.map((angle) => [Math.round(angle / EPSILON), angle])).values()];
}

function phaseSeeds(coordinates: TangentPlaneOffset[], basis: Basis, tolerance: number): TangentPlaneOffset[] {
  const east = inverse(basis, [1, 0]); const north = inverse(basis, [0, 1]);
  const bins = [0, 1].map((axis) => Math.max(1, Math.floor(1 / Math.max(EPSILON,
    2 * tolerance * Math.hypot(east[axis], north[axis])))));
  const buckets = new Map<string, TangentPlaneOffset[]>();
  for (const u of coordinates) {
    const key = `${Math.floor(modular(u[0]) * bins[0])},${Math.floor(modular(u[1]) * bins[1])}`;
    const values = buckets.get(key) ?? []; values.push(u); buckets.set(key, values);
  }
  const seeds: TangentPlaneOffset[] = [];
  const ranked = [...buckets].map(([key, values]) => {
    const [x, y] = key.split(",").map(Number);
    const neighbors = new Set<string>();
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      neighbors.add(`${modulo(x + dx, bins[0])},${modulo(y + dy, bins[1])}`);
    }
    const nearby = [...neighbors].flatMap((neighbor) => buckets.get(neighbor) ?? []);
    return { key, values, nearby };
  }).sort((a, b) => b.nearby.length - a.nearby.length || lexical(a.key, b.key)).slice(0, MAX_CONSENSUS_SEEDS);
  for (const bucket of ranked) {
    seeds.push([circularMean(bucket.nearby.map((u) => u[0]), 1), circularMean(bucket.nearby.map((u) => u[1]), 1)],
      bucket.values[0].map(modular) as TangentPlaneOffset);
  }
  return seeds;
}

function assignments(points: Point[], basis: Basis, phase: TangentPlaneOffset, tolerance: number): LatticeAssignment[] {
  return points.map(({ tile, p }) => {
    const u = inverse(basis, p);
    const i = Math.round(u[0] - phase[0]); const j = Math.round(u[1] - phase[1]);
    const predicted = position(basis, [i + phase[0], j + phase[1]]);
    const residual = Math.hypot(p[0] - predicted[0], p[1] - predicted[1]);
    return { tile_id: tile.id, i: i === 0 ? 0 : i, j: j === 0 ? 0 : j,
      residual_deg: residual, residual_fraction: residual, inlier: residual <= tolerance + EPSILON && Number.isSafeInteger(i) && Number.isSafeInteger(j) };
  });
}

function compareFits(a: LatticeInferenceResult, b: LatticeInferenceResult): number {
  const rms = a.rms_residual_fraction - b.rms_residual_fraction;
  const rotation = Math.abs(a.rotation_deg) - Math.abs(b.rotation_deg);
  return b.inlier_count - a.inlier_count || (Math.abs(rms) > EPSILON ? rms : 0) ||
    b.compatible_pair_count - a.compatible_pair_count || (Math.abs(rotation) > EPSILON * 180 / Math.PI ? rotation : 0) ||
    lexical(a.group_key, b.group_key) || a.rotation_deg - b.rotation_deg ||
    a.phase_fraction[0] - b.phase_fraction[0] || a.phase_fraction[1] - b.phase_fraction[1];
}

function fitAlignment(points: Point[], pairs: Pair[], tiling: GenericLatticeTiling, policy: InferencePolicy,
  reference: CenterInput, scale: number, groupKey: string, angle: number): LatticeInferenceResult | null {
  const declared = tiling.basis_deg.map((b) => b.map((value) => value / scale)) as Basis;
  const basis = rotatedBasis(declared, angle);
  const coordinates = points.map(({ p }) => inverse(basis, p));
  const fixed = tiling.origin.type === "fixed_anchor";
  const seeds = fixed ? [[0, 0] as TangentPlaneOffset] : phaseSeeds(coordinates, basis, policy.phase_tolerance_fraction);
  let best: LatticeInferenceResult | null = null;
  for (const seed of seeds) {
    let phase = seed.map(modular) as TangentPlaneOffset;
    let assigned = assignments(points, basis, phase, policy.phase_tolerance_fraction);
    for (let step = 0; !fixed && step < 3; step += 1) {
      const inliers = coordinates.filter((_, index) => assigned[index].inlier);
      if (!inliers.length) break;
      phase = [modular(circularMean(inliers.map((u) => u[0]), 1)), modular(circularMean(inliers.map((u) => u[1]), 1))];
      assigned = assignments(points, basis, phase, policy.phase_tolerance_fraction);
    }
    const inliers = assigned.filter((item) => item.inlier);
    if (new Set(inliers.map((item) => `${item.i},${item.j}`)).size < policy.min_anchor_tiles) continue;
    const support = new Set<string>();
    for (const pair of pairs) {
      const a = assigned[pair.a]; const b = assigned[pair.b];
      if (!a.inlier || !b.inlier) continue;
      const di = b.i - a.i; const dj = b.j - a.j;
      if ((!di && !dj) || Math.max(Math.abs(di), Math.abs(dj)) > NEIGHBOR_ORDER) continue;
      const expected = position(basis, [di, dj]);
      if (Math.hypot(pair.delta[0] - expected[0], pair.delta[1] - expected[1]) <= policy.spacing_tolerance_fraction + EPSILON) {
        support.add([`${a.i},${a.j}`, `${b.i},${b.j}`].sort(lexical).join(":"));
      }
    }
    if (support.size < policy.min_neighbor_pairs) continue;
    const offset = position(basis, phase).map((value) => value * scale) as TangentPlaneOffset;
    const [ra, dec] = localOffsetToSky(reference, offset);
    const result: LatticeInferenceResult = {
      status: "success", group_key: groupKey, considered_tile_count: points.length,
      basis_deg: rotatedBasis(tiling.basis_deg, angle), rotation_deg: Math.abs(angle) <= EPSILON ? 0 : angle * 180 / Math.PI,
      projection_origin: { ...reference }, phase_offset_deg: offset, phase_fraction: phase,
      anchor_ra_deg: ra, anchor_dec_deg: dec,
      assignments: assigned.map((item) => ({ ...item, residual_deg: item.residual_fraction * scale })),
      inlier_count: inliers.length,
      rms_residual_fraction: Math.sqrt(inliers.reduce((sum, item) => sum + item.residual_fraction ** 2, 0) / inliers.length),
      compatible_pair_count: support.size, rotation_support_pairs: support.size, characteristic_scale_deg: scale,
    };
    if (!best || compareFits(result, best) < 0) best = result;
  }
  return best;
}

// Least-squares rotation of already accepted integer assignments. Only rotation
// changes: no basis stretching, free lattice discovery, or outlier participation.
function refineRotation(points: Point[], fit: LatticeInferenceResult, declared: Basis, fixed: boolean): number {
  const rows = points.flatMap((point, index) => fit.assignments[index].inlier
    ? [{ p: point.p, q: position(declared, [fit.assignments[index].i, fit.assignments[index].j]) }] : []);
  const mean = (axis: number, key: "p" | "q") => fixed ? 0 : rows.reduce((sum, row) => sum + row[key][axis], 0) / rows.length;
  const px = mean(0, "p"); const py = mean(1, "p"); const qx = mean(0, "q"); const qy = mean(1, "q");
  let dot = 0; let cross = 0;
  for (const row of rows) {
    const x = row.q[0] - qx; const y = row.q[1] - qy;
    dot += x * (row.p[0] - px) + y * (row.p[1] - py);
    cross += y * (row.p[0] - px) - x * (row.p[1] - py);
  }
  return dot === 0 && cross === 0 ? fit.rotation_deg * Math.PI / 180 : signedAngle(Math.atan2(cross, dot));
}

/** Align one independent group to a declared lattice, never discovering its fundamental spacing.
 * @param tiles - Enabled ICRS centers from a single compatible dataset/profile group.
 * @param tiling - Validated authoritative basis in east/north degrees and origin policy.
 * @param policy - Fractional tolerances and minimum evidence; zero rotation is exact when forbidden.
 * @param reference - Local ICRS projection reference for region-center placement; fixed anchors override it.
 * @param groupKey - Stable identity used for deterministic solution ties.
 * @returns Runtime alignment with all integer assignments and normalized residuals, or an explicit failure.
 * No profile/input mutation occurs. The Gate 3 local approximation and near-pole limitations apply.
 */
export function inferDeclaredLattice(tiles: readonly TileRecord[], tiling: GenericLatticeTiling, policy: InferencePolicy,
  reference: CenterInput, groupKey = "declared"): LatticeInferenceOutcome {
  const failure = (status: Exclude<LatticeInferenceOutcome["status"], "success">): LatticeInferenceOutcome =>
    ({ status, group_key: groupKey, considered_tile_count: tiles.length });
  if (!policy.enabled) return failure("disabled");
  if (tiles.length < policy.min_anchor_tiles) return failure("insufficient_anchors");
  const origin = tiling.origin.type === "fixed_anchor" ? { ra_deg: tiling.origin.ra_deg, dec_deg: tiling.origin.dec_deg } : reference;
  const scale = Math.min(Math.hypot(...tiling.basis_deg[0]), Math.hypot(...tiling.basis_deg[1]));
  const normalized = tiling.basis_deg.map((b) => b.map((value) => value / scale)) as Basis;
  const points: Point[] = [...tiles].sort((a, b) => lexical(a.id, b.id) || a.ra_deg - b.ra_deg || a.dec_deg - b.dec_deg)
    .map((tile) => ({ tile, p: skyToLocalOffset(tile, origin).map((value) => value / scale) as TangentPlaneOffset }));
  const pairs = localPairs(points, normalized, policy.spacing_tolerance_fraction);
  if (pairs.length < policy.min_neighbor_pairs) return failure("insufficient_pairs");
  const angles = policy.allow_rotation ? rotationSeeds(pairs, policy.spacing_tolerance_fraction) : [0];
  let best: LatticeInferenceResult | null = null;
  for (const angle of angles) {
    let fit = fitAlignment(points, pairs, tiling, policy, origin, scale, groupKey, angle);
    for (let step = 0; fit && policy.allow_rotation && step < 3; step += 1) {
      const refined = fitAlignment(points, pairs, tiling, policy, origin, scale, groupKey,
        refineRotation(points, fit, normalized, tiling.origin.type === "fixed_anchor"));
      if (!refined || compareFits(refined, fit) > 0) break;
      fit = refined;
    }
    if (fit && (!best || compareFits(fit, best) < 0)) best = fit;
  }
  return best ?? failure(tiling.origin.type === "fixed_anchor" ? "inconsistent_fixed_anchor" : "no_alignment");
}

/** Fit eligible dataset/instrument groups independently and select the best deterministic alignment.
 * @param tiles - Actual loaded/accepted ICRS pointings; disabled and excluded centers never anchor inference.
 * @param survey - Active validated survey; auto requires its instrument identity, include admits independent groups.
 * @param reference - ICRS local-plane reference chosen by the planner.
 * @returns Best runtime alignment or an explicit eligibility/evidence/alignment outcome.
 * Generic grouping uses dataset and instrument IDs, never CSV PID or PID-derived group_id.
 * All input tiles remain available to coverage, regardless of inference role/outcome.
 */
export function inferSurveyLattice(tiles: readonly TileRecord[], survey: SurveyProfileV2, reference: CenterInput): LatticeInferenceOutcome {
  const empty = (status: Exclude<LatticeInferenceOutcome["status"], "success">): LatticeInferenceOutcome => ({ status, considered_tile_count: 0 });
  if (survey.tiling.type === "manual") return empty("manual_tiling");
  if (survey.tiling.type === "legacy_splus") return empty("legacy_strategy");
  if (!survey.inference.enabled) return empty("disabled");
  const groups = new Map<string, TileRecord[]>();
  for (const tile of tiles) {
    const role = tile.inference_role ?? "auto";
    if (tile.enabled === false || role === "exclude") continue;
    const instrument = tile.source === "proposed" ? survey.instrument_id : tile.instrument_profile_id;
    if (role === "auto" && instrument !== survey.instrument_id) continue;
    const dataset = tile.dataset_id ?? (tile.source === "proposed" ? `accepted:${tile.generation_method}` : `unassociated:${tile.id}`);
    const key = JSON.stringify([instrument ?? "explicit-unassociated", dataset]);
    const group = groups.get(key) ?? []; group.push(tile); groups.set(key, group);
  }
  if (!groups.size) return empty("no_usable_centers");
  const outcomes = [...groups].sort(([a], [b]) => lexical(a, b)).map(([key, group]) =>
    inferDeclaredLattice(group, survey.tiling as GenericLatticeTiling, survey.inference, reference, key));
  const fits = outcomes.filter((outcome): outcome is LatticeInferenceResult => outcome.status === "success").sort(compareFits);
  const considered = outcomes.reduce((sum, outcome) => sum + outcome.considered_tile_count, 0);
  if (fits.length) return { ...fits[0], considered_tile_count: considered };
  // Report the most informative attempted group, with stable lexical ties.
  const priority = ["inconsistent_fixed_anchor", "no_alignment", "insufficient_pairs", "insufficient_anchors"];
  outcomes.sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status) || lexical(a.group_key ?? "", b.group_key ?? ""));
  return { ...outcomes[0], considered_tile_count: considered };
}

/** Test occupancy in the inference/generation plane using only the profile's fractional tolerance.
 * @param candidate - Candidate ICRS lattice site.
 * @param tiles - All enabled actual pointings, including inference-excluded datasets.
 * @param reference - Same ICRS projection reference used by the candidate generator.
 * @param basis - Runtime or declared east/north basis in degrees.
 * @param toleranceFraction - Occupied if separation / min(norm(b1), norm(b2)) is at most this value.
 * @returns Whether an actual pointing occupies this site; no coverage sampling occurs.
 */
export function latticeSiteOccupied(candidate: CenterInput, tiles: readonly TileRecord[], reference: CenterInput,
  basis: Basis, toleranceFraction: number): boolean {
  const scale = Math.min(Math.hypot(...basis[0]), Math.hypot(...basis[1]));
  const p = skyToLocalOffset(candidate, reference);
  return tiles.some((tile) => {
    if (tile.enabled === false) return false;
    const q = skyToLocalOffset(tile, reference);
    return Math.hypot((p[0] - q[0]) / scale, (p[1] - q[1]) / scale) <= toleranceFraction + EPSILON;
  });
}
