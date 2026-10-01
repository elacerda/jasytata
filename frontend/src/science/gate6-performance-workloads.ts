import type { Footprint, SkyPolygon } from "../types";
import { localOffsetToSky } from "./footprint-engine";
import { planRegion, type ProjectLatticeCandidateSource } from "./planner";

/** Build benchmark-only ICRS rectangles with the frozen local degree projection.
 * @param width - East extent in degrees.
 * @param height - North extent in degrees.
 * @param ra - Reference ICRS RA in degrees.
 * @param dec - Reference ICRS DEC in degrees.
 * @returns Ordered polygon; no scientific sampling or candidate budget is changed.
 */
export function performanceBox(width: number, height: number, ra = 150, dec = 0): SkyPolygon {
  return { vertices: ([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]] as [number, number][])
    .map((offset) => { const [ra_deg, dec_deg] = localOffsetToSky({ ra_deg: ra, dec_deg: dec }, offset); return { ra_deg, dec_deg }; }) };
}

/** Additional deterministic Gate 6 planning inputs; all use the production budgets. */
export const performancePlans: { id: string; polygon: SkyPolygon; source: ProjectLatticeCandidateSource }[] = [
  { id: "muse-dense", polygon: performanceBox(0.15, 0.1), source: projectSource("vlt-muse-wfm", 0.008, 30) },
  { id: "kcwi-high-dec", polygon: performanceBox(0.012, 0.01, 149.9, 82), source: projectSource("keck-kcwi-small", 4 / 3600, 0) },
  { id: "decam-ra-wrap", polygon: performanceBox(3, 2, 359.85, 30), source: projectSource("ctio-decam-area-equivalent", 1) },
  { id: "sami-effective-sequence", polygon: performanceBox(0.015, 0.015), source: { ...projectSource("aat-sami-61core-15arcsec", 0.003), strategyId: "sami-dr1-seven-position" } },
];

/** Run a canonical fixture with either shared selection policy.
 * @param fixture - Immutable benchmark input, including real instrument/strategy IDs.
 * @param strategy - Complete or Efficient with the unchanged production policy.
 * @returns Full serializable nominal response, including metrics and provenance.
 */
export function runPerformancePlan(fixture: typeof performancePlans[number], strategy: "complete" | "efficient" = "complete") {
  return planRegion(fixture.polygon, [], undefined, undefined, strategy, undefined, undefined, fixture.source);
}

function projectSource(instrumentId: string, pitch: number, positionAngleDeg?: number): ProjectLatticeCandidateSource {
  return { type: "project_lattice", instrumentId, positionAngleDeg, placement: {
    type: "lattice_project_placement", provenance: "user_declared",
    authoring: { preset: "rectangular", east_spacing_deg: pitch, north_spacing_deg: pitch },
    rotation: { mode: "independent", rotation_deg: 17 }, origin: { type: "region_center" },
  } };
}

/** Rotated, offset, mixed-shape footprint for mask/intersection preparation profiling. */
export const performanceCompound: Footprint = { type: "compound", position_angle_deg: 31, components: [
  { offset_deg: [-0.02, 0], rotation_deg: 17, footprint: { type: "rectangle", width_deg: 0.035, height_deg: 0.02 } },
  { offset_deg: [0.02, 0.005], footprint: { type: "circle", radius_deg: 0.012 } },
  { offset_deg: [0, -0.015], footprint: { type: "polygon", vertices_deg: [[-0.01, -0.01], [0.015, -0.01], [0, 0.01]] } },
] };
