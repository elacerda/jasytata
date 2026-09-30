import { describe, expect, it } from "vitest";
import type { InstrumentProfileV2, TileRecord } from "../types";
import { createBundledProfileRegistry, ProfileRegistry } from "./registry";
import { SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "./v2";
import { validateInstrumentProfileV2 } from "./schema-v2";
import { validateProfileDocument } from "./document";
import { footprintForTile } from "./footprints";
import { DEFAULT_PROFILE } from "./index";
import kcwiInstruments from "./kcwi-slicers.json";

describe("browser profile registry", () => {
  it("resolves the bundled T80 instrument and S-PLUS survey by stable ID", () => {
    const registry = createBundledProfileRegistry();

    expect(registry.resolveInstrumentProfile("t80-south")).toEqual(T80_SOUTH_INSTRUMENT_V2);
    expect(registry.resolveSurveyProfile("splus-t80-south")).toEqual(SPLUS_SURVEY_V2);
  });

  it("sorts profile lists by ID and reports unknown IDs explicitly", () => {
    const registry = new ProfileRegistry();
    const later: InstrumentProfileV2 = { ...T80_SOUTH_INSTRUMENT_V2, id: "z-camera" };
    const earlier: InstrumentProfileV2 = { ...T80_SOUTH_INSTRUMENT_V2, id: "a-camera" };
    registry.registerInstrumentProfile(later);
    registry.registerInstrumentProfile(earlier);

    expect(registry.listInstrumentProfiles().map((profile) => profile.id)).toEqual(["a-camera", "z-camera"]);
    expect(() => registry.resolveInstrumentProfile("missing-camera")).toThrow('Unknown instrument profile ID "missing-camera"');
    expect(() => registry.resolveSurveyProfile("missing-survey")).toThrow('Unknown survey profile ID "missing-survey"');
  });

  it("rejects duplicate IDs without replacing the registered profile", () => {
    const registry = createBundledProfileRegistry();
    const replacement = { ...T80_SOUTH_INSTRUMENT_V2, display_name: "Replacement camera" };

    expect(() => registry.registerInstrumentProfile(replacement)).toThrow(/already registered/);
    expect(registry.resolveInstrumentProfile("t80-south").display_name).toBe("T80-South camera");
    expect(() => registry.registerSurveyProfile({ ...SPLUS_SURVEY_V2, display_name: "Replacement survey" })).toThrow(/already registered/);
    expect(registry.resolveSurveyProfile("splus-t80-south").display_name).toBe("S-PLUS / T80-South");
  });

  it("requires the referenced instrument before registering a survey", () => {
    const registry = new ProfileRegistry();

    expect(() => registry.registerSurveyProfile(SPLUS_SURVEY_V2)).toThrow(/Unknown instrument profile ID "t80-south"/);
  });
});

describe("empirical KCWI compatibility and v0.4 production profiles", () => {
  it.each([
    ["keck-kcwi-small", 8.4],
    ["keck-kcwi-medium", 16.5],
    ["keck-kcwi-large", 33.1],
  ] as const)("validates %s with measured arcsecond dimensions and the declared slice-axis PA", (id, widthArcsec) => {
    const raw = kcwiInstruments.find((instrument) => instrument.id === id);
    const instrument = validateInstrumentProfileV2(raw);
    expect(instrument.coordinate_frame).toBe("icrs");
    expect(instrument.schema_version).toBe(2);
    expect(instrument.footprint.type).toBe("rectangle");
    if (instrument.footprint.type !== "rectangle") throw new Error("Expected KCWI rectangle");
    expect(instrument.footprint.width_deg).toBeCloseTo(widthArcsec / 3600, 15);
    expect(instrument.footprint.height_deg).toBeCloseTo(20.4 / 3600, 15);
    expect(instrument.footprint.position_angle_deg).toBe(0);
    expect(instrument.description).toContain("https://www2.keck.hawaii.edu/inst/kcwi/primer.html");
    expect(instrument.description).toContain("not a Keck rotator-keyword conversion");

    const registry = new ProfileRegistry();
    expect(registry.registerInstrumentProfile(raw)).toEqual(instrument);
    expect(registry.resolveInstrumentProfile(id)).toEqual(instrument);
    expect(registry.listSurveyProfiles()).toEqual([]);
    expect(() => validateInstrumentProfileV2({ ...raw, footprint: { ...instrument.footprint, width_deg: 0 } })).toThrow(/Rectangle width/);
  });

  it("keeps the protected v2 pair and installs selected v3 production profiles", () => {
    const registry = createBundledProfileRegistry();
    expect(registry.listInstrumentProfiles().map(({ id }) => id)).toEqual(["t80-south"]);
    expect(registry.listSurveyProfiles()).toEqual([SPLUS_SURVEY_V2]);
    expect(registry.resolveProfileDocument("splus-t80-south")).toEqual({
      instrument: T80_SOUTH_INSTRUMENT_V2, survey: SPLUS_SURVEY_V2,
    });
    expect(DEFAULT_PROFILE.id).toBe("splus-t80-south");
    for (const raw of kcwiInstruments) {
      const production = registry.resolveAnyInstrumentProfile(raw.id);
      if (production.schema_version !== 3) throw new Error("Expected bundled KCWI v3 production profile");
      expect(production.footprint).toEqual(validateInstrumentProfileV2(raw).footprint);
      expect(production.footprint_semantics).toMatchObject({ role: "observed_area", fidelity: "exact" });
      expect(registry.findSurveyProfile(raw.id)).toBeUndefined();
      expect(() => registry.registerInstrumentProfile(raw)).toThrow(/already registered/);

      const compatibility = new ProfileRegistry();
      expect(compatibility.registerInstrumentProfile(raw)).toEqual(validateInstrumentProfileV2(raw));
      expect(compatibility.resolveInstrumentProfile(raw.id).schema_version).toBe(2);
    }
    expect(registry.listAnyInstrumentProfiles()).toHaveLength(23);
    expect(registry.resolveInstrumentProfile("t80-south")).toEqual(T80_SOUTH_INSTRUMENT_V2);
    expect(registry.resolveAnySurveyProfile("sami-dr1-seven-position").schema_version).toBe(3);
  });

  it("keeps KCWI data independent between registry instances and lookups", () => {
    const registry = createBundledProfileRegistry();
    const other = createBundledProfileRegistry();
    const copy = registry.resolveInstrumentProfile("keck-kcwi-large");
    copy.display_name = "Changed copy";
    if (copy.footprint.type !== "rectangle") throw new Error("Expected KCWI rectangle");
    copy.footprint.width_deg = 1;
    registry.listInstrumentProfiles()[0].description = "Changed list";
    expect(registry.resolveInstrumentProfile(copy.id)).toEqual(other.resolveInstrumentProfile(copy.id));
  });

  it.each(kcwiInstruments)("resolves source geometry for $id independently of output policy and ID spelling", (raw) => {
    const registry = createBundledProfileRegistry();
    const tile: TileRecord = {
      id: "source-1", name: "Target", ra_deg: 150, dec_deg: -30, source: "original",
      generation_method: null, original_values: { RA: "150", DEC: "-30" }, metadata: {},
      instrument_profile_id: raw.id, inference_role: "exclude",
    };
    const production = registry.resolveAnyInstrumentProfile(raw.id);
    expect(footprintForTile(tile, DEFAULT_PROFILE, registry)).toEqual(production.footprint);
    const legacyRegistry = new ProfileRegistry();
    const renamed = legacyRegistry.registerInstrumentProfile({ ...raw, id: "ordinary-slicer" });
    expect(footprintForTile({ ...tile, instrument_profile_id: renamed.id }, DEFAULT_PROFILE, legacyRegistry)).toEqual(raw.footprint);
    expect(footprintForTile({ ...tile, source: "proposed" }, DEFAULT_PROFILE, registry)).toEqual(T80_SOUTH_INSTRUMENT_V2.footprint);
    expect(footprintForTile({ ...tile, source: "proposed", output_strategy_id: "sami-dr1-seven-position" }, DEFAULT_PROFILE, registry))
      .toEqual(production.footprint);
    expect(footprintForTile({ ...tile, source: "proposed" }, null, registry)).toEqual(production.footprint);
  });

  it("records the existing instrument-only browser-document gap without inventing a survey", () => {
    for (const instrument of kcwiInstruments) {
      expect(() => validateProfileDocument({ instrument })).toThrow(/Schema v2 profile documents require both instrument and survey/);
    }
  });
});
