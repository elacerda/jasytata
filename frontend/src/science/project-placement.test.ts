import { describe, expect, it } from "vitest";
import type { Footprint, GenericLatticeTiling, LatticeProjectPlacement, ProjectPlacementPolicy, ResolvedLatticeProjectPlacement, SkyPolygon, TangentPlaneOffset } from "../types";
import { localOffsetToSky, rotateLocalOffset, skyToLocalOffset } from "./footprint-engine";
import { candidateLatticeRange, generateLatticeCandidates, latticePoint } from "./lattice";
import { LATTICE_BASIS_DEGENERACY_TOLERANCE, validateLatticeBasis } from "./lattice-validation";
import { resolveProjectPlacement } from "./project-placement";

const region: SkyPolygon = { vertices: [
  { ra_deg: 149, dec_deg: -1 }, { ra_deg: 151, dec_deg: -1 },
  { ra_deg: 151, dec_deg: 1 }, { ra_deg: 149, dec_deg: 1 },
] };

function latticePolicy(
  authoring: LatticeProjectPlacement["authoring"],
  rotation: LatticeProjectPlacement["rotation"] = { mode: "independent", rotation_deg: 0 },
  origin: LatticeProjectPlacement["origin"] = { type: "region_center" },
): LatticeProjectPlacement {
  return { type: "lattice_project_placement", provenance: "user_declared", authoring, rotation, origin };
}

function resolveLattice(policy: LatticeProjectPlacement, selectedRegion = region, pa?: number): ResolvedLatticeProjectPlacement {
  const resolved = resolveProjectPlacement(policy, selectedRegion, pa);
  if (resolved.type !== "resolved_lattice_project_placement") throw new Error("Expected a resolved lattice");
  return resolved;
}

describe("Gate 1 project-placement resolution", () => {
  it("resolves rectangular spacing into the canonical basis with astronomical positive rotation", () => {
    const zero = resolveLattice(latticePolicy({
      preset: "rectangular", east_spacing_deg: 4, north_spacing_deg: 2,
    }));
    expect(zero).toMatchObject({
      type: "resolved_lattice_project_placement",
      provenance: "user_declared",
      basis_deg: [[4, 0], [0, 2]],
      rotation_mode: "independent",
      lattice_rotation_deg: 0,
    });

    const quarterTurn = resolveLattice(latticePolicy({
      preset: "rectangular", east_spacing_deg: 4, north_spacing_deg: 2,
    }, { mode: "independent", rotation_deg: 90 }));
    expect(quarterTurn).toMatchObject({ basis_deg: [[0, -4], [2, 0]], lattice_rotation_deg: 90 });
  });

  it("defines triangular pitch as each nearest-neighbor center spacing", () => {
    const pitch = 0.8;
    const zero = resolveLattice(latticePolicy({ preset: "triangular", pitch_deg: pitch }));
    expect(zero.basis_deg).toEqual([[pitch, 0], [pitch / 2, Math.sqrt(3) * pitch / 2]]);
    const [b1, b2] = zero.basis_deg;
    expect(Math.hypot(...b1)).toBeCloseTo(pitch, 14);
    expect(Math.hypot(...b2)).toBeCloseTo(pitch, 14);
    expect(Math.hypot(b2[0] - b1[0], b2[1] - b1[1])).toBeCloseTo(pitch, 14);

    const angle = 37;
    const rotated = resolveLattice(latticePolicy(
      { preset: "triangular", pitch_deg: pitch }, { mode: "independent", rotation_deg: angle },
    ));
    expect(rotated.basis_deg[0]).toEqual(rotateLocalOffset([pitch, 0], angle));
    expect(rotated.basis_deg[1]).toEqual(rotateLocalOffset([pitch / 2, Math.sqrt(3) * pitch / 2], angle));
    expect(Math.hypot(...rotated.basis_deg[0])).toBeCloseTo(pitch, 14);
    expect(Math.hypot(...rotated.basis_deg[1])).toBeCloseTo(pitch, 14);
  });

  it("accepts an advanced oblique basis and rejects degenerate advanced input", () => {
    const basis: [TangentPlaneOffset, TangentPlaneOffset] = [[0.8, 0.3], [-0.2, 0.9]];
    expect(resolveLattice(latticePolicy({ preset: "advanced_basis", basis_deg: basis })).basis_deg).toEqual(basis);
    expect(() => resolveLattice(latticePolicy({
      preset: "advanced_basis", basis_deg: [[1, 1], [2, 2]],
    } as unknown as LatticeProjectPlacement["authoring"]))).toThrow(/collinear/);
  });

  it("requires positive preset spacings and validates the selected region", () => {
    expect(() => resolveLattice(latticePolicy({ preset: "rectangular", east_spacing_deg: 0, north_spacing_deg: 1 }))).toThrow(/positive/);
    expect(() => resolveLattice(latticePolicy({ preset: "rectangular", east_spacing_deg: 1, north_spacing_deg: Number.NaN }))).toThrow(/finite/);
    expect(() => resolveLattice(latticePolicy({ preset: "triangular", pitch_deg: 0 }))).toThrow(/positive/);
    expect(() => resolveLattice(latticePolicy({ preset: "triangular", pitch_deg: Number.POSITIVE_INFINITY }))).toThrow(/finite/);
    const invalidRegion = { vertices: [{ ra_deg: 360, dec_deg: 0 }] } as unknown as SkyPolygon;
    expect(() => resolveLattice(latticePolicy({ preset: "triangular", pitch_deg: 1 }), invalidRegion)).toThrow(/Polygon/);
  });

  it("keeps independent lattice rotation separate from an instrument PA and resolves follow-PA explicitly", () => {
    const independent = latticePolicy(
      { preset: "rectangular", east_spacing_deg: 1, north_spacing_deg: 2 },
      { mode: "independent", rotation_deg: 17 },
    );
    expect(resolveLattice(independent, region, 91)).toEqual(resolveLattice(independent));

    const following = latticePolicy(
      { preset: "rectangular", east_spacing_deg: 1, north_spacing_deg: 2 },
      { mode: "follow_instrument_pa" },
    );
    expect(() => resolveLattice(following)).toThrow(/requires a resolved instrument\/project PA/);
    const resolved = resolveLattice(following, region, 90);
    expect(resolved).toMatchObject({ rotation_mode: "follow_instrument_pa", lattice_rotation_deg: 90, basis_deg: [[0, -1], [2, 0]] });
  });

  it("resolves region_center to the deterministic unwrapped bounds midpoint across RA zero", () => {
    const crossesZero: SkyPolygon = { vertices: [
      { ra_deg: 359.6, dec_deg: -0.3 }, { ra_deg: 0.4, dec_deg: -0.3 },
      { ra_deg: 0.4, dec_deg: 0.1 }, { ra_deg: 359.8, dec_deg: 0.1 },
      { ra_deg: 359.8, dec_deg: 0.4 }, { ra_deg: 359.6, dec_deg: 0.4 },
    ] };
    const policy = latticePolicy({ preset: "rectangular", east_spacing_deg: 0.1, north_spacing_deg: 0.1 });
    const first = resolveLattice(policy, crossesZero);
    const reordered: SkyPolygon = { vertices: [...crossesZero.vertices.slice(2), ...crossesZero.vertices.slice(0, 2)] };
    const second = resolveLattice(policy, reordered);
    expect(first.basis_deg).toEqual(second.basis_deg);
    expect(first.origin).toEqual(second.origin);
    expect(first.resolved_origin.ra_deg).toBeCloseTo(second.resolved_origin.ra_deg, 12);
    expect(first.resolved_origin.dec_deg).toBeCloseTo(second.resolved_origin.dec_deg, 12);
    expect(first.origin).toEqual({ type: "region_center" });
    expect(first.resolved_origin.ra_deg).toBeCloseTo(0, 12);
    expect(first.resolved_origin.dec_deg).toBeCloseTo(0.05, 12);
  });

  it("validates ICRS fixed anchors and rejects exact poles outside the local projection domain", () => {
    const authoring = { preset: "rectangular", east_spacing_deg: 1, north_spacing_deg: 1 } as const;
    for (const [ra_deg, dec_deg] of [[-0.1, 0], [360, 0], [150, 90], [150, -90], [150, Number.NaN], [150, Number.POSITIVE_INFINITY]]) {
      expect(() => resolveLattice(latticePolicy(authoring, undefined, { type: "fixed_anchor", ra_deg, dec_deg }))).toThrow();
    }
    expect(resolveLattice(latticePolicy(authoring, undefined, { type: "fixed_anchor", ra_deg: 359.9, dec_deg: -82 })))
      .toMatchObject({ resolved_origin: { ra_deg: 359.9, dec_deg: -82 } });
  });

  it("requires user-declared provenance and rejects non-project placement shapes", () => {
    const policy = latticePolicy({ preset: "triangular", pitch_deg: 1 });
    expect(() => resolveProjectPlacement({ ...policy, provenance: "registered" } as unknown as ProjectPlacementPolicy, region)).toThrow(/user_declared/);
    expect(resolveProjectPlacement({ type: "manual_project_placement", provenance: "user_declared" }, region))
      .toEqual({ type: "resolved_manual_project_placement", provenance: "user_declared" });
  });

  it("returns JSON- and structured-clone-safe canonical state", () => {
    const resolved = resolveLattice(latticePolicy({
      preset: "triangular", pitch_deg: 0.7,
    }, { mode: "independent", rotation_deg: 23 }, { type: "fixed_anchor", ra_deg: 359.8, dec_deg: 82 } ));
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
    expect(structuredClone(resolved)).toEqual(resolved);
  });
});

describe("Gate 1 shared scale-safe lattice basis validation", () => {
  it("rejects zero, collinear, non-finite, and near-collinear vectors around the frozen cutoff", () => {
    expect(() => validateLatticeBasis([[0, 0], [1, 0]])).toThrow(/non-zero/);
    expect(() => validateLatticeBasis([[1, 0], [2, 0]])).toThrow(/collinear/);
    expect(() => validateLatticeBasis([[Number.NaN, 0], [0, 1]])).toThrow(/finite/);
    expect(() => validateLatticeBasis([[1, 0], [0, Number.POSITIVE_INFINITY]])).toThrow(/finite/);

    const below = LATTICE_BASIS_DEGENERACY_TOLERANCE * 0.9;
    const above = LATTICE_BASIS_DEGENERACY_TOLERANCE * 1.1;
    expect(() => validateLatticeBasis([[1, 0], [1, below]])).toThrow(/collinear/);
    expect(() => validateLatticeBasis([[1, 0], [1, above]])).not.toThrow();
    expect(() => candidateLatticeRange(region, [[1, 0], [1, below]], { ra_deg: 150, dec_deg: 0 }, { type: "circle", radius_deg: 0.1 })).toThrow(/collinear/);
    expect(() => candidateLatticeRange(region, [[1, 0], [1, above]], { ra_deg: 150, dec_deg: 0 }, { type: "circle", radius_deg: 0.1 })).not.toThrow();
  });

  it("accepts extremely small and large finite basis scales without scale-driven rejection", () => {
    expect(() => validateLatticeBasis([[1e-300, 0], [0, 1e-300]])).not.toThrow();
    expect(() => validateLatticeBasis([[1e300, 0], [0, 1e300]])).not.toThrow();
  });
});

describe("Gate 1 frozen local east/north transform", () => {
  it("uses shortest wrapped RA branches in both crossing directions", () => {
    expect(skyToLocalOffset({ ra_deg: 0.1, dec_deg: 30 }, { ra_deg: 359.9, dec_deg: 30 })[0])
      .toBeCloseTo(0.2 * Math.cos(30 * Math.PI / 180), 12);
    expect(skyToLocalOffset({ ra_deg: 359.9, dec_deg: 30 }, { ra_deg: 0.1, dec_deg: 30 })[0])
      .toBeCloseTo(-0.2 * Math.cos(30 * Math.PI / 180), 12);
    expect(localOffsetToSky({ ra_deg: 359.9, dec_deg: 30 }, [0.2 * Math.cos(30 * Math.PI / 180), 0])[0]).toBeCloseTo(0.1, 12);
    expect(localOffsetToSky({ ra_deg: 0.1, dec_deg: 30 }, [-0.2 * Math.cos(30 * Math.PI / 180), 0])[0]).toBeCloseTo(359.9, 12);
  });

  it.each([82, -82])("round-trips the current local approximation around DEC %s", (dec_deg) => {
    const reference = { ra_deg: 359.95, dec_deg };
    const sky = { ra_deg: 0.05, dec_deg: dec_deg + 0.1 };
    const offset = skyToLocalOffset(sky, reference);
    expect(offset[0]).toBeCloseTo(0.1 * Math.cos(dec_deg * Math.PI / 180), 14);
    expect(offset[1]).toBeCloseTo(0.1, 12);
    const roundTrip = localOffsetToSky(reference, offset);
    expect(roundTrip[0]).toBeCloseTo(0.05, 12);
    expect(roundTrip[1]).toBeCloseTo(dec_deg + 0.1, 14);
  });

  it.each([89.9, -89.9])("retains the 0.01 cosine clamp near DEC %s", (dec_deg) => {
    const reference = { ra_deg: 150, dec_deg };
    const offset = skyToLocalOffset({ ra_deg: 151, dec_deg }, reference);
    expect(offset[0]).toBeCloseTo(0.01, 14);
    expect(localOffsetToSky(reference, [0.01, 0])[0]).toBeCloseTo(151, 12);
  });
});

describe("Gate 1 deterministic candidate admissibility", () => {
  it("repeats exact j/i ordering and centers for independent rotated lattice and footprint orientations", () => {
    const angle = 23;
    const tiling: GenericLatticeTiling = {
      type: "lattice",
      basis_deg: [rotateLocalOffset([0.4, 0], angle), rotateLocalOffset([0, 0.35], angle)],
      origin: { type: "region_center" },
    };
    const footprint: Footprint = { type: "rectangle", width_deg: 0.24, height_deg: 0.08, position_angle_deg: 37 };
    const broadRegion: SkyPolygon = { vertices: [
      { ra_deg: 148, dec_deg: -2 }, { ra_deg: 152, dec_deg: -2 },
      { ra_deg: 152, dec_deg: 2 }, { ra_deg: 148, dec_deg: 2 },
    ] };
    const first = generateLatticeCandidates(broadRegion, tiling, footprint, 1200);
    const repeated = generateLatticeCandidates(broadRegion, tiling, footprint, 1200);
    expect(repeated).toEqual(first);
    expect(first.map(({ i, j }) => [i, j])).toEqual([...first].sort((a, b) => a.j - b.j || a.i - b.i).map(({ i, j }) => [i, j]));
    const site = first.find(({ i, j }) => i === 1 && j === 0);
    expect(site).toBeDefined();
    expect(site).toMatchObject(latticePoint(1, 0, tiling.basis_deg));

    const cameraTurned: Footprint = { ...footprint, position_angle_deg: 71 };
    const second = generateLatticeCandidates(broadRegion, tiling, cameraTurned, 1200);
    expect(second.find(({ i, j }) => i === 1 && j === 0)).toEqual(site);
    expect(tiling.basis_deg).toEqual([rotateLocalOffset([0.4, 0], angle), rotateLocalOffset([0, 0.35], angle)]);
  });

  it("excludes a boundary-only footprint contact with the selected region", () => {
    const touchingRegion: SkyPolygon = { vertices: [
      { ra_deg: 150.5, dec_deg: -0.1 }, { ra_deg: 150.7, dec_deg: -0.1 },
      { ra_deg: 150.7, dec_deg: 0.1 }, { ra_deg: 150.5, dec_deg: 0.1 },
    ] };
    const sparse: GenericLatticeTiling = {
      type: "lattice", basis_deg: [[10, 0], [0, 10]],
      origin: { type: "fixed_anchor", ra_deg: 150, dec_deg: 0 },
    };
    expect(generateLatticeCandidates(touchingRegion, sparse, { type: "rectangle", width_deg: 1, height_deg: 1 }, 1200)).toEqual([]);
  });
});
