import type { PlacementProvenance } from "../types";
import { validateProfileReferenceV3 } from "./schema-v3";

const PLACEMENT_ORIGINS = new Set<PlacementProvenance["origin"]>([
  "manual",
  "imported_unverified",
  "authoritative_import",
  "declared_profile_lattice",
  "local_inference",
]);

/** Validate a declared per-pointing placement origin without inferring legacy values.
 *
 * The authoritative import origin requires a named scientific source reference.
 * Other origins reject a reference because it would imply authority semantics
 * that their contract does not define. No `GenerationMethod`, `InferenceRole`,
 * filename or geometric regularity is used to infer an origin.
 *
 * @param value - Untrusted per-pointing placement provenance.
 * @returns An independently copied, validated provenance record.
 * @throws If fields are unknown, the origin is unsupported, or reference use is inconsistent.
 */
export function validatePlacementProvenance(value: unknown): PlacementProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Placement provenance must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "origin" && key !== "source_reference");
  if (unknown.length) throw new Error(`Placement provenance contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  if (typeof record.origin !== "string" || !PLACEMENT_ORIGINS.has(record.origin as PlacementProvenance["origin"])) {
    throw new Error(`Unsupported placement origin: ${String(record.origin)}`);
  }
  if (record.origin === "authoritative_import") {
    if (record.source_reference === undefined) throw new Error("authoritative_import placement requires source_reference");
    return {
      origin: "authoritative_import",
      source_reference: validateProfileReferenceV3(record.source_reference),
    };
  }
  if (record.source_reference !== undefined) {
    throw new Error(`${record.origin} placement must not declare source_reference`);
  }
  return { origin: record.origin as PlacementProvenance["origin"] };
}

/** Return no v3 origin for a v2 pointing, preserving legacy uncertainty.
 *
 * V2 contains no authoritative origin field. Callers must keep such records
 * unclassified until a user supplies an explicit v3 declaration.
 *
 * @param _legacyPointing - A v2 pointing value, accepted for an explicit migration call.
 * @returns `undefined`, indicating that origin must remain unclassified.
 */
export function placementProvenanceFromV2(_legacyPointing: unknown): undefined {
  void _legacyPointing;
  return undefined;
}
