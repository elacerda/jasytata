import { describe, expect, it } from "vitest";
import { parseCatalogueCsv } from "./catalogue";

const bytes = (csv: string) => new TextEncoder().encode(csv);

describe("catalogue position angle import", () => {
  it("imports a supported PA column as a declared angle while retaining its original source value", () => {
    const result = parseCatalogueCsv(bytes("ra_deg,dec_deg,position_angle_deg,note\n12,-4,37.25,kept\n"));
    expect(result.tiles[0].position_angle_deg).toBe(37.25);
    expect(result.tiles[0].original_values).toEqual({ ra_deg: "12", dec_deg: "-4", position_angle_deg: "37.25", note: "kept" });
  });

  it("accepts absent PA unless the caller says the active policy requires it", () => {
    const csv = bytes("ra_deg,dec_deg\n12,-4\n");
    expect(parseCatalogueCsv(csv).tiles[0]).not.toHaveProperty("position_angle_deg");
    expect(() => parseCatalogueCsv(csv, "targets.csv", undefined, undefined, "auto", { requirePositionAngle: true }))
      .toThrow(/missing the required position angle column/);
    expect(() => parseCatalogueCsv(bytes("x,y\n12,-4\n"), "targets.csv", undefined, undefined, "auto", { requirePositionAngle: true }))
      .toThrow(/missing the required position angle column/);
  });

  it("validates required row values and rejects nonfinite declared PA", () => {
    expect(() => parseCatalogueCsv(bytes("ra_deg,dec_deg,pa_deg\n12,-4,\n"), "targets.csv", undefined, undefined, "auto", { requirePositionAngle: true }))
      .toThrow(/empty required value.*pa_deg/);
    for (const value of ["NaN", "Infinity", "-Infinity"]) {
      expect(() => parseCatalogueCsv(bytes(`ra_deg,dec_deg,pa_deg\n12,-4,${value}\n`))).toThrow(/Invalid position angle/);
    }
  });

  it("requires an explicit supported column when multiple PA headers are present", () => {
    const csv = bytes("ra_deg,dec_deg,position_angle_deg,pa_deg\n12,-4,10,20\n");
    expect(() => parseCatalogueCsv(csv)).toThrow(/multiple supported position angle columns/);
    expect(parseCatalogueCsv(csv, "targets.csv", undefined, undefined, "auto", { positionAngleColumn: "pa_deg" }).tiles[0].position_angle_deg).toBe(20);
  });
});
