import type {
  CompoundFootprint,
  CompoundFootprintComponent,
  CoveragePolicy,
  ExportPolicy,
  Footprint,
  InferencePolicy,
  InstrumentProfileV2,
  NonCompoundFootprint,
  PolygonFootprint,
  SurveyProfileV2,
  TangentPlaneOffset,
  TilingModel,
} from "../types";

const PROFILE_ID = /^[a-z][a-z0-9-]*$/;
const FRACTION_EPSILON = 1e-12;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (!result.trim()) throw new Error(`${name} must be non-empty`);
  return result;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function validateIdentity(value: UnknownRecord, expectedVersion: 2): { id: string; display_name: string; description?: string | null } {
  if (value.schema_version !== expectedVersion) throw new Error(`schema_version must be ${expectedVersion}`);
  const id = requireString(value.id, "Profile id");
  if (!PROFILE_ID.test(id)) throw new Error("Invalid profile identifier");
  const display_name = requireNonEmptyString(value.display_name, "Profile display name");
  let description: string | null | undefined;
  if (value.description !== undefined) {
    if (value.description !== null && typeof value.description !== "string") throw new Error("Profile description must be a string or null");
    description = value.description;
  }
  return { id, display_name, ...(description !== undefined ? { description } : {}) };
}

function validateOptionalAngle(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : requireFiniteNumber(value, name);
}

function validateOffset(value: unknown, name: string): TangentPlaneOffset {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name} must contain east and north offsets`);
  return [requireFiniteNumber(value[0], `${name} east`), requireFiniteNumber(value[1], `${name} north`)];
}

function orientation(a: TangentPlaneOffset, b: TangentPlaneOffset, c: TangentPlaneOffset): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: TangentPlaneOffset, b: TangentPlaneOffset, point: TangentPlaneOffset): boolean {
  return point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1]);
}

function segmentsIntersect(a: TangentPlaneOffset, b: TangentPlaneOffset, c: TangentPlaneOffset, d: TangentPlaneOffset): boolean {
  const abc = orientation(a, b, c);
  const abd = orientation(a, b, d);
  const cda = orientation(c, d, a);
  const cdb = orientation(c, d, b);
  if (((abc > 0 && abd < 0) || (abc < 0 && abd > 0)) && ((cda > 0 && cdb < 0) || (cda < 0 && cdb > 0))) return true;
  return (abc === 0 && onSegment(a, b, c)) || (abd === 0 && onSegment(a, b, d)) ||
    (cda === 0 && onSegment(c, d, a)) || (cdb === 0 && onSegment(c, d, b));
}

function validatePolygon(value: UnknownRecord): PolygonFootprint {
  if (!Array.isArray(value.vertices_deg) || value.vertices_deg.length < 3) throw new Error("Polygon must have at least three vertices");
  const vertices = value.vertices_deg.map((vertex, index) => validateOffset(vertex, `Polygon vertex ${index + 1}`));
  for (let first = 0; first < vertices.length; first += 1) {
    for (let second = first + 1; second < vertices.length; second += 1) {
      if (vertices[first][0] === vertices[second][0] && vertices[first][1] === vertices[second][1]) {
        throw new Error("Polygon vertices must be distinct");
      }
    }
  }
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const next = vertices[(index + 1) % vertices.length];
    twiceArea += vertices[index][0] * next[1] - next[0] * vertices[index][1];
  }
  if (!Number.isFinite(twiceArea) || twiceArea === 0) throw new Error("Polygon must have non-zero finite local area");
  for (let first = 0; first < vertices.length; first += 1) {
    const firstNext = (first + 1) % vertices.length;
    for (let second = first + 1; second < vertices.length; second += 1) {
      const secondNext = (second + 1) % vertices.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(vertices[first], vertices[firstNext], vertices[second], vertices[secondNext])) {
        throw new Error("Polygon edges must not self-intersect");
      }
    }
  }
  const positionAngle = validateOptionalAngle(value.position_angle_deg, "Polygon position angle");
  return { type: "polygon", vertices_deg: vertices, ...(positionAngle !== undefined ? { position_angle_deg: positionAngle } : {}) };
}

function validateNonCompoundFootprint(value: unknown, name: string): NonCompoundFootprint {
  const footprint = requireRecord(value, name);
  switch (footprint.type) {
    case "rectangle": {
      const width = requireFiniteNumber(footprint.width_deg, "Rectangle width");
      const height = requireFiniteNumber(footprint.height_deg, "Rectangle height");
      if (width <= 0 || width > 180) throw new Error("Rectangle width must be greater than 0 and at most 180 degrees");
      if (height <= 0 || height > 180) throw new Error("Rectangle height must be greater than 0 and at most 180 degrees");
      const positionAngle = validateOptionalAngle(footprint.position_angle_deg, "Rectangle position angle");
      return { type: "rectangle", width_deg: width, height_deg: height, ...(positionAngle !== undefined ? { position_angle_deg: positionAngle } : {}) };
    }
    case "circle": {
      const radius = requireFiniteNumber(footprint.radius_deg, "Circle radius");
      if (radius <= 0 || radius > 90) throw new Error("Circle radius must be greater than 0 and at most 90 degrees");
      return { type: "circle", radius_deg: radius };
    }
    case "polygon":
      return validatePolygon(footprint);
    default:
      throw new Error(`Unknown or unsupported footprint type: ${String(footprint.type)}`);
  }
}

function validateCompoundComponent(value: unknown, index: number): CompoundFootprintComponent {
  const component = requireRecord(value, `Compound component ${index + 1}`);
  const offset = validateOffset(component.offset_deg, `Compound component ${index + 1} offset`);
  const rotation = validateOptionalAngle(component.rotation_deg, `Compound component ${index + 1} rotation`);
  return {
    offset_deg: offset,
    ...(rotation !== undefined ? { rotation_deg: rotation } : {}),
    footprint: validateNonCompoundFootprint(component.footprint, `Compound component ${index + 1} footprint`),
  };
}

function validateFootprint(value: unknown): Footprint {
  const footprint = requireRecord(value, "Instrument footprint");
  if (footprint.type !== "compound") return validateNonCompoundFootprint(footprint, "Instrument footprint");
  if (!Array.isArray(footprint.components) || footprint.components.length === 0) throw new Error("Compound footprint must have at least one component");
  const result: CompoundFootprint = { type: "compound", components: footprint.components.map(validateCompoundComponent) };
  return result;
}

/** Validate and copy a version 2 instrument geometry profile.
 *
 * Local footprint offsets and vertices are east/north tangent-plane degrees
 * about an ICRS pointing center. This function performs schema checks only; it
 * does not construct sky masks or apply a footprint to catalogue positions.
 *
 * @param profile - Untrusted JSON-compatible instrument profile value.
 * @returns A normalized, independently allocated version 2 profile.
 * @throws If the profile identity, coordinate frame, or footprint is invalid.
 */
export function validateInstrumentProfileV2(profile: unknown): InstrumentProfileV2 {
  const value = requireRecord(profile, "Instrument profile");
  const identity = validateIdentity(value, 2);
  if (value.coordinate_frame !== "icrs") throw new Error("Instrument coordinate_frame must be icrs");
  return { schema_version: 2, ...identity, coordinate_frame: "icrs", footprint: validateFootprint(value.footprint) };
}

function validateTiling(value: unknown): TilingModel {
  const tiling = requireRecord(value, "Tiling model");
  switch (tiling.type) {
    case "legacy_splus":
      return { type: "legacy_splus" };
    case "manual":
      return { type: "manual" };
    case "lattice": {
      if (!Array.isArray(tiling.basis_deg) || tiling.basis_deg.length !== 2) throw new Error("Lattice requires two basis vectors");
      const first = validateOffset(tiling.basis_deg[0], "First lattice basis vector");
      const second = validateOffset(tiling.basis_deg[1], "Second lattice basis vector");
      const firstLength = Math.hypot(first[0], first[1]);
      const secondLength = Math.hypot(second[0], second[1]);
      if (firstLength === 0 || secondLength === 0) throw new Error("Lattice basis vectors must be non-zero");
      const normalizedDeterminant = (first[0] / firstLength) * (second[1] / secondLength) -
        (first[1] / firstLength) * (second[0] / secondLength);
      if (!Number.isFinite(normalizedDeterminant) || Math.abs(normalizedDeterminant) <= FRACTION_EPSILON) {
        throw new Error("Lattice basis vectors must not be collinear or degenerate");
      }
      const originPolicy = tiling.origin_policy;
      if (originPolicy !== "region_center" && originPolicy !== "region_corner" && originPolicy !== "fixed_phase") {
        throw new Error("Invalid lattice origin policy");
      }
      const positionAngle = validateOptionalAngle(tiling.position_angle_deg, "Lattice position angle");
      return {
        type: "lattice", basis_deg: [first, second], origin_policy: originPolicy,
        ...(positionAngle !== undefined ? { position_angle_deg: positionAngle } : {}),
      };
    }
    default:
      throw new Error(`Unknown tiling model type: ${String(tiling.type)}`);
  }
}

function validateInference(value: unknown): InferencePolicy {
  const policy = requireRecord(value, "Inference policy");
  if (typeof policy.enabled !== "boolean") throw new Error("Inference enabled must be a boolean");
  if (typeof policy.allow_rotation !== "boolean") throw new Error("Inference allow_rotation must be a boolean");
  const spacing = requireFiniteNumber(policy.spacing_tolerance_fraction, "Inference spacing tolerance fraction");
  const phase = requireFiniteNumber(policy.phase_tolerance_fraction, "Inference phase tolerance fraction");
  const occupancy = requireFiniteNumber(policy.occupancy_tolerance_fraction, "Inference occupancy tolerance fraction");
  for (const [name, fraction] of [["spacing", spacing], ["phase", phase], ["occupancy", occupancy]] as const) {
    if (fraction < 0 || fraction > 1) throw new Error(`Inference ${name} tolerance fraction must be in [0, 1]`);
  }
  const anchors = requireFiniteNumber(policy.min_anchor_tiles, "Inference minimum anchor tiles");
  const pairs = requireFiniteNumber(policy.min_neighbor_pairs, "Inference minimum neighbor pairs");
  if (!Number.isSafeInteger(anchors) || anchors < 1) throw new Error("Inference minimum anchor tiles must be a positive integer");
  if (!Number.isSafeInteger(pairs) || pairs < 1) throw new Error("Inference minimum neighbor pairs must be a positive integer");
  return {
    enabled: policy.enabled, spacing_tolerance_fraction: spacing, phase_tolerance_fraction: phase,
    occupancy_tolerance_fraction: occupancy, min_anchor_tiles: anchors, min_neighbor_pairs: pairs,
    allow_rotation: policy.allow_rotation,
  };
}

function validateCoverage(value: unknown): CoveragePolicy {
  const policy = requireRecord(value, "Coverage policy");
  const sampling = requireRecord(policy.sampling, "Coverage sampling policy");
  const targetSamples = requireFiniteNumber(sampling.target_samples_per_footprint_axis, "Target samples per footprint axis");
  const maxSamples = requireFiniteNumber(sampling.max_samples, "Maximum coverage samples");
  if (!Number.isSafeInteger(targetSamples) || targetSamples <= 0) throw new Error("Target samples per footprint axis must be a positive integer");
  if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) throw new Error("Maximum coverage samples must be a positive finite integer");
  let efficient: CoveragePolicy["efficient"];
  if (policy.efficient !== undefined) {
    const efficientValue = requireRecord(policy.efficient, "Efficient coverage policy");
    const minCoverage = requireFiniteNumber(efficientValue.min_coverage, "Efficient minimum coverage");
    const minEfficiency = requireFiniteNumber(efficientValue.min_marginal_efficiency, "Efficient minimum marginal efficiency");
    if (minCoverage < 0 || minCoverage > 1) throw new Error("Efficient minimum coverage must be in [0, 1]");
    if (minEfficiency < 0 || minEfficiency > 1) throw new Error("Efficient minimum marginal efficiency must be in [0, 1]");
    efficient = { min_coverage: minCoverage, min_marginal_efficiency: minEfficiency };
  }
  return { sampling: { target_samples_per_footprint_axis: targetSamples, max_samples: maxSamples }, ...(efficient ? { efficient } : {}) };
}

function validateColumn(value: unknown, name: string): string {
  return requireNonEmptyString(value, name);
}

function validateExport(value: unknown): ExportPolicy {
  const policy = requireRecord(value, "Export policy");
  const ra = validateColumn(policy.ra_column, "RA output column");
  const dec = validateColumn(policy.dec_column, "DEC output column");
  if (ra === dec) throw new Error("Export output column names must be unique");
  if (policy.coordinate_format !== "decimal" && policy.coordinate_format !== "sexagesimal") throw new Error("Invalid export coordinate format");
  const columns = [ra, dec];
  let epoch: ExportPolicy["epoch"];
  if (policy.epoch !== undefined) {
    const epochValue = requireRecord(policy.epoch, "Export epoch policy");
    const column = validateColumn(epochValue.column, "Epoch output column");
    const defaultValue = requireNonEmptyString(epochValue.default, "Default export epoch");
    if (!Array.isArray(epochValue.allowed) || epochValue.allowed.length === 0) throw new Error("Allowed export epochs must be a non-empty array");
    const allowed = epochValue.allowed.map((item, index) => requireNonEmptyString(item, `Allowed export epoch ${index + 1}`));
    if (new Set(allowed).size !== allowed.length) throw new Error("Allowed export epochs must be unique");
    if (!allowed.includes(defaultValue)) throw new Error("Default export epoch must be one of the allowed values");
    columns.push(column);
    epoch = { column, default: defaultValue, allowed };
  }
  let positionAngleColumn: string | undefined;
  if (policy.position_angle_column !== undefined) {
    positionAngleColumn = validateColumn(policy.position_angle_column, "Position angle output column");
    columns.push(positionAngleColumn);
  }
  const constantEntries: Array<[string, string | number | boolean]> = [];
  if (policy.constant_fields !== undefined) {
    const constants = requireRecord(policy.constant_fields, "Export constant fields");
    for (const [column, constant] of Object.entries(constants)) {
      validateColumn(column, "Constant-field output column");
      if (typeof constant !== "string" && typeof constant !== "boolean" && (typeof constant !== "number" || !Number.isFinite(constant))) {
        throw new Error(`Export constant field '${column}' must be a string, finite number, or boolean`);
      }
      columns.push(column);
      constantEntries.push([column, constant]);
    }
  }
  if (new Set(columns).size !== columns.length) throw new Error("Export output column names must be unique");
  const constantFields = Object.fromEntries(constantEntries) as Record<string, string | number | boolean>;
  return {
    ra_column: ra, dec_column: dec, coordinate_format: policy.coordinate_format,
    ...(epoch ? { epoch } : {}),
    ...(positionAngleColumn !== undefined ? { position_angle_column: positionAngleColumn } : {}),
    ...(policy.constant_fields !== undefined ? { constant_fields: constantFields } : {}),
  };
}

/** Validate and copy a version 2 survey policy profile.
 *
 * Policies are declarative schema in this release. They do not alter the v1
 * planner, coverage sampling, or CSV exporter.
 *
 * @param profile - Untrusted JSON-compatible survey profile value.
 * @returns A normalized, independently allocated version 2 profile.
 * @throws If identity, references, tiling, inference, coverage, or export values are invalid.
 */
export function validateSurveyProfileV2(profile: unknown): SurveyProfileV2 {
  const value = requireRecord(profile, "Survey profile");
  const identity = validateIdentity(value, 2);
  const instrumentId = requireString(value.instrument_id, "Survey instrument_id");
  if (!PROFILE_ID.test(instrumentId)) throw new Error("Invalid instrument identifier");
  return {
    schema_version: 2, ...identity, instrument_id: instrumentId,
    tiling: validateTiling(value.tiling), inference: validateInference(value.inference),
    coverage: validateCoverage(value.coverage), export: validateExport(value.export),
  };
}
