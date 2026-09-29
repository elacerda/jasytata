import { describe, expect, it } from "vitest";
import type { Footprint } from "../types";
import {
  deriveEffectiveSequenceFootprint,
  deriveExposurePlacements,
  normalizeSequenceAngle,
  type ObservingSequence,
} from "./exposure-sequence";

const pointing = { id: "galaxy-1", center: { ra_deg: 150, dec_deg: 30 } };

function referenceSkyOffset(raDeg: number, decDeg: number, eastArcsec: number, northArcsec: number) {
  const cosine = Math.max(Math.cos(decDeg * Math.PI / 180), 0.01);
  const rawRa = raDeg + eastArcsec / 3600 / cosine;
  return [((rawRa % 360) + 360) % 360, decDeg + northArcsec / 3600];
}

function expectSkyClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual[0]).toBeCloseTo(expected[0], 12);
  expect(actual[1]).toBeCloseTo(expected[1], 12);
}

describe("pure observing-sequence geometry", () => {
  it("preserves one nominal exposure and absent PA when no sequence is supplied", () => {
    expect(deriveExposurePlacements(pointing)).toEqual([{
      id: "galaxy-1:1",
      order: 1,
      center: [150, 30],
      eastOffsetArcsec: 0,
      northOffsetArcsec: 0,
      relativeRotationDeg: 0,
    }]);
  });

  it("uses sky-local east/north offsets independent of nominal PA", () => {
    const sequence: ObservingSequence = {
      id: "offset-check",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0 },
        { order: 2, east_arcsec: 12, north_arcsec: -6 },
      ],
    };
    const placements = deriveExposurePlacements({ ...pointing, positionAngleDeg: 137 }, sequence);
    expect(placements.map((item) => item.center[0])).toEqual([
      ...referenceSkyOffset(150, 30, 0, 0).slice(0, 1),
      ...referenceSkyOffset(150, 30, 12, -6).slice(0, 1),
    ]);
    expect(placements[1].center[1]).toBeCloseTo(30 - 6 / 3600, 14);
    expect(placements[1].positionAngleDeg).toBe(137);
    expect(placements[1].id).toBe("offset-check:2");
  });

  it("composes relative rotation with declared PA and keeps absent PA absent", () => {
    const sequence: ObservingSequence = {
      id: "rotation",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 },
        { order: 2, east_arcsec: 0, north_arcsec: 0, rotation_deg: 90 },
      ],
    };
    const declared = deriveExposurePlacements({ ...pointing, positionAngleDeg: 350 }, sequence);
    expect(declared.map((item) => item.positionAngleDeg)).toEqual([350, 80]);
    expect(declared.map((item) => item.geometryPositionAngleDeg)).toEqual([350, 80]);

    const absent = deriveExposurePlacements(pointing, {
      id: "absent-zero-rotation",
      exposures: [{ order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 }],
    });
    expect(absent[0]).not.toHaveProperty("positionAngleDeg");
    expect(absent[0]).not.toHaveProperty("geometryPositionAngleDeg");
    for (const equivalentZero of [360, -360, 720]) {
      const equivalent = deriveExposurePlacements(pointing, {
        id: `absent-equivalent-${equivalentZero}`,
        exposures: [{ order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: equivalentZero }],
      });
      expect(equivalent[0].center).toEqual(absent[0].center);
      expect(equivalent[0]).not.toHaveProperty("positionAngleDeg");
      expect(equivalent[0]).not.toHaveProperty("geometryPositionAngleDeg");
    }
    expect(() => deriveExposurePlacements(pointing, sequence)).toThrow(/requires a declared pointing PA/);
  });

  it("normalizes equivalent angles without mutating stored relative rotations", () => {
    expect([0, 360, -360].map(normalizeSequenceAngle)).toEqual([0, 0, 0]);
    expect([90, -270].map(normalizeSequenceAngle)).toEqual([90, 90]);
    const sequence: ObservingSequence = {
      id: "preserve",
      exposures: [{ order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: -270 }],
    };
    const derived = deriveExposurePlacements({ ...pointing, positionAngleDeg: 360 }, sequence);
    expect(sequence.exposures[0].rotation_deg).toBe(-270);
    expect(derived[0].relativeRotationDeg).toBe(-270);
    expect(derived[0].positionAngleDeg).toBe(90);
  });

  it("matches the frozen CALIFA three-position sequence", () => {
    const sequence: ObservingSequence = {
      id: "califa-ppak-three-point",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0 },
        { order: 2, east_arcsec: -5.22, north_arcsec: -4.53 },
        { order: 3, east_arcsec: -5.22, north_arcsec: 4.53 },
      ],
    };
    const placements = deriveExposurePlacements(pointing, sequence);
    expect(placements.map(({ order }) => order)).toEqual([1, 2, 3]);
    for (const [index, eastArcsec, northArcsec] of [[0, 0, 0], [1, -5.22, -4.53], [2, -5.22, 4.53]] as const) {
      expectSkyClose(placements[index].center, referenceSkyOffset(150, 30, eastArcsec, northArcsec));
      expect(placements[index].relativeRotationDeg).toBe(0);
    }
  });

  it("matches the frozen MaNGA N-S-E equilateral sequence", () => {
    const a = 1.44;
    const east = -a / (2 * Math.sqrt(3));
    const sequence: ObservingSequence = {
      id: "sdss-manga-three-point",
      exposures: [
        { order: 1, east_arcsec: east, north_arcsec: a / 2 },
        { order: 2, east_arcsec: east, north_arcsec: -a / 2 },
        { order: 3, east_arcsec: a / Math.sqrt(3), north_arcsec: 0 },
      ],
    };
    const placements = deriveExposurePlacements(pointing, sequence);
    const vertices = sequence.exposures.map(({ east_arcsec, north_arcsec }) => [east_arcsec, north_arcsec]);
    const sideLengths = [0, 1, 2].map((index) => {
      const [east1, north1] = vertices[index];
      const [east2, north2] = vertices[(index + 1) % 3];
      return Math.hypot(east2 - east1, north2 - north1);
    });
    expect(placements.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(sideLengths).toEqual([a, a, a]);
    expectSkyClose(placements[0].center, referenceSkyOffset(150, 30, east, a / 2));
    expectSkyClose(placements[1].center, referenceSkyOffset(150, 30, east, -a / 2));
    expectSkyClose(placements[2].center, referenceSkyOffset(150, 30, a / Math.sqrt(3), 0));
  });

  it("supports the frozen canonical SAMI center-plus-six ring", () => {
    const ring = Array.from({ length: 6 }, (_, index) => {
      const angle = index * Math.PI / 3;
      return {
        order: index + 2,
        east_arcsec: 0.7 * Math.sin(angle),
        north_arcsec: 0.7 * Math.cos(angle),
      };
    });
    const sequence: ObservingSequence = {
      id: "sami-dr1-seven-position",
      exposures: [{ order: 1, east_arcsec: 0, north_arcsec: 0 }, ...ring],
    };
    const placements = deriveExposurePlacements(pointing, sequence);
    expect(placements).toHaveLength(7);
    expect(placements[0].center).toEqual([150, 30]);
    expect(placements.slice(1).map(({ eastOffsetArcsec, northOffsetArcsec }) =>
      Math.hypot(eastOffsetArcsec, northOffsetArcsec))).toEqual(Array(6).fill(0.7));
    const neighbors = ring.map((offset, index) => {
      const next = ring[(index + 1) % ring.length];
      return Math.hypot(offset.east_arcsec - next.east_arcsec, offset.north_arcsec - next.north_arcsec);
    });
    for (const side of neighbors) expect(side).toBeCloseTo(0.7, 12);
  });

  it("represents effective geometry as an ordered union without mutating the profile", () => {
    const footprint: Footprint = { type: "circle", radius_deg: 0.25 };
    const sequence: ObservingSequence = {
      id: "same-position",
      exposures: [
        { order: 1, east_arcsec: 0, north_arcsec: 0 },
        { order: 2, east_arcsec: 0, north_arcsec: 0 },
      ],
    };
    const result = deriveEffectiveSequenceFootprint(pointing, footprint, sequence);
    expect(result.type).toBe("exposure_union");
    expect(result.exposures).toHaveLength(2);
    expect(result.exposures.map(({ exposure }) => exposure.center)).toEqual([[150, 30], [150, 30]]);
    expect(result.exposures.every(({ footprint: shape }) => shape === footprint)).toBe(true);
    expect(footprint).toEqual({ type: "circle", radius_deg: 0.25 });
    // Identical placements describe one geometric region in a union, not two
    // additive footprint-area contributions.
    const uniqueCenters = new Set(result.exposures.map(({ exposure }) => exposure.center.join(",")));
    expect(uniqueCenters.size).toBe(1);
  });

  it("rejects malformed IDs, ordering, and nonfinite values", () => {
    expect(() => deriveExposurePlacements(pointing, { id: " ", exposures: [
      { order: 1, east_arcsec: 0, north_arcsec: 0 },
    ] })).toThrow(/Sequence ID/);
    expect(() => deriveExposurePlacements(pointing, { id: "bad-order", exposures: [
      { order: 2, east_arcsec: 0, north_arcsec: 0 },
    ] })).toThrow(/contiguous/);
    expect(() => deriveExposurePlacements(pointing, { id: "bad-offset", exposures: [
      { order: 1, east_arcsec: Number.NaN, north_arcsec: 0 },
    ] })).toThrow(/finite/);
    expect(() => deriveExposurePlacements(pointing, { id: "bad-rotation", exposures: [
      { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: Number.POSITIVE_INFINITY },
    ] })).toThrow(/rotation must be finite/);
    expect(() => deriveExposurePlacements({ ...pointing, positionAngleDeg: Number.NaN })).toThrow(/PA must be finite/);
  });
});
