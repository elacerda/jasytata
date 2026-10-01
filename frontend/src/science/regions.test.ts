import { describe, expect, it } from "vitest";
import { rectangleRegionFromCenterSize, rectangleRegionFromCorners } from "./regions";
import { parseSkyCoordinate } from "./coordinates";
import { skyToLocalOffset } from "./footprint-engine";
import { wrappedRaDelta } from "./math";
import { polygonBounds } from "./geometry";
import type { SkyPolygon } from "../types";

function equivalent(actual: SkyPolygon, expected: SkyPolygon): void {
  actual.vertices.forEach((point, index) => {
    expect(Math.abs(wrappedRaDelta(point.ra_deg, expected.vertices[index].ra_deg))).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(point.dec_deg - expected.vertices[index].dec_deg)).toBeLessThanOrEqual(1e-10);
  });
}

describe("Gate 2 canonical rectangle regions", () => {
  it("constructs SW, SE, NE, NW with implicit closure and full local extents", () => {
    const center = { ra_deg: 40, dec_deg: -30 };
    const region = rectangleRegionFromCenterSize({ center, width: 2, height: 1, unit: "deg" });
    expect(region.vertices).toHaveLength(4);
    region.vertices.forEach((point, index) => {
      const offset = skyToLocalOffset(point, center);
      expect(offset[0]).toBeCloseTo([-1, 1, 1, -1][index], 10);
      expect(offset[1]).toBeCloseTo([-0.5, -0.5, 0.5, 0.5][index], 10);
    });
  });
  it.each(["deg", "arcmin", "arcsec"] as const)("normalizes %s dimensions to degrees", (unit) => {
    const multiplier = { deg: 1, arcmin: 60, arcsec: 3600 }[unit];
    const input = { center: { ra_deg: 40, dec_deg: 20 }, width: 2, height: 1, unit: "deg" as const };
    equivalent(rectangleRegionFromCenterSize({ ...input, width: 2 * multiplier, height: multiplier, unit }), rectangleRegionFromCenterSize(input));
  });
  it.each([
    [40, 42, -31, -29], [359.9, 0.1, -21.2, -21], [0.1, 359.9, -21, -21.2],
    [40, 42, 81, 83], [42, 40, -83, -81], [359.9, 0.1, 89.7, 89.8], [0.1, 359.9, -89.8, -89.7],
  ])("corners and center/size agree (%s, %s, %s, %s)", (ra1, ra2, dec1, dec2) => {
    const a = { ra_deg: ra1, dec_deg: dec1 }; const b = { ra_deg: ra2, dec_deg: dec2 };
    const region = rectangleRegionFromCorners(a, b);
    const bounds = polygonBounds(region);
    const delta = wrappedRaDelta(ra2, ra1);
    const center = { ra_deg: (ra1 + delta / 2 + 360) % 360, dec_deg: (dec1 + dec2) / 2 };
    const width = Math.abs(delta) * Math.max(Math.cos(center.dec_deg * Math.PI / 180), 0.01);
    equivalent(region, rectangleRegionFromCenterSize({ center, width, height: Math.abs(dec2 - dec1), unit: "deg" }));
    equivalent(region, rectangleRegionFromCorners(b, a));
    expect(bounds.ra_span_deg).toBeCloseTo(Math.abs(delta), 10);
    expect(region.vertices[0].dec_deg).toBeCloseTo(Math.min(dec1, dec2), 10);
    expect(region.vertices[1].dec_deg).toBeCloseTo(Math.min(dec1, dec2), 10);
    expect(region.vertices.every((point) => point.ra_deg >= 0 && point.ra_deg < 360)).toBe(true);
  });
  it.each([0, -1, NaN, Infinity])("refuses invalid width/height %s", (dimension) => {
    const input = { center: { ra_deg: 30, dec_deg: 20 }, width: 1, height: 1, unit: "deg" as const };
    expect(() => rectangleRegionFromCenterSize({ ...input, width: dimension })).toThrow(/positive/);
    expect(() => rectangleRegionFromCenterSize({ ...input, height: dimension })).toThrow(/positive/);
  });
  it.each([
    { ra_deg: NaN, dec_deg: 20 }, { ra_deg: 360, dec_deg: 20 }, { ra_deg: -1, dec_deg: 20 },
    { ra_deg: 20, dec_deg: Infinity }, { ra_deg: 20, dec_deg: 90 }, { ra_deg: 20, dec_deg: -91 },
  ])("refuses invalid ICRS coordinate %j", (center) => {
    expect(() => rectangleRegionFromCenterSize({ center, width: 1, height: 1, unit: "deg" })).toThrow(/ICRS/);
    expect(() => rectangleRegionFromCorners(center, { ra_deg: 40, dec_deg: 20 })).toThrow(/ICRS/);
  });
  it.each([89, -89])("refuses rectangle reaching a pole from DEC %s", (dec_deg) => {
    expect(() => rectangleRegionFromCenterSize({ center: { ra_deg: 40, dec_deg }, width: 0.1, height: 2, unit: "deg" })).toThrow(/pole/);
  });
  it.each([180, 181, 360, 720])("refuses unsupported RA extent before normalization (%s)", (width) => {
    expect(() => rectangleRegionFromCenterSize({ center: { ra_deg: 40, dec_deg: 0 }, width, height: 1, unit: "deg" })).toThrow(/180/);
  });
  it("refuses ambiguous opposite corners at 180 degrees", () => {
    expect(() => rectangleRegionFromCorners({ ra_deg: 10, dec_deg: 10 }, { ra_deg: 190, dec_deg: 11 })).toThrow(/ambiguous/);
  });
  it("retains existing degenerate polygon tolerances", () => {
    expect(() => rectangleRegionFromCorners({ ra_deg: 40, dec_deg: 20 }, { ra_deg: 40, dec_deg: 21 })).toThrow(/positive/);
    expect(() => rectangleRegionFromCenterSize({ center: { ra_deg: 40, dec_deg: 20 }, width: 1e-7, height: 1, unit: "deg" })).toThrow(/distinct|area/);
    expect(() => rectangleRegionFromCenterSize({ center: { ra_deg: 40, dec_deg: 20 }, width: 0.001, height: 0.001, unit: "deg" })).toThrow(/area/);
  });
});

describe("Gate 2 labelled coordinate parsing", () => {
  it.each([
    ["02:30:44.67", "-21:10:19.5"], ["02 30 44.67", "-21 10 19.5"], ["37.686125", "-21.1720833"],
  ])("parses RA %s and Dec %s", (ra, dec) => {
    const point = parseSkyCoordinate(ra, dec);
    expect(point.ra_deg).toBeCloseTo(37.686125, 10);
    expect(point.dec_deg).toBeCloseTo(-21.172083333333, 6);
  });
  it.each([["bad", "20"], ["", "20"], ["360.1", "20"], ["20", "91"], ["02 30", "20"], ["20", "-21 10"]])("rejects invalid/ambiguous %s / %s", (ra, dec) => {
    expect(() => parseSkyCoordinate(ra, dec)).toThrow(/Invalid|use/);
  });
});
