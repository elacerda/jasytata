import type {
  ExposureOffsetV3,
  Footprint,
  InstrumentProfileV3,
  ParameterSourceV3,
  PersistedPositionAnglePolicyV3,
  ProfileProvenanceV3,
  ProfileReferenceV3,
  SurveyProfileV3,
} from "../types";
import { ProfileError, profileValidation } from "./errors";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";

type RecordValue = Record<string, unknown>;

function record(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as RecordValue;
}

function strict(value: RecordValue, allowed: readonly string[], name: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${name} contains unsupported field${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`);
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function identity(value: RecordValue): { id: string; display_name: string; description?: string | null } {
  if (value.schema_version !== 3) throw new ProfileError("unsupported_schema", `Unsupported schema_version: ${String(value.schema_version)}; expected 3`);
  const id = nonEmpty(value.id, "Profile id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Invalid profile identifier");
  const display_name = nonEmpty(value.display_name, "Profile display name");
  let description: string | null | undefined;
  if (value.description !== undefined) {
    if (value.description !== null && typeof value.description !== "string") throw new Error("Profile description must be a string or null");
    description = value.description;
  }
  return { id, display_name, ...(description !== undefined ? { description } : {}) };
}

/** Validate one canonical v3 scientific reference without changing the input.
 * @param value - Untrusted URL-or-DOI reference object.
 * @returns A fresh, validated reference.
 * @throws If the object has unknown fields, malformed locators, or zero/two primary locators.
 */
export function validateProfileReferenceV3(value: unknown): ProfileReferenceV3 {
  const item = record(value, "Profile reference");
  strict(item, ["url", "doi", "title", "locator"], "Profile reference");
  const hasUrl = item.url !== undefined;
  const hasDoi = item.doi !== undefined;
  if (hasUrl === hasDoi) throw new Error("Profile reference must contain exactly one of url or doi");
  const result: ProfileReferenceV3 = {};
  if (hasUrl) {
    const urlText = nonEmpty(item.url, "Reference URL");
    let url: URL;
    try { url = new URL(urlText); } catch { throw new Error("Reference URL must be an absolute HTTP or HTTPS URL"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Reference URL must use HTTP or HTTPS");
    result.url = url.href;
  } else {
    const doi = nonEmpty(item.doi, "Reference DOI");
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error("Reference DOI must use the form 10.xxxx/suffix");
    result.doi = doi.toLowerCase();
  }
  if (item.title !== undefined) result.title = nonEmpty(item.title, "Reference title");
  if (item.locator !== undefined) result.locator = nonEmpty(item.locator, "Reference locator");
  return result;
}

function canonicalReferenceKey(reference: ProfileReferenceV3): string {
  if (reference.doi !== undefined) return `doi:${reference.doi.toLowerCase()}`;
  return `url:${new URL(reference.url!).href}`;
}

function validateProvenance(value: unknown, requiredPaths: readonly string[], name: string): ProfileProvenanceV3 {
  const provenance = record(value, `${name} provenance`);
  strict(provenance, ["references", "parameter_sources", "assumptions", "limitations"], `${name} provenance`);
  if (!Array.isArray(provenance.references) || provenance.references.length === 0) {
    throw new Error(`${name} provenance requires at least one primary reference`);
  }
  const references = provenance.references.map(validateProfileReferenceV3)
    .sort((left, right) => compareText(canonicalReferenceKey(left), canonicalReferenceKey(right)));
  const referenceKeys = references.map(canonicalReferenceKey);
  if (new Set(referenceKeys).size !== referenceKeys.length) throw new Error(`${name} provenance references must be unique`);
  if (!Array.isArray(provenance.parameter_sources)) throw new Error(`${name} parameter_sources must be an array`);
  const parameter_sources: ParameterSourceV3[] = provenance.parameter_sources.map((entry, index) => {
    const source = record(entry, `${name} parameter source ${index + 1}`);
    strict(source, ["parameter_path", "reference_url", "reference_doi", "note"], `${name} parameter source ${index + 1}`);
    const parameter_path = nonEmpty(source.parameter_path, "Parameter source path");
    const hasUrl = source.reference_url !== undefined;
    const hasDoi = source.reference_doi !== undefined;
    if (hasUrl === hasDoi) throw new Error(`Parameter source '${parameter_path}' must contain exactly one reference_url or reference_doi`);
    const reference: ProfileReferenceV3 = hasUrl
      ? validateProfileReferenceV3({ url: source.reference_url })
      : validateProfileReferenceV3({ doi: source.reference_doi });
    if (!referenceKeys.includes(canonicalReferenceKey(reference))) {
      throw new Error(`Parameter source '${parameter_path}' does not resolve to a listed primary reference`);
    }
    return {
      parameter_path,
      ...(hasUrl ? { reference_url: reference.url } : { reference_doi: reference.doi }),
      ...(source.note !== undefined ? { note: nonEmpty(source.note, "Parameter source note") } : {}),
    };
  }).sort((left, right) => compareText(left.parameter_path, right.parameter_path));
  const paths = parameter_sources.map((source) => source.parameter_path);
  if (new Set(paths).size !== paths.length) throw new Error(`${name} parameter source paths must be unique`);
  const allowed = new Set(requiredPaths);
  for (const path of paths) if (!allowed.has(path)) throw new Error(`Unknown ${name} geometry parameter path '${path}'`);
  for (const path of requiredPaths) if (!paths.includes(path)) throw new Error(`${name} provenance is missing a source for '${path}'`);
  const assumptions = validateStringList(provenance.assumptions, `${name} assumptions`);
  const limitations = validateStringList(provenance.limitations, `${name} limitations`);
  return { references, parameter_sources, assumptions, limitations };
}

function validateStringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => nonEmpty(item, `${name} item ${index + 1}`));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function geometryPaths(footprint: Footprint, path = "footprint"): string[] {
  const paths: string[] = [];
  if (footprint.type === "rectangle") {
    paths.push(`${path}.width_deg`, `${path}.height_deg`);
    if (footprint.position_angle_deg !== undefined) paths.push(`${path}.position_angle_deg`);
  } else if (footprint.type === "circle") {
    paths.push(`${path}.radius_deg`);
  } else if (footprint.type === "polygon") {
    paths.push(`${path}.vertices_deg`);
    if (footprint.position_angle_deg !== undefined) paths.push(`${path}.position_angle_deg`);
  } else {
    if (footprint.position_angle_deg !== undefined) paths.push(`${path}.position_angle_deg`);
    footprint.components.forEach((component, index) => {
      const componentPath = `${path}.components[${index}]`;
      paths.push(`${componentPath}.offset_deg`);
      if (component.rotation_deg !== undefined) paths.push(`${componentPath}.rotation_deg`);
      paths.push(...geometryPaths(component.footprint, `${componentPath}.footprint`));
    });
  }
  return paths;
}

function validateFootprintSemantics(value: unknown): InstrumentProfileV3["footprint_semantics"] {
  const semantics = record(value, "Footprint semantics");
  strict(semantics, ["role", "fidelity", "approximation_notice"], "Footprint semantics");
  if (!["observed_area", "nominal_envelope", "target_access"].includes(String(semantics.role))) throw new Error("Invalid footprint role");
  if (semantics.fidelity !== "exact" && semantics.fidelity !== "approximate") throw new Error("Invalid footprint fidelity");
  const noticeRequired = semantics.fidelity === "approximate" || semantics.role !== "observed_area";
  const approximation_notice = semantics.approximation_notice === undefined
    ? undefined
    : nonEmpty(semantics.approximation_notice, "Approximation notice");
  if (noticeRequired && approximation_notice === undefined) throw new Error("Approximate, envelope, and access footprints require an approximation_notice");
  return {
    role: semantics.role as InstrumentProfileV3["footprint_semantics"]["role"],
    fidelity: semantics.fidelity,
    ...(approximation_notice !== undefined ? { approximation_notice } : {}),
  };
}

function validatePositionAnglePolicy(
  value: unknown,
  footprint: Footprint,
  semantics: InstrumentProfileV3["footprint_semantics"],
): PersistedPositionAnglePolicyV3 {
  const policy = record(value, "Position-angle policy");
  strict(policy, ["mode", "required"], "Position-angle policy");
  if (!["fixed", "user_selected", "per_pointing", "not_applicable"].includes(String(policy.mode))) throw new Error("Invalid position-angle mode");
  if (typeof policy.required !== "boolean") throw new Error("Position-angle required must be a boolean");
  const mode = policy.mode as PersistedPositionAnglePolicyV3["mode"];
  const profilePA = footprint.type === "circle" ? undefined : footprint.position_angle_deg;
  if (mode === "fixed" && (profilePA === undefined || policy.required !== true)) {
    throw new Error("Fixed position-angle policy requires a finite profile PA and required=true");
  }
  if (mode === "not_applicable" && (profilePA !== undefined || policy.required)) {
    throw new Error("not_applicable position-angle policy forbids profile PA and required=true");
  }
  if (mode === "not_applicable" && footprint.type !== "circle" && semantics.fidelity !== "approximate") {
    throw new Error("not_applicable requires rotationally invariant geometry or an approximate representation that omits orientation");
  }
  return { mode, required: policy.required };
}

/** Validate and copy an explicit Schema v3 instrument profile.
 * @param profile - Untrusted JSON-compatible instrument profile.
 * @returns Normalized instrument geometry with explicit fidelity, role, evidence, and PA policy.
 * @throws ProfileError when the object, scientific geometry, references, or semantics are invalid.
 */
export function validateInstrumentProfileV3(profile: unknown): InstrumentProfileV3 {
  return profileValidation("invalid_structure", () => {
    const value = record(profile, "Instrument profile");
    const id = identity(value);
    strict(value, ["schema_version", "id", "display_name", "description", "coordinate_frame", "footprint", "footprint_semantics", "provenance", "position_angle"], "Instrument profile v3");
    const cleanInstrument = validateInstrumentProfileV2({
      schema_version: 2,
      id: id.id,
      display_name: id.display_name,
      ...(id.description !== undefined ? { description: id.description } : {}),
      coordinate_frame: value.coordinate_frame,
      footprint: value.footprint,
    });
    const footprint_semantics = validateFootprintSemantics(value.footprint_semantics);
    const rawProvenance = record(value.provenance, "Instrument provenance");
    const rawAssumptions = rawProvenance.assumptions;
    const rawLimitations = rawProvenance.limitations;
    if ((footprint_semantics.fidelity === "approximate" || footprint_semantics.role !== "observed_area") &&
        (!Array.isArray(rawAssumptions) || rawAssumptions.length === 0 ||
         !Array.isArray(rawLimitations) || rawLimitations.length === 0)) {
      throw new Error("Approximate, envelope, and access footprints require assumptions and limitations");
    }
    const provenance = validateProvenance(value.provenance, geometryPaths(cleanInstrument.footprint), "Instrument");
    const position_angle = validatePositionAnglePolicy(value.position_angle, cleanInstrument.footprint, footprint_semantics);
    return {
      schema_version: 3,
      ...id,
      coordinate_frame: "icrs",
      footprint: cleanInstrument.footprint,
      footprint_semantics,
      provenance,
      position_angle,
    };
  });
}

function strategyGeometryPaths(profile: Pick<SurveyProfileV3, "tiling" | "observing_sequence">): string[] {
  const paths: string[] = [];
  if (profile.tiling.type === "legacy_splus") {
    paths.push("tiling.grid_extent_deg", "tiling.effective_overlap_arcsec");
  } else if (profile.tiling.type === "lattice") {
    paths.push("tiling.basis_deg", "tiling.origin.type");
    if (profile.tiling.origin.type === "fixed_anchor") paths.push("tiling.origin.ra_deg", "tiling.origin.dec_deg");
  }
  profile.observing_sequence?.exposures.forEach((exposure, index) => {
    paths.push(`observing_sequence.exposures[${index}].east_arcsec`, `observing_sequence.exposures[${index}].north_arcsec`);
    if (exposure.rotation_deg !== undefined) paths.push(`observing_sequence.exposures[${index}].rotation_deg`);
  });
  return paths;
}

function validateObservingSequence(value: unknown): NonNullable<SurveyProfileV3["observing_sequence"]> {
  const sequence = record(value, "Observing sequence");
  strict(sequence, ["id", "exposures"], "Observing sequence");
  const id = nonEmpty(sequence.id, "Observing sequence id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Invalid observing sequence identifier");
  if (!Array.isArray(sequence.exposures) || sequence.exposures.length === 0) throw new Error("Observing sequence must contain at least one exposure");
  const exposures: ExposureOffsetV3[] = sequence.exposures.map((entry, index) => {
    const exposure = record(entry, `Exposure ${index + 1}`);
    strict(exposure, ["order", "east_arcsec", "north_arcsec", "rotation_deg"], `Exposure ${index + 1}`);
    const order = finite(exposure.order, `Exposure ${index + 1} order`);
    if (!Number.isSafeInteger(order) || order !== index + 1) throw new Error("Exposure order must be unique, contiguous, and 1-based");
    const east_arcsec = finite(exposure.east_arcsec, `Exposure ${index + 1} east offset`);
    const north_arcsec = finite(exposure.north_arcsec, `Exposure ${index + 1} north offset`);
    const rotation_deg = exposure.rotation_deg === undefined ? undefined : finite(exposure.rotation_deg, `Exposure ${index + 1} relative rotation`);
    return { order, east_arcsec, north_arcsec, ...(rotation_deg !== undefined ? { rotation_deg } : {}) };
  });
  return { id, exposures };
}

/** Validate and copy an explicit Schema v3 survey/strategy profile.
 * @param profile - Untrusted JSON-compatible survey profile.
 * @returns Normalized strategy with explicit coverage basis and provenance.
 * @throws ProfileError when policy values, sequence, coverage density, or evidence are invalid.
 */
export function validateSurveyProfileV3(profile: unknown): SurveyProfileV3 {
  return profileValidation("invalid_structure", () => {
    const value = record(profile, "Survey profile");
    const id = identity(value);
    strict(value, ["schema_version", "id", "display_name", "description", "instrument_id", "tiling", "inference", "coverage", "coverage_basis_default", "observing_sequence", "export", "provenance"], "Survey profile v3");
    const instrument_id = nonEmpty(value.instrument_id, "Survey instrument_id");
    if (!/^[a-z][a-z0-9-]*$/.test(instrument_id)) throw new Error("Invalid instrument identifier");
    if (value.coverage_basis_default !== "single_exposure" && value.coverage_basis_default !== "effective_sequence") throw new Error("Invalid default coverage basis");
    const observing_sequence = value.observing_sequence === undefined ? undefined : validateObservingSequence(value.observing_sequence);
    if (value.coverage_basis_default === "effective_sequence" && observing_sequence === undefined) {
      throw new Error("effective_sequence coverage basis requires an observing sequence");
    }
    const coverageValue = record(value.coverage, "Coverage policy");
    strict(coverageValue, ["sampling", "efficient", "target_samples_per_footprint_axis"], "Coverage policy v3");
    const targetSamples = finite(coverageValue.target_samples_per_footprint_axis, "V3 target samples per footprint axis");
    if (!Number.isSafeInteger(targetSamples) || targetSamples < 8) throw new Error("V3 target samples per footprint axis must be an integer of at least 8");

    const candidate = validateSurveyProfileV2({
      schema_version: 2,
      id: id.id,
      display_name: id.display_name,
      ...(id.description !== undefined ? { description: id.description } : {}),
      instrument_id,
      tiling: value.tiling,
      inference: value.inference,
      coverage: (() => {
        const v2Coverage = { ...coverageValue };
        delete v2Coverage.target_samples_per_footprint_axis;
        return v2Coverage;
      })(),
      export: value.export,
    });
    if (candidate.coverage.sampling.target_samples_per_footprint_axis !== targetSamples) {
      throw new Error("Top-level and nested target_samples_per_footprint_axis must match");
    }
    const normalizedWithoutProvenance: Omit<SurveyProfileV3, "provenance"> = {
      schema_version: 3,
      ...id,
      instrument_id,
      tiling: candidate.tiling,
      inference: candidate.inference,
      coverage: { ...candidate.coverage, target_samples_per_footprint_axis: targetSamples },
      coverage_basis_default: value.coverage_basis_default as SurveyProfileV3["coverage_basis_default"],
      ...(observing_sequence !== undefined ? { observing_sequence } : {}),
      export: candidate.export,
    };
    // Parameter paths are resolved against the declared strategy geometry only.
    const paths = strategyGeometryPaths(normalizedWithoutProvenance);
    const provenance = validateProvenance(value.provenance, paths, "Survey");
    return { ...normalizedWithoutProvenance, provenance };
  });
}
