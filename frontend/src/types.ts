/** Origin of a proposed tile center. */
export type GenerationMethod = "manual" | "imported_centers" | "region_legacy" | "region_extended" | "region_lattice";
/** Distinguishes immutable source rows from session proposal rows. */
export type TileSource = "original" | "proposed";
/** Planning policy applied to sampled-region tile selection. */
export type CoverageStrategy = "complete" | "efficient";
/** Whether a catalogue dataset may provide local-grid inference evidence. */
export type InferenceRole = "auto" | "include" | "exclude";

/** Scientific origin declared for one pointing center. */
export type PlacementOrigin =
  | "manual"
  | "imported_unverified"
  | "authoritative_import"
  | "declared_profile_lattice"
  | "local_inference";

/** Per-pointing placement provenance; authoritative imports require a source reference. */
export interface PlacementProvenance {
  origin: PlacementOrigin;
  source_reference?: ProfileReferenceV3;
}

/** Runtime policy controlling how a pointing obtains its astronomical PA. */
export type PositionAnglePolicy = "fixed" | "user_selected" | "per_pointing" | "not_applicable";

/** Caller-owned orientation inputs; deliberately excluded from persisted profile schemas. */
export interface PositionAngleOptions {
  /** Policy governing profile, row, and plan-level PA precedence. */
  policy: PositionAnglePolicy;
  /** Require a selected PA for optional per-pointing and user-selected policies. */
  required?: boolean;
  /** User-selected PA supplied by the active plan, in degrees east of north. */
  plan_position_angle_deg?: number;
}

/** Effective geometry and the scientifically declared resolved PA, when meaningful. */
export interface ResolvedFootprintOrientation {
  /** Immutable footprint copy with the policy-resolved absolute PA applied. */
  footprint: Footprint;
  /** Declared PA in degrees east of north; absent when no physical PA is declared. */
  resolved_position_angle_deg?: number;
}

/** Catalogue tile in client state, with original string values retained for inspection. */
export interface TileRecord {
  id: string;
  name: string;
  /** Canonical right ascension in ICRS decimal degrees, normalized to [0, 360). */
  ra_deg: number;
  /** Canonical declination in ICRS decimal degrees, in [-90, 90]. */
  dec_deg: number;
  /** Declared camera PA in astronomical degrees east of north.
   * Absent when no orientation is declared; never inferred from lattice rotation. */
  position_angle_deg?: number;
  /** Explicit center-origin declaration; absent legacy rows remain unclassified. */
  placement_provenance?: PlacementProvenance;
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
  /** Historical source grouping used only by legacy S-PLUS inference, never generic export. */
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
  /** Registry instrument geometry for this dataset; null while explicit assignment is required. */
  instrument_profile_id: string | null;
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

/** Placement of a local lattice; fixed anchors are canonical ICRS degrees. */
export type LatticeOrigin =
  | { type: "region_center" }
  | { type: "fixed_anchor"; ra_deg: number; dec_deg: number };

/** Authoritative east/north pointing spacing, independent of footprint PA. */
export interface GenericLatticeTiling {
  type: "lattice";
  basis_deg: [TangentPlaneOffset, TangentPlaneOffset];
  origin: LatticeOrigin;
}

/** Compatibility generation, a declared local lattice, or manual coverage only. */
export type TilingModel =
  | { type: "legacy_splus"; grid_extent_deg: [width_deg: number, height_deg: number]; effective_overlap_arcsec: number }
  | GenericLatticeTiling
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

/** Runtime alignment in one RA-wrap-safe east/north plane; never persisted into a profile. */
export interface LatticeAlignment {
  /** ICRS reference whose cosine scale is retained during inference and generation. */
  projection_origin: CenterInput;
  /** East/north displacement of lattice site (0,0) from the projection reference, in degrees. */
  phase_offset_deg: TangentPlaneOffset;
}

/** Integer assignment with a Euclidean tangent-plane residual, including rejected outliers. */
export interface LatticeAssignment {
  tile_id: string;
  i: number;
  j: number;
  residual_deg: number;
  /** Residual divided by min(norm(b1), norm(b2)). */
  residual_fraction: number;
  inlier: boolean;
}

/** Successful alignment to the profile basis, rotated only when explicitly allowed. */
export interface LatticeInferenceResult extends LatticeAlignment {
  status: "success";
  group_key: string;
  considered_tile_count: number;
  basis_deg: GenericLatticeTiling["basis_deg"];
  /** Astronomical clockwise rotation: positive maps north toward east. */
  rotation_deg: number;
  anchor_ra_deg: number;
  anchor_dec_deg: number;
  /** Modular coefficients in [0,1); exactly [0,0] for a fixed anchor. */
  phase_fraction: TangentPlaneOffset;
  assignments: LatticeAssignment[];
  inlier_count: number;
  rms_residual_fraction: number;
  compatible_pair_count: number;
  /** Unique inlier pair correspondences supporting the reported orientation. */
  rotation_support_pairs: number;
  characteristic_scale_deg: number;
}

/** Explicit generic inference outcome; legacy inference keeps its separate contract. */
export type LatticeInferenceOutcome = LatticeInferenceResult | {
  status: "disabled" | "manual_tiling" | "legacy_strategy" | "no_usable_centers" |
    "insufficient_anchors" | "insufficient_pairs" | "inconsistent_fixed_anchor" | "no_alignment";
  considered_tile_count: number;
  group_key?: string;
};

/** Numerical sampling and optional efficient-stopping policy. */
export interface CoveragePolicy {
  sampling: {
    /** Positive integer density along the intrinsic smaller footprint extent. */
    target_samples_per_footprint_axis: number;
    /** Positive integer cap on the actual full rectangular grid, including zero-weight cells. */
    max_samples: number;
  };
  efficient?: {
    /** Current sampled coverage floor in [0,1]; Complete ignores this policy. */
    min_coverage: number;
    /** Strict stopping floor in [0,1] for new sampled physical area / footprint area. */
    min_marginal_efficiency: number;
  };
}

/** Unrounded generic sampling resolution; all lengths are local-plane degrees. */
export interface CoverageSamplingMetadata {
  characteristic_scale_deg: number;
  natural_step_deg: number;
  /** Requested maximum cell pitch after coarsening; full bounds are subdivided evenly. */
  effective_step_deg: number;
  /** Actual principal grid length, including cells excluded by the polygon mask. */
  sample_count: number;
  max_samples: number;
  budget_limited: boolean;
  /** Actual east/north cell widths at the bounding-box midpoint declination. */
  cell_width_deg: number;
  cell_height_deg: number;
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
  /** Optional labels for generated observer identifiers, independent of runtime IDs and source metadata. */
  identifiers?: {
    id_column?: string;
    name_column?: string;
    group_column?: string;
  };
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

/** Canonical scientific reference used by a v3 profile. Exactly one locator is set. */
export interface ProfileReferenceV3 {
  url?: string;
  doi?: string;
  title?: string;
  locator?: string;
}

/** Source association for one persisted physical or strategy geometry parameter. */
export interface ParameterSourceV3 {
  parameter_path: string;
  reference_url?: string;
  reference_doi?: string;
  note?: string;
}

/** Small durable evidence set for a version 3 profile. */
export interface ProfileProvenanceV3 {
  references: ProfileReferenceV3[];
  parameter_sources: ParameterSourceV3[];
  assumptions: string[];
  limitations: string[];
}

/** Declared semantics of an instrument mode's modeled footprint. */
export interface FootprintSemanticsV3 {
  role: "observed_area" | "nominal_envelope" | "target_access";
  fidelity: "exact" | "approximate";
  approximation_notice?: string;
}

/** Persisted instrument orientation policy; profile angle stays on its footprint. */
export interface PersistedPositionAnglePolicyV3 {
  mode: PositionAnglePolicy;
  required: boolean;
}

/** Ordered local sky offset and relative rotation in a persisted v3 strategy sequence. */
export interface ExposureOffsetV3 {
  order: number;
  east_arcsec: number;
  north_arcsec: number;
  rotation_deg?: number;
}

/** Stable identity and deterministic exposure order for a persisted strategy. */
export interface ObservingSequenceV3 {
  id: string;
  exposures: ExposureOffsetV3[];
}

/** Explicit v0.4 instrument profile with footprint semantics and evidence. */
export interface InstrumentProfileV3 {
  schema_version: 3;
  id: string;
  display_name: string;
  description?: string | null;
  coordinate_frame: "icrs";
  footprint: Footprint;
  footprint_semantics: FootprintSemanticsV3;
  provenance: ProfileProvenanceV3;
  position_angle: PersistedPositionAnglePolicyV3;
}

/** Explicit v0.4 observing strategy retaining the established policies plus sequence semantics. */
export interface SurveyProfileV3 {
  schema_version: 3;
  id: string;
  display_name: string;
  description?: string | null;
  instrument_id: string;
  tiling: TilingModel;
  inference: InferencePolicy;
  coverage: CoveragePolicy & { target_samples_per_footprint_axis: number };
  coverage_basis_default: "single_exposure" | "effective_sequence";
  observing_sequence?: ObservingSequenceV3;
  export: ExportPolicy;
  provenance: ProfileProvenanceV3;
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
  /** Gate 6A audit data; absent on the frozen legacy sampling path. */
  sampling?: CoverageSamplingMetadata;
}

/** Nearby candidates and matched catalogue centers supporting a fitted grid. */
export interface InferenceDiagnostics {
  nearby_tile_count: number;
  anchor_tile_ids: string[];
  compatible_neighbor_pairs: number;
  dec_spacing_deg: number | null;
  ra_spacing_deg: number | null;
  /** Gate 5 runtime outcome for generic surveys only. */
  lattice?: LatticeInferenceOutcome;
}

/** Auditable preview response from existing-grid inference, compatibility fallback, or a declared lattice. */
export interface RegionPlanResponse {
  coverage_strategy: CoverageStrategy;
  solution: "extended_existing_grid" | "profile_fallback" | "declared_lattice";
  generation_method: "region_legacy" | "region_extended" | "region_lattice";
  tiles: TileRecord[];
  candidate_centers: CenterInput[];
  inference: InferenceDiagnostics;
  diagnostics: string[];
  metrics: PlanMetrics;
}

/** Coordinate representation accepted by the generic CSV exporter. */
export type CoordinateFormat = "decimal" | "sexagesimal";
