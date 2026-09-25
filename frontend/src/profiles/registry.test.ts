import { describe, expect, it } from "vitest";
import type { InstrumentProfileV2 } from "../types";
import { createBundledProfileRegistry, ProfileRegistry } from "./registry";
import { SPLUS_SURVEY_V2, T80_SOUTH_INSTRUMENT_V2 } from "./v2";

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
