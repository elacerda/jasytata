/** Origin of a proposed tile center. */
export type GenerationMethod = "manual" | "imported_centers" | "region_legacy" | "region_extended";
/** Distinguishes immutable source rows from session proposal rows. */
export type TileSource = "original" | "proposed";
/** Planning policy applied to sampled-region tile selection. */
export type CoverageStrategy = "complete" | "efficient";
/** Whether a catalogue dataset may provide local-grid inference evidence. */
export type InferenceRole = "auto" | "include" | "exclude";

/** Catalogue tile in client state, with original string values retained for inspection. */
export interface TileRecord {
  id: string;
  name: string;
  /** Canonical right ascension in ICRS decimal degrees, normalized to [0, 360). */
  ra_deg: number;
  /** Canonical declination in ICRS decimal degrees, in [-90, 90]. */
  dec_deg: number;
  source: TileSource;
  /** Whether this proposed tile participates in the active solution. */
  enabled?: boolean;
  generation_method: GenerationMethod | null;
  dataset_id?: string | null;
  dataset_name?: string | null;
  /** Source instrument profile, copied from its dataset for scientific planning. */
  instrument_profile_id?: string | null;
  /** Dataset inference role, copied onto source tiles for scientific planning. */
  inference_role?: InferenceRole;
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
  /** Instrument profile known for a bundled/reference catalogue, when available. */
  instrument_profile_id?: string;
}

/** One independent uploaded CSV layer retained in the browser session. */
export interface CatalogueDataset {
  id: string;
  filename: string;
  color: string;
  ra_column: string;
  dec_column: string;
  /** Instrument geometry for this dataset; no survey profile is required. */
  instrument_profile_id: string;
  /** Coverage always participates; this role only controls lattice inference. */
  inference_role: InferenceRole;
  tiles: TileRecord[];
  visible: boolean;
}

/** Canonical browser-validated observing geometry, installed or session-only. */
export interface TilingProfile {
  id: string;
  display_name: string;
  description?: string | null;
  tile_width_deg: number;
  tile_height_deg: number;
  effective_overlap_arcsec: number;
  coordinate_frame: string;
  export_epoch_default: string;
  export_epoch_options: string[];
  algorithm: string;
}

/** Two-dimensional local tangent-plane offset in degrees: east, then north. */
export type TangentPlaneOffset = [east_deg: number, north_deg: number];

/** Axis-aligned or rotated rectangular footprint dimensions in degrees. */
export interface RectangleFootprint {
  type: "rectangle";
  width_deg: number;
  height_deg: number;
  position_angle_deg?: number;
}

/** Circular footprint radius in degrees. */
export interface CircleFootprint {
  type: "circle";
  radius_deg: number;
}

/** Simple polygon vertices as east/north offsets from the pointing center. */
export interface PolygonFootprint {
  type: "polygon";
  vertices_deg: TangentPlaneOffset[];
  position_angle_deg?: number;
}

/** Footprint component placed at an east/north offset from the pointing center. */
export interface CompoundFootprintComponent {
  offset_deg: TangentPlaneOffset;
  rotation_deg?: number;
  footprint: NonCompoundFootprint;
}

/** Mosaic union of non-compound child footprints with optional parent rotation. */
export interface CompoundFootprint {
  type: "compound";
  components: CompoundFootprintComponent[];
  /** Parent angle in degrees east of north, applied to offsets and child shapes. */
  position_angle_deg?: number;
}

/** A footprint that cannot contain another compound footprint. */
export type NonCompoundFootprint = RectangleFootprint | CircleFootprint | PolygonFootprint;

/** Supported instrument footprint geometry. */
export type Footprint = NonCompoundFootprint | CompoundFootprint;

/** Versioned geometry and canonical coordinate frame for an instrument. */
export interface InstrumentProfileV2 {
  schema_version: 2;
  id: string;
  display_name: string;
  description?: string | null;
  coordinate_frame: "icrs";
  footprint: Footprint;
}

/** Explicit compatibility or generic local-plane tiling strategy. */
export type TilingModel =
  | { type: "legacy_splus" }
  | {
      type: "lattice";
      basis_deg: [TangentPlaneOffset, TangentPlaneOffset];
      origin_policy: "region_center" | "region_corner" | "fixed_phase";
      position_angle_deg?: number;
    }
  | { type: "manual" };

/** Scale-independent thresholds and minimum evidence for lattice inference. */
export interface InferencePolicy {
  enabled: boolean;
  spacing_tolerance_fraction: number;
  phase_tolerance_fraction: number;
  occupancy_tolerance_fraction: number;
  min_anchor_tiles: number;
  min_neighbor_pairs: number;
  allow_rotation: boolean;
}

/** Numerical sampling and optional efficient-stopping policy. */
export interface CoveragePolicy {
  sampling: {
    target_samples_per_footprint_axis: number;
    max_samples: number;
  };
  efficient?: {
    min_coverage: number;
    min_marginal_efficiency: number;
  };
}

/** Output column layout and optional per-row export values. */
export interface ExportPolicy {
  ra_column: string;
  dec_column: string;
  coordinate_format: CoordinateFormat;
  epoch?: {
    column: string;
    default: string;
    allowed: string[];
  };
  position_angle_column?: string;
  constant_fields?: Record<string, string | number | boolean>;
}

/** Versioned survey tiling, inference, coverage, and export decisions. */
export interface SurveyProfileV2 {
  schema_version: 2;
  id: string;
  display_name: string;
  description?: string | null;
  instrument_id: string;
  tiling: TilingModel;
  inference: InferencePolicy;
  coverage: CoveragePolicy;
  export: ExportPolicy;
}

/** Celestial position used by import and region-planning endpoints. */
export interface CenterInput {
  /** ICRS right ascension in decimal degrees. */
  ra_deg: number;
  /** ICRS declination in decimal degrees. */
  dec_deg: number;
  label?: string | null;
}

/** Ordered ICRS polygon vertices in decimal degrees; the closing vertex is implicit. */
export interface SkyPolygon {
  vertices: CenterInput[];
}

/** Deterministic sampled-coverage measurements independent of inference. */
export interface PlanMetrics {
  existing_tiles_contributing: number;
  new_tiles: number;
  selected_region_area_deg2: number;
  already_covered_fraction: number;
  selected_region_coverage: number;
  incremental_coverage: number;
  remaining_uncovered_fraction: number;
  remaining_uncovered_area_deg2: number;
  redundant_coverage: number;
  outside_region_coverage_deg2: number;
  sample_step_deg: number;
}

/** Nearby candidates and matched catalogue centers supporting a fitted grid. */
export interface InferenceDiagnostics {
  nearby_tile_count: number;
  anchor_tile_ids: string[];
  compatible_neighbor_pairs: number;
  dec_spacing_deg: number | null;
  ra_spacing_deg: number | null;
}

/** Auditable preview response from existing-grid inference or legacy fallback. */
export interface RegionPlanResponse {
  coverage_strategy: CoverageStrategy;
  solution: "extended_existing_grid" | "profile_fallback";
  generation_method: "region_legacy" | "region_extended";
  tiles: TileRecord[];
  candidate_centers: CenterInput[];
  inference: InferenceDiagnostics;
  diagnostics: string[];
  metrics: PlanMetrics;
}

/** Coordinate representation accepted by the generic CSV exporter. */
export type CoordinateFormat = "decimal" | "sexagesimal";
