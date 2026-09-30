import { measureResolvedCoverage } from "./test-support/resolved-coverage";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, T80_SOUTH_INSTRUMENT_V2 } from "../profiles";
import { createBundledProfileRegistry } from "../profiles/registry";
import type { Footprint, SkyPolygon, TileRecord } from "../types";
import { coveredMask, contributingTileCountForTiles, sampleRegion, tileMask } from "./coverage";
import { footprintContainsPoint, footprintIntersectsRegion, rotateLocalOffset } from "./footprint-engine";
import { pointingGeometryUnionArea, resolvePointingGeometries, type PointingGeometry } from "./pointing-geometry";
import type { ObservingSequence } from "./exposure-sequence";

const rectangle: Footprint = { type: "rectangle", width_deg: 2, height_deg: 1 };

function tile(positionAngle?: number): TileRecord {
  return {
    id: "pointing-1", name: "Pointing 1", ra_deg: 150, dec_deg: 0,
    ...(positionAngle === undefined ? {} : { position_angle_deg: positionAngle }),
    source: "original", generation_method: null, original_values: null, metadata: {},
    instrument_profile_id: "gate5-test-camera",
  };
}

function registryFor(footprint: Footprint) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile({ ...T80_SOUTH_INSTRUMENT_V2, id: "gate5-test-camera", footprint });
  return registry;
}

function squareAt(ra: number, dec: number, width: number, height = width): SkyPolygon {
  return { vertices: [
    { ra_deg: ra - width / 2, dec_deg: dec - height / 2 },
    { ra_deg: ra + width / 2, dec_deg: dec - height / 2 },
    { ra_deg: ra + width / 2, dec_deg: dec + height / 2 },
    { ra_deg: ra - width / 2, dec_deg: dec + height / 2 },
  ] };
}

function perPointingContext(coverageBasis: "single_exposure" | "effective_sequence" = "single_exposure") {
  return { orientationPolicyForTile: () => ({ policy: "per_pointing" as const, required: true }), coverageBasis };
}

function sequenceContext(sequence: ObservingSequence, coverageBasis: "single_exposure" | "effective_sequence") {
  return {
    orientationPolicyForTile: () => ({ policy: "not_applicable" as const }),
    coverageBasis,
    sequenceForTile: () => sequence,
  };
}

function expectSameMask(actual: Uint8Array, expected: Uint8Array): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

describe("canonical pointing geometry", () => {
  it("resolves fixed PA on a non-square rectangle and preserves the instrument profile", () => {
    const fixed = { ...rectangle, position_angle_deg: 90 } as Footprint;
    const registry = registryFor(fixed);
    const sourceFootprint = registry.resolveInstrumentProfile("gate5-test-camera").footprint;
    const geometry = resolvePointingGeometries(tile(), DEFAULT_PROFILE, registry, {
      orientationPolicyForTile: () => ({ policy: "fixed", required: true }),
    })[0];

    expect(geometry.position_angle_deg).toBe(90);
    expect(geometry.footprint).toMatchObject({ type: "rectangle", width_deg: 2, height_deg: 1, position_angle_deg: 90 });
    expect(registry.resolveInstrumentProfile("gate5-test-camera").footprint).toEqual(sourceFootprint);
    expect(footprintContainsPoint(geometry.footprint, [0, 0.8])).toBe(true);
    expect(footprintContainsPoint(geometry.footprint, [0.8, 0])).toBe(false);
    expect(footprintIntersectsRegion(geometry.footprint, { ra_deg: 150, dec_deg: 0 }, squareAt(150, 0.8, 0.1))).toBe(true);
    expect(footprintIntersectsRegion(geometry.footprint, { ra_deg: 150, dec_deg: 0 }, squareAt(150.8, 0, 0.1))).toBe(false);
    const grid = sampleRegion(squareAt(150, 0, 3), rectangle, {
      sampling: { target_samples_per_footprint_axis: 8, max_samples: 20_000 },
    });
    const mask = tileMask(grid, geometry.center[0], geometry.center[1], geometry.footprint);
    expect(mask.some(Boolean)).toBe(true);
  });

  it("applies distinct per-pointing PAs without changing the shared instrument", () => {
    const registry = registryFor(rectangle);
    const firstTile = tile(0);
    const secondTile = { ...tile(90), id: "pointing-2", ra_deg: firstTile.ra_deg, dec_deg: firstTile.dec_deg };
    const originalProfileFootprint = registry.resolveInstrumentProfile("gate5-test-camera").footprint;
    const first = resolvePointingGeometries(firstTile, DEFAULT_PROFILE, registry, perPointingContext())[0];
    const second = resolvePointingGeometries(secondTile, DEFAULT_PROFILE, registry, perPointingContext())[0];

    expect(first.center).toEqual(second.center);
    expect(first.position_angle_deg).toBe(0);
    expect(second.position_angle_deg).toBe(90);
    expect(first.footprint).not.toEqual(second.footprint);
    expect(footprintIntersectsRegion(first.footprint, { ra_deg: 150, dec_deg: 0 }, squareAt(150.8, 0, 0.1))).toBe(true);
    expect(footprintIntersectsRegion(second.footprint, { ra_deg: 150, dec_deg: 0 }, squareAt(150.8, 0, 0.1))).toBe(false);
    const grid = sampleRegion(squareAt(150, 0, 3), rectangle, {
      sampling: { target_samples_per_footprint_axis: 8, max_samples: 20_000 },
    });
    const firstMask = tileMask(grid, first.center[0], first.center[1], first.footprint);
    const secondMask = tileMask(grid, second.center[0], second.center[1], second.footprint);
    expect(Array.from(firstMask)).not.toEqual(Array.from(secondMask));
    expect(registry.resolveInstrumentProfile("gate5-test-camera").footprint).toEqual(originalProfileFootprint);
  });

  it("keeps absent PA absent while retaining usable canonical geometry", () => {
    const registry = registryFor(rectangle);
    const absentTile = tile();
    const geometry = resolvePointingGeometries(absentTile, DEFAULT_PROFILE, registry, {
      orientationPolicyForTile: () => ({ policy: "not_applicable" }),
    })[0];
    const grid = sampleRegion(squareAt(150, 0, 3), rectangle, {
      sampling: { target_samples_per_footprint_axis: 8, max_samples: 20_000 },
    });

    expect(geometry.position_angle_deg).toBeUndefined();
    expect("position_angle_deg" in geometry.footprint).toBe(false);
    expect(tileMask(grid, geometry.center[0], geometry.center[1], geometry.footprint).some(Boolean)).toBe(true);
  });

  it.each([0, 360, -360])("normalizes effective geometry for equivalent PA %s", (positionAngle) => {
    const registry = registryFor(rectangle);
    const geometry = resolvePointingGeometries(tile(positionAngle), DEFAULT_PROFILE, registry, perPointingContext())[0];
    expect(geometry.position_angle_deg).toBe(0);
    expect(geometry.footprint).toMatchObject({ position_angle_deg: 0 });
    expect(tile(positionAngle).position_angle_deg).toBe(positionAngle);
  });

  it("retains v2 behavior without context and rejects an unknown runtime basis", () => {
    const footprint = { ...rectangle, position_angle_deg: -270 } as Footprint;
    const registry = registryFor(footprint);
    const tileWithRowPA = tile(90);
    const legacy = resolvePointingGeometries(tileWithRowPA, DEFAULT_PROFILE, registry)[0];
    const effectiveWithoutSequence = resolvePointingGeometries(tileWithRowPA, DEFAULT_PROFILE, registry, {
      coverageBasis: "effective_sequence",
    })[0];
    expect(legacy.footprint).toEqual(footprint);
    expect(legacy.position_angle_deg).toBe(-270);
    expect(effectiveWithoutSequence).toEqual(legacy);
    expect(() => resolvePointingGeometries(tile(), DEFAULT_PROFILE, registry, {
      coverageBasis: "per-exposure" as "single_exposure",
    })).toThrow(/Unsupported pointing coverage basis/);
  });
});

describe("selected empirical exposure sequences", () => {
  const califa: ObservingSequence = { id: "califa-ppak-three-point", exposures: [
    { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 },
    { order: 2, east_arcsec: -5.22, north_arcsec: -4.53, rotation_deg: 0 },
    { order: 3, east_arcsec: -5.22, north_arcsec: 4.53, rotation_deg: 0 },
  ] };
  const sideArcsec = 1.44;
  const manga: ObservingSequence = { id: "sdss-manga-three-point", exposures: [
    { order: 1, east_arcsec: -sideArcsec / (2 * Math.sqrt(3)), north_arcsec: sideArcsec / 2, rotation_deg: 0 },
    { order: 2, east_arcsec: -sideArcsec / (2 * Math.sqrt(3)), north_arcsec: -sideArcsec / 2, rotation_deg: 0 },
    { order: 3, east_arcsec: sideArcsec / Math.sqrt(3), north_arcsec: 0, rotation_deg: 0 },
  ] };

  it("derives CALIFA offsets in the documented order without asserting bundle shape", () => {
    // Synthetic test geometry uses the approximate extent only as a convenient
    // scale; this is not a PPAK footprint model or a claim about its vertices.
    const syntheticFootprint: Footprint = { type: "rectangle", width_deg: 74 / 3600, height_deg: 64 / 3600 };
    const registry = registryFor(syntheticFootprint);
    const effective = resolvePointingGeometries(tile(), DEFAULT_PROFILE, registry, sequenceContext(califa, "effective_sequence"));
    const nominal = resolvePointingGeometries(tile(), DEFAULT_PROFILE, registry, sequenceContext(califa, "single_exposure"));

    expect(effective).toHaveLength(3);
    expect(effective.map(({ order }) => order)).toEqual([1, 2, 3]);
    expect(effective.map(({ footprint }) => footprint)).toEqual([syntheticFootprint, syntheticFootprint, syntheticFootprint]);
    expect(effective[0].center).toEqual([tile().ra_deg, tile().dec_deg]);
    expect(effective[1].center[0]).toBeLessThan(tile().ra_deg);
    expect(effective[1].center[1]).toBeLessThan(tile().dec_deg);
    expect(effective[2].center[1]).toBeGreaterThan(tile().dec_deg);
    expect(nominal).toHaveLength(1);
    expect(nominal[0].center).toEqual([tile().ra_deg, tile().dec_deg]);
  });

  it("keeps MaNGA's north/south/east set one pointing and one lattice-independent union", () => {
    const registry = registryFor({ type: "circle", radius_deg: 6 / 3600 });
    const geometryTile = tile();
    const context = sequenceContext(manga, "effective_sequence");
    const effective = resolvePointingGeometries(geometryTile, DEFAULT_PROFILE, registry, context);
    const single = resolvePointingGeometries(geometryTile, DEFAULT_PROFILE, registry, sequenceContext(manga, "single_exposure"));
    const localCenters = effective.map(({ center: [ra, dec] }) => [ra * 3600, dec * 3600]);
    const separations = [
      Math.hypot(localCenters[0][0] - localCenters[1][0], localCenters[0][1] - localCenters[1][1]),
      Math.hypot(localCenters[0][0] - localCenters[2][0], localCenters[0][1] - localCenters[2][1]),
      Math.hypot(localCenters[1][0] - localCenters[2][0], localCenters[1][1] - localCenters[2][1]),
    ];

    expect(effective).toHaveLength(3);
    expect(effective.map(({ order }) => order)).toEqual([1, 2, 3]);
    expect(separations.every((distance) => Math.abs(distance - sideArcsec) < 1e-8)).toBe(true);
    expect((manga.exposures.reduce((sum, exposure) => sum + exposure.east_arcsec, 0)) / 3).toBeCloseTo(0, 12);
    expect((manga.exposures.reduce((sum, exposure) => sum + exposure.north_arcsec, 0)) / 3).toBeCloseTo(0, 12);
    expect(single).toHaveLength(1);
    expect(single[0].center).toEqual([geometryTile.ra_deg, geometryTile.dec_deg]);
    expect(effective.some(({ center }) => center[0] === single[0].center[0] && center[1] === single[0].center[1])).toBe(false);
  });
});

describe("sequence coverage and physical union area", () => {
  it("unions exposure masks once and counts one intersecting nominal pointing", () => {
    const registry = registryFor({ type: "rectangle", width_deg: 0.5, height_deg: 0.5 });
    const pointing = tile();
    const sequence: ObservingSequence = { id: "two-offsets", exposures: [
      { order: 1, east_arcsec: -360, north_arcsec: 0 },
      { order: 2, east_arcsec: 360, north_arcsec: 0 },
    ] };
    const context = sequenceContext(sequence, "effective_sequence");
    const grid = sampleRegion(squareAt(150, 0, 1.5), rectangle, {
      sampling: { target_samples_per_footprint_axis: 8, max_samples: 20_000 },
    });
    const effective = coveredMask(grid, [pointing], DEFAULT_PROFILE, registry, context);
    const geometries = resolvePointingGeometries(pointing, DEFAULT_PROFILE, registry, context);
    const expected = new Uint8Array(grid.ra.length);
    for (const geometry of geometries) {
      const exposureMask = tileMask(grid, geometry.center[0], geometry.center[1], geometry.footprint);
      for (let index = 0; index < expected.length; index += 1) if (exposureMask[index]) expected[index] = 1;
    }
    expectSameMask(effective, expected);
    expect(contributingTileCountForTiles(squareAt(150, 0, 1.5), [pointing], DEFAULT_PROFILE, registry, context)).toBe(1);
  });

  it("uses effective union area for outside-region metrics on proposed sequences", () => {
    const profile = {
      ...DEFAULT_PROFILE,
      id: "custom",
      algorithm: "RECT_GRID_V1" as const,
      tile_width_deg: 0.01,
      tile_height_deg: 0.02,
      effective_overlap_arcsec: 0.1,
    };
    const proposal: TileRecord = {
      id: "proposal-1", name: "Proposal 1", ra_deg: 150, dec_deg: 0,
      source: "proposed", generation_method: "manual", original_values: null, metadata: {},
    };
    const disjoint: ObservingSequence = { id: "distant-pair", exposures: [
      { order: 1, east_arcsec: -3600, north_arcsec: 0 },
      { order: 2, east_arcsec: 3600, north_arcsec: 0 },
    ] };
    const metrics = measureResolvedCoverage(squareAt(150, 0, 0.01), [], [proposal], "custom", profile, createBundledProfileRegistry(), sequenceContext(disjoint, "effective_sequence"));

    expect(metrics.outside_region_coverage_deg2).toBe(0.0004);
  });

  it.each([
    { centerEast: 0.005, expectedArea: 0.0003, label: "overlapping" },
    { centerEast: 0.03, expectedArea: 0.0004, label: "disjoint" },
  ])("counts $label rectangle exposure union area once", ({ centerEast, expectedArea }) => {
    const footprint: Footprint = { type: "rectangle", width_deg: 0.01, height_deg: 0.02 };
    const geometries: PointingGeometry[] = [
      { id: "one", order: 1, center: [150, 0], footprint },
      { id: "two", order: 2, center: [150 + centerEast, 0], footprint },
    ];
    expect(pointingGeometryUnionArea(geometries, { ra_deg: 150, dec_deg: 0 })).toBeCloseTo(expectedArea, 5);
  });

  it("preserves compound detector offsets, parent PA, and child rotation in a sequence union", () => {
    const compound: Footprint = { type: "compound", position_angle_deg: 25, components: [
      { offset_deg: [-0.2, 0], rotation_deg: 15, footprint: { type: "rectangle", width_deg: 0.1, height_deg: 0.05 } },
      { offset_deg: [0.2, 0], rotation_deg: -15, footprint: { type: "rectangle", width_deg: 0.1, height_deg: 0.05 } },
    ] };
    const registry = registryFor(compound);
    const sequence: ObservingSequence = { id: "rotated-compound", exposures: [
      { order: 1, east_arcsec: 0, north_arcsec: 0, rotation_deg: 0 },
      { order: 2, east_arcsec: 3600, north_arcsec: 0, rotation_deg: 10 },
    ] };
    const geometries = resolvePointingGeometries(tile(), DEFAULT_PROFILE, registry, {
      ...perPointingContext("effective_sequence"), sequenceForTile: () => sequence,
    });
    const expectedFirstComponentCenter = rotateLocalOffset([-0.2, 0], 25);
    const expectedFirstShapeOffset = rotateLocalOffset([0.02, 0], 40);

    expect(geometries[0].footprint).toMatchObject({ type: "compound", position_angle_deg: 25 });
    expect(geometries[1].footprint).toMatchObject({ type: "compound", position_angle_deg: 35 });
    expect(footprintContainsPoint(geometries[0].footprint, [
      expectedFirstComponentCenter[0] + expectedFirstShapeOffset[0],
      expectedFirstComponentCenter[1] + expectedFirstShapeOffset[1],
    ])).toBe(true);
    expect(pointingGeometryUnionArea(geometries, { ra_deg: tile().ra_deg, dec_deg: tile().dec_deg })).toBeCloseTo(0.02, 5);
  });
});
