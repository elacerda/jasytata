import type {
  FootprintSemanticsV3,
  InstrumentProfileV3,
  ObservingSequenceV3,
  PersistedPositionAnglePolicyV3,
  ProfileProvenanceV3,
  SurveyProfileV3,
} from "../types";
import { validateInstrumentProfileV2, validateSurveyProfileV2 } from "./schema-v2";
import { validateInstrumentProfileV3, validateSurveyProfileV3 } from "./schema-v3";

/** Explicit semantic choices required to lift a v2 instrument into v3. */
export interface InstrumentV3MigrationDecisions {
  footprint_semantics?: FootprintSemanticsV3;
  provenance?: ProfileProvenanceV3;
  position_angle?: PersistedPositionAnglePolicyV3;
}

/** Explicit strategy choices required to lift a v2 survey into v3. */
export interface SurveyV3MigrationDecisions {
  provenance?: ProfileProvenanceV3;
  coverage_basis_default?: SurveyProfileV3["coverage_basis_default"];
  /** Supply `null` to explicitly confirm the strategy has no default sequence. */
  observing_sequence?: ObservingSequenceV3 | null;
}

/** Result of a migration attempt that may need additional scientific decisions. */
export type V3MigrationResult<T> =
  | { status: "incomplete"; missing: string[] }
  | { status: "ready"; profile: T };

/** Lift an instrument's unchanged v2 structure after explicit v3 semantics are supplied.
 *
 * The existing ID, name, coordinate frame and footprint values are copied without
 * scientific transformation. Role, fidelity, provenance and PA policy are never
 * inferred from v2 fields; omitted decisions produce an incomplete result.
 *
 * @param input - Untrusted Schema v2 instrument profile.
 * @param decisions - Explicit classifications and scientific provenance.
 * @returns An incomplete result naming required choices, or a strictly validated v3 profile.
 * @throws If the v2 input or any supplied v3 semantic value is invalid.
 */
export function migrateV2InstrumentToV3(
  input: unknown,
  decisions: InstrumentV3MigrationDecisions = {},
): V3MigrationResult<InstrumentProfileV3> {
  const source = validateInstrumentProfileV2(input);
  const missing = [
    ...(decisions.footprint_semantics === undefined ? ["footprint_semantics (role and fidelity)"] : []),
    ...(decisions.provenance === undefined ? ["provenance"] : []),
    ...(decisions.position_angle === undefined ? ["position_angle policy"] : []),
  ];
  if (missing.length) return { status: "incomplete", missing };

  return {
    status: "ready",
    profile: validateInstrumentProfileV3({
      schema_version: 3,
      id: source.id,
      display_name: source.display_name,
      ...(source.description !== undefined ? { description: source.description } : {}),
      coordinate_frame: source.coordinate_frame,
      footprint: source.footprint,
      footprint_semantics: decisions.footprint_semantics,
      provenance: decisions.provenance,
      position_angle: decisions.position_angle,
    }),
  };
}

/** Lift a survey's unchanged v2 structure after explicit v3 strategy decisions.
 *
 * Existing tiling, inference, coverage, export and identity values are copied
 * unchanged. The existing nested sampling density is also copied to the v3
 * top-level field; the v3 validator checks that both representations agree.
 * Provenance, coverage basis and whether a default sequence exists are not
 * recoverable from v2 and must be supplied explicitly. Pass `null` for
 * `observing_sequence` to affirm that the strategy has no sequence.
 *
 * @param input - Untrusted Schema v2 survey profile.
 * @param decisions - Explicit strategy provenance and sequence semantics.
 * @returns An incomplete result naming required choices, or a strictly validated v3 profile.
 * @throws If the v2 input or any supplied v3 semantic value is invalid.
 */
export function migrateV2SurveyToV3(
  input: unknown,
  decisions: SurveyV3MigrationDecisions = {},
): V3MigrationResult<SurveyProfileV3> {
  const source = validateSurveyProfileV2(input);
  const missing = [
    ...(decisions.provenance === undefined ? ["provenance"] : []),
    ...(decisions.coverage_basis_default === undefined ? ["coverage_basis_default"] : []),
    ...(!Object.hasOwn(decisions, "observing_sequence") ? ["observing_sequence (supply a sequence or null)"] : []),
  ];
  if (missing.length) return { status: "incomplete", missing };

  const coverage = {
    ...source.coverage,
    target_samples_per_footprint_axis: source.coverage.sampling.target_samples_per_footprint_axis,
  };
  const sequence = decisions.observing_sequence;
  return {
    status: "ready",
    profile: validateSurveyProfileV3({
      schema_version: 3,
      id: source.id,
      display_name: source.display_name,
      ...(source.description !== undefined ? { description: source.description } : {}),
      instrument_id: source.instrument_id,
      tiling: source.tiling,
      inference: source.inference,
      coverage,
      export: source.export,
      coverage_basis_default: decisions.coverage_basis_default,
      ...(sequence === null ? {} : { observing_sequence: sequence }),
      provenance: decisions.provenance,
    }),
  };
}
