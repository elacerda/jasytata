import type { CatalogueDataset, CatalogueResponse } from "./types";

const BASE_HUES = [188, 270, 115, 325, 215, 70, 155, 295];

/** Assign a stable, distinguishable layer color by insertion order.
 *
 * @param index - Zero-based dataset position in the session.
 * @returns CSS HSL color. Additional layers continue around the hue wheel.
 */
export function datasetColor(index: number): string {
  const hue = index < BASE_HUES.length
    ? BASE_HUES[index]
    : (BASE_HUES[index % BASE_HUES.length] + 23 * Math.floor(index / BASE_HUES.length)) % 360;
  return `hsl(${hue} 72% 43%)`;
}

/** Attach a stable layer identity to every imported pointing.
 *
 * @param result - Catalogue parsed in the browser.
 * @param index - Zero-based insertion order for deterministic color selection.
 * @param id - Stable session identifier for this upload.
 * @returns Independent dataset with source origins and collision-free row IDs.
 */
export function createDataset(result: CatalogueResponse, index: number, id: string): CatalogueDataset {
  return {
    id,
    filename: result.filename,
    color: datasetColor(index),
    ra_column: result.ra_column ?? "RA",
    dec_column: result.dec_column ?? "DEC",
    visible: true,
    tiles: result.tiles.map((tile) => ({
      ...tile,
      id: `${id}:${tile.id}`,
      dataset_id: id,
      dataset_name: result.filename,
      group_id: `${id}:${tile.group_id ?? "catalogue"}`,
    })),
  };
}
