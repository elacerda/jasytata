import { describe, expect, it } from "vitest";
import type { Footprint, LatticeProjectPlacement, SkyPolygon } from "../types";
import { previewProjectLattice, projectAngularToDegrees } from "./project-lattice-preview";

const region: SkyPolygon = { vertices: [
  { ra_deg: 149.95, dec_deg: -0.05 }, { ra_deg: 150.05, dec_deg: -0.05 },
  { ra_deg: 150.05, dec_deg: 0.05 }, { ra_deg: 149.95, dec_deg: 0.05 },
] };
const footprint: Footprint = { type: "circle", radius_deg: 0.01 };

function placement(
  spacingDeg = 1 / 60,
  rotation: LatticeProjectPlacement["rotation"] = { mode: "independent", rotation_deg: 0 },
  origin: LatticeProjectPlacement["origin"] = { type: "region_center" },
): LatticeProjectPlacement {
  return {
    type: "lattice_project_placement", provenance: "user_declared",
    authoring: { preset: "rectangular", east_spacing_deg: spacingDeg, north_spacing_deg: spacingDeg },
    rotation, origin,
  };
}

describe("Gate 3 project lattice candidate preview", () => {
  it("converts explicit angular units to canonical degrees", () => {
    expect(projectAngularToDegrees(58, "arcsec")).toBeCloseTo(58 / 3600, 14);
    expect(projectAngularToDegrees(1, "arcmin")).toBeCloseTo(1 / 60, 14);
    expect(projectAngularToDegrees(1, "deg")).toBe(1);
    expect(() => projectAngularToDegrees(Number.NaN, "deg")).toThrow(/finite/);
  });

  it("resolves 58-arcsecond rectangular grids at zero and non-zero rotation", () => {
    const pitch = projectAngularToDegrees(58, "arcsec");
    const zero = previewProjectLattice(region, placement(pitch), footprint);
    expect(zero.placement.basis_deg).toEqual([[pitch, 0], [0, pitch]]);

    const turned = previewProjectLattice(region, {
      ...placement(pitch, { mode: "independent", rotation_deg: 30 }),
    }, footprint);
    expect(turned.placement.lattice_rotation_deg).toBe(30);
    expect(turned.placement.basis_deg).not.toEqual(zero.placement.basis_deg);
  });

  it("keeps triangular pitch as nearest-neighbor spacing before rotation", () => {
    const pitch = projectAngularToDegrees(58, "arcsec");
    const policy: LatticeProjectPlacement = {
      ...placement(),
      authoring: { preset: "triangular", pitch_deg: pitch },
    };
    const zero = previewProjectLattice(region, policy, footprint);
    expect(zero.placement.basis_deg[0]).toEqual([pitch, 0]);
    expect(Math.hypot(...zero.placement.basis_deg[1])).toBeCloseTo(pitch, 14);
    const rotated = previewProjectLattice(region, {
      ...policy, rotation: { mode: "independent", rotation_deg: 37 },
    }, footprint);
    expect(Math.hypot(...rotated.placement.basis_deg[0])).toBeCloseTo(pitch, 14);
    expect(Math.hypot(...rotated.placement.basis_deg[1])).toBeCloseTo(pitch, 14);
  });

  it("retains independent lattice rotation separately from physical instrument PA", () => {
    const camera = { type: "rectangle", width_deg: 0.04, height_deg: 0.02, position_angle_deg: 30 } as const;
    const independent = previewProjectLattice(region, placement(0.04), camera, 30);
    const following = previewProjectLattice(region, placement(0.04, { mode: "follow_instrument_pa" }), camera, 30);
    expect(independent.placement.lattice_rotation_deg).toBe(0);
    expect(following.placement.lattice_rotation_deg).toBe(30);
    expect(independent.placement.basis_deg).not.toEqual(following.placement.basis_deg);
    expect(camera.position_angle_deg).toBe(30);
  });

  it("returns deterministic candidates in j-then-i order without proposal identities", () => {
    const policy = placement(0.02);
    const first = previewProjectLattice(region, policy, footprint);
    const repeated = previewProjectLattice(region, policy, footprint);
    expect(repeated).toEqual(first);
    expect(first.candidates.length).toBeGreaterThan(0);
    expect(first.candidates.map(({ j, i }) => [j, i])).toEqual(
      [...first.candidates].sort((a, b) => a.j - b.j || a.i - b.i).map(({ j, i }) => [j, i]),
    );
    expect(first.candidates[0]).not.toHaveProperty("id");
    expect(first.candidates[0]).not.toHaveProperty("source");
  });

  it("rejects excessive search ranges and zero admissible sites", () => {
    expect(() => previewProjectLattice(region, placement(0.01), footprint, undefined, 2)).toThrow(/reduce the selected area/);
    expect(() => previewProjectLattice(region, placement(0.5, { mode: "independent", rotation_deg: 0 }, {
      type: "fixed_anchor", ra_deg: 159.37, dec_deg: 0,
    }), { type: "circle", radius_deg: 0.001 })).toThrow(/no admissible candidate sites/);
  });
});
