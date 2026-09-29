import { describe, expect, it } from "vitest";
import type { InstrumentProfileV2, TileRecord } from "../types";
import { footprintContainsPoint } from "../science/footprint-engine";
import { DEFAULT_PROFILE } from "./index";
import { ProfileRegistry } from "./registry";
import { resolveFootprintForTile, withFootprintPositionAngle } from "./footprints";
import { T80_SOUTH_INSTRUMENT_V2 } from "./v2";

const rectangleInstrument: InstrumentProfileV2 = {
  ...T80_SOUTH_INSTRUMENT_V2,
  id: "orientation-test-rectangle",
  footprint: { type: "rectangle", width_deg: 4, height_deg: 1, position_angle_deg: -270 },
};

function fixture() {
  const registry = new ProfileRegistry();
  registry.registerInstrumentProfile(rectangleInstrument);
  const tile: TileRecord = {
    id: "tile-1", name: "Target", ra_deg: 150, dec_deg: -30, source: "original",
    generation_method: null, original_values: { RA: "150", DEC: "-30" }, metadata: {},
    instrument_profile_id: rectangleInstrument.id,
  };
  return { registry, tile };
}

describe("canonical footprint orientation", () => {
  it("keeps v2 resolution unchanged when no runtime policy is supplied", () => {
    const { registry, tile } = fixture();
    const resolved = resolveFootprintForTile({ ...tile, position_angle_deg: 90 }, DEFAULT_PROFILE, registry);
    const ignoredNonfiniteRow = resolveFootprintForTile({ ...tile, position_angle_deg: Number.NaN }, DEFAULT_PROFILE, registry);

    expect(resolved.footprint).toEqual(rectangleInstrument.footprint);
    expect(ignoredNonfiniteRow.footprint).toEqual(rectangleInstrument.footprint);
    expect(resolved.resolved_position_angle_deg).toBe(-270);
    expect(rectangleInstrument.footprint).toEqual({
      type: "rectangle", width_deg: 4, height_deg: 1, position_angle_deg: -270,
    });
  });

  it("normalizes fixed PA for geometry while preserving the profile value", () => {
    const { registry, tile } = fixture();
    const resolved = resolveFootprintForTile(tile, DEFAULT_PROFILE, registry, { policy: "fixed" });

    expect(resolved.resolved_position_angle_deg).toBe(90);
    expect(resolved.footprint).toEqual({ ...rectangleInstrument.footprint, position_angle_deg: 90 });
    expect(footprintContainsPoint(resolved.footprint, [1.5, 0])).toBe(false);
    expect(footprintContainsPoint({ type: "rectangle", width_deg: 4, height_deg: 1 }, [1.5, 0])).toBe(true);
    const storedFootprint = registry.resolveInstrumentProfile(rectangleInstrument.id).footprint;
    expect(storedFootprint.type).toBe("rectangle");
    if (storedFootprint.type !== "rectangle") throw new Error("Expected stored rectangle");
    expect(storedFootprint.position_angle_deg).toBe(-270);
  });

  it("uses a per-pointing row PA as an absolute replacement and falls back to profile PA", () => {
    const { registry, tile } = fixture();
    const row = resolveFootprintForTile({ ...tile, position_angle_deg: 360 }, DEFAULT_PROFILE, registry, {
      policy: "per_pointing", required: true,
    });
    const fallback = resolveFootprintForTile(tile, DEFAULT_PROFILE, registry, { policy: "per_pointing" });

    expect(row.resolved_position_angle_deg).toBe(0);
    expect(row.footprint).toEqual({ ...rectangleInstrument.footprint, position_angle_deg: 0 });
    expect(fallback.resolved_position_angle_deg).toBe(90);
    expect(fallback.footprint).toEqual({ ...rectangleInstrument.footprint, position_angle_deg: 90 });
  });

  it("uses plan PA before profile PA under user-selected policy", () => {
    const { registry, tile } = fixture();
    const resolved = resolveFootprintForTile(tile, DEFAULT_PROFILE, registry, {
      policy: "user_selected", plan_position_angle_deg: -360, required: true,
    });

    expect(resolved.resolved_position_angle_deg).toBe(0);
    expect(resolved.footprint).toEqual({ ...rectangleInstrument.footprint, position_angle_deg: 0 });
  });

  it("leaves absent and not-applicable PA undeclared and in canonical geometry", () => {
    const { registry, tile } = fixture();
    const unOriented = registry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "orientation-test-absent",
      footprint: { type: "rectangle", width_deg: 4, height_deg: 1 },
    });
    const absentTile = { ...tile, instrument_profile_id: unOriented.id };
    const absent = resolveFootprintForTile(absentTile, DEFAULT_PROFILE, registry, {
      policy: "per_pointing",
    });
    const notApplicable = resolveFootprintForTile(absentTile, DEFAULT_PROFILE, registry, {
      policy: "not_applicable",
    });

    expect(absent.resolved_position_angle_deg).toBeUndefined();
    expect(absent.footprint).toEqual(unOriented.footprint);
    expect(notApplicable.resolved_position_angle_deg).toBeUndefined();
    expect(notApplicable.footprint).toEqual(unOriented.footprint);
    expect(footprintContainsPoint(absent.footprint, [1.5, 0])).toBe(true);
  });

  it("rejects missing required PA, conflicting sources, and non-finite runtime angles", () => {
    const { registry, tile } = fixture();
    const absentRegistry = new ProfileRegistry();
    const absent = absentRegistry.registerInstrumentProfile({
      ...T80_SOUTH_INSTRUMENT_V2,
      id: "orientation-test-required",
      footprint: { type: "rectangle", width_deg: 4, height_deg: 1 },
    });
    const absentTile = { ...tile, instrument_profile_id: absent.id };

    expect(() => resolveFootprintForTile(absentTile, DEFAULT_PROFILE, absentRegistry, {
      policy: "per_pointing", required: true,
    })).toThrow(/requires a tile or profile/);
    expect(() => resolveFootprintForTile({ ...tile, position_angle_deg: 10 }, DEFAULT_PROFILE, registry, {
      policy: "fixed",
    })).toThrow(/not allowed by the fixed/);
    expect(() => resolveFootprintForTile({ ...tile, position_angle_deg: Number.NaN }, DEFAULT_PROFILE, registry, {
      policy: "per_pointing",
    })).toThrow(/Tile position angle must be finite/);
    expect(() => resolveFootprintForTile(tile, DEFAULT_PROFILE, registry, {
      policy: "user_selected", plan_position_angle_deg: Number.POSITIVE_INFINITY,
    })).toThrow(/Plan position angle must be finite/);
    expect(() => resolveFootprintForTile(absentTile, DEFAULT_PROFILE, absentRegistry, {
      policy: "not_applicable", plan_position_angle_deg: 0,
    })).toThrow(/must be absent/);
  });

  it("keeps rotationally symmetric geometry free of a physical PA claim", () => {
    const circle = { type: "circle" as const, radius_deg: 1 };
    expect(withFootprintPositionAngle(circle, 90)).toBe(circle);
  });
});
