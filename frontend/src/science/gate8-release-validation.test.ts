import { describe, expect, it } from "vitest";
import type { InstrumentProfileV3, SurveyProfileV3 } from "../types";
import { DEFAULT_PROFILE } from "../profiles";
import { createBundledProfileRegistry } from "../profiles/registry";
import { resolvePlanningProfile } from "../profiles/planning";
import { makeCenterProposals, readCsv } from "./catalogue";
import { coverageGeometryContext } from "./coverage-semantics";
import {
  footprintArea,
  footprintCharacteristicScale,
  footprintContainsPoint,
  footprintLocalBounds,
} from "./footprint-engine";
import { resolvePointingGeometries } from "./pointing-geometry";
import { buildExportCsv, type PointingExposureExport } from "./export";

const arcseconds = (value: number) => value / 3600;
const arcminutes = (value: number) => value / 60;

const expectedInstrumentIds = [
  "aat-hector-hr-61core-15arcsec", "aat-sami-61core-15arcsec", "califa-pmas-ppak-331",
  "cfht-megacam-40readout-envelope", "cfht-sitelle", "ctio-decam-area-equivalent",
  "keck-kcwi-large", "keck-kcwi-medium", "keck-kcwi-small", "sdss-lvm-i-science-ifu",
  "sdss-manga-127-fiber", "sdss-manga-19-fiber", "sdss-manga-37-fiber", "sdss-manga-61-fiber",
  "sdss-manga-91-fiber", "subaru-hsc-optical-envelope", "subaru-pfs-target-access",
  "rubin-lsstcam-area-equivalent", "vista-4most-target-access", "vlt-muse-nfm", "vlt-muse-wfm",
  "vst-omegacam-1deg-envelope",
].sort();

const expectedStrategyInstruments: Readonly<Record<string, string>> = {
  "califa-ppak-three-point": "califa-pmas-ppak-331",
  "sami-dr1-seven-position": "aat-sami-61core-15arcsec",
  "sdss-manga-19-three-point": "sdss-manga-19-fiber",
  "sdss-manga-37-three-point": "sdss-manga-37-fiber",
  "sdss-manga-61-three-point": "sdss-manga-61-fiber",
  "sdss-manga-91-three-point": "sdss-manga-91-fiber",
  "sdss-manga-127-three-point": "sdss-manga-127-fiber",
};

type GeometryExpectation =
  | { id: string; type: "rectangle"; widthDeg: number; heightDeg: number; paDeg?: number }
  | { id: string; type: "circle"; radiusDeg: number }
  | { id: string; type: "hexagon"; radiusDeg: number; roundedFlatArcsec?: number };

function assertPrimaryProvenance(id: string, provenance: InstrumentProfileV3["provenance"] | SurveyProfileV3["provenance"]) {
  const references = provenance.references.map((reference) => {
    expect(Boolean(reference.title?.trim() || reference.url || reference.doi), id).toBe(true);
    if (reference.url) {
      const url = new URL(reference.url);
      expect(["http:", "https:"], id).toContain(url.protocol);
      return reference.url;
    }
    return `https://doi.org/${reference.doi}`;
  });
  expect(references.length, id).toBeGreaterThan(0);
  expect(provenance.parameter_sources.length, id).toBeGreaterThan(0);
  expect(provenance.assumptions.length, id).toBeGreaterThan(0);
  expect(provenance.limitations.length, id).toBeGreaterThan(0);
  const sourcePaths = new Set<string>();
  for (const source of provenance.parameter_sources) {
    expect(source.parameter_path.trim().length, id).toBeGreaterThan(0);
    if (source.note) expect(source.note.trim().length, id).toBeGreaterThan(0);
    expect(sourcePaths.has(source.parameter_path), id).toBe(false);
    sourcePaths.add(source.parameter_path);
    const reference = source.reference_url ?? `https://doi.org/${source.reference_doi}`;
    expect(references, `${id}: ${source.parameter_path}`).toContain(reference);
  }
}

const geometryExpectations: GeometryExpectation[] = [
  { id: "keck-kcwi-small", type: "rectangle", widthDeg: arcseconds(8.4), heightDeg: arcseconds(20.4), paDeg: 0 },
  { id: "keck-kcwi-medium", type: "rectangle", widthDeg: arcseconds(16.5), heightDeg: arcseconds(20.4), paDeg: 0 },
  { id: "keck-kcwi-large", type: "rectangle", widthDeg: arcseconds(33.1), heightDeg: arcseconds(20.4), paDeg: 0 },
  { id: "vlt-muse-wfm", type: "rectangle", widthDeg: arcseconds(59.9), heightDeg: arcseconds(60) },
  { id: "vlt-muse-nfm", type: "rectangle", widthDeg: arcseconds(7.42), heightDeg: arcseconds(7.43) },
  { id: "cfht-sitelle", type: "rectangle", widthDeg: arcminutes(11), heightDeg: arcminutes(11), paDeg: 0 },
  { id: "vst-omegacam-1deg-envelope", type: "rectangle", widthDeg: 1, heightDeg: 1 },
  { id: "cfht-megacam-40readout-envelope", type: "rectangle", widthDeg: 1, heightDeg: 1 },
  { id: "aat-hector-hr-61core-15arcsec", type: "circle", radiusDeg: arcseconds(7.5) },
  { id: "aat-sami-61core-15arcsec", type: "circle", radiusDeg: arcseconds(7.5) },
  { id: "rubin-lsstcam-area-equivalent", type: "circle", radiusDeg: Math.sqrt(9.6 / Math.PI) },
  { id: "ctio-decam-area-equivalent", type: "circle", radiusDeg: Math.sqrt(3 / Math.PI) },
  { id: "subaru-hsc-optical-envelope", type: "circle", radiusDeg: 0.75 },
  { id: "sdss-lvm-i-science-ifu", type: "hexagon", radiusDeg: arcminutes(30.2 / 2) },
  { id: "vista-4most-target-access", type: "hexagon", radiusDeg: 2.5 / 2 },
  { id: "subaru-pfs-target-access", type: "hexagon", radiusDeg: 1.38 / 2 },
  { id: "sdss-manga-19-fiber", type: "hexagon", radiusDeg: arcseconds(12 / 2), roundedFlatArcsec: 10.4 },
  { id: "sdss-manga-37-fiber", type: "hexagon", radiusDeg: arcseconds(17 / 2), roundedFlatArcsec: 14.7 },
  { id: "sdss-manga-61-fiber", type: "hexagon", radiusDeg: arcseconds(22 / 2), roundedFlatArcsec: 19.0 },
  { id: "sdss-manga-91-fiber", type: "hexagon", radiusDeg: arcseconds(27 / 2), roundedFlatArcsec: 23.3 },
  { id: "sdss-manga-127-fiber", type: "hexagon", radiusDeg: arcseconds(32 / 2), roundedFlatArcsec: 27.7 },
  { id: "califa-pmas-ppak-331", type: "hexagon", radiusDeg: arcseconds(74 / 2), roundedFlatArcsec: 64 },
];

function closeTo(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function polygonArea(vertices: readonly (readonly [number, number])[]) {
  return Math.abs(vertices.reduce((sum, [east, north], index) => {
    const [nextEast, nextNorth] = vertices[(index + 1) % vertices.length];
    return sum + east * nextNorth - nextEast * north;
  }, 0)) / 2;
}

function assertGeometry(instrument: InstrumentProfileV3, expected: GeometryExpectation) {
  const footprint = instrument.footprint;
  const bounds = footprintLocalBounds(footprint);
  const scaleTolerance = 1e-12;
  expect(footprint.type, instrument.id).toBe(expected.type === "hexagon" ? "polygon" : expected.type);

  if (expected.type === "rectangle") {
    if (footprint.type !== "rectangle") throw new Error(`Expected rectangle for ${instrument.id}`);
    closeTo(footprint.width_deg, expected.widthDeg, scaleTolerance);
    closeTo(footprint.height_deg, expected.heightDeg, scaleTolerance);
    if (expected.paDeg !== undefined) expect(footprint.position_angle_deg).toBe(expected.paDeg);
    closeTo(footprintArea(footprint), expected.widthDeg * expected.heightDeg, 1e-14);
    closeTo(footprintCharacteristicScale(footprint), Math.min(expected.widthDeg, expected.heightDeg), scaleTolerance);
    closeTo(bounds.min_east_deg, -expected.widthDeg / 2, scaleTolerance);
    closeTo(bounds.max_east_deg, expected.widthDeg / 2, scaleTolerance);
    closeTo(bounds.min_north_deg, -expected.heightDeg / 2, scaleTolerance);
    closeTo(bounds.max_north_deg, expected.heightDeg / 2, scaleTolerance);
    expect(footprintContainsPoint(footprint, [0, 0])).toBe(true);
    expect(footprintContainsPoint(footprint, [expected.widthDeg * 0.49, expected.heightDeg * 0.49])).toBe(true);
    expect(footprintContainsPoint(footprint, [expected.widthDeg * 0.51, 0])).toBe(false);
    return;
  }

  if (expected.type === "circle") {
    if (footprint.type !== "circle") throw new Error(`Expected circle for ${instrument.id}`);
    closeTo(footprint.radius_deg, expected.radiusDeg, scaleTolerance);
    closeTo(footprintArea(footprint), Math.PI * expected.radiusDeg ** 2, 1e-13);
    closeTo(footprintCharacteristicScale(footprint), 2 * expected.radiusDeg, scaleTolerance);
    closeTo(bounds.min_east_deg, -expected.radiusDeg, scaleTolerance);
    closeTo(bounds.max_east_deg, expected.radiusDeg, scaleTolerance);
    closeTo(bounds.min_north_deg, -expected.radiusDeg, scaleTolerance);
    closeTo(bounds.max_north_deg, expected.radiusDeg, scaleTolerance);
    expect(footprintContainsPoint(footprint, [0, 0])).toBe(true);
    expect(footprintContainsPoint(footprint, [expected.radiusDeg * 0.5, 0])).toBe(true);
    expect(footprintContainsPoint(footprint, [expected.radiusDeg * 1.01, 0])).toBe(false);
    return;
  }

  if (footprint.type !== "polygon") throw new Error(`Expected regular polygon envelope for ${instrument.id}`);
  const vertices = footprint.vertices_deg;
  expect(vertices, instrument.id).toHaveLength(6);
  vertices.forEach(([east, north], index) => {
    const angle = (90 - index * 60) * Math.PI / 180;
    closeTo(east, expected.radiusDeg * Math.cos(angle), scaleTolerance);
    closeTo(north, expected.radiusDeg * Math.sin(angle), scaleTolerance);
    closeTo(Math.hypot(east, north), expected.radiusDeg, scaleTolerance);
    const opposite = vertices[(index + 3) % 6];
    closeTo(east + opposite[0], 0, scaleTolerance);
    closeTo(north + opposite[1], 0, scaleTolerance);
  });
  const flatToFlatDeg = Math.sqrt(3) * expected.radiusDeg;
  closeTo(bounds.min_east_deg, -flatToFlatDeg / 2, scaleTolerance);
  closeTo(bounds.max_east_deg, flatToFlatDeg / 2, scaleTolerance);
  closeTo(bounds.min_north_deg, -expected.radiusDeg, scaleTolerance);
  closeTo(bounds.max_north_deg, expected.radiusDeg, scaleTolerance);
  closeTo(polygonArea(vertices), 3 * Math.sqrt(3) / 2 * expected.radiusDeg ** 2, 1e-14);
  closeTo(footprintArea(footprint), 3 * Math.sqrt(3) / 2 * expected.radiusDeg ** 2, 1e-14);
  closeTo(footprintCharacteristicScale(footprint), flatToFlatDeg, scaleTolerance);
  if (expected.roundedFlatArcsec !== undefined) {
    closeTo(flatToFlatDeg * 3600, expected.roundedFlatArcsec, 0.1);
  }
  expect(footprintContainsPoint(footprint, [0, 0])).toBe(true);
  expect(footprintContainsPoint(footprint, [0, expected.radiusDeg * 0.75])).toBe(true);
  expect(footprintContainsPoint(footprint, [0, expected.radiusDeg * 1.01])).toBe(false);
}

function expectedSequenceOffsets(strategy: SurveyProfileV3): Array<[number, number]> {
  if (strategy.id === "califa-ppak-three-point") return [[0, 0], [-5.22, -4.53], [-5.22, 4.53]];
  if (strategy.id.startsWith("sdss-manga-")) {
    const side = 1.44;
    return [
      [-side / (2 * Math.sqrt(3)), side / 2],
      [-side / (2 * Math.sqrt(3)), -side / 2],
      [side / Math.sqrt(3), 0],
    ];
  }
  return Array.from({ length: 7 }, (_, index) => {
    if (index === 0) return [0, 0];
    const angle = (90 - (index - 1) * 60) * Math.PI / 180;
    return [0.7 * Math.cos(angle), 0.7 * Math.sin(angle)];
  });
}

describe("Gate 8 independent release registry and geometry ledger", () => {
  it("registers exactly the protected v2 pair, 22 selected v3 instruments, and seven real strategies", () => {
    const registry = createBundledProfileRegistry();
    const instruments = registry.listAnyInstrumentProfiles();
    const v3Instruments = instruments.filter((item): item is InstrumentProfileV3 => item.schema_version === 3);
    const strategies = registry.listAnySurveyProfiles().filter((item): item is SurveyProfileV3 => item.schema_version === 3);

    expect(instruments).toHaveLength(23);
    expect(v3Instruments).toHaveLength(22);
    expect(new Set(instruments.map(({ id }) => id)).size).toBe(23);
    expect(v3Instruments.map(({ id }) => id).sort()).toEqual(expectedInstrumentIds);
    expect(strategies).toHaveLength(7);
    expect(new Set(registry.listAnySurveyProfiles().map(({ id }) => id)).size).toBe(8);
    expect(Object.fromEntries(strategies.map(({ id, instrument_id }) => [id, instrument_id])))
      .toEqual(expectedStrategyInstruments);
    expect(registry.resolveInstrumentProfile("t80-south").schema_version).toBe(2);
    expect(registry.resolveSurveyProfile("splus-t80-south").schema_version).toBe(2);
    expect(DEFAULT_PROFILE.id).toBe("splus-t80-south");
    for (const strategy of strategies) {
      expect(registry.resolveInstrumentProfile(strategy.instrument_id).schema_version).toBe(3);
    }
  });

  it("matches independent source-derived geometry for every selected v3 instrument", () => {
    const registry = createBundledProfileRegistry();
    const byId = new Map(registry.listAnyInstrumentProfiles().map((item) => [item.id, item]));
    expect(geometryExpectations.map(({ id }) => id).sort()).toEqual(expectedInstrumentIds);
    for (const expectation of geometryExpectations) {
      const instrument = byId.get(expectation.id);
      if (!instrument || instrument.schema_version !== 3) throw new Error(`Missing selected v3 profile ${expectation.id}`);
      assertGeometry(instrument, expectation);
    }
  });

  it("retains source metadata, roles, fidelity, PA policy, and primary references across all selected profiles", () => {
    const registry = createBundledProfileRegistry();
    const fixed = new Set(["keck-kcwi-small", "keck-kcwi-medium", "keck-kcwi-large", "cfht-sitelle"]);
    const perPointing = new Set(["vlt-muse-wfm", "vlt-muse-nfm", "vista-4most-target-access", "subaru-pfs-target-access"]);
    const observed = new Set(["keck-kcwi-small", "keck-kcwi-medium", "keck-kcwi-large"]);
    const targetAccess = new Set(["vista-4most-target-access", "subaru-pfs-target-access"]);

    for (const instrument of registry.listAnyInstrumentProfiles()) {
      if (instrument.schema_version !== 3) continue;
      const { footprint_semantics: semantics, position_angle: pa } = instrument;
      assertPrimaryProvenance(instrument.id, instrument.provenance);
      const geometryPaths = new Set(instrument.provenance.parameter_sources.map(({ parameter_path }) => parameter_path));
      const requiredGeometryPaths = instrument.footprint.type === "rectangle"
        ? ["footprint.width_deg", "footprint.height_deg"]
        : instrument.footprint.type === "circle" ? ["footprint.radius_deg"] : ["footprint.vertices_deg"];
      for (const path of requiredGeometryPaths) expect(geometryPaths, `${instrument.id}: ${path}`).toContain(path);
      expect(semantics.role, instrument.id).toBe(observed.has(instrument.id) ? "observed_area" : targetAccess.has(instrument.id) ? "target_access" : "nominal_envelope");
      expect(semantics.fidelity, instrument.id).toBe(observed.has(instrument.id) ? "exact" : "approximate");
      if (semantics.fidelity === "approximate") expect(semantics.approximation_notice?.trim().length, instrument.id).toBeGreaterThan(0);
      expect(pa.mode, instrument.id).toBe(fixed.has(instrument.id) ? "fixed" : perPointing.has(instrument.id) ? "per_pointing" : "not_applicable");
      expect(pa.required, instrument.id).toBe(pa.mode === "fixed" || pa.mode === "per_pointing");
    }
  });

  it("checks every selected strategy's relationship, ordered geometry, single exposure, and sequence export", () => {
    const registry = createBundledProfileRegistry();
    const strategies = registry.listAnySurveyProfiles().filter((item): item is SurveyProfileV3 => item.schema_version === 3);
    const pointing = makeCenterProposals([{ ra_deg: 150, dec_deg: -30 }], "manual")[0];

    for (const strategy of strategies) {
      const expectedInstrumentId = expectedStrategyInstruments[strategy.id];
      const instrument = registry.resolveInstrumentProfile(expectedInstrumentId);
      if (instrument.schema_version !== 3) throw new Error(`Expected v3 instrument ${expectedInstrumentId}`);
      expect(strategy.instrument_id).toBe(expectedInstrumentId);
      expect(strategy.tiling.type).toBe("manual");
      expect(strategy.inference.enabled).toBe(false);
      expect(strategy.coverage_basis_default).toBe("effective_sequence");
      expect(strategy.observing_sequence).toBeDefined();
      assertPrimaryProvenance(strategy.id, strategy.provenance);
      const sequence = strategy.observing_sequence!;
      const expectedOffsets = expectedSequenceOffsets(strategy);
      expect(sequence.exposures.map(({ order }) => order)).toEqual(expectedOffsets.map((_, index) => index + 1));
      expect(sequence.exposures).toHaveLength(expectedOffsets.length);
      const sequencePaths = new Set(strategy.provenance.parameter_sources.map(({ parameter_path }) => parameter_path));
      sequence.exposures.forEach((exposure, index) => {
        expect(sequencePaths, strategy.id).toContain(`observing_sequence.exposures[${index}].east_arcsec`);
        expect(sequencePaths, strategy.id).toContain(`observing_sequence.exposures[${index}].north_arcsec`);
        closeTo(exposure.east_arcsec, expectedOffsets[index][0], 1e-9);
        closeTo(exposure.north_arcsec, expectedOffsets[index][1], 1e-9);
        expect(exposure.rotation_deg ?? 0).toBe(0);
      });

      const profile = resolvePlanningProfile(strategy.id, undefined, registry).profile;
      const tile = { ...pointing, output_strategy_id: strategy.id, instrument_profile_id: instrument.id };
      const context = coverageGeometryContext([tile], profile, registry);
      const single = resolvePointingGeometries(tile, profile, registry, { ...context, coverageBasis: "single_exposure" });
      const effective = resolvePointingGeometries(tile, profile, registry, context);
      expect(single).toHaveLength(1);
      expect(single[0].center).toEqual([pointing.ra_deg, pointing.dec_deg]);
      expect(effective).toHaveLength(expectedOffsets.length);
      effective.forEach((geometry, index) => {
        closeTo((geometry.center[0] - pointing.ra_deg) * Math.cos(pointing.dec_deg * Math.PI / 180) * 3600,
          expectedOffsets[index][0], 1e-8);
        closeTo((geometry.center[1] - pointing.dec_deg) * 3600, expectedOffsets[index][1], 1e-8);
      });

      const exposureRows: PointingExposureExport[] = effective.map((geometry) => ({
        id: geometry.id,
        order: geometry.order,
        ra_deg: geometry.center[0],
        dec_deg: geometry.center[1],
      }));
      const nominal = readCsv(buildExportCsv([tile], strategy));
      const expandedCsv = buildExportCsv([tile], strategy, undefined, { resolveExposures: () => exposureRows });
      expect(expandedCsv).toBe(buildExportCsv([tile], strategy, undefined, { resolveExposures: () => exposureRows }));
      const expanded = readCsv(expandedCsv);
      const idColumn = strategy.export.identifiers?.id_column;
      if (!idColumn) throw new Error(`Expected stable row IDs in ${strategy.id} export`);
      const idIndex = expanded[0].indexOf(idColumn);
      expect(nominal).toHaveLength(2);
      expect(expanded).toHaveLength(expectedOffsets.length + 1);
      expect(expanded.slice(1).map((row) => row[idIndex])).toEqual(expectedOffsets.map((_, index) => `PROPOSED_0001_EXP_${String(index + 1).padStart(4, "0")}`));
      expect(expanded[0]).toEqual([
        strategy.export.ra_column,
        strategy.export.dec_column,
        idColumn,
        ...Object.keys(strategy.export.constant_fields ?? {}).sort(),
      ]);
      expect(expanded[0]).not.toContain("EPOCH");
      expect(expanded[0]).not.toContain("POSITION_ANGLE_DEG");
      const raIndex = expanded[0].indexOf(strategy.export.ra_column);
      const decIndex = expanded[0].indexOf(strategy.export.dec_column);
      effective.forEach((geometry, index) => {
        expect(expanded[index + 1][raIndex]).toBe(geometry.center[0].toFixed(8));
        expect(expanded[index + 1][decIndex]).toBe(geometry.center[1].toFixed(8));
      });
      for (const [key, value] of Object.entries(strategy.export.constant_fields ?? {})) {
        expect(expanded[0]).toContain(key);
        expect(expanded.slice(1).every((row) => row[expanded[0].indexOf(key)] === value)).toBe(true);
      }
    }
  });
});
