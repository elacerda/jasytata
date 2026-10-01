import type {
  LatticeOrigin,
  ProjectLatticeAuthoring,
  ProjectPlacementPolicy,
  ResolvedProjectPlacement,
  SkyPolygon,
  TangentPlaneOffset,
} from "../types";
import { validateFixedLatticeAnchor, validateLatticeBasis } from "./lattice-validation";
import { latticePlanningOrigin } from "./lattice";
import { rotateLocalOffset } from "./footprint-engine";
import { validatePolygon } from "./geometry";
import { modulo } from "./math";

type RecordValue = Record<string, unknown>;
type Basis = [TangentPlaneOffset, TangentPlaneOffset];

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function rejectUnknownFields(value: RecordValue, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${name} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function positive(value: unknown, name: string): number {
  const result = finite(value, name);
  if (result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

function validateRegion(value: unknown): asserts value is SkyPolygon {
  const region = record(value, "Selected region");
  if (!Array.isArray(region.vertices)) throw new Error("Selected region must contain polygon vertices");
  if (!region.vertices.every(isRecord)) throw new Error("Selected region vertices must be coordinate objects");
  validatePolygon(region as unknown as SkyPolygon);
}

function validateOrigin(value: unknown): LatticeOrigin {
  const origin = record(value, "Project lattice origin");
  if (origin.type === "region_center") {
    rejectUnknownFields(origin, ["type"], "Region-center project origin");
    return { type: "region_center" };
  }
  if (origin.type === "fixed_anchor") {
    rejectUnknownFields(origin, ["type", "ra_deg", "dec_deg"], "Fixed-anchor project origin");
    const ra_deg = finite(origin.ra_deg, "Lattice anchor RA");
    const dec_deg = finite(origin.dec_deg, "Lattice anchor DEC");
    validateFixedLatticeAnchor(ra_deg, dec_deg);
    return { type: "fixed_anchor", ra_deg, dec_deg };
  }
  throw new Error("Invalid project lattice origin type");
}

function validateAuthoring(value: unknown): ProjectLatticeAuthoring {
  const authoring = record(value, "Project lattice authoring");
  switch (authoring.preset) {
    case "rectangular": {
      rejectUnknownFields(authoring, ["preset", "east_spacing_deg", "north_spacing_deg"], "Rectangular lattice authoring");
      return {
        preset: "rectangular",
        east_spacing_deg: positive(authoring.east_spacing_deg, "East spacing"),
        north_spacing_deg: positive(authoring.north_spacing_deg, "North spacing"),
      };
    }
    case "triangular": {
      rejectUnknownFields(authoring, ["preset", "pitch_deg"], "Triangular lattice authoring");
      return { preset: "triangular", pitch_deg: positive(authoring.pitch_deg, "Triangular pitch") };
    }
    case "advanced_basis": {
      rejectUnknownFields(authoring, ["preset", "basis_deg"], "Advanced lattice authoring");
      validateLatticeBasis(authoring.basis_deg);
      const basis = authoring.basis_deg as Basis;
      return { preset: "advanced_basis", basis_deg: [[...basis[0]], [...basis[1]]] };
    }
    default:
      throw new Error("Project lattice preset must be rectangular, triangular, or advanced_basis");
  }
}

function validateRotation(value: unknown): RecordValue {
  const rotation = record(value, "Project lattice rotation");
  if (rotation.mode === "independent") {
    rejectUnknownFields(rotation, ["mode", "rotation_deg"], "Independent lattice rotation");
    return rotation;
  }
  if (rotation.mode === "follow_instrument_pa") {
    rejectUnknownFields(rotation, ["mode"], "Follow-instrument-PA lattice rotation");
    return rotation;
  }
  throw new Error("Project lattice rotation mode must be independent or follow_instrument_pa");
}

function basisForAuthoring(authoring: ProjectLatticeAuthoring): Basis {
  switch (authoring.preset) {
    case "rectangular":
      return [[authoring.east_spacing_deg, 0], [0, authoring.north_spacing_deg]];
    case "triangular":
      return [[authoring.pitch_deg, 0], [authoring.pitch_deg / 2, Math.sqrt(3) * authoring.pitch_deg / 2]];
    case "advanced_basis":
      return [[...authoring.basis_deg[0]], [...authoring.basis_deg[1]]];
    default:
      throw new Error("Unsupported project lattice preset");
  }
}

function rotatedBasis(basis: Basis, rotationDeg: number): Basis {
  return [rotateLocalOffset(basis[0], rotationDeg), rotateLocalOffset(basis[1], rotationDeg)];
}

function validatePolicy(value: unknown): ProjectPlacementPolicy {
  const policy = record(value, "Project placement policy");
  if (policy.type === "manual_project_placement") {
    rejectUnknownFields(policy, ["type", "provenance"], "Manual project placement");
    if (policy.provenance !== "user_declared") throw new Error("Project placement provenance must be user_declared");
    return { type: "manual_project_placement", provenance: "user_declared" };
  }
  if (policy.type === "lattice_project_placement") {
    rejectUnknownFields(policy, ["type", "provenance", "authoring", "rotation", "origin"], "Lattice project placement");
    if (policy.provenance !== "user_declared") throw new Error("Project placement provenance must be user_declared");
    const rotation = validateRotation(policy.rotation);
    return {
      type: "lattice_project_placement",
      provenance: "user_declared",
      authoring: validateAuthoring(policy.authoring),
      rotation: rotation.mode === "independent"
        ? { mode: "independent", rotation_deg: finite(rotation.rotation_deg, "Lattice rotation") }
        : { mode: "follow_instrument_pa" },
      origin: validateOrigin(policy.origin),
    };
  }
  throw new Error("Project placement type must be manual_project_placement or lattice_project_placement");
}

/** Resolve project placement authoring into serializable canonical sky geometry.
 *
 * Rectangular, triangular, and advanced authoring all resolve to the existing
 * two-vector east/north basis. Rotation uses the astronomical PA convention in
 * `rotateLocalOffset`: zero is north and positive angles move north toward east.
 * Instrument PA is read only for the explicit `follow_instrument_pa` mode.
 *
 * `region_center` resolves to the midpoint of the selected polygon's canonical
 * unwrapped RA and DEC bounds. No centroid fitting or phase optimization occurs.
 *
 * @param policy - Project-owned placement policy with `user_declared` provenance.
 * @param region - Valid selected ICRS polygon; vertices use decimal-degree RA/DEC.
 * @param resolvedInstrumentPA - Active instrument/project PA in degrees east of
 *   north, required only when the policy explicitly follows it.
 * @returns Plain project-placement state with canonical basis and resolved ICRS origin.
 * @throws If policy, region, basis, anchor, spacing, rotation, or required PA is invalid.
 */
export function resolveProjectPlacement(
  policy: ProjectPlacementPolicy,
  region: SkyPolygon,
  resolvedInstrumentPA?: number,
): ResolvedProjectPlacement {
  const cleanPolicy = validatePolicy(policy);
  validateRegion(region);
  if (cleanPolicy.type === "manual_project_placement") {
    return { type: "resolved_manual_project_placement", provenance: "user_declared" };
  }

  let rotationDeg: number;
  if (cleanPolicy.rotation.mode === "independent") {
    rotationDeg = cleanPolicy.rotation.rotation_deg;
  } else {
    if (resolvedInstrumentPA === undefined) throw new Error("follow_instrument_pa requires a resolved instrument/project PA");
    rotationDeg = finite(resolvedInstrumentPA, "Resolved instrument/project PA");
  }
  const normalizedRotation = modulo(rotationDeg, 360);
  const basis = rotatedBasis(basisForAuthoring(cleanPolicy.authoring), normalizedRotation);
  validateLatticeBasis(basis);

  const resolvedOrigin = latticePlanningOrigin(region, { type: "lattice", basis_deg: basis, origin: cleanPolicy.origin });
  return {
    type: "resolved_lattice_project_placement",
    provenance: "user_declared",
    basis_deg: basis,
    origin: cleanPolicy.origin.type === "region_center"
      ? { type: "region_center" }
      : { type: "fixed_anchor", ra_deg: cleanPolicy.origin.ra_deg, dec_deg: cleanPolicy.origin.dec_deg },
    resolved_origin: { ra_deg: resolvedOrigin.ra_deg, dec_deg: resolvedOrigin.dec_deg },
    rotation_mode: cleanPolicy.rotation.mode,
    lattice_rotation_deg: normalizedRotation,
  };
}
