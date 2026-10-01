import { describe, expect, it } from "vitest";
import { createBundledProfileRegistry } from "./registry";
import { automaticRegionUnavailableMessage, derivePlanningCapabilities, emptyPlanningStateMessage, planningModeLabel } from "./planning-capabilities";

const registry = createBundledProfileRegistry();

describe("derived output planning capabilities", () => {
  it("uses the declared survey tiling policy for automatic region planning", () => {
    const strategy = registry.resolveAnySurveyProfile("splus-t80-south");
    const instrument = registry.resolveAnyInstrumentProfile(strategy.instrument_id);
    const capabilities = derivePlanningCapabilities(instrument, strategy);

    expect(capabilities.supportsAutomaticRegionPlanning).toBe(true);
    expect(capabilities.canPlaceManualPointing).toBe(true);
    expect(capabilities.canImportCenters).toBe(true);
    expect(planningModeLabel(capabilities)).toBe("Automatic region tiling + manual pointings");
    expect(emptyPlanningStateMessage(capabilities)).toMatch(/Select an area to generate a plan/);
  });

  it("derives standalone manual placement and a user-supplied PA from profile semantics, not IDs", () => {
    const muse = registry.resolveAnyInstrumentProfile("vlt-muse-wfm");
    const renamedInstrument = { ...muse, id: "unrelated-standalone-id" };
    const capabilities = derivePlanningCapabilities(renamedInstrument, null);

    expect(capabilities.supportsAutomaticRegionPlanning).toBe(false);
    expect(capabilities.canPlaceManualPointing).toBe(true);
    expect(capabilities.canImportCenters).toBe(true);
    expect(capabilities.requiresUserPositionAngle).toBe(true);
    expect(capabilities.positionAngleMode).toBe("per_pointing");
    expect(planningModeLabel(capabilities)).toBe("Manual pointings · PA required");
    expect(automaticRegionUnavailableMessage(capabilities)).toMatch(/not defined for this instrument/);
  });

  it("uses semantics for renamed regional strategies, fixed PA, and unresolved contexts", () => {
    const strategy = registry.resolveAnySurveyProfile("splus-t80-south");
    const instrument = registry.resolveAnyInstrumentProfile("keck-kcwi-small");
    const renamedStrategy = { ...strategy, id: "arbitrary-regional-strategy", instrument_id: instrument.id };
    const regional = derivePlanningCapabilities(instrument, renamedStrategy);
    expect(regional.supportsAutomaticRegionPlanning).toBe(true);
    expect(regional.positionAngleMode).toBe("fixed");
    expect(regional.positionAngleRequired).toBe(true);
    expect(regional.requiresUserPositionAngle).toBe(false);
    expect(derivePlanningCapabilities(instrument, null).supportsAutomaticRegionPlanning).toBe(false);
    expect(derivePlanningCapabilities(null, renamedStrategy)).toMatchObject({
      supportsAutomaticRegionPlanning: false, canPlaceManualPointing: false, canImportCenters: false,
      canMeasureSelectedGeometry: false, canReportAreaCoverage: false,
    });
  });

  it("never exposes area planning for target-access geometry, even with a regional policy", () => {
    const access = registry.resolveAnyInstrumentProfile("subaru-pfs-target-access");
    const strategy = registry.resolveAnySurveyProfile("splus-t80-south");
    expect(derivePlanningCapabilities(access, { ...strategy, instrument_id: access.id })).toMatchObject({
      supportsAutomaticRegionPlanning: false, canMeasureSelectedGeometry: false, canReportAreaCoverage: false,
      canPlaceManualPointing: true, canImportCenters: true,
    });
  });

  it("labels target-access centers and withholds area-coverage claims", () => {
    const pfs = registry.resolveAnyInstrumentProfile("subaru-pfs-target-access");
    const capabilities = derivePlanningCapabilities({ ...pfs, id: "generic-access-field" }, null);

    expect(capabilities.geometryRole).toBe("target_access");
    expect(capabilities.requiresUserPositionAngle).toBe(true);
    expect(capabilities.canReportAreaCoverage).toBe(false);
    expect(planningModeLabel(capabilities)).toBe("Manual target-access centers · PA required");
    expect(emptyPlanningStateMessage(capabilities)).toMatch(/target-access center/);
  });

  it("keeps an ordered exposure sequence separate from regional tiling", () => {
    const sami = registry.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (sami.schema_version !== 3) throw new Error("Expected the bundled SAMI strategy to use Schema v3.");
    const samiInstrument = registry.resolveAnyInstrumentProfile(sami.instrument_id);
    const renamedStrategy = { ...sami, id: "generic-sequence-id" };
    const capabilities = derivePlanningCapabilities(samiInstrument, renamedStrategy);

    expect(capabilities.observingSequenceExposureCount).toBe(7);
    expect(capabilities.supportsAutomaticRegionPlanning).toBe(false);
    expect(capabilities.canMeasureSelectedGeometry).toBe(true);
    expect(capabilities.canReportAreaCoverage).toBe(true);
    expect(planningModeLabel(capabilities)).toBe("Manual target centers + 7-exposure sequence");
    expect(automaticRegionUnavailableMessage(capabilities)).toMatch(/not a regional tiling policy/);
    expect(emptyPlanningStateMessage(capabilities)).toMatch(/preview the declared exposure sequence/);

    const threeExposureStrategy = { ...renamedStrategy, observing_sequence: {
      ...renamedStrategy.observing_sequence!, exposures: renamedStrategy.observing_sequence!.exposures.slice(0, 3),
    } };
    expect(planningModeLabel(derivePlanningCapabilities(samiInstrument, threeExposureStrategy)))
      .toBe("Manual target centers + 3-exposure sequence");
  });
});
