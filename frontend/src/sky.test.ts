import { describe, expect, it } from "vitest";
import { skyPolygonFromVertices, tileFootprint } from "./sky";

describe("Aladin coordinate helpers", () => {
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
