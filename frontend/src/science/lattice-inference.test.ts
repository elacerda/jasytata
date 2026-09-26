import { describe, expect, it } from "vitest";
import type { CenterInput, GenericLatticeTiling, InferencePolicy, LatticeInferenceOutcome, LatticeInferenceResult, TangentPlaneOffset, TileRecord } from "../types";
import { SPLUS_SURVEY_V2 } from "../profiles";
import { localOffsetToSky, rotateLocalOffset } from "./footprint-engine";
import { generateLatticeCandidates } from "./lattice";
import { inferDeclaredLattice, inferSurveyLattice, latticeSiteOccupied } from "./lattice-inference";

const reference: CenterInput = { ra_deg: 150, dec_deg: 0 };
const policy: InferencePolicy = { enabled: true, spacing_tolerance_fraction: 0.04, phase_tolerance_fraction: 0.03,
  occupancy_tolerance_fraction: 0.08, min_anchor_tiles: 3, min_neighbor_pairs: 2, allow_rotation: false };
const rectangular: GenericLatticeTiling = { type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "region_center" } };
const cells: TangentPlaneOffset[] = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [2, 2]];

function observations(tiling = rectangular, indices = cells, phase: TangentPlaneOffset = [0.2, 0.3], angle = 0,
  origin = reference, noise: TangentPlaneOffset[] = []): TileRecord[] {
  const basis = tiling.basis_deg.map((b) => rotateLocalOffset(b, angle));
  return indices.map(([i, j], index) => {
    const p: TangentPlaneOffset = [basis[0][0] * (i + phase[0]) + basis[1][0] * (j + phase[1]),
      basis[0][1] * (i + phase[0]) + basis[1][1] * (j + phase[1])];
    const [ra, dec] = localOffsetToSky(origin, [p[0] + (noise[index]?.[0] ?? 0), p[1] + (noise[index]?.[1] ?? 0)]);
    return { id: `tile-${index}`, name: "", ra_deg: ra, dec_deg: dec, source: "original", enabled: true,
      generation_method: null, dataset_id: "survey-data", instrument_profile_id: "camera", inference_role: "auto",
      group_id: `arbitrary-PID-${index}`, original_values: { PID: String(index) }, metadata: {} };
  });
}
function success(outcome: LatticeInferenceOutcome): LatticeInferenceResult {
  expect(outcome.status).toBe("success");
  if (outcome.status !== "success") throw new Error(outcome.status);
  return outcome;
}
function checkIndices(fit: LatticeInferenceResult, indices = cells) {
  expect(fit.assignments.map(({ i, j }) => [i, j])).toEqual(indices);
}
function survey(tiling = rectangular, inference = policy) {
  return { ...SPLUS_SURVEY_V2, id: "survey", instrument_id: "camera", tiling, inference };
}

describe("Gate 5 declared-lattice alignment", () => {
  it("recovers a rectangular phase, zero rotation, integer sites and runtime anchor", () => {
    const fit = success(inferDeclaredLattice(observations(), rectangular, policy, reference));
    expect(fit.rotation_deg).toBe(0);
    expect(fit.basis_deg).toEqual(rectangular.basis_deg);
    expect(fit.phase_fraction[0]).toBeCloseTo(0.2, 11);
    expect(fit.phase_fraction[1]).toBeCloseTo(0.3, 11);
    expect(fit.anchor_ra_deg).toBeCloseTo(150.2, 11);
    expect(fit.anchor_dec_deg).toBeCloseTo(0.3, 11);
    checkIndices(fit);
    expect(fit.inlier_count).toBe(cells.length);
    expect(fit.rms_residual_fraction).toBeLessThan(1e-11);
    expect(fit.compatible_pair_count).toBeGreaterThanOrEqual(2);
  });

  it.each([27, -23, 179, -179])("recovers astronomical rotation %s with deterministic symmetry ties", (angle) => {
    const declared = { ...rectangular, basis_deg: [[1, 0], [0.2, 1.3]] as GenericLatticeTiling["basis_deg"] };
    const expected = Math.abs(angle) > 90 ? angle - Math.sign(angle) * 180 : angle;
    const data = observations(declared, cells, [0.2, 0.3], angle);
    const fit = success(inferDeclaredLattice(data, declared, { ...policy, allow_rotation: true }, reference));
    expect(fit.rotation_deg).toBeCloseTo(expected, 9);
    expect(fit.rotation_support_pairs).toBeGreaterThanOrEqual(policy.min_neighbor_pairs);
    expect(fit.rms_residual_fraction).toBeLessThan(1e-10);
    expect(inferDeclaredLattice([...data].reverse(), declared, { ...policy, allow_rotation: true }, reference)).toEqual(fit);
  });

  it("uses the smallest absolute rotation for a symmetric rectangular lattice", () => {
    const fit = success(inferDeclaredLattice(observations(rectangular, cells, [0.2, 0.3], 27), rectangular,
      { ...policy, allow_rotation: true }, reference));
    expect(fit.rotation_deg).toBeCloseTo(27, 9);
    checkIndices(fit);
  });

  it("does not silently rotate when rotation is disabled", () => {
    expect(inferDeclaredLattice(observations(rectangular, cells, [0.2, 0.3], 27), rectangular, policy, reference).status).toBe("no_alignment");
  });

  it.each([
    [[1, 0], [0.5, 1]],
    [[1, 0], [0.5, Math.sqrt(3) / 2]],
    [[-1, 0], [0.3, 1]],
  ] as GenericLatticeTiling["basis_deg"][])("recovers a skewed/triangular/negative-determinant basis %j", (b1, b2) => {
    const tiling = { ...rectangular, basis_deg: [b1, b2] as GenericLatticeTiling["basis_deg"] };
    const fit = success(inferDeclaredLattice(observations(tiling), tiling, policy, reference));
    checkIndices(fit);
    expect(fit.phase_fraction[0]).toBeCloseTo(0.2, 10);
    expect(fit.phase_fraction[1]).toBeCloseTo(0.3, 10);
    expect(fit.basis_deg).toEqual(tiling.basis_deg);
  });

  it("keeps the fundamental basis with missing immediate neighbors and harmonic offsets", () => {
    const sparse: TangentPlaneOffset[] = [[0, 0], [2, 0], [4, 0], [0, 2], [2, 2], [1, 1]];
    const fit = success(inferDeclaredLattice(observations(rectangular, sparse), rectangular, policy, reference));
    checkIndices(fit, sparse);
    expect(fit.basis_deg).toEqual(rectangular.basis_deg);
    expect(fit.characteristic_scale_deg).toBe(1);
  });

  it("aligns two local groups across a large hole without forming long harmonic pairs", () => {
    const sparse: TangentPlaneOffset[] = [[0, 0], [1, 0], [0, 1], [12, 0], [13, 0], [12, 1]];
    const fit = success(inferDeclaredLattice(observations(rectangular, sparse), rectangular, policy, reference));
    checkIndices(fit, sparse);
    expect(fit.inlier_count).toBe(6);
    expect(fit.compatible_pair_count).toBe(6);
  });

  it("does not accept unbounded long harmonics as neighbor evidence", () => {
    const sparse: TangentPlaneOffset[] = [[0, 0], [5, 0], [10, 0]];
    expect(inferDeclaredLattice(observations(rectangular, sparse), rectangular, policy, reference).status).toBe("insufficient_pairs");
  });

  it("estimates phase circularly across the modulo boundary", () => {
    const noise: TangentPlaneOffset[] = [[-0.012, 0.008], [0.01, -0.008], [-0.004, 0.002], [0.009, -0.002], [0, 0.004], [-0.003, -0.004]];
    const fit = success(inferDeclaredLattice(observations(rectangular, cells, [0.998, 0.002], 0, reference, noise), rectangular, policy, reference));
    expect(Math.min(fit.phase_fraction[0], 1 - fit.phase_fraction[0])).toBeLessThan(0.01);
    expect(Math.min(fit.phase_fraction[1], 1 - fit.phase_fraction[1])).toBeLessThan(0.01);
    expect(fit.inlier_count).toBe(6);
    expect(fit.rms_residual_fraction).toBeLessThan(0.015);
  });

  it("rejects unrelated outliers without changing the final noisy alignment", () => {
    const noise: TangentPlaneOffset[] = [[0.006, -0.004], [-0.007, 0.005], [0.003, 0.004], [-0.002, -0.005], [0.002, 0], [-0.002, 0]];
    const data = observations(rectangular, cells, [0.2, 0.3], 0, reference, noise);
    const clean = success(inferDeclaredLattice(data, rectangular, policy, reference));
    const outliers = observations(rectangular, [[0.44, 0.42], [3.39, 3.45]]).map((tile, i) => ({ ...tile, id: `outlier-${i}` }));
    const fit = success(inferDeclaredLattice([...data, ...outliers], rectangular, policy, reference));
    expect(fit.inlier_count).toBe(6);
    expect(fit.assignments.filter((a) => !a.inlier)).toHaveLength(2);
    expect(fit.phase_fraction).toEqual(clean.phase_fraction);
    expect(fit.rms_residual_fraction).toBeCloseTo(clean.rms_residual_fraction, 12);
  });

  it("recovers rotation with fixed noise and rejects outliers", () => {
    const declared = { ...rectangular, basis_deg: [[1, 0], [0.2, 1.3]] as GenericLatticeTiling["basis_deg"] };
    const noise: TangentPlaneOffset[] = [[0.006, -0.004], [-0.007, 0.005], [0.003, 0.004], [-0.002, -0.005], [0.002, 0], [-0.002, 0]];
    const data = observations(declared, cells, [0.2, 0.3], 27, reference, noise);
    data.push({ ...data[0], id: "outlier", ra_deg: 153.234, dec_deg: 3.432 });
    const fit = success(inferDeclaredLattice(data, declared, { ...policy, allow_rotation: true }, reference));
    expect(fit.rotation_deg).toBeCloseTo(27, 1);
    expect(fit.inlier_count).toBe(6);
    expect(fit.rms_residual_fraction).toBeLessThan(0.01);
  });

  it("is RA-wrap safe at zero and at nonzero declination", () => {
    const origin = { ra_deg: 359.6, dec_deg: -24 };
    const data = observations(rectangular, cells, [0.2, 0.3], 0, origin);
    expect(data.some((p) => p.ra_deg < 1)).toBe(true);
    const fit = success(inferDeclaredLattice(data, rectangular, policy, origin));
    checkIndices(fit);
    expect(fit.rms_residual_fraction).toBeLessThan(1e-10);
  });

  it.each([false, true])("has identical degree/arcminute acceptance and normalized residuals (rotation %s)", (allowRotation) => {
    const results = [1, 1 / 60].map((scale) => {
      const tiling = { ...rectangular, basis_deg: [[scale, 0], [0.2 * scale, 1.3 * scale]] as GenericLatticeTiling["basis_deg"] };
      const noise: TangentPlaneOffset[] = [[0.006, -0.004], [-0.007, 0.005], [0.003, 0.004], [-0.002, -0.005], [0.002, 0], [-0.002, 0]];
      const data = observations(tiling, cells, [0.2, 0.3], allowRotation ? 27 : 0, reference,
        noise.map((p) => p.map((v) => v * scale) as TangentPlaneOffset));
      const fit = success(inferDeclaredLattice(data, tiling, { ...policy, allow_rotation: allowRotation }, reference));
      const rejected = inferDeclaredLattice(data, tiling, { ...policy, phase_tolerance_fraction: 0.0001, allow_rotation: allowRotation }, reference);
      return { fit, rejected };
    });
    expect(results[0].fit.inlier_count).toBe(results[1].fit.inlier_count);
    expect(results[0].fit.compatible_pair_count).toBe(results[1].fit.compatible_pair_count);
    expect(results[0].fit.rms_residual_fraction).toBeCloseTo(results[1].fit.rms_residual_fraction, 9);
    expect(results[0].fit.rotation_deg).toBeCloseTo(results[1].fit.rotation_deg, 8);
    expect(results[0].rejected.status).toBe(results[1].rejected.status);
    expect(results[0].rejected.status).not.toBe("success");
  });

  it("validates a fixed anchor without shifting it", () => {
    const tiling = { ...rectangular, origin: { type: "fixed_anchor" as const, ...reference } };
    const fit = success(inferDeclaredLattice(observations(tiling, cells, [0, 0]), tiling, policy, { ra_deg: 151, dec_deg: 1 }));
    expect(fit.phase_fraction).toEqual([0, 0]);
    expect(fit.anchor_ra_deg).toBe(reference.ra_deg);
    expect(fit.anchor_dec_deg).toBe(reference.dec_deg);
    checkIndices(fit);
  });

  it("rotates about an authoritative fixed anchor when allowed", () => {
    const tiling = { ...rectangular, basis_deg: [[1, 0], [0.2, 1.3]] as GenericLatticeTiling["basis_deg"], origin: { type: "fixed_anchor" as const, ...reference } };
    const fit = success(inferDeclaredLattice(observations(tiling, cells, [0, 0], 27), tiling, { ...policy, allow_rotation: true }, reference));
    expect(fit.rotation_deg).toBeCloseTo(27, 9);
    expect(fit.anchor_ra_deg).toBe(reference.ra_deg);
    expect(fit.phase_fraction).toEqual([0, 0]);
  });

  it("fails for an inconsistent fixed anchor rather than shifting phase", () => {
    const tiling = { ...rectangular, origin: { type: "fixed_anchor" as const, ...reference } };
    const frozen = structuredClone(tiling);
    expect(inferDeclaredLattice(observations(tiling), tiling, policy, reference).status).toBe("inconsistent_fixed_anchor");
    expect(tiling).toEqual(frozen);
  });

  it("requires policy minimum anchors and pairs, including independent sites", () => {
    expect(inferDeclaredLattice(observations().slice(0, 2), rectangular, policy, reference).status).toBe("insufficient_anchors");
    expect(inferDeclaredLattice(observations(), rectangular, { ...policy, min_neighbor_pairs: 100 }, reference).status).toBe("insufficient_pairs");
    const one = observations()[0];
    expect(inferDeclaredLattice([one, { ...one, id: "copy-1" }, { ...one, id: "copy-2" }], rectangular, policy, reference).status).toBe("insufficient_pairs");
  });

  it("does not inflate pair evidence when many records share the same centers", () => {
    const data = observations(rectangular, [[0, 0], [1, 0], [0, 1]]);
    const duplicated = Array.from({ length: 100 }, (_, i) => ({ ...data[i % 3], id: `copy-${i}` }));
    expect(inferDeclaredLattice([...data, ...duplicated], rectangular, { ...policy, min_neighbor_pairs: 4 }, reference).status)
      .toBe("insufficient_pairs");
    expect(success(inferDeclaredLattice([...data, ...duplicated], rectangular, policy, reference)).compatible_pair_count).toBe(3);
  });

  it("rejects a runtime translation of an authoritative fixed anchor in candidate generation", () => {
    const fixed = { ...rectangular, origin: { type: "fixed_anchor" as const, ...reference } };
    const region = { vertices: [
      { ra_deg: 149.5, dec_deg: -0.5 }, { ra_deg: 150.5, dec_deg: -0.5 },
      { ra_deg: 150.5, dec_deg: 0.5 }, { ra_deg: 149.5, dec_deg: 0.5 },
    ] };
    const footprint = { type: "circle" as const, radius_deg: 0.1 };
    expect(() => generateLatticeCandidates(region, fixed, footprint, 1200,
      { projection_origin: reference, phase_offset_deg: [0.01, 0] })).toThrow(/authoritative fixed anchor/);
    expect(() => generateLatticeCandidates(region, fixed, footprint, 1200,
      { projection_origin: { ...reference, dec_deg: 0.01 }, phase_offset_deg: [0, 0] })).toThrow(/authoritative fixed anchor/);
  });

  it("distinguishes disabled, manual and legacy strategy outcomes", () => {
    expect(inferSurveyLattice(observations(), survey(rectangular, { ...policy, enabled: false }), reference).status).toBe("disabled");
    expect(inferSurveyLattice(observations(), { ...survey(), tiling: { type: "manual" } }, reference).status).toBe("manual_tiling");
    expect(inferSurveyLattice(observations(), SPLUS_SURVEY_V2, reference).status).toBe("legacy_strategy");
  });

  it("uses dataset/instrument identity and roles without PID dependence or cross-dataset merging", () => {
    const data = observations();
    const active = survey();
    const original = success(inferSurveyLattice(data, active, reference));
    const relabeled = data.map((tile) => ({ ...tile, group_id: "another-PID", original_values: { arbitrary: "x" } }));
    expect(inferSurveyLattice(relabeled, active, reference)).toEqual(original);
    const unrelated = observations(rectangular, cells, [0.6, 0.7]).map((tile) => ({ ...tile, id: `other-${tile.id}`,
      dataset_id: "other-data", instrument_profile_id: "other-camera" }));
    expect(inferSurveyLattice([...data, ...unrelated], active, reference)).toEqual(original);
    expect(inferSurveyLattice(data.map((tile) => ({ ...tile, inference_role: "exclude" })), active, reference).status).toBe("no_usable_centers");
    expect(inferSurveyLattice(data.map((tile) => ({ ...tile, enabled: false })), active, reference).status).toBe("no_usable_centers");
    const included = unrelated.map((tile) => ({ ...tile, inference_role: "include" as const }));
    expect(success(inferSurveyLattice([...data, ...included], active, reference)).inlier_count).toBe(6);
    expect(success(inferSurveyLattice(included, active, reference)).group_key).toContain("other-data");
    const incompatible = included.map((tile, i) => ({ ...tile, ra_deg: reference.ra_deg + i * 0.37, dec_deg: 0.41 * i }));
    expect(success(inferSurveyLattice([...data, ...incompatible], active, reference)).assignments.map((a) => a.tile_id)).toEqual(data.map((t) => t.id));
    const split = data.map((tile, i) => ({ ...tile, dataset_id: `part-${i}` }));
    expect(inferSurveyLattice(split, active, reference).status).toBe("insufficient_anchors");
  });

  it("ranks groups by inliers, residual quality and stable identity independently of insertion order", () => {
    const data = observations();
    const more = observations(rectangular, [...cells, [3, 2]]).map((tile) => ({ ...tile, id: `more-${tile.id}`, dataset_id: "more" }));
    const fit = success(inferSurveyLattice([...data, ...more], survey(), reference));
    expect(fit.inlier_count).toBe(7);
    expect(fit.group_key).toContain("more");
    expect(inferSurveyLattice([...more, ...data].reverse(), survey(), reference)).toEqual(fit);
    const tie = data.map((tile) => ({ ...tile, id: `tie-${tile.id}`, dataset_id: "a-first" }));
    expect(success(inferSurveyLattice([...data, ...tie], survey(), reference)).group_key).toContain("a-first");
    const noisy = tie.map((tile, i) => ({ ...tile, ra_deg: tile.ra_deg + (i % 2 ? 0.005 : -0.005) }));
    expect(success(inferSurveyLattice([...data, ...noisy], survey(), reference)).group_key).toContain("survey-data");
  });

  it("uses scale-relative occupancy, including excluded centers and the exact boundary", () => {
    for (const scale of [1, 1 / 60]) {
      const basis: GenericLatticeTiling["basis_deg"] = [[scale, 0], [0, scale]];
      const tile = { ...observations()[0], ra_deg: reference.ra_deg, dec_deg: 0, inference_role: "exclude" as const };
      expect(latticeSiteOccupied({ ra_deg: 150 + 0.08 * scale, dec_deg: 0 }, [tile], reference, basis, 0.08)).toBe(true);
      expect(latticeSiteOccupied({ ra_deg: 150 + 0.09 * scale, dec_deg: 0 }, [tile], reference, basis, 0.08)).toBe(false);
      expect(latticeSiteOccupied(tile, [{ ...tile, enabled: false }], reference, basis, 0.08)).toBe(false);
    }
  });

  it("feeds the Gate 4 generator without changing the projection scale at a displaced anchor", () => {
    const origin = { ra_deg: 359.6, dec_deg: -24 };
    const data = observations(rectangular, cells, [0.2, 0.3], 0, origin);
    const fit = success(inferDeclaredLattice(data, rectangular, policy, origin));
    const region = { vertices: [[-0.5, -0.5], [3, -0.5], [3, 3], [-0.5, 3]].map((p) => {
      const [ra, dec] = localOffsetToSky(origin, p as TangentPlaneOffset); return { ra_deg: ra, dec_deg: dec };
    }) };
    const generated = generateLatticeCandidates(region, { ...rectangular, basis_deg: fit.basis_deg }, { type: "circle", radius_deg: 0.1 }, 1200, fit);
    for (const tile of data) {
      const site = generated.find((p) => p.i === fit.assignments.find((a) => a.tile_id === tile.id)!.i &&
        p.j === fit.assignments.find((a) => a.tile_id === tile.id)!.j)!;
      expect(site.ra_deg).toBeCloseTo(tile.ra_deg, 10);
      expect(site.dec_deg).toBeCloseTo(tile.dec_deg, 10);
    }
  });
});
