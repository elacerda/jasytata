import type { CenterInput, SkyPolygon } from "../types";
import { localOffsetToSky, skyToLocalOffset } from "./footprint-engine";
import { validatePolygon } from "./geometry";
import { modulo, wrappedRaDelta } from "./math";

/** Angular units accepted by rectangle authoring; dimensions are full extents. */
export type RegionAngularUnit = "deg" | "arcmin" | "arcsec";

/** Axis-aligned local rectangle, independent of instrument PA and lattice rotation. */
export interface RectangleCenterSize {
  /** Canonical ICRS center in degrees, strictly away from the exact poles. */
  center: Pick<CenterInput, "ra_deg" | "dec_deg">;
  /** Full east-west angular extent at center, measured in unit. */
  width: number;
  /** Full north-south angular extent at center, measured in unit. */
  height: number;
  /** Angular unit shared by width and height. */
  unit: RegionAngularUnit;
}

function validateCoordinate(point: RectangleCenterSize["center"]): void {
  if (!Number.isFinite(point.ra_deg) || point.ra_deg < 0 || point.ra_deg >= 360 ||
      !Number.isFinite(point.dec_deg) || Math.abs(point.dec_deg) >= 90) {
    throw new Error("Use finite ICRS coordinates: RA in [0, 360)° and Dec strictly between −90° and +90°.");
  }
}

/** Construct a canonical selected SkyPolygon from full local angular extents.
 *
 * Width is east-west extent at the declared center, height is north-south
 * extent. The frozen Gate 1 transform uses max(cos(center DEC), 0.01), not a
 * spherical/gnomonic rectangle. No rotation or instrument PA is applied.
 * Vertices are SW, SE, NE, NW on the unwrapped RA branch; stored RA is [0, 360)
 * and closure is implicit. Rectangles with RA span >=180° are refused because
 * opposite corners at 180° have no unique shortest branch.
 *
 * @param input - ICRS center in degrees and positive full width/height in unit.
 * @returns Validated canonical polygon; no mutation or external effects.
 * @throws For invalid coordinates, dimensions/units, polar or branch crossings,
 *   or degeneracy under the existing polygon validation tolerance.
 */
export function rectangleRegionFromCenterSize(input: RectangleCenterSize): SkyPolygon {
  validateCoordinate(input.center);
  const factor = { deg: 1, arcmin: 1 / 60, arcsec: 1 / 3600 }[input.unit];
  if (!Number.isFinite(factor) || !Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) {
    throw new Error("Width and height must be finite positive numbers; choose deg, arcmin, or arcsec.");
  }
  const halfWidth = input.width * factor / 2;
  const halfHeight = input.height * factor / 2;
  // Query the shared inverse transform for its branch scale instead of copying
  // cosine/clamp arithmetic. Reject before modulo can disguise a wide region.
  const branchEast = Math.abs(skyToLocalOffset({
    ra_deg: modulo(input.center.ra_deg + 180, 360), dec_deg: input.center.dec_deg,
  }, input.center)[0]);
  if (halfWidth * 2 >= branchEast) {
    throw new Error("Rectangle RA span must be less than 180°. Reduce width or choose a smaller region.");
  }
  if (Math.abs(input.center.dec_deg) + halfHeight >= 90) {
    throw new Error("Rectangle reaches a celestial pole. Reduce height or move its center away from the pole.");
  }
  const offsets: Array<[number, number]> = [
    [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
    [halfWidth, halfHeight], [-halfWidth, halfHeight],
  ];
  const region: SkyPolygon = { vertices: offsets.map((offset) => {
    const [ra_deg, dec_deg] = localOffsetToSky(input.center, offset);
    return { ra_deg: ra_deg % 360, dec_deg };
  }) };
  validatePolygon(region);
  return region;
}

/** Construct the same canonical rectangle from two opposite ICRS corners.
 *
 * The center is the midpoint of shortest unwrapped RA and DEC. Width is the
 * absolute east separation at that center under the Gate 1 local transform;
 * height is the absolute DEC separation. Reversing corners preserves SW/SE/NE/NW.
 *
 * @param corner1 - First opposite corner, canonical ICRS degrees.
 * @param corner2 - Second opposite corner, canonical ICRS degrees.
 * @returns Canonical SkyPolygon with implicit closure and normalized RA.
 * @throws For invalid coordinates, ambiguous 180° RA separation, polar or
 *   degenerate regions; delegates the same validation as center/size authoring.
 */
export function rectangleRegionFromCorners(
  corner1: RectangleCenterSize["center"],
  corner2: RectangleCenterSize["center"],
): SkyPolygon {
  validateCoordinate(corner1);
  validateCoordinate(corner2);
  const delta = wrappedRaDelta(corner2.ra_deg, corner1.ra_deg);
  if (Math.abs(delta) === 180) throw new Error("Opposite corners separated by 180° RA are ambiguous. Choose a smaller region.");
  const center = {
    ra_deg: modulo(corner1.ra_deg + delta / 2, 360) % 360,
    dec_deg: (corner1.dec_deg + corner2.dec_deg) / 2,
  };
  const first = skyToLocalOffset(corner1, center);
  const second = skyToLocalOffset(corner2, center);
  return rectangleRegionFromCenterSize({ center, width: Math.abs(second[0] - first[0]), height: Math.abs(second[1] - first[1]), unit: "deg" });
}
