import circle from "./circle.json";
import mosaic from "./mosaic.json";
import triangular from "./triangular.json";
import circleCsv from "./circle.csv?raw";
import mosaicCsv from "./mosaic.csv?raw";
import triangularCsv from "./triangular.csv?raw";
import bundled from "../../profiles/splus-t80-south.json";
import golden from "../golden.json";
import { parseProfileJsonV2, type ProfileDocument } from "../../profiles/document";
import { createBundledProfileRegistry } from "../../profiles/registry";
import { localOffsetToSky } from "../../science/footprint-engine";
import type { CenterInput, SkyPolygon } from "../../types";

/** Test region in the supported midpoint local plane; offsets are east/north degrees.
 * @param origin - Canonical ICRS center in degrees, including RA=0.
 * @param width - Full local east extent in degrees.
 * @param height - Full north extent in degrees.
 * @returns Ordered ICRS selection vertices with canonical wrapped RA.
 */
export function localRegion(origin: CenterInput, width: number, height: number): SkyPolygon {
  return { vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const [ra_deg, dec_deg] = localOffsetToSky(origin, [x * width / 2, y * height / 2]);
    return { ra_deg, dec_deg };
  }) };
}

/** Four documents enter science only via the user JSON parser, never typed casts. */
export const cases = [
  { key: "t80", document: parseProfileJsonV2(JSON.stringify(bundled)), csv: null,
    origin: { ra_deg: 152, dec_deg: -29 }, region: golden.planner_cases.find(({ id }) => id === "empty_rectangle")!.polygon, rotation: 0 },
  { key: "circle", document: parseProfileJsonV2(JSON.stringify(circle)), csv: circleCsv,
    origin: { ra_deg: 0, dec_deg: -32 }, region: localRegion({ ra_deg: 0, dec_deg: -32 }, 0.44, 0.36), rotation: 13 },
  { key: "mosaic", document: parseProfileJsonV2(JSON.stringify(mosaic)), csv: mosaicCsv,
    origin: { ra_deg: 150, dec_deg: -25 }, region: localRegion({ ra_deg: 150, dec_deg: -25 }, 0.9, 0.65), rotation: 7 },
  { key: "triangular", document: parseProfileJsonV2(JSON.stringify(triangular)), csv: triangularCsv,
    origin: { ra_deg: 75, dec_deg: 42 }, region: localRegion({ ra_deg: 75, dec_deg: 42 }, 3.2, 2.6), rotation: 0 },
];

/** Fresh session with user-validated test profiles; no production presets are added.
 * @returns Isolated registry containing the real bundled T80 and three validation documents.
 */
export function matrixRegistry() {
  const registry = createBundledProfileRegistry();
  for (const fixture of cases.slice(1)) registry.registerProfileDocument(fixture.document);
  return registry;
}

/** Camera PA present on the declared footprint, independently of lattice orientation.
 * @param document - Strictly validated instrument/survey pair.
 * @returns Declared camera PA in degrees, or undefined for an unoriented footprint.
 */
export function cameraPa(document: ProfileDocument): number | undefined {
  return document.instrument.footprint.type === "circle" ? undefined : document.instrument.footprint.position_angle_deg;
}
