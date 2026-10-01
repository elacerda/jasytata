import type { AnyInstrumentProfile, AnySurveyProfile } from "./profiles/registry";
import { profileRegistry } from "./profiles";
import { resolveFootprintForTile } from "./profiles/footprints";
import { formatDegrees } from "./profiles/presentation";
import type { PointingGeometryContext } from "./science/pointing-geometry";
import type { CoverageResult, InferenceDiagnostics, PlacementOrigin, ProfileProvenanceV3, ProfileReferenceV3, TileRecord } from "./types";

const origins: Record<PlacementOrigin, string> = {
  manual: "Manual", imported_unverified: "Imported · unverified",
  authoritative_import: "Authoritative import", declared_profile_lattice: "Declared profile lattice",
  local_inference: "Local inference", user_declared: "User-declared project placement",
};

function Reference({ reference }: { reference: ProfileReferenceV3 }) {
  const href = reference.url ?? `https://doi.org/${reference.doi}`;
  const label = reference.title ?? (reference.doi ? `DOI ${reference.doi}` : reference.url);
  // Validated references can use non-web schemes; only web links are navigable here.
  return <>{/^https?:\/\//i.test(href) ? <a href={href}>{label}</a> : <span>{label}</span>}
    {reference.locator && <span> · {reference.locator}</span>}</>;
}

function Evidence({ title, provenance }: { title: string; provenance: ProfileProvenanceV3 }) {
  return <div className="scientific-evidence">
    <h3>{title}</h3>
    {provenance.assumptions.length > 0 && <><h4>Assumptions</h4><ul>{provenance.assumptions.map((text) => <li key={text}>{text}</li>)}</ul></>}
    {provenance.limitations.length > 0 && <><h4>Limitations</h4><ul>{provenance.limitations.map((text) => <li key={text}>{text}</li>)}</ul></>}
    <h4>Primary references</h4>
    <ul>{provenance.references.map((reference, index) => <li key={index}><Reference reference={reference} /></li>)}</ul>
  </div>;
}

/** Inspect durable v3 evidence without expanding the ordinary planning panel.
 * @param props - Active instrument and optional selected real strategy.
 * @returns Native keyboard-operable disclosure; legacy profiles have no inferred evidence.
 */
export function ScientificDetails({ instrument, strategy }: { instrument: AnyInstrumentProfile; strategy: AnySurveyProfile | null }) {
  if (instrument.schema_version !== 3 && strategy?.schema_version !== 3) return null;
  return <details className="scientific-details" key={`${instrument.id}:${strategy?.id ?? ""}`}>
    <summary>Scientific details</summary>
    {instrument.schema_version === 3 && <>
      {instrument.footprint_semantics.approximation_notice && <p>{instrument.footprint_semantics.approximation_notice}</p>}
      <Evidence title={instrument.display_name} provenance={instrument.provenance} />
    </>}
    {strategy?.schema_version === 3 && <Evidence title={strategy.display_name} provenance={strategy.provenance} />}
  </details>;
}

function tileAngle(tile: TileRecord, context: PointingGeometryContext) {
  return resolveFootprintForTile(tile, null, profileRegistry, context.orientationPolicyForTile?.(tile)).resolved_position_angle_deg;
}

/** Show a pointing's resolved physical PA, never a computational default zero.
 * @param props - Instrument-associated nominal tile and frozen runtime PA choices.
 * @returns Unit-bearing sky PA, an explicit unresolved diagnostic, or no PA for N/A.
 */
export function PointingAngle({ tile, context }: { tile: TileRecord; context: PointingGeometryContext }) {
  try {
    const angle = tileAngle(tile, context);
    return angle === undefined ? null : <span>PA {formatDegrees(angle)} east of north</span>;
  } catch {
    return <span role="alert">Pointing PA unresolved</span>;
  }
}

/** Show scientific identity and placement evidence for a selected nominal pointing.
 * @param props - Source/proposed tile, session geometry choices and active instrument fallback.
 * @returns Compact role/fidelity, origin, meaningful PA and selected sequence information.
 */
export function PointingScience({ tile, context, fallbackInstrument }: {
  tile: TileRecord; context: PointingGeometryContext; fallbackInstrument: AnyInstrumentProfile | null;
}) {
  const instrument = tile.instrument_profile_id ? profileRegistry.listAnyInstrumentProfiles().find(({ id }) => id === tile.instrument_profile_id)
    : tile.source === "proposed" ? fallbackInstrument : null;
  const strategy = tile.output_strategy_id ? profileRegistry.findAnySurveyProfile(tile.output_strategy_id) : undefined;
  return <div className="pointing-science">
    {instrument && <><p><strong>{instrument.display_name}</strong></p><p className="scientific-id">{instrument.id}</p>
      <p>{instrument.schema_version === 3
        ? `${instrument.footprint_semantics.role === "observed_area" ? "Observed-area geometry" : instrument.footprint_semantics.role === "nominal_envelope" ? "Nominal envelope" : "Target-access envelope"} · ${instrument.footprint_semantics.fidelity === "exact" ? "Exact" : "Approximate"}`
        : "Legacy v2 survey geometry"}</p>
      {instrument.schema_version === 3 && instrument.footprint_semantics.role === "target_access" && <p>Not observed coverage · no fibre assignment</p>}
      {instrument.schema_version === 3 && instrument.footprint_semantics.role === "nominal_envelope" && <p>Planning envelope, not exact active area</p>}
    </>}
    {instrument && <p><PointingAngle tile={tile} context={context} /></p>}
    <p>Placement: {tile.placement_provenance ? origins[tile.placement_provenance.origin] : "Not declared (legacy record)"}</p>
    {tile.placement_provenance?.project_lattice && <p>Lattice site: (i={tile.placement_provenance.project_lattice.i}, j={tile.placement_provenance.project_lattice.j})</p>}
    {tile.placement_provenance?.origin === "authoritative_import" && tile.placement_provenance.source_reference &&
      <p>Source: <Reference reference={tile.placement_provenance.source_reference} /></p>}
    {strategy && <p>Strategy: {strategy.display_name}{strategy.schema_version === 3 && strategy.observing_sequence
      ? ` · ${strategy.observing_sequence.exposures.length} exposures · ${context.coverageBasis === "effective_sequence" ? "Effective sequence" : "Single exposure"}` : " · no observing sequence"}</p>}
  </div>;
}

function basisLabel(metrics: CoverageResult) {
  switch (metrics.coverage_basis) {
    case "observed_area": return "Observed-area geometry coverage";
    case "nominal_envelope": return "Nominal envelope overlap";
    case "target_access": return "Target-access envelope · not observed coverage";
    case "legacy_v2": return "Legacy survey coverage";
  }
}

function angularScale(degrees: number) {
  return `${Number((degrees * 3600).toPrecision(3))} arcsec`;
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <div className={`metric-row ${emphasis ? "is-emphasis" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function SamplingDetails({ metrics }: { metrics: CoverageResult }) {
  const sampling = metrics.sampling;
  if (!sampling) return null;
  const bound = "error_bound" in metrics ? metrics.error_bound : undefined;
  return <details className="scientific-details">
    <summary>Sampling details</summary>
    <Metric label="Coverage basis" value={basisLabel(metrics)} />
    {"geometry_basis" in metrics && metrics.geometry_basis && <Metric label="Geometry basis" value={metrics.geometry_basis === "effective_sequence" ? "Effective sequence" : "Single exposure"} />}
    <Metric label="Smallest contributing scale" value={angularScale(sampling.characteristic_scale_deg)} />
    <Metric label="Required pitch" value={angularScale(sampling.natural_step_deg)} />
    <Metric label="Actual cell size (east × north)" value={`${angularScale(sampling.cell_width_deg)} × ${angularScale(sampling.cell_height_deg)}`} />
    <Metric label="Samples / maximum budget" value={`${sampling.sample_count.toLocaleString()} / ${sampling.max_samples.toLocaleString()}`} />
    <Metric label="Required samples" value={sampling.required_sample_count?.toLocaleString() ?? "Beyond safe integer range"} />
    {bound && <>
      <Metric label="Fraction error upper bound" value={`${Number((bound.fraction_error_upper_bound * 100).toPrecision(3))} percentage points`} />
      <Metric label="Area error upper bound" value={`${Number(bound.area_error_upper_bound_deg2.toPrecision(3))} deg²`} />
      <p>Numerical bound in the modeled plane. Physical and spherical projection errors are unquantified; this does not certify gap-free coverage.</p>
    </>}
    {sampling.status === "under_resolved" && <p>Actual cells are diagnostic only; no coverage fraction was calculated.</p>}
  </details>;
}

/** Present role-aware measurements or typed scientific unavailability without fake percentages.
 * @param props - Frozen Gate 6B result, optional inference diagnostics and candidate count.
 * @returns Measurement readout with compact sampling disclosure and text status/alert semantics.
 */
export function CoverageReadout({ metrics, inference = null, candidateCount = 0 }: {
  metrics: CoverageResult; inference?: InferenceDiagnostics | null; candidateCount?: number;
}) {
  if (metrics.coverage_status !== "resolved" && metrics.coverage_status !== "legacy_compatible") {
    return <div className="metrics-panel scientific-coverage">
      <div role="alert">
        <strong>{metrics.coverage_status === "under_resolved" ? "Coverage unavailable at required resolution"
          : metrics.coverage_status === "unsupported_basis" ? "Area coverage is not supported for this basis" : "No eligible coverage contributors"}</strong>
        <p>{basisLabel(metrics)}</p>
        {metrics.coverage_status === "under_resolved" && <>
          <p>No authoritative coverage percentage is available. The required spatial sampling exceeds the computational budget.</p>
          {metrics.sampling && <p>Required pitch: {angularScale(metrics.sampling.natural_step_deg)}. Required samples: {metrics.sampling.required_sample_count?.toLocaleString() ?? "beyond safe integer range"}; maximum budget: {metrics.sampling.max_samples.toLocaleString()}.</p>}
        </>}
        {metrics.coverage_basis === "target_access" && <p>This field is an access envelope. It does not establish individual fibre reachability, assignment or successful observation.</p>}
      </div>
      <SamplingDetails metrics={metrics} />
    </div>;
  }
  const envelope = metrics.coverage_basis === "nominal_envelope";
  const fidelity = metrics.contributing_semantics?.filter(({ role }) => role === metrics.coverage_basis).map(({ fidelity }) => fidelity);
  return <div className="metrics-panel scientific-coverage">
    <p><strong>{basisLabel(metrics)} · sampled estimate{(envelope || fidelity?.includes("approximate")) ? " · Approximate" : fidelity?.includes("exact") ? " · Exact geometry" : ""}</strong></p>
    {envelope && <p>Planning envelope, not exact active area</p>}
    {metrics.geometry_basis && <p>{metrics.geometry_basis === "effective_sequence" ? "Effective sequence · geometric union only" : "Single exposure"}</p>}
    <Metric label="Selected region" value={`${metrics.coverage_basis === "legacy_v2" ? metrics.selected_region_area_deg2.toFixed(2) : Number(metrics.selected_region_area_deg2.toPrecision(3))} deg²`} />
    <Metric label="Existing contributors" value={String(metrics.existing_tiles_contributing)} />
    {inference && <>
      <Metric label="Nearby anchor candidates" value={String(inference.nearby_tile_count)} />
      <Metric label="Inference anchors used" value={String(inference.anchor_tile_ids.length)} />
      <Metric label="Compatible neighbor pairs" value={String(inference.compatible_neighbor_pairs)} />
    </>}
    <Metric label="New tiles" value={String(metrics.new_tiles)} emphasis />
    <Metric label={envelope ? "Existing envelope overlap" : "Already covered"} value={`${(metrics.already_covered_fraction * 100).toFixed(1)}%`} />
    <Metric label={basisLabel(metrics)} value={`${(metrics.selected_region_coverage * 100).toFixed(1)}%`} emphasis />
    <Metric label={envelope ? "Incremental envelope overlap" : "Incremental new coverage"} value={`${(metrics.incremental_coverage * 100).toFixed(1)}%`} />
    <Metric label={envelope ? "Remaining outside envelopes" : "Remaining uncovered"} value={`${(metrics.remaining_uncovered_fraction * 100).toFixed(1)}% · ${Number(metrics.remaining_uncovered_area_deg2.toPrecision(3))} deg²`} />
    <Metric label={envelope ? "Redundant envelope overlap" : "Redundant proposal coverage"} value={`${(metrics.redundant_coverage * 100).toFixed(1)}%`} />
    <Metric label="Outside selected area" value={`${Number(metrics.outside_region_coverage_deg2.toPrecision(3))} deg²`} />
    {metrics.sampling ? <SamplingDetails metrics={metrics} /> : <div className="metric-footnote">Legacy sample step {formatDegrees(metrics.sample_step_deg)} · {candidateCount} candidate lattice centers</div>}
  </div>;
}
