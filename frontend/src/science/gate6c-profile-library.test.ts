import { describe, expect, it } from "vitest";
import type { Footprint, InstrumentProfileV3, SurveyProfileV3, TileRecord } from "../types";
import productionV3 from "../profiles/production-v3.json";
import { DEFAULT_PROFILE } from "../profiles";
import { ProfileRegistry, createBundledProfileRegistry } from "../profiles/registry";
import { parseProfileJson, serializeProfile } from "../profiles/document";
import { footprintForTile, resolveFootprintForTile } from "../profiles/footprints";
import { resolvePlanningProfile } from "../profiles/planning";
import { validatePlacementProvenance } from "../profiles/placement-provenance";
import { makeCenterProposals } from "./catalogue";
import { measureActiveCoverage } from "./coverage";
import { coverageGeometryContext } from "./coverage-semantics";
import { resolvePointingGeometries } from "./pointing-geometry";
import { requireResolvedCoverage } from "./test-support/resolved-coverage";

const reference = "https://example.org/jasytata-gate6c-synthetic-geometry";
const expectedProductionIds = [
  "aat-hector-hr-61core-15arcsec", "aat-sami-61core-15arcsec", "califa-pmas-ppak-331",
  "cfht-megacam-40readout-envelope", "cfht-sitelle", "ctio-decam-area-equivalent",
  "keck-kcwi-large", "keck-kcwi-medium", "keck-kcwi-small", "sdss-lvm-i-science-ifu",
  "sdss-manga-19-fiber", "sdss-manga-37-fiber", "sdss-manga-61-fiber", "sdss-manga-91-fiber",
  "sdss-manga-127-fiber", "subaru-hsc-optical-envelope",
  "subaru-pfs-target-access", "rubin-lsstcam-area-equivalent", "vista-4most-target-access",
  "vlt-muse-nfm", "vlt-muse-wfm", "vst-omegacam-1deg-envelope",
].sort();
const expectedStrategyIds = [
  "califa-ppak-three-point", "sami-dr1-seven-position", "sdss-manga-19-three-point",
  "sdss-manga-37-three-point", "sdss-manga-61-three-point", "sdss-manga-91-three-point",
  "sdss-manga-127-three-point",
].sort();

function region(width: number, height = width, ra = 150, dec = 0) {
  const cosine = Math.max(Math.cos(dec * Math.PI / 180), 0.01);
  return { vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
    ra_deg: ((ra + x * width / 2 / cosine) % 360 + 360) % 360,
    dec_deg: dec + y * height / 2,
  })) };
}

function sourceTile(id: string, instrumentId: string, ra = 150, dec = 0): TileRecord {
  return {
    id, name: id, ra_deg: ra, dec_deg: dec, source: "original", enabled: true,
    generation_method: null, original_values: null, metadata: {}, instrument_profile_id: instrumentId,
    placement_provenance: validatePlacementProvenance({ origin: "imported_unverified" }),
  };
}

function polygonAreaArcsec2(verticesDeg: readonly (readonly [number, number])[]): number {
  const vertices = verticesDeg.map(([east, north]) => [east * 3600, north * 3600] as const);
  return Math.abs(vertices.reduce((sum, [east, north], index) => {
    const [nextEast, nextNorth] = vertices[(index + 1) % vertices.length];
    return sum + east * nextNorth - nextEast * north;
  }, 0)) / 2;
}

function assertRegularHexEnvelope(id: string, cornerArcsec: number, flatArcsec: number, sourceUrls: readonly string[]) {
  const profile = createBundledProfileRegistry().resolveAnyInstrumentProfile(id);
  if (profile.schema_version !== 3 || profile.footprint.type !== "polygon") throw new Error(`Expected v3 polygon profile ${id}`);
  const vertices = profile.footprint.vertices_deg;
  expect(vertices).toHaveLength(6);

  const localArcsec = vertices.map(([east, north]) => [east * 3600, north * 3600] as const);
  const radii = localArcsec.map(([east, north]) => Math.hypot(east, north));
  const cornerSpan = Math.max(...localArcsec.flatMap(([east, north], index) =>
    localArcsec.slice(index + 1).map(([otherEast, otherNorth]) => Math.hypot(east - otherEast, north - otherNorth))));
  const flatSpan = Math.max(...localArcsec.map(([east]) => east)) - Math.min(...localArcsec.map(([east]) => east));
  const expectedArea = 3 * Math.sqrt(3) * cornerArcsec ** 2 / 8;
  const signedArea = vertices.reduce((sum, [east, north], index) => {
    const [nextEast, nextNorth] = vertices[(index + 1) % vertices.length];
    return sum + east * nextNorth - nextEast * north;
  }, 0);
  const orientation = Math.sign(signedArea);
  const originEdgeCrossProducts = vertices.map(([east, north], index) => {
    const [nextEast, nextNorth] = vertices[(index + 1) % vertices.length];
    return (nextEast - east) * -north - (nextNorth - north) * -east;
  });

  expect(cornerSpan).toBeCloseTo(cornerArcsec, 10);
  expect(flatSpan).toBeCloseTo(flatArcsec, 0);
  expect(Math.abs(flatSpan - cornerArcsec * Math.sqrt(3) / 2)).toBeLessThan(0.1);
  expect(polygonAreaArcsec2(vertices)).toBeCloseTo(expectedArea, 8);
  for (const radius of radii) expect(radius).toBeCloseTo(cornerArcsec / 2, 10);
  for (let index = 0; index < 3; index += 1) {
    expect(localArcsec[index][0] + localArcsec[index + 3][0]).toBeCloseTo(0, 10);
    expect(localArcsec[index][1] + localArcsec[index + 3][1]).toBeCloseTo(0, 10);
  }
  expect(vertices[0][0]).toBeCloseTo(0, 15);
  expect(vertices[0][1]).toBeCloseTo(cornerArcsec / 2 / 3600, 15);
  expect(originEdgeCrossProducts.every((cross) => Math.sign(cross) === orientation || Math.abs(cross) < 1e-15)).toBe(true);
  expect(profile.footprint_semantics).toMatchObject({ role: "nominal_envelope", fidelity: "approximate" });
  expect(profile.footprint_semantics.approximation_notice).toBeTruthy();
  expect(profile.position_angle).toEqual({ mode: "not_applicable", required: false });
  for (const url of sourceUrls) expect(profile.provenance.references.some((referenceItem) => referenceItem.url === url)).toBe(true);
  expect(profile.provenance.parameter_sources).toContainEqual(expect.objectContaining({
    parameter_path: "footprint.vertices_deg",
    reference_url: sourceUrls[0],
  }));
}

function geometryPaths(footprint: Footprint): string[] {
  if (footprint.type === "rectangle") return ["footprint.width_deg", "footprint.height_deg", ...(footprint.position_angle_deg === undefined ? [] : ["footprint.position_angle_deg"])];
  if (footprint.type === "circle") return ["footprint.radius_deg"];
  if (footprint.type === "polygon") return ["footprint.vertices_deg", ...(footprint.position_angle_deg === undefined ? [] : ["footprint.position_angle_deg"])];
  return footprint.components.flatMap((component, index) => [
    `footprint.components[${index}].offset_deg`,
    ...geometryPathsWithPrefix(component.footprint, `footprint.components[${index}].footprint`),
    ...(component.rotation_deg === undefined ? [] : [`footprint.components[${index}].rotation_deg`]),
  ]);
}

function geometryPathsWithPrefix(footprint: Exclude<Footprint, { type: "compound" }>, prefix: string): string[] {
  if (footprint.type === "rectangle") return [`${prefix}.width_deg`, `${prefix}.height_deg`, ...(footprint.position_angle_deg === undefined ? [] : [`${prefix}.position_angle_deg`])];
  if (footprint.type === "circle") return [`${prefix}.radius_deg`];
  return [`${prefix}.vertices_deg`, ...(footprint.position_angle_deg === undefined ? [] : [`${prefix}.position_angle_deg`])];
}

function testInstrument(id: string, footprint: Footprint, role: "observed_area" | "nominal_envelope" = "observed_area"): InstrumentProfileV3 {
  const url = reference;
  return {
    schema_version: 3, id, display_name: id, coordinate_frame: "icrs", footprint,
    footprint_semantics: {
      role, fidelity: role === "observed_area" ? "exact" : "approximate",
      ...(role === "nominal_envelope" ? { approximation_notice: "Synthetic nominal geometry for generic runtime regression." } : {}),
    },
    position_angle: { mode: "per_pointing", required: false },
    provenance: {
      references: [{ url }],
      parameter_sources: geometryPaths(footprint).map((parameter_path) => ({ parameter_path, reference_url: url })),
      assumptions: role === "observed_area" ? [] : ["Synthetic envelope geometry."],
      limitations: role === "observed_area" ? [] : ["No synthetic coverage truth is implied."],
    },
  };
}

function testStrategy(id: string, instrumentId: string, sequence?: SurveyProfileV3["observing_sequence"]): SurveyProfileV3 {
  const sequencePaths = sequence?.exposures.flatMap((_, index) => [
    `observing_sequence.exposures[${index}].east_arcsec`,
    `observing_sequence.exposures[${index}].north_arcsec`,
  ]) ?? [];
  return {
    schema_version: 3, id, display_name: id, instrument_id: instrumentId,
    tiling: { type: "manual" },
    inference: {
      enabled: false, spacing_tolerance_fraction: 0, phase_tolerance_fraction: 0,
      occupancy_tolerance_fraction: 0, min_anchor_tiles: 1, min_neighbor_pairs: 1,
      allow_rotation: false,
    },
    coverage: { sampling: { target_samples_per_footprint_axis: 8, max_samples: 90_000 }, target_samples_per_footprint_axis: 8 },
    coverage_basis_default: sequence ? "effective_sequence" : "single_exposure",
    ...(sequence ? { observing_sequence: sequence } : {}),
    export: { ra_column: "RA", dec_column: "DEC", coordinate_format: "decimal" },
    provenance: {
      references: [{ url: reference }],
      parameter_sources: sequencePaths.map((parameter_path) => ({ parameter_path, reference_url: reference })),
      assumptions: [], limitations: [],
    },
  };
}

function mixedRegistry() {
  const registry = createBundledProfileRegistry();
  registry.registerInstrumentProfileV3(testInstrument("g6c-wide-observed", { type: "rectangle", width_deg: 1.4, height_deg: 1.4 }));
  registry.registerSurveyProfileV3(testStrategy("g6c-wide-observed-run", "g6c-wide-observed"));
  registry.registerInstrumentProfileV3(testInstrument("g6c-sequence-ifu", { type: "rectangle", width_deg: 0.02, height_deg: 0.01 }));
  registry.registerSurveyProfileV3(testStrategy("g6c-sequence-run", "g6c-sequence-ifu", {
    id: "generic-two-position", exposures: [
      { order: 1, east_arcsec: 0, north_arcsec: 0 },
      { order: 2, east_arcsec: 8.4, north_arcsec: 0 },
    ],
  }));
  return registry;
}

describe("Gate 6C selected profile library", () => {
  it("bundles every selected stable ID and keeps the instrument library selective", () => {
    const registry = createBundledProfileRegistry();
    const production = registry.listAnyInstrumentProfiles().filter((profile): profile is InstrumentProfileV3 => profile.schema_version === 3);
    expect(production.map(({ id }) => id)).toEqual(expectedProductionIds);
    expect(production.map(({ id }) => id)).toEqual(productionV3.instruments.map(({ id }) => id).sort());
    expect(registry.listAnySurveyProfiles().filter((profile) => profile.schema_version === 3).map(({ id }) => id)).toEqual(expectedStrategyIds);
  });

  it("independently validates MaNGA Table 4 nominal corner and flat dimensions for all bundle sizes", () => {
    for (const [fibers, corner, flat] of [
      [19, 12, 10.4], [37, 17, 14.7], [61, 22, 19.0], [91, 27, 23.3], [127, 32, 27.7],
    ] as const) {
      assertRegularHexEnvelope(
        `sdss-manga-${fibers}-fiber`, corner, flat,
        ["https://arxiv.org/pdf/1412.1535"],
      );
    }
  });

  it("independently validates the sourced PPAK nominal 74-by-64 arcsec hex envelope", () => {
    assertRegularHexEnvelope("califa-pmas-ppak-331", 74, 64, [
      "https://arxiv.org/abs/astro-ph/0512557",
      "https://www.caha.es/pmas/PMAS_OVERVIEW/pmas_overview_Fig3b-x.html",
      "https://arxiv.org/html/1307.8130",
    ]);
  });

  it("round-trips each instrument-only profile through canonical file lifecycle and manual source assignment", () => {
    const registry = createBundledProfileRegistry();
    for (const original of registry.listAnyInstrumentProfiles().filter((profile): profile is InstrumentProfileV3 => profile.schema_version === 3)) {
      const document = registry.resolveInstrumentProfileDocument(original.id);
      const encoded = serializeProfile(document);
      const parsed = parseProfileJson(encoded);
      expect(parsed).toEqual(document);

      const imported = new ProfileRegistry();
      expect(imported.registerProfileDocument(parsed)).toEqual(document);
      const manuallyEntered = sourceTile(`center-${original.id}`, original.id, 150.25, -22.5);
      expect(footprintForTile(manuallyEntered, DEFAULT_PROFILE, imported)).toEqual(original.footprint);
      expect(imported.findAnySurveyProfile(original.id)).toBeUndefined();
      const restored = imported.resolveAnyInstrumentProfile(original.id);
      if (restored.schema_version !== 3) throw new Error("Expected round-tripped Schema v3 profile");
      expect(restored.footprint_semantics).toEqual(original.footprint_semantics);
    }
  });

  it("applies Gate 6B coverage behavior to every bundled v3 instrument by its declared role", () => {
    const registry = mixedRegistry();
    const instruments = registry.listAnyInstrumentProfiles().filter((profile): profile is InstrumentProfileV3 => profile.schema_version === 3);
    for (const instrument of instruments) {
      const source = sourceTile(`role-${instrument.id}`, instrument.id);
      const tile = instrument.position_angle.mode === "per_pointing" ? { ...source, position_angle_deg: 0 } : source;
      const basis = instrument.footprint_semantics.role === "target_access" ? "observed_area" : instrument.footprint_semantics.role;
      const result = measureActiveCoverage(
        region(0.05), [tile], [], "g6c-wide-observed-run", undefined, registry,
        { measurementBasis: basis },
      );
      if (instrument.footprint_semantics.role === "target_access") {
        expect(result.coverage_status, instrument.id).toBe("no_contributors");
        expect(result).not.toHaveProperty("selected_region_coverage");
      } else {
        const metrics = requireResolvedCoverage(result);
        expect(metrics.contributing_semantics, instrument.id).toContainEqual({
          role: instrument.footprint_semantics.role,
          fidelity: instrument.footprint_semantics.fidelity,
        });
        expect(metrics.authoritative_observed_area, instrument.id).toBe(instrument.footprint_semantics.role === "observed_area");
      }
    }
  });

  it("records the real geometry/fidelity/role/PA/sequence/lifecycle cross-profile matrix generically", () => {
    const registry = createBundledProfileRegistry();
    const instruments = registry.listAnyInstrumentProfiles().filter((profile): profile is InstrumentProfileV3 => profile.schema_version === 3);
    const shapes = new Set(instruments.map(({ footprint }) => footprint.type));
    const fidelity = new Set(instruments.map(({ footprint_semantics }) => footprint_semantics.fidelity));
    const roles = new Set(instruments.map(({ footprint_semantics }) => footprint_semantics.role));
    const paModes = new Set(instruments.map(({ position_angle }) => position_angle.mode));
    expect(shapes).toEqual(new Set(["rectangle", "circle", "polygon"]));
    expect(fidelity).toEqual(new Set(["exact", "approximate"]));
    expect(roles).toEqual(new Set(["observed_area", "nominal_envelope", "target_access"]));
    expect(paModes).toEqual(new Set(["fixed", "per_pointing", "not_applicable"]));
    expect(instruments.some(({ position_angle }) => position_angle.mode === "user_selected")).toBe(false);

    for (const [index, instrument] of instruments.entries()) {
      const alias = { ...instrument, id: `generic-profile-${index}` };
      const isolated = new ProfileRegistry();
      isolated.registerInstrumentProfileV3(alias);
      const row = sourceTile("generic-source", alias.id);
      const policy = { policy: alias.position_angle.mode, required: alias.position_angle.required } as const;
      if (alias.position_angle.mode === "fixed") {
        const resolved = resolveFootprintForTile(row, DEFAULT_PROFILE, isolated, policy);
        expect(resolved.resolved_position_angle_deg).toBe(alias.footprint.type === "circle" ? undefined : alias.footprint.position_angle_deg);
      } else if (alias.position_angle.mode === "per_pointing") {
        if (alias.position_angle.required) expect(() => resolveFootprintForTile(row, DEFAULT_PROFILE, isolated, policy)).toThrow(/requires a tile or profile position angle/);
        const withDeclaredAngle = resolveFootprintForTile({ ...row, position_angle_deg: 37 }, DEFAULT_PROFILE, isolated, policy);
        expect(withDeclaredAngle.resolved_position_angle_deg).toBe(37);
      } else {
        const resolved = resolveFootprintForTile(row, DEFAULT_PROFILE, isolated, policy);
        expect(resolved.resolved_position_angle_deg).toBeUndefined();
        expect(() => resolveFootprintForTile({ ...row, position_angle_deg: 37 }, DEFAULT_PROFILE, isolated, policy)).toThrow(/not applicable/);
      }
    }

    const strategies = registry.listAnySurveyProfiles().filter((profile): profile is SurveyProfileV3 => profile.schema_version === 3);
    expect(strategies.map(({ id }) => id)).toEqual(expectedStrategyIds);
    expect(strategies.find(({ id }) => id === "sami-dr1-seven-position")?.observing_sequence?.exposures.map(({ order }) => order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(instruments.every(({ schema_version }) => schema_version === 3)).toBe(true);
  });

  it.each([
    ["califa-ppak-three-point", "califa-pmas-ppak-331", [[0, 0], [-5.22, -4.53], [-5.22, 4.53]]],
    ...([19, 37, 61, 91, 127] as const).map((fibers) => {
      const side = 1.44;
      return [`sdss-manga-${fibers}-three-point`, `sdss-manga-${fibers}-fiber`, [
        [-side / (2 * Math.sqrt(3)), side / 2],
        [-side / (2 * Math.sqrt(3)), -side / 2],
        [side / Math.sqrt(3), 0],
      ]] as const;
    }),
  ] as const)("round-trips %s and resolves single versus three-exposure geometry", (strategyId, instrumentId, expectedOffsets) => {
    const bundled = createBundledProfileRegistry();
    const document = bundled.resolveAnyProfileDocument(strategyId);
    const restored = new ProfileRegistry();
    restored.registerProfileDocument(parseProfileJson(serializeProfile(document)));

    const strategy = restored.resolveAnySurveyProfile(strategyId);
    if (strategy.schema_version !== 3 || !strategy.observing_sequence) throw new Error(`Expected v3 observing strategy ${strategyId}`);
    expect(strategy.instrument_id).toBe(instrumentId);
    expect(strategy.observing_sequence.id).toBe(strategyId);
    expect(strategy.observing_sequence.exposures.map(({ order }) => order)).toEqual([1, 2, 3]);
    expect(strategy.coverage_basis_default).toBe("effective_sequence");

    const profile = resolvePlanningProfile(strategyId, undefined, restored).profile;
    const proposal = makeCenterProposals([{ ra_deg: 150, dec_deg: -30 }], "manual")[0];
    const effectiveContext = coverageGeometryContext([proposal], profile, restored);
    const singleContext = coverageGeometryContext([proposal], profile, restored, { coverageBasis: "single_exposure" });
    const effective = resolvePointingGeometries(proposal, profile, restored, effectiveContext);
    const single = resolvePointingGeometries(proposal, profile, restored, singleContext);
    const cosDec = Math.cos(proposal.dec_deg * Math.PI / 180);

    expect(effective).toHaveLength(3);
    expect(effective.map(({ order }) => order)).toEqual([1, 2, 3]);
    expect(single).toHaveLength(1);
    expect(single[0].center).toEqual([proposal.ra_deg, proposal.dec_deg]);
    expect(effective.map(({ footprint }) => footprint)).toEqual(Array(3).fill(restored.resolveAnyInstrumentProfile(instrumentId).footprint));
    for (const [index, [expectedEast, expectedNorth]] of expectedOffsets.entries()) {
      expect(strategy.observing_sequence.exposures[index]).toMatchObject({
        order: index + 1, east_arcsec: expectedEast, north_arcsec: expectedNorth,
      });
      const [ra, dec] = effective[index].center;
      const eastArcsec = (ra - proposal.ra_deg) * cosDec * 3600;
      const northArcsec = (dec - proposal.dec_deg) * 3600;
      expect(eastArcsec).toBeCloseTo(expectedEast, 8);
      expect(northArcsec).toBeCloseTo(expectedNorth, 8);
      expect(effective[index].position_angle_deg).toBeUndefined();
    }
  });

  it("keeps observed-area resolution, target access, nominal envelopes and sequence geometry separate", () => {
    const registry = mixedRegistry();
    const roi = region(0.05);
    const wide = sourceTile("wide", "g6c-wide-observed", 149.31);
    const kcwi = sourceTile("small-ifU", "keck-kcwi-small", 150.024);
    const observedContext = { measurementBasis: "observed_area" as const };
    const combined = requireResolvedCoverage(measureActiveCoverage(roi, [wide, kcwi], [], "g6c-wide-observed-run", undefined, registry, observedContext));
    const wideOnly = requireResolvedCoverage(measureActiveCoverage(roi, [wide], [], "g6c-wide-observed-run", undefined, registry, observedContext));
    expect(combined.coverage_basis).toBe("observed_area");
    expect(combined.coverage_status).toBe("resolved");
    expect(combined.sampling?.characteristic_scale_deg).toBeCloseTo(8.4 / 3600, 14);
    expect(combined.sampling?.natural_step_deg).toBeCloseTo((8.4 / 3600) / 8, 15);
    expect(wideOnly.sampling?.characteristic_scale_deg).toBe(1.4);
    expect(combined.existing_tiles_contributing).toBe(2);

    const accessIds = ["subaru-pfs-target-access", "vista-4most-target-access"];
    for (const accessId of accessIds) {
      const access = sourceTile(`access-${accessId}`, accessId);
      const accessOnly = measureActiveCoverage(roi, [access], [], "g6c-wide-observed-run", undefined, registry, observedContext);
      expect(accessOnly.coverage_status).toBe("no_contributors");
      expect(accessOnly).not.toHaveProperty("selected_region_coverage");
      const withAccess = measureActiveCoverage(roi, [kcwi, access], [], "g6c-wide-observed-run", undefined, registry, observedContext);
      const kcwiOnly = measureActiveCoverage(roi, [kcwi], [], "g6c-wide-observed-run", undefined, registry, observedContext);
      expect(withAccess).toEqual(kcwiOnly);
    }

    const envelope = sourceTile("widefield-envelope", "vst-omegacam-1deg-envelope");
    const observedPlusEnvelope = measureActiveCoverage(roi, [kcwi, envelope], [], "g6c-wide-observed-run", undefined, registry, observedContext);
    const observedOnly = measureActiveCoverage(roi, [kcwi], [], "g6c-wide-observed-run", undefined, registry, observedContext);
    expect(observedPlusEnvelope).toEqual(observedOnly);
    const envelopeOnly = requireResolvedCoverage(measureActiveCoverage(roi, [envelope], [], "g6c-wide-observed-run", undefined, registry, { measurementBasis: "nominal_envelope" }));
    expect(envelopeOnly.coverage_basis).toBe("nominal_envelope");
    expect(envelopeOnly.authoritative_observed_area).toBe(false);
    expect(envelopeOnly.contributing_semantics).toEqual([{ role: "nominal_envelope", fidelity: "approximate" }]);

    const sequenceRun = "g6c-sequence-run";
    const sequenceProfile = resolvePlanningProfile(sequenceRun, undefined, registry).profile;
    const proposal = makeCenterProposals([{ ra_deg: 150, dec_deg: 0 }], "manual")[0];
    const ordinary = sourceTile("ordinary-single", "keck-kcwi-small");
    const sequenceContext = coverageGeometryContext([ordinary, proposal], sequenceProfile, registry);
    const sequencedGeometry = resolvePointingGeometries(proposal, sequenceProfile, registry, sequenceContext);
    const ordinaryGeometry = resolvePointingGeometries(ordinary, sequenceProfile, registry, sequenceContext);
    expect(sequencedGeometry.map(({ order }) => order)).toEqual([1, 2]);
    expect(ordinaryGeometry).toHaveLength(1);
    expect(ordinaryGeometry[0].position_angle_deg).toBe(0);
    const mixedSequence = requireResolvedCoverage(measureActiveCoverage(region(0.05), [ordinary], [proposal], sequenceRun, undefined, registry));
    expect(mixedSequence.geometry_basis).toBe("effective_sequence");
    expect(mixedSequence.coverage_basis).toBe("observed_area");

    const unresolved = measureActiveCoverage(region(10), [ordinary], [proposal], sequenceRun, undefined, registry);
    expect(unresolved.coverage_status).toBe("under_resolved");
    expect(unresolved.sampling?.status).toBe("under_resolved");
    expect(unresolved).not.toHaveProperty("selected_region_coverage");
    expect(unresolved).not.toHaveProperty("remaining_uncovered_fraction");
  });

  it("round-trips the selected SAMI strategy with its linked instrument and resolves its effective sequence", () => {
    const bundled = createBundledProfileRegistry();
    const document = bundled.resolveAnyProfileDocument("sami-dr1-seven-position");
    expect("instrument" in document && document.instrument?.id).toBe("aat-sami-61core-15arcsec");
    const restored = new ProfileRegistry();
    restored.registerProfileDocument(parseProfileJson(serializeProfile(document)));
    const strategy = restored.resolveAnySurveyProfile("sami-dr1-seven-position");
    if (strategy.schema_version !== 3 || !strategy.observing_sequence) throw new Error("Expected the persisted SAMI v3 strategy");
    const profile = resolvePlanningProfile(strategy.id, undefined, restored).profile;
    const proposal = makeCenterProposals([{ ra_deg: 150, dec_deg: -30 }], "manual")[0];
    const geometryContext = coverageGeometryContext([proposal], profile, restored);
    const geometries = resolvePointingGeometries(proposal, profile, restored, geometryContext);
    expect(geometries.map(({ order }) => order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(geometries[0].center).toEqual([proposal.ra_deg, proposal.dec_deg]);
    const result = requireResolvedCoverage(measureActiveCoverage(region(0.02, 0.02, 150, -30), [], [proposal], strategy.id, undefined, restored, { measurementBasis: "nominal_envelope" }));
    expect(result.coverage_status).toBe("resolved");
    expect(result.coverage_basis).toBe("nominal_envelope");
    expect(result.geometry_basis).toBe("effective_sequence");
    expect(result.authoritative_observed_area).toBe(false);
  });
});
