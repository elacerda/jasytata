import type { Footprint } from "../types";

/** Format an ICRS or local tangent-plane angle in degrees for a readout. */
export function formatDegrees(value: number): string {
  return `${value.toFixed(3).replace(/\.?0+$/, "")}°`;
}

/**
 * Describe Schema v2 footprint geometry for profile readouts.
 *
 * @param footprint - Validated rectangle, circle, polygon, or compound geometry.
 * @param includeOrientation - Include the effective position angle for geometries
 *   that support it. Circles have no orientation field and never display one.
 * @returns A concise, unit-bearing description suitable for browser summaries.
 */
export function footprintSummary(footprint: Footprint, includeOrientation = false): string {
  switch (footprint.type) {
    case "rectangle": {
      const summary = `Rectangle ${formatDegrees(footprint.width_deg)} × ${formatDegrees(footprint.height_deg)}`;
      return includeOrientation ? `${summary} · PA ${formatDegrees(footprint.position_angle_deg ?? 0)}` : summary;
    }
    case "circle":
      return `Circle · radius ${formatDegrees(footprint.radius_deg)}`;
    case "polygon": {
      const summary = `Polygon · ${footprint.vertices_deg.length} vertices`;
      return includeOrientation ? `${summary} · PA ${formatDegrees(footprint.position_angle_deg ?? 0)}` : summary;
    }
    case "compound": {
      const summary = `Mosaic · ${footprint.components.length} components`;
      return includeOrientation ? `${summary} · PA ${formatDegrees(footprint.position_angle_deg ?? 0)}` : summary;
    }
  }
}
