import { describe, expect, it } from "vitest";
import { regionBoundsFromCorners, skyPolygonFromVertices, tileFootprint } from "./sky";

describe("Aladin coordinate helpers", () => {
  it("finds the short RA interval across zero", () => {
    const bounds = regionBoundsFromCorners([
      [359.2, -30],
      [0.8, -30],
      [0.8, -28],
      [359.2, -28],
    ]);
    expect(bounds.ra_start_deg).toBeCloseTo(359.2);
    expect(bounds.ra_end_deg).toBeCloseTo(0.8);
    expect(bounds.dec_min_deg).toBe(-30);
    expect(bounds.dec_max_deg).toBe(-28);
  });

  it("corrects square tile RA width by declination", () => {
    const corners = tileFootprint({ ra_deg: 143, dec_deg: -40 }, { tile_width_deg: 1.4, tile_height_deg: 1.4 });
    const raWidth = ((corners[1][0] - corners[0][0] + 360) % 360) * Math.cos((40 * Math.PI) / 180);
    expect(raWidth).toBeCloseTo(1.4, 4);
    expect(corners).toHaveLength(5);
  });

  it("keeps ordered celestial vertices across RA zero and rejects invalid shapes", () => {
    const polygon = skyPolygonFromVertices([[359.2, -30], [0.8, -30], [0.8, -28], [359.2, -28]]);
    expect(polygon.vertices.map((point) => point.ra_deg)).toEqual([359.2, 0.8, 0.8, 359.2]);
    expect(() => skyPolygonFromVertices([[1, 0], [2, 0], [1, 0]])).toThrow(/distinct|three/i);
    expect(() => skyPolygonFromVertices([[0, 0], [2, 2], [0, 2], [2, 0]])).toThrow(/zero area|crosses/i);
  });
});
