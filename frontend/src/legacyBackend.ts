import type { PlanMetrics, RegionPlanResponse, SkyPolygon, TileRecord, TilingProfile } from "./types";

/** Temporary FastAPI bridge for the two numerical operations awaiting parity. */
async function checked<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((item: { loc?: string[]; msg?: string }) => `${item.loc?.at(-1) ?? "Profile"}: ${item.msg ?? "invalid value"}`).join("; ")
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

/** Plan a selected region against original and already accepted proposed tiles.
 *
 * @param polygon - Ordered ICRS vertices in decimal degrees.
 * @param existingTiles - Original catalogue plus accepted proposals.
 * @param profileId - Active observing profile identifier.
 * @param profile - Inline canonical profile for session-only custom geometry.
 * @returns Auditable solution with selected centers, anchors, diagnostics, and metrics.
 */
export async function planRegion(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  profileId?: string,
  profile?: TilingProfile,
): Promise<RegionPlanResponse> {
  // TODO(backendless): port the numerical planner after fixture parity is established.
  return checked(
    await fetch("/api/plan/region", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRegionPlanRequest(polygon, existingTiles, profileId, profile)),
    }),
  );
}

/** Build the exact JSON-serializable scientific input sent to region planning.
 *
 * @param polygon - Ordered ICRS vertices in decimal degrees.
 * @param existingTiles - Actual loaded centers plus enabled accepted proposals.
 * @param profileId - Active footprint profile identifier.
 * @param profile - Inline canonical profile for custom geometry.
 * @returns Request payload shared by the API call and development diagnostics.
 */
export function buildRegionPlanRequest(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  profileId?: string,
  profile?: TilingProfile,
) {
  return { polygon, existing_tiles: existingTiles, profile_id: profileId, ...(profile ? { profile } : {}) };
}

/** Recompute polygon coverage after manual proposal toggles.
 *
 * @param polygon - Ordered selected ICRS sky vertices.
 * @param existingTiles - Every loaded immutable catalogue pointing, regardless of visibility.
 * @param proposedTiles - Full proposal; only enabled centers contribute.
 * @param profileId - Active profile identifier.
 * @param profile - Inline canonical profile for custom geometry.
 * @returns Updated sampled coverage metrics without replacement proposals.
 */
export async function measureCoverage(
  polygon: SkyPolygon,
  existingTiles: TileRecord[],
  proposedTiles: TileRecord[],
  profileId?: string,
  profile?: TilingProfile,
): Promise<PlanMetrics> {
  // TODO(backendless): port sampled coverage and geometric intersection logic.
  return checked(await fetch("/api/coverage/region", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ polygon, existing_tiles: existingTiles, proposed_tiles: proposedTiles, profile_id: profileId, ...(profile ? { profile } : {}) }),
  }));
}
