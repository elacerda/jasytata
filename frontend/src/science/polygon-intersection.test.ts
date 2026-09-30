import { measureResolvedCoverage } from "./test-support/resolved-coverage";
import { describe, expect, it } from "vitest";
import { validateInstrumentProfileV2 } from "../profiles/schema-v2";
import { createBundledProfileRegistry, SPLUS_SURVEY_V2 } from "../profiles";
import type { CenterInput, Footprint, GenericLatticeTiling, SkyPolygon, TangentPlaneOffset } from "../types";
import { makeCenterProposals } from "./catalogue";
import {} from "./coverage";
import { footprintContainsPoint, footprintIntersectsRegion, localOffsetToSky, skyToLocalOffset } from "./footprint-engine";
import { contributingTileCount } from "./geometry";
import { generateLatticeCandidates } from "./lattice";
import { planRegion } from "./planner";

const instrument = validateInstrumentProfileV2({
  schema_version: 2,
  id: "g9b-offset-polygon",
  display_name: "Offset polygon diagnostic",
  coordinate_frame: "icrs",
  footprint: {
    type: "polygon",
    vertices_deg: [[1, -0.1], [1.2, -0.1], [1.2, 0.1], [1, 0.1]],
  },
});
const footprint = instrument.footprint;
const pointing = { ra_deg: 150, dec_deg: 0 };
const region = { vertices: [
  { ra_deg: 149.95, dec_deg: -0.05 },
  { ra_deg: 150.05, dec_deg: -0.05 },
  { ra_deg: 150.05, dec_deg: 0.05 },
  { ra_deg: 149.95, dec_deg: 0.05 },
] };

/** Map ordered east/north degree vertices to ICRS using the established projection. */
function skyRegion(vertices: TangentPlaneOffset[], center: CenterInput = pointing): SkyPolygon {
  return { vertices: vertices.map((point) => {
    const [ra_deg, dec_deg] = localOffsetToSky(center, point);
    return { ra_deg, dec_deg };
  }) };
}

/** Four implicitly closed local east/north corners, in degrees, counterclockwise. */
function box(left: number, bottom: number, right: number, top: number): TangentPlaneOffset[] {
  return [[left, bottom], [right, bottom], [right, top], [left, top]];
}

/** Register the validated diagnostic camera with fixed lattice phase and disabled inference. */
function diagnosticRegistry(center = pointing, pitch = 1.1) {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfile(instrument);
  const tiling: GenericLatticeTiling = {
    type: "lattice", basis_deg: [[pitch, 0], [0, pitch]],
    origin: { type: "fixed_anchor", ...center },
  };
  const survey = registry.registerSurveyProfile({
    ...SPLUS_SURVEY_V2, id: "g9b-offset-survey", instrument_id: instrument.id,
    tiling, inference: { ...SPLUS_SURVEY_V2.inference, enabled: false },
  });
  return { registry, survey, tiling };
}

describe("Gate 9B1 offset polygon intersection", () => {
  it("rejects the exact Gate 9A disjoint region despite containing the nominal pointing", () => {
    expect(footprintContainsPoint(footprint, [0, 0])).toBe(false);
    for (const vertex of region.vertices) {
      expect(footprintContainsPoint(footprint, skyToLocalOffset(vertex, pointing))).toBe(false);
    }
    expect(footprintIntersectsRegion(footprint, pointing, region)).toBe(false);
  });

  it("counts zero actual coverage contributors for the exact Gate 9A reproduction", () => {
    const tiles = makeCenterProposals([pointing], "manual");
    expect(contributingTileCount(region, tiles, footprint)).toBe(0);
  });

  it.each([
    ["true overlap", box(1.15, -0.05, 1.25, 0.05)],
    ["polygon fully inside region", box(0.9, -0.2, 1.3, 0.2)],
    ["region fully inside polygon", box(1.05, -0.05, 1.15, 0.05)],
    ["inscribed region with every vertex on the footprint boundary", [[1.1, -0.1], [1.2, 0], [1.1, 0.1], [1, 0]] as TangentPlaneOffset[]],
    ["identical boundaries", box(1, -0.1, 1.2, 0.1)],
    ["collinear boundaries with positive-area overlap", box(1.1, -0.1, 1.3, 0.1)],
  ] as const)("detects %s for both polygon windings without an origin sample", (_name, vertices) => {
    for (const reversedFootprint of [false, true]) for (const reversedRegion of [false, true]) {
      const polygon: Footprint = { type: "polygon", vertices_deg: box(1, -0.1, 1.2, 0.1) };
      if (reversedFootprint) polygon.vertices_deg.reverse();
      const selected = [...vertices];
      if (reversedRegion) selected.reverse();
      expect(footprintContainsPoint(polygon, [0, 0])).toBe(false);
      expect(footprintIntersectsRegion(polygon, pointing, skyRegion(selected))).toBe(true);
    }
  });

  it.each([0.2, 0.0002])("detects edge-only crossing at scale %s degrees", (scale) => {
    const horizontal = box(1, -scale / 10, 1 + scale, scale / 10);
    const vertical = box(1 + scale * 0.4, -scale, 1 + scale * 0.6, scale);
    const polygon: Footprint = { type: "polygon", vertices_deg: horizontal };
    const other: Footprint = { type: "polygon", vertices_deg: vertical };
    for (const vertex of horizontal) expect(footprintContainsPoint(other, vertex)).toBe(false);
    for (const vertex of vertical) expect(footprintContainsPoint(polygon, vertex)).toBe(false);
    expect(footprintIntersectsRegion(polygon, pointing, skyRegion(vertical))).toBe(true);
  });

  it("preserves rectangle overlap with aligned edges and crossing edges of small detectors", () => {
    const rectangle: Footprint = { type: "rectangle", width_deg: 0.25, height_deg: 0.25 };
    expect(footprintIntersectsRegion(rectangle, pointing, skyRegion(box(0.0625, -0.125, 0.25, 0.125)))).toBe(true);
    const small: Footprint = { type: "rectangle", width_deg: 0.0002, height_deg: 0.00004 };
    const vertical = skyRegion(box(0.00004, -0.0002, 0.00006, 0.0002));
    expect(footprintIntersectsRegion(small, pointing, vertical)).toBe(true);
  });

  it.each([
    ["shared edge", box(1.2, -0.1, 1.4, 0.1)],
    ["shared vertex", box(1.2, 0.1, 1.4, 0.3)],
    ["near-collinear separated edge", box(1, 0.1 + 1e-9, 1.2, 0.3)],
  ] as const)("preserves positive-area semantics for %s", (_name, vertices) => {
    expect(footprintIntersectsRegion(footprint, pointing, skyRegion([...vertices]))).toBe(false);
  });

  it("detects a thin overlap next to a collinear edge without increasing epsilon", () => {
    expect(footprintIntersectsRegion(footprint, pointing, skyRegion(box(1, 0.1 - 1e-9, 1.2, 0.3)))).toBe(true);
  });

  it("applies nonzero astronomical PA before classifying offset polygon intersections", () => {
    const rotated: Footprint = { type: "polygon", vertices_deg: box(1, -0.1, 1.2, 0.1), position_angle_deg: 90 };
    expect(footprintIntersectsRegion(rotated, pointing, region)).toBe(false);
    expect(footprintIntersectsRegion(rotated, pointing, skyRegion(box(-0.05, -1.15, 0.05, -1.05)))).toBe(true);
    expect(footprintIntersectsRegion(rotated, pointing, skyRegion(box(1.05, -0.05, 1.15, 0.05)))).toBe(false);
  });

  it("validates concavity and excludes a notch despite overlapping bounding boxes", () => {
    const concave = validateInstrumentProfileV2({ ...instrument, footprint: {
      type: "polygon", vertices_deg: [[1, 0], [1.4, 0], [1.4, 0.1], [1.1, 0.1], [1.1, 0.4], [1, 0.4]],
    } }).footprint;
    expect(footprintContainsPoint(concave, [0, 0])).toBe(false);
    expect(footprintIntersectsRegion(concave, pointing, skyRegion(box(1.2, 0.2, 1.3, 0.3)))).toBe(false);
    expect(footprintIntersectsRegion(concave, pointing, skyRegion(box(1.05, 0.2, 1.15, 0.3)))).toBe(true);
    expect(footprintIntersectsRegion(concave, pointing, skyRegion(box(0.9, -0.1, 1.5, 0.5)))).toBe(true);
  });

  it("tests actual compound children and preserves a central gap", () => {
    const mosaic: Footprint = { type: "compound", components: [
      { offset_deg: [0, 0], footprint: { type: "polygon", vertices_deg: box(1, -0.1, 1.2, 0.1) } },
      { offset_deg: [-1.1, 0], footprint: { type: "circle", radius_deg: 0.1 } },
    ] };
    expect(footprintIntersectsRegion(mosaic, pointing, region)).toBe(false);
    expect(footprintIntersectsRegion(mosaic, pointing, skyRegion(box(1.05, -0.05, 1.15, 0.05)))).toBe(true);
    expect(footprintIntersectsRegion(mosaic, pointing, skyRegion(box(-1.15, -0.05, -1.05, 0.05)))).toBe(true);
  });

  it("composes parent and child PA and offsets before polygon intersection", () => {
    const mosaic: Footprint = { type: "compound", position_angle_deg: 90, components: [
      { offset_deg: [0.5, 0], rotation_deg: 90, footprint: {
        type: "polygon", vertices_deg: box(1, -0.1, 1.2, 0.1), position_angle_deg: -90,
      } },
    ] };
    expect(footprintIntersectsRegion(mosaic, pointing, skyRegion(box(-0.05, -0.55, 0.05, -0.45)))).toBe(false);
    expect(footprintIntersectsRegion(mosaic, pointing, skyRegion(box(-0.05, -1.65, 0.05, -1.55)))).toBe(true);
  });

  it.each([
    { type: "rectangle", width_deg: 0.25, height_deg: 0.25 },
    { type: "circle", radius_deg: 0.125 },
  ] satisfies Footprint[])("preserves specialized $type intersection and positive-area contact semantics", (shape) => {
    expect(footprintIntersectsRegion(shape, pointing, region)).toBe(true);
    expect(footprintIntersectsRegion(shape, pointing, skyRegion(box(-0.2, -0.2, 0.2, 0.2)))).toBe(true);
    expect(footprintIntersectsRegion(shape, pointing, skyRegion(box(0.125, -0.05, 0.2, 0.05)))).toBe(false);
    expect(footprintIntersectsRegion(shape, pointing, skyRegion(box(0.1, 0.1, 0.11, 0.11))))
      .toBe(shape.type === "rectangle");
  });

  it.each([150, 0])("uses real coverage and planner filtering near RA=%s", (ra_deg) => {
    const center = { ra_deg, dec_deg: 0 };
    const selected = ra_deg === 150 ? region : skyRegion(box(-0.05, -0.05, 0.05, 0.05), center);
    const { registry, survey, tiling } = diagnosticRegistry(center);
    const tiles = makeCenterProposals([center], "manual");
    const metrics = measureResolvedCoverage(selected, tiles, [], survey.id, undefined, registry);
    expect(metrics.existing_tiles_contributing).toBe(0);
    expect(metrics.already_covered_fraction).toBe(0);
    const candidates = generateLatticeCandidates(selected, tiling, footprint, 1200);
    expect(candidates.map(({ i, j }) => [i, j])).toEqual([[-1, 0]]);
    const plan = planRegion(selected, [], survey.id, undefined, "complete", registry);
    expect(plan.candidate_centers).toHaveLength(1);
    expect(plan.candidate_centers[0].ra_deg).toBeCloseTo(ra_deg === 0 ? 358.9 : 148.9, 10);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.metrics.selected_region_coverage).toBe(1);
    expect(contributingTileCount(selected, plan.tiles, footprint)).toBe(1);
  });

  it("rejects a disjoint offset polygon candidate even when the padded range includes its origin", () => {
    const { tiling } = diagnosticRegistry(pointing, 5);
    expect(generateLatticeCandidates(region, tiling, footprint, 1200)).toEqual([]);
  });
});
