import type { CompoundFootprint, CoverageMeasurementBasis, Footprint, NonCompoundFootprint, PositionAngleOptions, SkyPolygon, TileRecord, TilingProfile } from "../types";
import { deriveExposurePlacements, type ObservingSequence } from "./exposure-sequence";
import { footprintArea, footprintIntersectsRegion, rotateLocalOffset, skyToLocalOffset } from "./footprint-engine";
import type { CenterInput } from "../types";
import { resolveFootprintForTile, withFootprintPositionAngle } from "../profiles/footprints";
import { profileRegistry, type ProfileRegistry } from "../profiles/registry";

/** Geometry representation selected for one nominal Jasytata pointing. */
export interface PointingGeometry {
  /** Stable derived exposure identity, or the nominal tile identity. */
  id: string;
  /** Stable one-based order; nominal single geometry has order one. */
  order: number;
  /** Sky center as `[RA, DEC]` in ICRS decimal degrees. */
  center: [number, number];
  /** Immutable instrument footprint with its effective absolute PA applied. */
  footprint: Footprint;
  /** Declared absolute astronomical PA, absent for intentionally un-oriented geometry. */
  position_angle_deg?: number;
}

/** Physical exposure derived from one nominal pointing and a registered strategy.
 *
 * Coordinates are ICRS decimal degrees. Exposure offsets remain sky-local east
 * and north arcseconds from the parent nominal center; project-lattice identity
 * records the parent site and does not transform those offsets.
 */
export interface ExpandedPointingExposure {
  /** Stable identity scoped to the parent nominal pointing and sequence element. */
  id: string;
  /** ID of the accepted or selected nominal pointing that owns this exposure. */
  parentNominalPointingId: string;
  /** Project-lattice site identity when the parent came from user placement. */
  parentLatticeSite?: { i: number; j: number };
  /** Registered observing strategy associated with the parent pointing. */
  strategyId: string;
  /** Registered ordered sequence identity. */
  sequenceId: string;
  /** One-based position in the registered exposure sequence. */
  order: number;
  /** East offset from the nominal center, in arcseconds. */
  eastOffsetArcsec: number;
  /** North offset from the nominal center, in arcseconds. */
  northOffsetArcsec: number;
  /** Exposure rotation relative to the nominal resolved PA, in degrees. */
  relativeRotationDeg: number;
  /** Resolved exposure center as `[RA, DEC]` in ICRS decimal degrees. */
  center: [number, number];
  /** Resolved absolute astronomical PA in degrees east of north, when declared. */
  positionAngleDeg?: number;
}

/** Runtime choices for interpreting pointing orientation and optional exposures.
 *
 * The context is intentionally caller-owned and is not part of profile, tile, or
 * catalogue persistence. An omitted context preserves the Schema v2 footprint
 * behavior: tile-level PA is ignored and one footprint remains at the nominal
 * center. Effective-sequence coverage uses a geometric union; it implies no
 * depth or completeness model.
 */
export interface PointingGeometryContext {
  /** Scientific area basis, independent of single versus sequence geometry. */
  measurementBasis?: CoverageMeasurementBasis;
  /** Run-level density for v2 mixed geometry; never persisted into v2 profiles. */
  targetSamplesPerFootprintAxis?: number;
  /** Resolve the PA policy independently for each tile. */
  orientationPolicyForTile?: (tile: TileRecord) => PositionAngleOptions | undefined;
  /** Return the optional ordered exposure sequence for a nominal tile. */
  sequenceForTile?: (tile: TileRecord) => ObservingSequence | undefined;
  /** Whether consumers use the nominal pointing geometry or exposure union. */
  coverageBasis?: "single_exposure" | "effective_sequence";
}

/** Resolve the canonical effective geometry for rendering, coverage, and intersection.
 *
 * Exposure offsets are sky-local east/north arcseconds. Their derived centers do
 * not rotate with PA. Each relative exposure rotation is added to the resolved
 * nominal PA for footprint orientation. In `single_exposure` mode, the center is
 * always the nominal tile center, even if the first sequence exposure is offset.
 *
 * @param tile - Nominal sky pointing and source identity.
 * @param profile - Active survey profile for unassociated rows, or null when the
 *   tile itself identifies its registered instrument.
 * @param registry - Session-local instrument registry.
 * @param context - Optional runtime orientation and sequence policy.
 * @returns One nominal geometry or the ordered exposure geometries.
 * @throws If the selected PA policy or observing sequence is invalid.
 */
export function resolvePointingGeometries(
  tile: TileRecord,
  profile: TilingProfile | null,
  registry: ProfileRegistry = profileRegistry,
  context?: PointingGeometryContext,
): PointingGeometry[] {
  const resolved = resolveFootprintForTile(tile, profile, registry, context?.orientationPolicyForTile?.(tile));
  const basis = context?.coverageBasis ?? "single_exposure";
  if (basis !== "single_exposure" && basis !== "effective_sequence") {
    throw new Error(`Unsupported pointing coverage basis: ${String(basis)}`);
  }
  const nominalGeometry = (): PointingGeometry[] => [{
    id: tile.id,
    order: 1,
    center: [tile.ra_deg, tile.dec_deg],
    footprint: resolved.footprint,
    ...(resolved.resolved_position_angle_deg === undefined ? {} : { position_angle_deg: resolved.resolved_position_angle_deg }),
  }];
  if (basis === "single_exposure") return nominalGeometry();

  const sequence = context?.sequenceForTile?.(tile);
  if (sequence === undefined) return nominalGeometry();

  const exposures = deriveExposurePlacements({
    id: tile.id,
    center: { ra_deg: tile.ra_deg, dec_deg: tile.dec_deg },
    ...(resolved.resolved_position_angle_deg === undefined ? {} : { positionAngleDeg: resolved.resolved_position_angle_deg }),
  }, sequence);
  return exposures.map((exposure) => ({
    id: exposure.id,
    order: exposure.order,
    center: exposure.center,
    footprint: withFootprintPositionAngle(resolved.footprint, exposure.geometryPositionAngleDeg),
    ...(exposure.positionAngleDeg === undefined ? {} : { position_angle_deg: exposure.positionAngleDeg }),
  }));
}

/** Expand one nominal pointing through its associated registered sequence.
 *
 * Expansion always uses the effective sequence geometry while leaving the
 * caller's coverage basis unchanged. The profile sequence supplies ordered
 * offsets; the parent tile supplies its stable identity and optional project
 * lattice site. No project-lattice rotation is applied to sequence offsets.
 *
 * @param tile - Nominal ICRS pointing and provenance.
 * @param profile - Active survey profile, or null when the tile identifies its
 *   registered instrument.
 * @param registry - Session-local validated instrument and strategy registry.
 * @param context - Resolved PA and sequence lookup policy for the tile.
 * @param strategyId - Registered strategy association; defaults to the tile's
 *   `output_strategy_id`.
 * @returns Ordered physical exposures, or an empty array when the tile has no
 *   registered sequence.
 * @throws If an exposure sequence has no strategy association or its resolved
 *   geometry does not match its ordered source elements.
 */
export function expandPointingExposures(
  tile: TileRecord,
  profile: TilingProfile | null,
  registry: ProfileRegistry = profileRegistry,
  context?: PointingGeometryContext,
  strategyId = tile.output_strategy_id ?? undefined,
): ExpandedPointingExposure[] {
  const sequence = context?.sequenceForTile?.(tile);
  if (!sequence) return [];
  if (!strategyId) throw new Error("Expanded exposures require a registered strategy association.");

  const geometries = resolvePointingGeometries(tile, profile, registry, {
    ...context,
    coverageBasis: "effective_sequence",
    sequenceForTile: () => sequence,
  });
  if (geometries.length !== sequence.exposures.length) {
    throw new Error("Resolved exposure geometry does not match the registered sequence length.");
  }
  const site = tile.placement_provenance?.origin === "user_declared"
    ? tile.placement_provenance.project_lattice
    : undefined;
  return sequence.exposures.map((offset, index) => {
    const geometry = geometries[index];
    if (geometry.order !== offset.order) {
      throw new Error("Resolved exposure geometry does not match the registered sequence order.");
    }
    return {
      id: `${tile.id}:${sequence.id}:${offset.order}`,
      parentNominalPointingId: tile.id,
      ...(site ? { parentLatticeSite: { i: site.i, j: site.j } } : {}),
      strategyId,
      sequenceId: sequence.id,
      order: offset.order,
      eastOffsetArcsec: offset.east_arcsec,
      northOffsetArcsec: offset.north_arcsec,
      relativeRotationDeg: offset.rotation_deg ?? 0,
      center: [geometry.center[0], geometry.center[1]],
      ...(geometry.position_angle_deg === undefined ? {} : { positionAngleDeg: geometry.position_angle_deg }),
    };
  });
}

/** Test whether any selected geometry in one nominal pointing intersects a region.
 *
 * The result counts one nominal pointing regardless of how many of its exposures
 * intersect. Each test uses the same effective PA and exposure centers as coverage.
 *
 * @param geometries - Nominal or ordered exposure geometries for one pointing.
 * @param region - Ordered ICRS polygon in decimal degrees.
 * @returns Whether at least one footprint overlaps positive region area.
 */
export function pointingGeometriesIntersectRegion(
  geometries: readonly PointingGeometry[],
  region: SkyPolygon,
): boolean {
  return geometries.some((geometry) => footprintIntersectsRegion(
    geometry.footprint,
    { ra_deg: geometry.center[0], dec_deg: geometry.center[1] } satisfies Pick<CenterInput, "ra_deg" | "dec_deg">,
    region,
  ));
}

/** Measure the physical local-plane area of the geometric union of exposures.
 *
 * Each exposure is translated into the nominal pointing's local east/north plane.
 * Compound instrument footprints are flattened while preserving their parent PA,
 * component rotations, child PA, and offsets. The existing deterministic compound
 * area integrator counts overlapping exposure regions once.
 *
 * @param geometries - Ordered geometries derived from one nominal pointing.
 * @param nominalCenter - Nominal ICRS pointing center in decimal degrees.
 * @returns Physical union area in square degrees.
 * @throws If no geometries are supplied.
 */
export function pointingGeometryUnionArea(
  geometries: readonly PointingGeometry[],
  nominalCenter: Pick<CenterInput, "ra_deg" | "dec_deg">,
): number {
  if (geometries.length === 0) throw new Error("A pointing geometry union requires at least one exposure.");
  if (geometries.length === 1) return footprintArea(geometries[0].footprint);

  const components: CompoundFootprint["components"] = [];
  for (const geometry of geometries) {
    const centerOffset = skyToLocalOffset(
      { ra_deg: geometry.center[0], dec_deg: geometry.center[1] },
      nominalCenter,
    );
    const footprint = geometry.footprint;
    if (footprint.type !== "compound") {
      components.push({ offset_deg: centerOffset, footprint: withoutPositionAngle(footprint) });
      if ("position_angle_deg" in footprint && footprint.position_angle_deg !== undefined) {
        components[components.length - 1].rotation_deg = footprint.position_angle_deg;
      }
      continue;
    }

    const parentAngle = footprint.position_angle_deg ?? 0;
    for (const child of footprint.components) {
      const rotatedOffset = rotateLocalOffset(child.offset_deg, parentAngle);
      components.push({
        offset_deg: [centerOffset[0] + rotatedOffset[0], centerOffset[1] + rotatedOffset[1]],
        rotation_deg: parentAngle + (child.rotation_deg ?? 0),
        footprint: child.footprint,
      });
    }
  }

  const union: CompoundFootprint = { type: "compound", components };
  return footprintArea(union);
}

function withoutPositionAngle(footprint: NonCompoundFootprint): NonCompoundFootprint {
  if (footprint.type === "circle") return footprint;
  const result = { ...footprint };
  delete result.position_angle_deg;
  return result;
}
