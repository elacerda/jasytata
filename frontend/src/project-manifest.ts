import packageMetadata from "../package.json";
import type { ProjectPlanningMode } from "./profiles/planning-capabilities";
import {
  serializeProfile,
  validateProfileDocument,
  type AnyProfileDocument,
} from "./profiles/document";
import {
  ProfileRegistry,
  createBundledProfileRegistry,
  profileRegistry,
  type AnyInstrumentProfile,
  type AnySurveyProfile,
} from "./profiles/registry";
import { resolveFootprintForTile } from "./profiles/footprints";
import { validateLatticeBasis } from "./science/lattice-validation";
import {
  normalizeProjectPlacementPolicy,
  resolveProjectPlacement,
} from "./science/project-placement";
import { validatePolygon } from "./science/geometry";
import type {
  CatalogueDataset,
  CoverageStrategy,
  InferenceRole,
  LatticeProjectPlacement,
  PositionAngleOptions,
  PositionAnglePolicy,
  ProjectPlacementPolicy,
  SkyPolygon,
  TangentPlaneOffset,
  TileRecord,
} from "./types";

export const JASYTATA_PROJECT_FORMAT = "jasytata-project";
export const JASYTATA_PROJECT_SCHEMA_VERSION = 1;

export type ProjectSequenceCoverageBasis = "single_exposure" | "effective_sequence";

/** SHA-256 reference to one normalized, externally supplied catalogue input. */
export interface ProjectCatalogueDependency {
  source_name: string;
  row_count: number;
  ra_column: string;
  dec_column: string;
  instrument_profile_id: string | null;
  inference_role: InferenceRole;
  sha256: string;
}

/** PA input captured separately from the registered instrument's PA policy. */
export interface ProjectPositionAngleInput {
  policy: PositionAnglePolicy;
  required: boolean;
  input_deg: number | null;
}

/** Canonical project recipe. Candidate/plan state, pointings and browser state are excluded. */
export interface JasytataProjectManifest {
  format: typeof JASYTATA_PROJECT_FORMAT;
  schema_version: typeof JASYTATA_PROJECT_SCHEMA_VERSION;
  app_version: string;
  project: {
    instrument: { id: string };
    observing_strategy: { id: string } | null;
    planning_mode: ProjectPlanningMode;
    region: SkyPolygon | null;
    placement: ProjectPlacementPolicy | null;
    /** Resolver output used to detect changes in the declared authoring, PA or phase. */
    canonical_basis_deg: [TangentPlaneOffset, TangentPlaneOffset] | null;
    position_angle: ProjectPositionAngleInput | null;
    coverage_strategy: CoverageStrategy;
    sequence_coverage_basis: ProjectSequenceCoverageBasis | null;
    catalogue_dependencies: ProjectCatalogueDependency[];
  };
  /** Embedded only for imported/custom profiles required by these exact references. */
  profile_dependencies: AnyProfileDocument[];
}

/** User-owned inputs accepted by the project manifest serializer. */
export interface CreateProjectManifestInput {
  instrumentId: string;
  observingStrategyId: string | null;
  planningMode: ProjectPlanningMode;
  region: SkyPolygon | null;
  placement: ProjectPlacementPolicy | null;
  positionAngleInputDeg: number | null;
  coverageStrategy: CoverageStrategy;
  sequenceCoverageBasis: ProjectSequenceCoverageBasis | null;
  catalogueDependencies: readonly ProjectCatalogueDependency[];
  importedProfileDocuments?: ReadonlyMap<string, AnyProfileDocument>;
}

/** Matched external catalogue layers in the order declared by a manifest. */
export interface ProjectCatalogueMatch {
  complete: boolean;
  matchedDatasetIds: string[];
  missingCount: number;
}

interface ProfileDependencyPlan {
  normalizedDocuments: AnyProfileDocument[];
  instrumentsToRegister: AnyInstrumentProfile[];
  strategiesToRegister: AnySurveyProfile[];
  registry: ProfileRegistry;
}

const PROFILE_DEPENDENCY_KEYS = ["profile_dependencies"] as const;
const CATALOGUE_DIGEST_FORMAT = "jasytata-project-catalogue-v1";
const BUNDLED_REGISTRY = createBundledProfileRegistry();
const BUNDLED_INSTRUMENT_IDS = new Set(BUNDLED_REGISTRY.listAnyInstrumentProfiles().map(({ id }) => id));
const BUNDLED_STRATEGY_IDS = new Set(BUNDLED_REGISTRY.listAnySurveyProfiles().map(({ id }) => id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new Error(`${label} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertJsonValue(member, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label} must contain only plain JSON values.`);
  }
  for (const [key, member] of Object.entries(value)) assertJsonValue(member, `${label}.${key}`);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, member]) => [key, stableValue(member)]));
}

function stableJson(value: unknown): string {
  assertJsonValue(value, "Project manifest");
  return JSON.stringify(stableValue(value));
}

function normalizeRegion(value: unknown): SkyPolygon | null {
  if (value === null) return null;
  try {
    const input = record(value, "Selected region");
    rejectUnknownFields(input, ["vertices"], "Selected region");
    if (!Array.isArray(input.vertices)) throw new Error("Selected region vertices must be an array.");
    const vertices = input.vertices.map((vertex, index) => {
      const point = record(vertex, `Selected region vertex ${index + 1}`);
      rejectUnknownFields(point, ["ra_deg", "dec_deg"], `Selected region vertex ${index + 1}`);
      return {
        ra_deg: finiteNumber(point.ra_deg, `Selected region vertex ${index + 1} RA`),
        dec_deg: finiteNumber(point.dec_deg, `Selected region vertex ${index + 1} Dec`),
      };
    });
    const region = { vertices };
    validatePolygon(region);
    return region;
  } catch (caught) {
    throw new Error(`Invalid region: ${caught instanceof Error ? caught.message : "review its coordinates and polygon geometry."}`);
  }
}

function normalizeBasis(value: unknown): [TangentPlaneOffset, TangentPlaneOffset] | null {
  if (value === null) return null;
  try {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((vector) => Array.isArray(vector) && vector.length === 2)) {
      throw new Error("Canonical basis must contain two east/north vectors.");
    }
    const basis: [TangentPlaneOffset, TangentPlaneOffset] = [
      [finiteNumber(value[0][0], "Canonical basis vector 1 east"), finiteNumber(value[0][1], "Canonical basis vector 1 north")],
      [finiteNumber(value[1][0], "Canonical basis vector 2 east"), finiteNumber(value[1][1], "Canonical basis vector 2 north")],
    ];
    validateLatticeBasis(basis);
    return basis;
  } catch (caught) {
    throw new Error(`Invalid placement basis: ${caught instanceof Error ? caught.message : "review the two finite non-collinear vectors."}`);
  }
}

function normalizeCatalogueDependency(value: unknown, index: number): ProjectCatalogueDependency {
  const item = record(value, `Catalogue dependency ${index + 1}`);
  rejectUnknownFields(item, [
    "source_name", "row_count", "ra_column", "dec_column", "instrument_profile_id", "inference_role", "sha256",
  ], `Catalogue dependency ${index + 1}`);
  const sourceName = requiredString(item.source_name, `Catalogue dependency ${index + 1} source name`);
  if (sourceName.includes("/") || sourceName.includes("\\") || sourceName === "." || sourceName === "..") {
    throw new Error(`Catalogue dependency ${index + 1} source name must be a file name, not a path.`);
  }
  if (!Number.isInteger(item.row_count) || (item.row_count as number) < 0) {
    throw new Error(`Catalogue dependency ${index + 1} row count must be a non-negative integer.`);
  }
  const raColumn = requiredString(item.ra_column, `Catalogue dependency ${index + 1} RA column`);
  const decColumn = requiredString(item.dec_column, `Catalogue dependency ${index + 1} Dec column`);
  if (raColumn === decColumn) throw new Error(`Catalogue dependency ${index + 1} RA and Dec columns must differ.`);
  const instrumentId = item.instrument_profile_id === null
    ? null
    : requiredString(item.instrument_profile_id, `Catalogue dependency ${index + 1} instrument ID`);
  if (item.inference_role !== "auto" && item.inference_role !== "include" && item.inference_role !== "exclude") {
    throw new Error(`Catalogue dependency ${index + 1} has an unsupported inference role.`);
  }
  const hash = requiredString(item.sha256, `Catalogue dependency ${index + 1} SHA-256`);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Catalogue dependency ${index + 1} SHA-256 must be 64 lowercase hexadecimal characters.`);
  return {
    source_name: sourceName,
    row_count: item.row_count as number,
    ra_column: raColumn,
    dec_column: decColumn,
    instrument_profile_id: instrumentId,
    inference_role: item.inference_role,
    sha256: hash,
  };
}

function normalizePositionAngle(
  value: unknown,
  instrument: AnyInstrumentProfile,
): ProjectPositionAngleInput | null {
  if (instrument.schema_version !== 3) {
    if (value !== null) throw new Error("Invalid PA input: this instrument profile uses its registered legacy orientation policy.");
    return null;
  }
  const input = record(value, "Instrument PA input");
  rejectUnknownFields(input, ["policy", "required", "input_deg"], "Instrument PA input");
  const policy = instrument.position_angle.mode;
  if (input.policy !== policy || input.required !== instrument.position_angle.required) {
    throw new Error(`Instrument PA policy does not match registered instrument "${instrument.id}".`);
  }
  const inputDeg = input.input_deg === null ? null : finiteNumber(input.input_deg, "Instrument PA input");
  if (inputDeg !== null && (policy === "fixed" || policy === "not_applicable")) {
    throw new Error(`Invalid PA input: instrument policy "${policy}" does not accept a user-entered angle.`);
  }
  return { policy, required: instrument.position_angle.required, input_deg: inputDeg };
}

function normalizeCoverageStrategy(value: unknown): CoverageStrategy {
  if (value !== "complete" && value !== "efficient") throw new Error("Coverage strategy must be Complete or Efficient.");
  return value;
}

function normalizeSequenceBasis(value: unknown): ProjectSequenceCoverageBasis | null {
  if (value === null) return null;
  if (value !== "single_exposure" && value !== "effective_sequence") {
    throw new Error("Unsupported sequence coverage basis; choose single_exposure or effective_sequence.");
  }
  return value;
}

function registerInstrument(registry: ProfileRegistry, profile: AnyInstrumentProfile): void {
  if (profile.schema_version === 2) registry.registerInstrumentProfile(profile);
  else registry.registerInstrumentProfileV3(profile);
}

function registerStrategy(registry: ProfileRegistry, profile: AnySurveyProfile): void {
  if (profile.schema_version === 2) registry.registerSurveyProfile(profile);
  else registry.registerSurveyProfileV3(profile);
}

function cloneRegistry(registry: ProfileRegistry): ProfileRegistry {
  const copy = new ProfileRegistry();
  registry.listAnyInstrumentProfiles().forEach((profile) => registerInstrument(copy, profile));
  registry.listAnySurveyProfiles().forEach((profile) => registerStrategy(copy, profile));
  return copy;
}

function prepareProfileDependencies(
  values: unknown,
  registry: ProfileRegistry,
): ProfileDependencyPlan {
  if (!Array.isArray(values)) throw new Error("Project profile_dependencies must be an array.");
  let normalizedDocuments: AnyProfileDocument[];
  try {
    normalizedDocuments = values.map((value) => validateProfileDocument(value));
  } catch (caught) {
    throw new Error(`Invalid embedded profile dependency: ${caught instanceof Error ? caught.message : "profile validation failed."}`);
  }
  const candidate = cloneRegistry(registry);
  const instrumentsToRegister: AnyInstrumentProfile[] = [];
  const strategiesToRegister: AnySurveyProfile[] = [];

  for (const document of normalizedDocuments) {
    if (!("instrument" in document) || !document.instrument) continue;
    const incoming = document.instrument as AnyInstrumentProfile;
    const existing = candidate.listAnyInstrumentProfiles().find((item) => item.id === incoming.id);
    if (existing) {
      if (stableJson(existing) !== stableJson(incoming)) {
        throw new Error(`Embedded instrument profile "${incoming.id}" conflicts with the registered definition.`);
      }
      continue;
    }
    registerInstrument(candidate, incoming);
    instrumentsToRegister.push(incoming);
  }

  for (const document of normalizedDocuments) {
    if (!("survey" in document) || !document.survey) continue;
    const incoming = document.survey as AnySurveyProfile;
    const existing = candidate.listAnySurveyProfiles().find((item) => item.id === incoming.id);
    if (existing) {
      if (stableJson(existing) !== stableJson(incoming)) {
        throw new Error(`Embedded observing strategy "${incoming.id}" conflicts with the registered definition.`);
      }
      continue;
    }
    try {
      registerStrategy(candidate, incoming);
    } catch (caught) {
      throw new Error(`Could not resolve embedded strategy "${incoming.id}": ${caught instanceof Error ? caught.message : "invalid strategy reference."}`);
    }
    strategiesToRegister.push(incoming);
  }

  return { normalizedDocuments, instrumentsToRegister, strategiesToRegister, registry: candidate };
}

function currentInstrumentPositionAngle(
  instrument: AnyInstrumentProfile,
  angleInput: ProjectPositionAngleInput | null,
  registry: ProfileRegistry,
): number | undefined {
  if (instrument.schema_version !== 3) return undefined;
  const policy = instrument.position_angle.mode;
  const inputDeg = angleInput?.input_deg ?? null;
  const tile: TileRecord = {
    id: "project-manifest-pa-resolution",
    name: "Project manifest PA resolution",
    ra_deg: 0,
    dec_deg: 0,
    source: "proposed",
    generation_method: "manual",
    instrument_profile_id: instrument.id,
    ...(policy === "per_pointing" && inputDeg !== null ? { position_angle_deg: inputDeg } : {}),
    enabled: true,
    original_values: null,
    metadata: {},
  };
  const options: PositionAngleOptions = {
    policy,
    required: instrument.position_angle.required,
    ...(policy === "user_selected" && inputDeg !== null ? { plan_position_angle_deg: inputDeg } : {}),
  };
  return resolveFootprintForTile(tile, null, registry, options).resolved_position_angle_deg;
}

function normalizeManifest(value: unknown, registry: ProfileRegistry): JasytataProjectManifest {
  assertJsonValue(value, "Project manifest");
  const root = record(value, "Project manifest");
  rejectUnknownFields(root, ["format", "schema_version", "app_version", "project", ...PROFILE_DEPENDENCY_KEYS], "Project manifest");
  if (root.format !== JASYTATA_PROJECT_FORMAT) throw new Error(`Unsupported project format "${String(root.format)}"; expected "${JASYTATA_PROJECT_FORMAT}".`);
  if (!Number.isInteger(root.schema_version) || typeof root.schema_version !== "number") {
    throw new Error("Project schema_version must be an integer.");
  }
  if (root.schema_version > JASYTATA_PROJECT_SCHEMA_VERSION) {
    throw new Error(`Project schema version ${root.schema_version} is newer than this app supports (version ${JASYTATA_PROJECT_SCHEMA_VERSION}). Update Jasytata to import it.`);
  }
  if (root.schema_version !== JASYTATA_PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema version ${root.schema_version}; supported version is ${JASYTATA_PROJECT_SCHEMA_VERSION}.`);
  }
  const appVersion = requiredString(root.app_version, "Project app_version");
  const sourceProject = record(root.project, "Project manifest project");
  rejectUnknownFields(sourceProject, [
    "instrument", "observing_strategy", "planning_mode", "region", "placement", "canonical_basis_deg",
    "position_angle", "coverage_strategy", "sequence_coverage_basis", "catalogue_dependencies",
  ], "Project manifest project");

  if (!Array.isArray(sourceProject.catalogue_dependencies)) {
    throw new Error("Project catalogue_dependencies must be an array.");
  }
  const catalogueDependencies = sourceProject.catalogue_dependencies.map(normalizeCatalogueDependency);
  const preparedProfiles = prepareProfileDependencies(root.profile_dependencies, registry);
  const instrumentReference = record(sourceProject.instrument, "Instrument reference");
  rejectUnknownFields(instrumentReference, ["id"], "Instrument reference");
  const instrumentId = requiredString(instrumentReference.id, "Instrument reference ID");
  let instrument: AnyInstrumentProfile;
  try {
    instrument = preparedProfiles.registry.resolveAnyInstrumentProfile(instrumentId);
  } catch {
    throw new Error(`Unknown instrument "${instrumentId}". Import or register that exact instrument profile before importing this project.`);
  }

  let strategyId: string | null = null;
  let strategy: AnySurveyProfile | null = null;
  if (sourceProject.observing_strategy !== null) {
    const strategyReference = record(sourceProject.observing_strategy, "Observing-strategy reference");
    rejectUnknownFields(strategyReference, ["id"], "Observing-strategy reference");
    strategyId = requiredString(strategyReference.id, "Observing-strategy reference ID");
    try {
      strategy = preparedProfiles.registry.resolveAnySurveyProfile(strategyId);
    } catch {
      throw new Error(`Unknown observing strategy "${strategyId}". Import or register that exact strategy profile before importing this project.`);
    }
    if (strategy.instrument_id !== instrumentId) {
      throw new Error(`Observing strategy "${strategyId}" is incompatible with instrument "${instrumentId}"; the registered strategy requires "${strategy.instrument_id}".`);
    }
  }

  const planningMode = sourceProject.planning_mode;
  if (planningMode !== "manual_pointings" && planningMode !== "regional_mosaic") {
    throw new Error(`Unsupported project mode "${String(planningMode)}"; supported modes are manual_pointings and regional_mosaic.`);
  }
  if (planningMode === "regional_mosaic" && (instrument.schema_version !== 3 ||
      (instrument.footprint_semantics.role !== "observed_area" && instrument.footprint_semantics.role !== "nominal_envelope"))) {
    throw new Error(`Unsupported project mode regional_mosaic for instrument "${instrumentId}"; choose an area-plannable Schema v3 instrument.`);
  }

  const region = normalizeRegion(sourceProject.region);
  let placement: ProjectPlacementPolicy | null = null;
  if (sourceProject.placement !== null) {
    try {
      placement = normalizeProjectPlacementPolicy(sourceProject.placement);
    } catch (caught) {
      throw new Error(`Invalid project placement/basis: ${caught instanceof Error ? caught.message : "review its basis, rotation, origin, and provenance."}`);
    }
  }
  const canonicalBasis = normalizeBasis(sourceProject.canonical_basis_deg);
  const positionAngle = normalizePositionAngle(sourceProject.position_angle, instrument);
  const coverageStrategy = normalizeCoverageStrategy(sourceProject.coverage_strategy);
  const sequenceBasis = normalizeSequenceBasis(sourceProject.sequence_coverage_basis);
  if (sequenceBasis !== null && (!strategy || strategy.schema_version !== 3 || !strategy.observing_sequence)) {
    throw new Error("Sequence coverage basis requires a selected registered strategy with an observing sequence.");
  }
  const profileDependencies = preparedProfiles.normalizedDocuments;
  const catalogueInstrumentIds = new Set(catalogueDependencies.flatMap(({ instrument_profile_id }) => instrument_profile_id ? [instrument_profile_id] : []));
  for (const instrumentId of catalogueInstrumentIds) {
    try {
      preparedProfiles.registry.resolveAnyInstrumentProfile(instrumentId);
    } catch {
      throw new Error(`Unknown catalogue instrument "${instrumentId}". Include or register that exact source instrument profile before importing this project.`);
    }
  }

  for (const dependency of profileDependencies) {
    if ("instrument" in dependency && dependency.instrument && dependency.instrument.id !== instrumentId &&
        !catalogueInstrumentIds.has(dependency.instrument.id)) {
      throw new Error(`Project contains an unused embedded instrument profile dependency "${dependency.instrument.id}".`);
    }
    const requiredV2Pair = "instrument" in dependency && dependency.instrument?.schema_version === 2 &&
      "survey" in dependency && dependency.survey?.schema_version === 2;
    if ("survey" in dependency && dependency.survey && dependency.survey.id !== strategyId && !requiredV2Pair) {
      throw new Error(`Project contains an unused embedded observing-strategy dependency "${dependency.survey.id}".`);
    }
  }

  if (placement?.type === "lattice_project_placement") {
    if (instrument.schema_version !== 3) {
      throw new Error("Unsupported project mode: lattice placement requires a registered Schema v3 instrument.");
    }
    if (!region) throw new Error("Invalid project placement: a lattice placement requires a selected region.");
    if (!canonicalBasis) throw new Error("Missing required field canonical_basis_deg for lattice project placement.");
    let resolved;
    try {
      const effectivePa = placement.rotation.mode === "follow_instrument_pa"
        ? currentInstrumentPositionAngle(instrument, positionAngle, preparedProfiles.registry)
        : undefined;
      resolved = resolveProjectPlacement(placement, region, effectivePa);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "placement could not be resolved.";
      if (/PA|position angle|follow_instrument_pa/i.test(message)) throw new Error(`Invalid PA for project placement: ${message}`);
      throw new Error(`Invalid project placement/basis: ${message}`);
    }
    if (resolved.type !== "resolved_lattice_project_placement" || stableJson(resolved.basis_deg) !== stableJson(canonicalBasis)) {
      throw new Error("Invalid project placement basis: canonical_basis_deg does not match the declared authoring, rotation, PA, and origin inputs.");
    }
  } else if (canonicalBasis !== null) {
    throw new Error("Invalid project placement: canonical_basis_deg requires a lattice placement.");
  }

  return {
    format: JASYTATA_PROJECT_FORMAT,
    schema_version: JASYTATA_PROJECT_SCHEMA_VERSION,
    app_version: appVersion,
    project: {
      instrument: { id: instrumentId },
      observing_strategy: strategyId === null ? null : { id: strategyId },
      planning_mode: planningMode,
      region,
      placement,
      canonical_basis_deg: canonicalBasis,
      position_angle: positionAngle,
      coverage_strategy: coverageStrategy,
      sequence_coverage_basis: sequenceBasis,
      catalogue_dependencies: catalogueDependencies,
    },
    profile_dependencies: profileDependencies,
  };
}

/** Build and validate a manifest from canonical project inputs and registered profiles.
 *
 * Coordinates, PA, basis and catalogue science values are in degrees or canonical
 * normalized records. No preview, mask, plan, coverage, Worker, or map state is read.
 *
 * @param input - Project-owned inputs, external catalogue descriptors and custom-profile documents.
 * @param registry - Current registry used to resolve exact instrument and strategy references.
 * @returns Strictly validated manifest with canonical region and placement values.
 * @throws If a profile reference, project input, PA, region, placement, or dependency is invalid.
 */
export function createProjectManifest(
  input: CreateProjectManifestInput,
  registry: ProfileRegistry = profileRegistry,
): JasytataProjectManifest {
  const instrument = registry.resolveAnyInstrumentProfile(input.instrumentId);
  const angleInput = input.positionAngleInputDeg;
  const positionAngle = instrument.schema_version === 3
    ? {
      policy: instrument.position_angle.mode,
      required: instrument.position_angle.required,
      input_deg: angleInput,
    }
    : null;
  const profileDependencies = collectProjectProfileDependencies(
    input.instrumentId,
    input.observingStrategyId,
    input.importedProfileDocuments,
    input.catalogueDependencies.flatMap(({ instrument_profile_id }) => instrument_profile_id ? [instrument_profile_id] : []),
    registry,
  );
  let canonicalBasis: [TangentPlaneOffset, TangentPlaneOffset] | null = null;
  if (input.placement?.type === "lattice_project_placement") {
    if (!input.region) throw new Error("A lattice project placement requires a selected region.");
    if (instrument.schema_version !== 3) throw new Error("A lattice project placement requires a registered Schema v3 instrument.");
    const normalizedPlacement = normalizeProjectPlacementPolicy(input.placement) as LatticeProjectPlacement;
    const tempRegistry = prepareProfileDependencies(profileDependencies, registry).registry;
    const effectivePa = normalizedPlacement.rotation.mode === "follow_instrument_pa"
      ? currentInstrumentPositionAngle(instrument, positionAngle, tempRegistry)
      : undefined;
    const resolved = resolveProjectPlacement(normalizedPlacement, input.region, effectivePa);
    if (resolved.type !== "resolved_lattice_project_placement") throw new Error("Lattice project placement did not resolve to a canonical basis.");
    canonicalBasis = resolved.basis_deg;
  }
  const raw: JasytataProjectManifest = {
    format: JASYTATA_PROJECT_FORMAT,
    schema_version: JASYTATA_PROJECT_SCHEMA_VERSION,
    app_version: packageMetadata.version,
    project: {
      instrument: { id: input.instrumentId },
      observing_strategy: input.observingStrategyId === null ? null : { id: input.observingStrategyId },
      planning_mode: input.planningMode,
      region: input.region,
      placement: input.placement,
      canonical_basis_deg: canonicalBasis,
      position_angle: positionAngle,
      coverage_strategy: input.coverageStrategy,
      sequence_coverage_basis: input.sequenceCoverageBasis,
      catalogue_dependencies: [...input.catalogueDependencies],
    },
    profile_dependencies: profileDependencies,
  };
  return normalizeManifest(raw, registry);
}

/** Parse and fully validate a project manifest before App state can be changed.
 *
 * @param text - UTF-8 project JSON file contents.
 * @param registry - Current profile registry, extended only in a temporary validation copy.
 * @returns Normalized manifest with exact profile references and canonical scientific inputs.
 * @throws With an actionable error for malformed JSON, schema, references, or science inputs.
 */
export function parseProjectManifest(
  text: string,
  registry: ProfileRegistry = profileRegistry,
): JasytataProjectManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Malformed project JSON. Check the file syntax and try importing it again.");
  }
  return normalizeManifest(value, registry);
}

/** Canonically serialize a validated manifest with stable object-key order and readable JSON.
 *
 * @param manifest - Versioned manifest produced by `createProjectManifest` or `parseProjectManifest`.
 * @param registry - Registry used to revalidate profile references before serialization.
 * @returns Pretty-printed deterministic JSON with a final newline.
 * @throws If the supplied manifest is not valid for this registry.
 */
export function serializeProjectManifest(
  manifest: JasytataProjectManifest,
  registry: ProfileRegistry = profileRegistry,
): string {
  return `${JSON.stringify(stableValue(normalizeManifest(manifest, registry)), null, 2)}\n`;
}

/** Select only imported profile definitions required by the exact project references.
 *
 * Built-in profiles remain ID references. Schema v3 custom instrument and strategy
 * definitions are embedded separately; legacy v2 profiles retain their required pair.
 *
 * @param instrumentId - Exact active instrument profile ID.
 * @param strategyId - Exact selected strategy ID, or null for standalone mode.
 * @param documents - Existing UI registry of user-imported profile documents.
 * @param catalogueInstrumentIds - Source-instrument references that affect external catalogue planning input.
 * @param registry - Registry used to distinguish bundled references from custom dependencies.
 * @returns Deduplicated, sorted custom profile documents required by the project.
 * @throws If a non-bundled project or source instrument/strategy lacks its imported definition.
 */
export function collectProjectProfileDependencies(
  instrumentId: string,
  strategyId: string | null,
  documents: ReadonlyMap<string, AnyProfileDocument> = new Map(),
  catalogueInstrumentIds: readonly string[] = [],
  registry: ProfileRegistry = profileRegistry,
): AnyProfileDocument[] {
  const result = new Map<string, AnyProfileDocument>();
  const add = (document: AnyProfileDocument | undefined, kind: "instrument" | "strategy", id: string) => {
    if (!document) return;
    const normalized = validateProfileDocument(document);
    if (kind === "instrument" && "instrument" in normalized && normalized.instrument?.id === id) {
      const selected = normalized.instrument.schema_version === 2
        ? normalized
        : { instrument: normalized.instrument };
      result.set(serializeProfile(selected), selected);
    }
    if (kind === "strategy" && "survey" in normalized && normalized.survey?.id === id) {
      const selected = normalized.survey.schema_version === 2
        ? normalized
        : { survey: normalized.survey };
      result.set(serializeProfile(selected), selected);
    }
  };
  const instrumentIds = [...new Set([instrumentId, ...catalogueInstrumentIds])];
  instrumentIds.forEach((id) => add(documents.get(`instrument:${id}`), "instrument", id));
  if (strategyId) add(documents.get(`survey:${strategyId}`), "strategy", strategyId);
  const normalizedDocuments = [...result.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, document]) => document);
  for (const id of instrumentIds) {
    if (BUNDLED_INSTRUMENT_IDS.has(id) || normalizedDocuments.some((document) => "instrument" in document && document.instrument?.id === id)) continue;
    try {
      registry.resolveAnyInstrumentProfile(id);
    } catch {
      throw new Error(`Unknown project or catalogue instrument "${id}".`);
    }
    throw new Error(`Custom instrument "${id}" has no imported profile document to embed. Re-import its exact profile file before exporting this project.`);
  }
  if (strategyId && !BUNDLED_STRATEGY_IDS.has(strategyId) &&
      !normalizedDocuments.some((document) => "survey" in document && document.survey?.id === strategyId)) {
    try {
      registry.resolveAnySurveyProfile(strategyId);
    } catch {
      throw new Error(`Unknown observing strategy "${strategyId}".`);
    }
    throw new Error(`Custom observing strategy "${strategyId}" has no imported profile document to embed. Re-import its exact profile file before exporting this project.`);
  }
  return normalizedDocuments;
}

/** Register already validated custom profile dependencies after a full import succeeds.
 *
 * All validation and compatibility checks run against an isolated registry copy first.
 * The returned documents can be added to the App's imported-profile index. Built-ins and
 * matching definitions already present in the registry are left untouched.
 *
 * @param manifest - Fully validated manifest.
 * @param registry - Session profile registry to extend after project validation.
 * @returns Validated dependency documents installed or already present in the registry.
 * @throws If any dependency conflicts or cannot resolve its registered references.
 */
export function installProjectProfileDependencies(
  manifest: JasytataProjectManifest,
  registry: ProfileRegistry = profileRegistry,
): AnyProfileDocument[] {
  const plan = prepareProfileDependencies(manifest.profile_dependencies, registry);
  for (const profile of plan.instrumentsToRegister) registerInstrument(registry, profile);
  for (const profile of plan.strategiesToRegister) registerStrategy(registry, profile);
  return plan.normalizedDocuments;
}

function normalizedCatalogueScience(dataset: CatalogueDataset): unknown {
  const groupLabels = new Map<string, number>();
  let nextGroupLabel = 0;
  return {
    format: CATALOGUE_DIGEST_FORMAT,
    ra_column: dataset.ra_column,
    dec_column: dataset.dec_column,
    instrument_profile_id: dataset.instrument_profile_id,
    inference_role: dataset.inference_role,
    rows: dataset.tiles.map((tile) => {
      const sourceGroup = tile.group_id?.startsWith(`${dataset.id}:`)
        ? tile.group_id.slice(dataset.id.length + 1)
        : tile.group_id || dataset.id;
      let groupId = groupLabels.get(sourceGroup);
      if (groupId === undefined) {
        groupId = nextGroupLabel;
        nextGroupLabel += 1;
        groupLabels.set(sourceGroup, groupId);
      }
      return {
        ra_deg: tile.ra_deg,
        dec_deg: tile.dec_deg,
        position_angle_deg: tile.position_angle_deg ?? null,
        output_position_angle_deg: tile.output_position_angle_deg ?? null,
        source: tile.source,
        enabled: tile.enabled !== false,
        generation_method: tile.generation_method,
        instrument_profile_id: tile.instrument_profile_id ?? dataset.instrument_profile_id,
        output_strategy_id: tile.output_strategy_id ?? null,
        inference_role: tile.inference_role ?? dataset.inference_role,
        group_id: groupId,
      };
    }),
  };
}

async function sha256(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot calculate the SHA-256 catalogue fingerprint required by project manifests.");
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Describe loaded catalogues as external reproducibility dependencies.
 *
 * The digest covers canonical parsed coordinates, PA/provenance, profile assignment,
 * inference role, enabled state and row grouping in source order. Random session IDs,
 * map styling, raw CSV strings and display visibility are excluded.
 *
 * @param datasets - Loaded catalogue layers used as planner inputs.
 * @returns Ordered external dependencies with SHA-256 fingerprints; no rows or paths are embedded.
 * @throws If normalized rows are non-finite or Web Crypto is unavailable.
 */
export async function describeProjectCatalogueDependencies(
  datasets: readonly CatalogueDataset[],
): Promise<ProjectCatalogueDependency[]> {
  return Promise.all(datasets.map(async (dataset) => ({
    source_name: dataset.filename.split(/[\\/]/).at(-1) || "catalogue.csv",
    row_count: dataset.tiles.length,
    ra_column: dataset.ra_column,
    dec_column: dataset.dec_column,
    instrument_profile_id: dataset.instrument_profile_id,
    inference_role: dataset.inference_role,
    sha256: await sha256(normalizedCatalogueScience(dataset)),
  })));
}

function catalogueDependencyMatches(
  expected: ProjectCatalogueDependency,
  actual: ProjectCatalogueDependency,
): boolean {
  return expected.source_name === actual.source_name &&
    expected.row_count === actual.row_count &&
    expected.ra_column === actual.ra_column &&
    expected.dec_column === actual.dec_column &&
    expected.instrument_profile_id === actual.instrument_profile_id &&
    expected.inference_role === actual.inference_role &&
    expected.sha256 === actual.sha256;
}

/** Match manifest catalogue references to supplied normalized catalogue layers.
 *
 * Matching is exact and one-to-one. A file name alone never resolves an external dependency.
 *
 * @param dependencies - Manifest catalogue dependencies in their authored order.
 * @param datasets - Current session catalogues to compare.
 * @returns Exact matching dataset IDs and whether every dependency is available.
 * @throws If SHA-256 cannot be computed in the current browser.
 */
export async function matchProjectCatalogueDependencies(
  dependencies: readonly ProjectCatalogueDependency[],
  datasets: readonly CatalogueDataset[],
): Promise<ProjectCatalogueMatch> {
  if (!dependencies.length) return { complete: true, matchedDatasetIds: [], missingCount: 0 };
  const actual = await Promise.all(datasets.map(async (dataset) => ({
    id: dataset.id,
    dependency: (await describeProjectCatalogueDependencies([dataset]))[0],
  })));
  const used = new Set<number>();
  const matchedDatasetIds: string[] = [];
  for (const expected of dependencies) {
    const matchIndex = actual.findIndex((candidate, index) => !used.has(index) &&
      catalogueDependencyMatches(expected, candidate.dependency));
    if (matchIndex < 0) continue;
    used.add(matchIndex);
    matchedDatasetIds.push(actual[matchIndex].id);
  }
  return {
    complete: matchedDatasetIds.length === dependencies.length,
    matchedDatasetIds,
    missingCount: dependencies.length - matchedDatasetIds.length,
  };
}
