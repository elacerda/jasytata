import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { expandPointingExposures } from "./science/pointing-geometry";
import { planRegion } from "./science/planner";
import { rectangleRegionFromCenterSize } from "./science/regions";
import { createBundledProfileRegistry } from "./profiles/registry";
import type { AnyProfileDocument } from "./profiles/document";
import {
  createProjectManifest,
  describeProjectCatalogueDependencies,
  installProjectProfileDependencies,
  JASYTATA_PROJECT_FORMAT,
  JASYTATA_PROJECT_SCHEMA_VERSION,
  matchProjectCatalogueDependencies,
  parseProjectManifest,
  serializeProjectManifest,
  type ProjectCatalogueDependency,
  type CreateProjectManifestInput,
  type JasytataProjectManifest,
} from "./project-manifest";
import type { CatalogueDataset, ProjectPlacementPolicy, SkyPolygon, TileRecord } from "./types";

const registry = createBundledProfileRegistry();
const square = (ra = 150, dec = 0, size = 0.035): SkyPolygon => ({ vertices: [
  { ra_deg: ra - size / 2, dec_deg: dec - size / 2 },
  { ra_deg: ra + size / 2, dec_deg: dec - size / 2 },
  { ra_deg: ra + size / 2, dec_deg: dec + size / 2 },
  { ra_deg: ra - size / 2, dec_deg: dec + size / 2 },
] });

function input(overrides: Partial<CreateProjectManifestInput> = {}): CreateProjectManifestInput {
  return {
    instrumentId: "vlt-muse-wfm",
    observingStrategyId: null,
    planningMode: "regional_mosaic",
    region: square(),
    placement: {
      type: "lattice_project_placement",
      provenance: "user_declared",
      authoring: { preset: "rectangular", east_spacing_deg: 58 / 3600, north_spacing_deg: 58 / 3600 },
      rotation: { mode: "independent", rotation_deg: 27 },
      origin: { type: "fixed_anchor", ra_deg: 149.991, dec_deg: -0.003 },
    },
    positionAngleInputDeg: 31,
    coverageStrategy: "complete",
    sequenceCoverageBasis: null,
    catalogueDependencies: [],
    ...overrides,
  };
}

function roundTrip(source: CreateProjectManifestInput): JasytataProjectManifest {
  const manifest = createProjectManifest(source, registry);
  return parseProjectManifest(serializeProjectManifest(manifest, registry), registry);
}

function rawManifest(overrides: (value: Record<string, unknown>) => void): string {
  const raw = JSON.parse(serializeProjectManifest(createProjectManifest(input(), registry), registry)) as Record<string, unknown>;
  overrides(raw);
  return JSON.stringify(raw);
}

function planFor(manifest: JasytataProjectManifest) {
  const project = manifest.project;
  if (!project.region || project.placement?.type !== "lattice_project_placement") throw new Error("Expected a regional lattice project.");
  return planRegion(project.region, [], undefined, undefined, project.coverage_strategy, registry, undefined, {
    type: "project_lattice",
    instrumentId: project.instrument.id,
    placement: project.placement,
    positionAngleDeg: project.position_angle?.input_deg ?? undefined,
    ...(project.observing_strategy ? { strategyId: project.observing_strategy.id } : {}),
  });
}

function sequenceFor(manifest: JasytataProjectManifest) {
  const strategyId = manifest.project.observing_strategy?.id;
  const strategy = strategyId ? registry.resolveAnySurveyProfile(strategyId) : undefined;
  if (!strategy || strategy.schema_version !== 3 || !strategy.observing_sequence) return undefined;
  return { id: strategy.observing_sequence.id, exposures: strategy.observing_sequence.exposures };
}

function catalogue(id: string, name: string, tileId: string): CatalogueDataset {
  const tile: TileRecord = {
    id: tileId,
    name: "Target A",
    ra_deg: 150.01,
    dec_deg: -0.02,
    source: "original",
    enabled: true,
    generation_method: null,
    dataset_id: id,
    group_id: `${id}:${name.split(/[\\/]/).at(-1)}:legacy-group`,
    instrument_profile_id: "vlt-muse-wfm",
    inference_role: "include",
    original_values: { RA: "150.01", DEC: "-0.02", comment: "retained only in imported catalogue" },
    metadata: { comment: "retained only in imported catalogue" },
  };
  return {
    id,
    filename: name,
    color: "#123456",
    ra_column: "RA",
    dec_column: "DEC",
    instrument_profile_id: "vlt-muse-wfm",
    inference_role: "include",
    tiles: [tile],
    visible: true,
  };
}

describe("Gate 7 project manifest contract", () => {
  it("uses a stable versioned JSON shape and round-trips every Gate 3 placement authoring mode", () => {
    const placements: ProjectPlacementPolicy[] = [
      {
        type: "lattice_project_placement", provenance: "user_declared",
        authoring: { preset: "rectangular", east_spacing_deg: 58 / 3600, north_spacing_deg: 61 / 3600 },
        rotation: { mode: "independent", rotation_deg: 27 },
        origin: { type: "fixed_anchor", ra_deg: 149.991, dec_deg: -0.003 },
      },
      {
        type: "lattice_project_placement", provenance: "user_declared",
        authoring: { preset: "triangular", pitch_deg: 44 / 3600 },
        rotation: { mode: "independent", rotation_deg: 0 },
        origin: { type: "region_center" },
      },
      {
        type: "lattice_project_placement", provenance: "user_declared",
        authoring: { preset: "advanced_basis", basis_deg: [[0.015, 0.004], [-0.006, 0.014]] },
        rotation: { mode: "follow_instrument_pa" },
        origin: { type: "fixed_anchor", ra_deg: 149.99, dec_deg: 0.005 },
      },
    ];
    for (const placement of placements) {
      const original = input({ placement });
      const manifest = roundTrip(original);
      expect(manifest.project.placement).toEqual(placement);
      expect(manifest.project.canonical_basis_deg).toEqual(createProjectManifest(original, registry).project.canonical_basis_deg);
      expect(manifest.project.instrument).toEqual({ id: "vlt-muse-wfm" });
      expect(manifest.project.observing_strategy).toBeNull();
      expect(manifest.project.position_angle).toEqual({ policy: "per_pointing", required: true, input_deg: 31 });
      expect(manifest.project.placement?.provenance).toBe("user_declared");
    }
    const first = serializeProjectManifest(createProjectManifest(input(), registry), registry);
    const second = serializeProjectManifest(createProjectManifest(input(), registry), registry);
    expect(JSON.parse(first)).toMatchObject({
      format: JASYTATA_PROJECT_FORMAT,
      schema_version: JASYTATA_PROJECT_SCHEMA_VERSION,
      app_version: packageMetadata.version,
    });
    expect(packageMetadata.version).toBe("0.5.0");
    expect(first).toBe(second);
  });

  it("round-trips canonical polygon, rectangle-authored, RA-wrap, and high-declination regions", () => {
    const regions = [
      square(),
      { vertices: [
        { ra_deg: 359.975, dec_deg: -0.025 }, { ra_deg: 0.005, dec_deg: -0.025 },
        { ra_deg: 0.005, dec_deg: 0.005 }, { ra_deg: 359.975, dec_deg: 0.005 },
      ] },
      square(42, 88.7, 0.06),
    ];
    for (const [index, region] of regions.entries()) {
      const manifest = roundTrip(input({ region, ...(index === 2 ? { placement: null } : {}) }));
      expect(manifest.project.region).toEqual(region);
    }
    const rectangleRegion = rectangleRegionFromCenterSize({
      center: { ra_deg: 211.3, dec_deg: 33.4 }, width: 0.02, height: 0.02, unit: "deg",
    });
    const rectangleAuthored = roundTrip(input({ region: rectangleRegion }));
    expect(rectangleAuthored.project.region?.vertices).toHaveLength(4);
    expect(rectangleAuthored.project.region).toEqual(rectangleRegion);
  });

  it.each([
    ["Complete", "complete", null, null],
    ["Efficient", "efficient", null, null],
    ["selected registered strategy", "complete", "sami-dr1-seven-position", "effective_sequence"],
    ["no strategy", "complete", null, null],
  ] as const)("preserves %s as a project choice", (_label, coverageStrategy, observingStrategyId, sequenceCoverageBasis) => {
    const isSami = observingStrategyId !== null;
    const manifest = roundTrip(input({
      instrumentId: isSami ? "aat-sami-61core-15arcsec" : "vlt-muse-wfm",
      observingStrategyId,
      positionAngleInputDeg: isSami ? null : 31,
      coverageStrategy,
      sequenceCoverageBasis,
      placement: isSami ? {
        type: "lattice_project_placement", provenance: "user_declared",
        authoring: { preset: "triangular", pitch_deg: 20 / 3600 },
        rotation: { mode: "independent", rotation_deg: 0 },
        origin: { type: "region_center" },
      } : input().placement,
    }));
    expect(manifest.project.coverage_strategy).toBe(coverageStrategy);
    expect(manifest.project.observing_strategy).toEqual(observingStrategyId ? { id: observingStrategyId } : null);
    expect(manifest.project.sequence_coverage_basis).toBe(sequenceCoverageBasis);
  });

  it("reproduces deterministic planning, coverage, stop reason, and ordered sequence expansion after round-trip", () => {
    const cases = [
      input({ coverageStrategy: "complete" }),
      input({ coverageStrategy: "efficient" }),
      input({
        instrumentId: "aat-sami-61core-15arcsec",
        observingStrategyId: "sami-dr1-seven-position",
        positionAngleInputDeg: null,
        coverageStrategy: "complete",
        sequenceCoverageBasis: "effective_sequence",
        placement: {
          type: "lattice_project_placement", provenance: "user_declared",
          authoring: { preset: "rectangular", east_spacing_deg: 50 / 3600, north_spacing_deg: 50 / 3600 },
          rotation: { mode: "independent", rotation_deg: 0 },
          origin: { type: "region_center" },
        },
      }),
    ];
    for (const source of cases) {
      const original = createProjectManifest(source, registry);
      const imported = parseProjectManifest(serializeProjectManifest(original, registry), registry);
      const originalPlan = planFor(original);
      const importedPlan = planFor(imported);
      expect(importedPlan).toEqual(originalPlan);
      expect(importedPlan.tiles.map((tile) => tile.id)).toEqual(originalPlan.tiles.map((tile) => tile.id));
      expect(importedPlan.tiles.map((tile) => [tile.ra_deg, tile.dec_deg])).toEqual(originalPlan.tiles.map((tile) => [tile.ra_deg, tile.dec_deg]));
      expect(importedPlan.metrics).toEqual(originalPlan.metrics);
      expect(importedPlan.selection_stop).toBe(originalPlan.selection_stop);
      expect(importedPlan.candidate_centers).toEqual(originalPlan.candidate_centers);
      const context = {
        coverageBasis: "effective_sequence" as const,
        sequenceForTile: () => sequenceFor(imported) ?? undefined,
      };
      expect(importedPlan.tiles.map((tile) => expandPointingExposures(tile, null, registry, context)))
        .toEqual(originalPlan.tiles.map((tile) => expandPointingExposures(tile, null, registry, context)));
    }
  });

  it("fingerprints normalized external catalogue science inputs without session IDs or raw rows", async () => {
    const first = catalogue("session-a", "/private/path/survey.csv", "random-tile-a");
    const equivalent = catalogue("session-b", "survey.csv", "random-tile-b");
    equivalent.tiles[0].group_id = "session-b:legacy-group";
    const changed = catalogue("session-c", "survey.csv", "random-tile-c");
    changed.tiles[0].ra_deg += 0.001;
    const [dependency] = await describeProjectCatalogueDependencies([first]);
    equivalent.tiles[0].name = "Different display label";
    equivalent.tiles[0].original_values = { RA: "150.010000", DEC: "-0.02", comment: "raw spelling differs" };
    equivalent.tiles[0].metadata = { comment: "non-scientific source metadata differs" };
    equivalent.tiles[0].group_id = "session-b:survey.csv:renamed-legacy-group";
    const [sameDependency] = await describeProjectCatalogueDependencies([equivalent]);
    const [changedDependency] = await describeProjectCatalogueDependencies([changed]);
    expect(dependency.source_name).toBe("survey.csv");
    expect(dependency.sha256).toBe(sameDependency.sha256);
    expect(changedDependency.sha256).not.toBe(dependency.sha256);
    expect(await matchProjectCatalogueDependencies([dependency], [equivalent, changed])).toEqual({
      complete: true,
      matchedDatasetIds: ["session-b"],
      missingCount: 0,
    });
    expect(await matchProjectCatalogueDependencies([dependency], [])).toMatchObject({ complete: false, missingCount: 1 });
    expect(roundTrip(input()).project.catalogue_dependencies).toEqual([]);
  });

  it("rejects malformed, future, incomplete, unsupported, and scientifically invalid manifests", () => {
    expect(() => parseProjectManifest("{not json", registry)).toThrow(/Malformed project JSON/);
    expect(() => parseProjectManifest(rawManifest((value) => { value.schema_version = 2; }), registry)).toThrow(/newer than this app supports/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      (value.project as Record<string, unknown>).instrument = { id: "missing-camera" };
    }), registry)).toThrow(/Unknown instrument/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      (value.project as Record<string, unknown>).observing_strategy = { id: "missing-strategy" };
    }), registry)).toThrow(/Unknown observing strategy/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      (value.project as Record<string, unknown>).observing_strategy = { id: "sami-dr1-seven-position" };
    }), registry)).toThrow(/incompatible with instrument/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      const project = value.project as Record<string, unknown>;
      (project.placement as Record<string, unknown>).authoring = { preset: "advanced_basis", basis_deg: [[1, 1], [2, 2]] };
    }), registry)).toThrow(/Invalid project placement\/basis/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      (value.project as Record<string, unknown>).region = { vertices: [{ ra_deg: 10, dec_deg: 91 }, { ra_deg: 11, dec_deg: 91 }, { ra_deg: 11, dec_deg: 92 }] };
    }), registry)).toThrow(/Invalid region/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      (value.project as Record<string, unknown>).position_angle = { policy: "per_pointing", required: true, input_deg: "NaN" };
    }), registry)).toThrow(/finite number/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      delete (value.project as Record<string, unknown>).coverage_strategy;
    }), registry)).toThrow(/Coverage strategy/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      (value.project as Record<string, unknown>).planning_mode = "scheduler";
    }), registry)).toThrow(/Unsupported project mode/);
    const validAnglePayload = rawManifest(() => undefined);
    const invalidNanPayload = validAnglePayload.replace(/("input_deg"\s*:\s*)31/, "$1NaN");
    expect(invalidNanPayload).not.toBe(validAnglePayload);
    expect(() => parseProjectManifest(invalidNanPayload, registry))
      .toThrow(/Malformed project JSON/);
    const invalidInfinityPayload = validAnglePayload.replace(/("input_deg"\s*:\s*)31/, "$1Infinity");
    expect(invalidInfinityPayload).not.toBe(validAnglePayload);
    expect(() => parseProjectManifest(invalidInfinityPayload, registry))
      .toThrow(/Malformed project JSON/);
    expect(() => parseProjectManifest(rawManifest((value) => {
      const project = value.project as Record<string, unknown>;
      (project.placement as Record<string, unknown>).rotation = { mode: "follow_instrument_pa" };
      (project.position_angle as Record<string, unknown>).input_deg = null;
    }), registry)).toThrow(/Invalid PA for project placement/);
  });

  it("requires declared lattice basis to agree with authoring and keeps placement distinct from profiles", () => {
    const manifest = createProjectManifest(input(), registry);
    expect(manifest.project.placement?.provenance).toBe("user_declared");
    expect(manifest.profile_dependencies).toEqual([]);
    expect(manifest.project.canonical_basis_deg).not.toBeNull();
    const inconsistentBasis = rawManifest((value) => {
      (value.project as Record<string, unknown>).canonical_basis_deg = [[1, 0], [0, 1]];
    });
    expect(() => parseProjectManifest(inconsistentBasis, registry)).toThrow(/does not match the declared authoring/);
  });

  it("embeds a selected custom instrument and installs it only after exact-reference validation", () => {
    const sourceRegistry = createBundledProfileRegistry();
    const resolvedInstrument = sourceRegistry.resolveAnyInstrumentProfile("vlt-muse-wfm");
    if (resolvedInstrument.schema_version !== 3) throw new Error("Expected a Schema v3 MUSE instrument.");
    const customInstrument = resolvedInstrument;
    customInstrument.id = "session-muse-project";
    customInstrument.display_name = "Session MUSE project instrument";
    sourceRegistry.registerInstrumentProfileV3(customInstrument);
    const document: AnyProfileDocument = { instrument: customInstrument };
    const source = input({
      instrumentId: customInstrument.id,
      importedProfileDocuments: new Map<string, AnyProfileDocument>([[`instrument:${customInstrument.id}`, document]]),
    });
    const manifest = createProjectManifest(source, sourceRegistry);
    expect(manifest.profile_dependencies).toEqual([document]);
    const targetRegistry = createBundledProfileRegistry();
    const parsed = parseProjectManifest(serializeProjectManifest(manifest, sourceRegistry), targetRegistry);
    expect(() => targetRegistry.resolveInstrumentProfile(customInstrument.id)).toThrow();
    installProjectProfileDependencies(parsed, targetRegistry);
    expect(targetRegistry.resolveInstrumentProfile(customInstrument.id).id).toBe(customInstrument.id);
  });

  it("embeds custom source-instrument dependencies needed by an external catalogue", () => {
    const sourceRegistry = createBundledProfileRegistry();
    const resolvedInstrument = sourceRegistry.resolveAnyInstrumentProfile("vlt-muse-wfm");
    if (resolvedInstrument.schema_version !== 3) throw new Error("Expected a Schema v3 MUSE instrument.");
    const customSourceInstrument = {
      ...resolvedInstrument,
      id: "custom-catalogue-camera",
      display_name: "Custom catalogue camera",
    };
    sourceRegistry.registerInstrumentProfileV3(customSourceInstrument);
    const sourceDocument: AnyProfileDocument = { instrument: customSourceInstrument };
    const dependency: ProjectCatalogueDependency = {
      source_name: "legacy-survey.csv",
      row_count: 2,
      ra_column: "RA",
      dec_column: "DEC",
      instrument_profile_id: customSourceInstrument.id,
      inference_role: "auto",
      sha256: "b".repeat(64),
    };
    const withoutDocument = input({ catalogueDependencies: [dependency] });
    expect(() => createProjectManifest(withoutDocument, sourceRegistry)).toThrow(/no imported profile document to embed/);

    const manifest = createProjectManifest(input({
      catalogueDependencies: [dependency],
      importedProfileDocuments: new Map([[`instrument:${customSourceInstrument.id}`, sourceDocument]]),
    }), sourceRegistry);
    expect(manifest.profile_dependencies).toEqual([sourceDocument]);
    const targetRegistry = createBundledProfileRegistry();
    const parsed = parseProjectManifest(serializeProjectManifest(manifest, sourceRegistry), targetRegistry);
    installProjectProfileDependencies(parsed, targetRegistry);
    expect(targetRegistry.resolveAnyInstrumentProfile(customSourceInstrument.id).id).toBe(customSourceInstrument.id);
  });
});
