/** Origin of a proposed tile center. */
export type GenerationMethod = "manual" | "imported_centers" | "region_legacy" | "region_extended";
/** Distinguishes immutable source rows from session proposal rows. */
export type TileSource = "original" | "proposed";

/** Catalogue tile in client state, with original string values retained for export. */
export interface TileRecord {
  id: string;
  pid: string;
  name: string;
  /** Canonical right ascension in ICRS decimal degrees, normalized to [0, 360). */
  ra_deg: number;
  /** Canonical declination in ICRS decimal degrees, in [-90, 90]. */
  dec_deg: number;
  epoch: string;
  status: string;
  source: TileSource;
  generation_method: GenerationMethod | null;
  dataset_id?: string | null;
  dataset_name?: string | null;
  group_id?: string | null;
  ra_column?: string | null;
  dec_column?: string | null;
  /** Every unmodified CSV field for original rows. */
  original_values: Record<string, string> | null;
  metadata: Record<string, string | number | boolean>;
}

/** Parsed original catalogue and its session-local rows. */
export interface CatalogueResponse {
  filename: string;
  row_count: number;
  tiles: TileRecord[];
  warnings: string[];
  columns?: string[];
  ra_column?: string | null;
  dec_column?: string | null;
  needs_mapping?: boolean;
}

/** One independent uploaded CSV layer retained in the browser session. */
export interface CatalogueDataset {
  id: string;
  filename: string;
  color: string;
  ra_column: string;
  dec_column: string;
  tiles: TileRecord[];
  visible: boolean;
}

/** Validated observing geometry supplied by the backend profile registry. */
export interface TilingProfile {
  id: string;
  display_name: string;
  description?: string | null;
  tile_width_deg: number;
  tile_height_deg: number;
  effective_overlap_arcsec: number;
  coordinate_frame: string;
  epoch: string;
  algorithm: string;
}

/** Celestial position used by import and region-planning endpoints. */
export interface CenterInput {
  /** ICRS right ascension in decimal degrees. */
  ra_deg: number;
  /** ICRS declination in decimal degrees. */
  dec_deg: number;
  label?: string | null;
}

/** Small rectangular ICRS bounds with eastward RA traversal across zero. */
export interface RegionBounds {
  ra_start_deg: number;
  ra_end_deg: number;
  dec_min_deg: number;
  dec_max_deg: number;
}

/** Ordered ICRS polygon vertices in decimal degrees; the closing vertex is implicit. */
export interface SkyPolygon {
  vertices: CenterInput[];
}

/** Deterministic sampled-coverage measurements returned by region planning. */
export interface PlanMetrics {
  existing_tiles_contributing: number;
  anchor_tiles_used: number;
  candidates_available: number;
  new_tiles: number;
  selected_region_area_deg2: number;
  selected_region_coverage: number;
  incremental_coverage: number;
  redundant_coverage: number;
  outside_region_coverage_deg2: number;
  sample_step_deg: number;
}

/** Auditable preview response from existing-grid inference or legacy fallback. */
export interface RegionPlanResponse {
  solution: "extended_existing_grid" | "legacy_bounds_fallback";
  generation_method: "region_legacy" | "region_extended";
  tiles: TileRecord[];
  candidate_centers: CenterInput[];
  anchor_tile_ids: string[];
  diagnostics: string[];
  metrics: PlanMetrics;
}

/** Metadata assigned to newly serialized CSV rows. */
export interface ExportConfig {
  pid: string;
  name_prefix: string;
  initial_sequence: number;
  epoch: string;
  status: string;
}
