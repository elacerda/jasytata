import type {
  Footprint,
  LatticeProjectPlacement,
  ResolvedLatticeProjectPlacement,
  SkyPolygon,
} from "../types";
import { generateLatticeCandidates, type LatticeCandidate } from "./lattice";
import { resolveProjectPlacement } from "./project-placement";
import { withFootprintPositionAngle } from "../profiles/footprints";

/** Default safety budget for candidate lattice sites shown in the project preview. */
export const PROJECT_LATTICE_PREVIEW_CANDIDATE_BUDGET = 1200;

/** Convert a project spacing or basis component into canonical degrees.
 * @param value - Finite angular magnitude in the selected unit.
 * @param unit - Explicit display unit; the returned basis component is degrees.
 * @returns The same angular value in degrees.
 * @throws If the unit or numeric value is invalid.
 */
export function projectAngularToDegrees(value: number, unit: "deg" | "arcmin" | "arcsec"): number {
  if (!Number.isFinite(value)) throw new Error("Project lattice dimensions must be finite numbers.");
  const factor = unit === "deg" ? 1 : unit === "arcmin" ? 1 / 60 : unit === "arcsec" ? 1 / 3600 : null;
  if (factor === null) throw new Error("Project lattice units must be deg, arcmin, or arcsec.");
  return value * factor;
}

/** Canonical project-lattice preview, separate from plan/proposal pointings. */
export interface ProjectLatticePreviewResult {
  placement: ResolvedLatticeProjectPlacement;
  candidates: LatticeCandidate[];
}

/** Resolve the Gate 1 project policy and enumerate its admissible candidate sites.
 *
 * The placement basis and origin are resolved by the Gate 1 resolver. Candidate
 * identities and ordering come from the existing j-then-i lattice enumerator.
 * The full candidate set is returned; callers may simplify its visual rendering
 * but must not use it as a generated observation plan.
 *
 * @param region - Selected canonical ICRS polygon in decimal degrees.
 * @param policy - Explicit project-owned lattice policy; never an instrument profile field.
 * @param footprint - Physical instrument footprint in its local east/north frame.
 * @param resolvedInstrumentPA - Effective camera/instrument PA in degrees east of north.
 *   It is applied to the footprint geometry and is read as lattice rotation only for the
 *   explicit `follow_instrument_pa` project policy.
 * @param maxCandidates - Maximum finite lattice search range accepted by the generator.
 * @returns Resolved canonical project placement and all admissible `(i,j)` sky centers.
 * @throws If placement, PA, footprint geometry, candidate budget, or projection is invalid,
 *   or if the valid placement has no admissible candidate sites in the selected region.
 */
export function previewProjectLattice(
  region: SkyPolygon,
  policy: LatticeProjectPlacement,
  footprint: Footprint,
  resolvedInstrumentPA?: number,
  maxCandidates = PROJECT_LATTICE_PREVIEW_CANDIDATE_BUDGET,
): ProjectLatticePreviewResult {
  const placement = resolveProjectPlacement(policy, region, resolvedInstrumentPA);
  if (placement.type !== "resolved_lattice_project_placement") {
    throw new Error("Project lattice preview requires a lattice placement policy.");
  }
  const candidates = generateLatticeCandidates(region, {
    type: "lattice",
    basis_deg: placement.basis_deg,
    origin: placement.origin,
  }, resolvedInstrumentPA === undefined ? footprint : withFootprintPositionAngle(footprint, resolvedInstrumentPA), maxCandidates);
  if (candidates.length === 0) {
    throw new Error("This placement has no admissible candidate sites in the selected region. Adjust the basis or origin and preview again.");
  }
  return { placement, candidates };
}
