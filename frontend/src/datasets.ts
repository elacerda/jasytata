import type { CatalogueDataset, CatalogueResponse } from "./types";
import { profileRegistry } from "./profiles";
import { T80_SOUTH_INSTRUMENT_V2 } from "./profiles/v2";

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

/** Attach a stable layer identity and instrument association to every imported dataset.
 *
 * @param result - Catalogue parsed in the browser.
 * @param index - Zero-based insertion order for deterministic color selection.
 * @param id - Stable session identifier for this upload.
 * @param instrumentProfileId - Optional explicit instrument override. The bundled
 *   reference association wins only when no override is supplied; otherwise the
 *   only currently bundled instrument, T80-South, is the import default.
 * @returns Independent dataset with source origins and collision-free row IDs.
 * @throws If the selected instrument profile is not registered.
 */
export function createDataset(result: CatalogueResponse, index: number, id: string, instrumentProfileId?: string): CatalogueDataset {
  const associatedInstrumentId = instrumentProfileId ?? result.instrument_profile_id ?? T80_SOUTH_INSTRUMENT_V2.id;
  profileRegistry.resolveInstrumentProfile(associatedInstrumentId);
  return {
    id,
    filename: result.filename,
    color: datasetColor(index),
    ra_column: result.ra_column ?? "RA",
    dec_column: result.dec_column ?? "DEC",
    instrument_profile_id: associatedInstrumentId,
    inference_role: "auto",
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
