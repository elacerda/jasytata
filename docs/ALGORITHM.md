# Scientific and planning algorithms

This document distinguishes declared local-plane lattices, the compatibility geometry in `SPLUS_LEGACY_GRID_V1`, existing-grid inference, and coverage selection. The current implementation is in `frontend/src/science/geometry.ts`, `grid.ts`, `lattice.ts`, `planner.ts`, and `coverage.ts`. `frontend/src/data/golden.json` preserves former Python reference data for coordinates, catalogue semantics, exports, legacy grid geometry, and compatible lattice evidence. `frontend/src/data/planner-contract.json` records reviewed outcomes under the current sampling and coverage contract.

## 1. Coordinate conventions

- Coordinates are ICRS/equatorial in decimal degrees after parsing.
- Sexagesimal RA is interpreted as hour angle (`HH:MM:SS`); one hour equals 15 degrees.
- Sexagesimal DEC is interpreted in degrees (`±DD:MM:SS`). TypeScript coordinate helpers preserve the former Astropy parsing and RA normalization behavior.
- The legacy grid treats RA/DEC as longitude/latitude offsets with a local `cos(dec)` approximation. It does not use a gnomonic or great-circle lattice.
- A tile is modeled for display and scoring as an axis-aligned 1.4° × 1.4° rectangle in local RA/DEC: ±0.7° in DEC and ±0.7° physical RA, where physical RA separation is `ΔRA × cos(tile_center_DEC)`.

## 2. `SPLUS_LEGACY_GRID_V1`

The bundled profile supplies the compatibility dimensions and effective overlap. The historical derivation is:

```text
tile size                  T = 1.4 deg
configured base overlap    O = 30 arcsec
legacy builder multiplier  m = 4
effective overlap          m O = 120 arcsec = 1/30 deg
center spacing             S = T - m O = 1.366666666... deg
```

For non-degenerate bounds, the first center is offset half a tile from the lower bounds. If the lower RA is `α₀` and the lower DEC is `δ₀`:

```text
δ_first = δ₀ + T/2
α_first = α₀ + (T/2) / cos(δ₀)
```

For successive rows:

```text
δ_(j+1) = δ_j + S
```

For each row `j`, RA centers step by:

```text
Δα_j = S / cos(δ_j)
α_(j,k+1) = α_(j,k) + Δα_j
```

The division by cosine is applied to the angular increment as in the reference's Astropy `Longitude` handling. This is a small-angle physical-spacing approximation: `Δα_j cos(δ_j) = S`. Centers stop at the upper input bounds, just as the legacy loops do. Reversed non-wrapping bounds are normalized to ascending bounds; RA intervals that cross zero must be explicitly marked as wrap intervals so the short interval is not mistaken for a 350° span. Degenerate fixed-coordinate axes retain the legacy behavior of placing that coordinate on the supplied boundary.

The committed Python-generated compatibility fixture records legacy grid centers and RA wrap behavior. TypeScript grid tests compare center sequences to the fixture within `1e-10` degree. The implementation intentionally does not replace the half-tile seed with a modern centered-grid convention.

## Declared generic tiling (Gate 4)

Footprint means the shape covered by an exposure. Lattice means relative center
positions. Origin means lattice placement/phase. The planner selects sites by
coverage. These are independent inputs and stages.

Schema v2 dispatches `legacy_splus` to the historical strategy below, `lattice`
to the pure generic engine, and `manual` to an explicit unavailable-automatic-plan
error. The instrument supplies footprint geometry; survey `basis_deg` supplies
two matrix-column vectors `[east,north]` in degrees, with
`P(i,j) = O + i*b1 + j*b2`. There is no lattice PA or fundamental overlap scalar.
All rectangular, rotated, staggered, and triangular layouts use this one model.

The planning plane uses the Gate 3 wrapped-RA/cosine approximation. The origin
is the midpoint of unwrapped RA and DEC region bounds, or a declared fixed ICRS
anchor. A fixed anchor establishes site `(0,0)` and the plane's cosine scale;
it does not define an exact global spherical grid. Region vertices are projected
into that plane, then bounded with footprint reach (including camera PA and
mosaic offsets). East reach is conservatively rescaled for possible center
cosines. The inverse basis transforms expanded corners to finite integer ranges,
with one index of rounding padding. The existing 1,200-candidate budget applies
before enumeration. RA branch crossings are rejected explicitly.

Enumeration is `j` ascending, then `i` ascending. Gate 3 footprint-region
intersection retains relevant centers. Coverage selection uses Gate 6A scale-aware sampling
and the existing greedy ranking. Gate 5 can supply a runtime alignment and fractional
occupied-center exclusion as described below; centers adding no sampled gain
are omitted by selection. No shifted supplemental grid is introduced for a
declared lattice: uncovered sampled gaps remain visible in metrics/diagnostics.
Proposal provenance is `region_lattice`; the historical strategy retains its
frozen `region_legacy`/`region_extended` values.

The profile bridge can construct an axis-aligned basis from v1 rectangle
dimensions minus overlap as an authoring convenience. The published inline
`RECT_GRID_V1` planning entry point retains its historical row generator and
overlap-fill because its v0.2.0 fixtures are also frozen. Declared Schema v2
`lattice` surveys always use the generic engine. Manual/imported centers
and their footprint coverage do not require an automatic tiling policy.
Scale-aware numerical coverage sampling is implemented in Gate 6A, as described below.

## Generic existing-grid alignment (Gate 5)

`lattice-inference.ts` aligns centers to the survey's declared matrix-column
basis `B0`; it never discovers an unconstrained fundamental lattice. Missing
cells, harmonics, and integer-equivalent bases make that inverse problem
ambiguous. The fitted basis is only `B = R(theta) B0`, with the same astronomical
east/north rotation convention as footprints (positive north toward east).
When `allow_rotation` is false, theta is exactly zero and the basis is unchanged.

The characteristic scale is `s = min(norm(b1), norm(b2))`. Spacing compatibility
uses `abs(norm(observed pair) - norm(B0*m))/s <= spacing_tolerance_fraction`;
the final pair-vector residual must satisfy that same normalized tolerance.
The planner restricts evidence to region bounds in its local plane plus a
basis-derived search margin. Spatial buckets form only local pairs, with integer
offsets bounded by `max(abs(m1), abs(m2)) <= 2`. Separations such as `2*b1`,
`2*b2`, and `b1+b2` support the declared fundamental basis without replacing it.
Disconnected local groups can share a phase across a large hole, but groups
containing only separations beyond this bound fail for insufficient pairs.

Spacing-compatible correspondences imply candidate rotations. Deterministic
circular consensus uses policy-derived angular buckets and unique pair support;
there is no random RANSAC. Only accepted integer assignments participate in a
subsequent least-squares rotation refinement, without basis stretching. Modular
phase consensus estimates `phi` from `B^-1*p mod 1` using circular means, so
0.99 and 0.01 are neighbors. Both consensus searches retain the strongest 32
bucket neighborhoods and refine their hypotheses; this is a bounded local fit,
not an exhaustive solver for adversarial catalogues. Integer assignments are
`round(B^-1*p - phi)`. Residuals are Euclidean distances in the projection plane
divided by `s`; `phase_tolerance_fraction` defines inliers. Outliers are reported
with assignments/residuals but do not enter the final phase or rotation refinement.
Minimum anchors require distinct lattice sites; minimum pairs require distinct
inlier site pairs. RMS residuals use inliers only.

A `fixed_anchor` is authoritative: it defines both the projection reference and
zero phase. Rotation, if allowed, is about that anchor; inference never translates
it. Inconsistent evidence produces `inconsistent_fixed_anchor`. For
`region_center`, phase is runtime state only. The result exposes the ICRS site
(0,0), rotated basis, phase, all assignments, inlier count, normalized RMS, and
pair support. It also retains the projection reference and local phase offset:
converting phase to a sky anchor must not change the cosine scale of the original
plane. The Gate 4 generator consumes this alignment directly and preserves its
canonical integer enumeration. Successful generic continuation reports
`extended_existing_grid` with neutral `region_lattice` provenance. Explicitly
disabled inference or no usable centers retains declared new-survey generation.
Attempted inference with insufficient anchors/pairs, an incompatible fixed
anchor, or no acceptable alignment throws an explicit planning error containing
the inference status before candidate generation. It never resets an existing
survey to the declared origin/phase after a failed alignment.
Manual inference is explicitly unavailable; legacy inference stays separate.

Enabled datasets are fitted independently by dataset ID and instrument ID.
`exclude` never anchors inference but still contributes coverage and occupancy.
`auto` requires the active instrument identity; `include` admits an independent
group but still requires a valid fit against the active declared basis. Accepted
proposals use the active output instrument and, absent a dataset ID, their
generation-method identity. Groups are never merged into one point cloud. Fits
rank by most inliers, lowest normalized RMS, most consistent pairs, smallest
absolute rotation, then lexical group identity and stable numeric phase/orientation
ties. Dimensionless roundoff allowances resolve numerically equivalent fits.
Generic grouping does not read CSV `PID` or PID-derived `group_id`; historical
grouping keeps that coupling until the Gate 7 mapping cleanup.

Generic occupancy compares every enabled actual pointing with a candidate in
the same local plane, using `separation/s <= occupancy_tolerance_fraction`.
It does not use the legacy 0.12-degree threshold. Gate 5 changed only occupancy. Gate 6A now derives generic coverage pitch and
its sample cap from the survey policy; Gate 6B consumes profile Efficient thresholds.
The RA-wrap-safe Gate 3 projection, cosine clamp, branch limits, and near-pole
limitations still apply. Neither inference nor generation fits an exact spherical
lattice. Symmetry-equivalent rotations/assignments are canonically ranked; a
unique historical integer labeling cannot be recovered from unlabeled centers.

## 3. Compatibility existing-grid inference

The selected polygon is unwrapped around its local RA center and must span at most 180°. Neighbor pairs are measured in local physical east-west degrees at the pair's mean declination:

```text
Δx = |wrapped(α₂ − α₁)| cos((δ₁ + δ₂) / 2)
Δy = |δ₂ − δ₁|
```

Tiles are eligible anchors when their centers lie inside the region plus a 4.2° search margin (three tile widths) in both local axes. Neighbor pairs are compatible with the legacy grid when either:

- horizontal: `|Δy| ≤ τ` and `||Δx| − S| ≤ τ`, or
- adjacent row: `||Δy| − S| ≤ τ` and `|Δx| ≤ 0.75 S`.

The tolerance is `τ = 0.05°` (3 arcmin). This was calibrated against nearest-neighbor differences in the supplied catalogue: dense S-PLUS rows commonly show DEC steps around 1.354–1.359° and physical RA steps around 1.35°, within roughly 0.02° of the legacy 1.3667° step; the sparse HYDRA rows include physical RA steps around 1.40°, within 0.04°. The threshold is deliberately narrower than 0.1° so unrelated sub-degree and broad 1.5° patterns do not anchor an extension.

At least two compatible neighbor pairs, two horizontal pairs, and three distinct anchor tiles are required. DEC and physical RA spacings are robust medians of observed compatible steps; when vertical neighbors are absent, DEC spacing falls back to the active profile. Anchor centers are clustered into declination rows, retaining each observed row's actual DEC instead of forcing one constant spacing across a broad region. Each observed row also retains its own measured physical RA pitch. RA phases are inferred and residual-checked independently within each observed row, measured relative to the selected region's RA center. Missing rows interpolate from observed row coordinates, phases, and RA pitches; rows beyond the observed range extrapolate from nearby rows. Candidate centers are extended over the selected region plus a half-tile margin. They remain on those inferred lattice coordinates; optimization never continuously shifts a center. If row phases are inconsistent, the planner reports `profile_fallback` rather than labeling an unsupported phase as an existing-grid extension.

Candidate centers within 0.12° **great-circle angular separation** of an actual input center are removed as occupied. This exclusion is wider than the 0.10° maximum accepted phase residual plus the Run C 14.93-arcsecond historical holdout tolerance, while remaining much smaller than the roughly 1.35° spacing between distinct sites. Occupancy compares every candidate with actual loaded centers; it does not use inferred row membership. For the compatibility strategy, when inference does not meet the anchor count and phase-residual checks, the planner reports `profile_fallback` and calls the active profile's grid builder on polygon bounds expanded by half a tile. The bounds accelerate lattice construction; polygon samples decide whether each candidate contributes. A successful fit is reported as `extended_existing_grid`. Structured inference diagnostics distinguish nearby candidate tiles from the stable IDs of anchors in compatible neighbor pairs and report the selected pair count and inferred spacings. The nearby count comes from polygon **bounds plus a three-tile search margin**, so it can substantially exceed the number of tiles inside the selected polygon. Fallback reports nearby candidates but zero matched anchors, zero compatible pairs, and no inferred spacings. Coverage recalculation does not replace inference diagnostics.

## 4. Coverage representation and scoring

The polygon's full bounding rectangle is sampled as uniform RA/DEC cell centers;
polygon-exterior cells retain zero weight. Interior cells retain `cos(DEC)`
weights. Footprint containment and geometric intersection use the Gate 3 engine,
including source-dataset geometry; sampling changes only numerical resolution.
For the frozen T80 rectangle, containment remains:

```text
|sample_DEC − tile_DEC| ≤ 0.7 deg
|wrapped(sample_RA − tile_RA) cos(tile_DEC)| ≤ 0.7 deg
```

### Scale-aware sampling (Gate 6A)

`footprintCharacteristicScale` returns an intrinsic local tangent-plane length:

- Rectangle: `min(width_deg, height_deg)`.
- Circle: `2 * radius_deg`.
- Polygon: the minimum positive east/north bounding-box extent of its intrinsic
  vertices, before applying position angle; area alone is not used.
- Compound/mosaic: recursively the minimum of all child characteristic scales.
  Offsets, child rotations, and parent rotation do not change it. Large distances
  between small detectors cannot turn their scale into the full mosaic span.
  The current schema permits non-compound children only; the helper uses the
  same recursive rule without extending the schema.

For generic Schema v2 `lattice` and `manual` surveys:

```text
natural_step_deg = characteristic_scale_deg / target_samples_per_footprint_axis
rows = max(1, ceil(DEC_extent / effective_step_deg))
cols = max(1, ceil(RA_extent * max(cos(midpoint_DEC), 0.01) / effective_step_deg))
```

The step must be finite and positive. Policy density and `max_samples` are
positive safe integers, validated both by the schema and the sampling entry
point. There is no absolute generic pitch or private generic sample cap.

`max_samples` bounds the **entire principal rectangular grid**: the actual
length of each RA, DEC, weight, and footprint-mask array, including zero-weight
polygon-exterior cells. This conservative choice bounds enumeration, memory,
and each coverage loop even for a thin or concave region. It does not mean only
the number of retained polygon-interior cells. Footprint containment runs only
for cells with positive weight. Thus its invocation count is also bounded.

When the natural grid fits, the effective step equals the natural step exactly.
Otherwise, an analytic inverse-square density estimate starts coarsening:
`max(natural_step, sqrt(local_width) * sqrt(height / max_samples))`. A one-cell
budget uses at least the larger extent. Ceiling counts and long thin regions
are corrected deterministically using the larger of the inverse-square count
correction and the next row/column reduction threshold (with a floating-point
roundoff allowance). Dimensions are recomputed until the cap is satisfied,
before allocating arrays. The effective step is then strictly coarser than the
natural step. No samples are randomly chosen or truncated from one region side.

Rows and columns evenly subdivide **all** unwrapped bounds. The effective step
is the requested maximum local cell pitch; actual east/north cell widths can
be smaller because integer counts must span the bounds. The origin is the
southwest bounding edge, the first sample is half a cell inward, rows increase
DEC, and columns increase continuous RA. No cell center lies on a bounding-box
edge. The existing strict ray-crossing predicate decides polygon membership;
it retains lower/left versus upper/right half-open behavior on axis-aligned
edges, with strict comparisons on slanted edges. RA is unwrapped through
`polygonLocalGeometry` before enumeration and wrapped to `[0,360)` only when
storing samples. No sky-projection convention changes.

`CoverageGrid.sampling` and `PlanMetrics.sampling` expose unrounded
`characteristic_scale_deg`, `natural_step_deg`, `effective_step_deg`,
`sample_count`, `max_samples`, `budget_limited`, `cell_width_deg`, and
`cell_height_deg`. `sample_count` is read from the actual principal array length,
not a theoretical area-density estimate. Cell widths are local degrees at the
bounding-box midpoint DEC. The historical rounded `sample_step_deg` metric
remains; use the new unrounded metadata to audit small-footprint resolution.

The one-argument `sampleRegion` adapter and `legacySampleLayout` preserve frozen
v0.2.0 sampling for `legacy_splus` surveys (including linked nonrectangular
compatibility cameras) and inline v1 `RECT_GRID_V1` profiles. Only this explicit
compatibility path retains a nominal `0.01°`, a `90_000` cap, and minimum eight
cells per axis. Its result shape remains unchanged, without generic metadata.
The bundled T80 sampling policy is declarative on that path pending a reviewed
compatibility migration; no frozen fixtures or stopping thresholds change here.

The grid remains a sampled local-plane estimate. The minimum child rule does
not guarantee resolving gaps narrower than the resulting step; budget coarsening
can miss small detectors or thin region features. If no cell belongs to the
polygon, sampling fails explicitly rather than inventing selected coverage.
Large fields and near-pole regions retain the existing cosine/wrapped-RA limits.
There is no adaptive refinement or continuous/spherical coverage proof. Gate 6B
adds profile-driven selection. Gate 6C measures coverage against independent
fine uniform quadrature: normal validation fixtures meet a 0.5-percentage-point
criterion, with reference refinement changes below 0.05 pp. The 256-fold scale
experiment has only 0.01081 pp error spread; resolved rotated detector gaps pass,
while a gap 0.75 of one sample step is missed (0.78125 pp error). Very tight
budgets and polar geometry remain diagnostic exceptions. See the
[measured matrix and limitations](GATE6C_COVERAGE_VALIDATION.md) for methodology,
convergence, phase sensitivity, budget behavior and Complete/Efficient margins.
This is empirical validation of the local model, not exact geometric coverage
or an accuracy promise for arbitrary policies and thresholds.

All actual existing original and already accepted enabled tile footprints are unioned before candidate selection. This stage reads the request's pointings directly, without filtering through anchor IDs, row phases, lattice candidates, or map visibility. A candidate's incremental coverage is the weighted selected-region sample area newly covered on top of existing and previously selected proposal footprints. "Existing contributors" separately counts actual tile rectangles with positive geometric intersection against the polygon; it does not depend on sample-cell hits. Every actual tile centered inside the polygon therefore counts as a contributor, including when a boundary sliver is smaller than the coverage sample pitch.

The scientific stages are: actual input footprints → existing coverage; actual input centers → lattice inference; inferred or profile lattice → candidates; actual input centers → spherical candidate occupancy; unoccupied candidates plus uncovered samples → proposals; existing footprints plus enabled proposal footprints → final coverage. The selected-area coverage fraction remains a numerical sample estimate, while contributor membership is a geometric intersection count.

Selection is deterministic greedy maximum incremental gain. Complete coverage is
the default and targets every sampled polygon cell. It ignores Efficient policy;
selection stops at full sampled coverage, candidate exhaustion, or best gain
below `1e-10` of the selected-region weight. This numerical safeguard is unchanged.
Ties prefer less overlap with already covered samples, less estimated tile area
outside the selected polygon, then stable coordinate order. Candidate coordinates
are never perturbed.

Efficient uses the same candidates and ranking. The loop first checks full
coverage, ranks the best tile, and applies the same incremental-gain safeguard.
It then stops before that tile when current sampled coverage is at least
`coverage.efficient.min_coverage` and marginal physical efficiency is **strictly
less** than `coverage.efficient.min_marginal_efficiency`. Equality remains eligible.
Both thresholds come from the active Schema v2 survey. Missing policy rejects
Efficient explicitly and does not affect Complete. The bundled S-PLUS/T80 JSON
sets `0.995` and `0.03`, reproducing frozen behavior. Only v1 inputs inherit these
values via the isolated `resolvePlanningProfile` compatibility adapter.

```text
marginal physical efficiency =
    sum(weights of newly covered selected samples) * cellAreaDeg2
    / footprintArea(active output footprint)
```

The numerator retains cos(DEC) weighting and has units of square degrees. The
Gate 3 area engine supplies rectangle product, circle analytic area, polygon
shoelace area, or deterministic adaptive compound union area. Mosaic detector
gaps remain empty and overlaps count once. The compound denominator inherits
Gate 3's 1/4096 bounding-scale boundary-cell approximation. It is not a bounding
rectangle or the sum of overlapping detector areas.

Supplemental gap-fill is exclusive to `legacy_splus` and frozen inline v1
`RECT_GRID_V1`. If their primary grid leaves uncovered samples, a supplemental
lattice is phased halfway between centers around the uncovered-sample bounds,
anchored to the nearest stable inferred tile where available. Spacing remains
capped at 90% of compatibility tile width and height. Both passes use the resolved
Efficient policy. Generic declared lattices never add supplemental spacing or
phase, and report remaining gaps. Generic occupancy continues to use the Gate 5
basis-relative fraction; the legacy spherical `0.12°` exclusion remains isolated.
The 1200-candidate safeguards reject excess browser work without truncating
candidates; focused generic tests reveal no reason to change these operational
limits. Outside area subtracts sampled inside area from generic physical footprint
area; overlapping outside tile areas are summed rather than unioned.

Efficient does not assess the topology or scientific importance of residual gaps.
Select Complete when exhaustive sampled coverage is required.

The reported 100% target means every selected sample is covered. It is an estimate based on the sample grid, not an exact continuous-polygon coverage proof; regions exceeding their applicable sample cap use a coarser grid and have correspondingly lower spatial resolution.

Returned coverage metrics include selected polygon area, existing tiles contributing sample coverage, new tile count, already-covered and final coverage fractions, incremental proposal coverage, remaining uncovered fraction and area, redundant proposed footprint fraction, outside-polygon tile area, and sample pitch. Manual enable/disable changes call the coverage endpoint to recompute these figures without replanning. The displayed candidate lattice count comes from the planning response's candidate center list.

## 5. Export integrity

Original catalogue records retain every source CSV string and arbitrary non-coordinate metadata for display. Generated records contain only ICRS positions, an enabled flag, and generation provenance. Generic export writes currently enabled centers with `RA,DEC,EPOCH`: decimal-degree RA/DEC at eight fractional digits by default, or sexagesimal hour-angle RA and degree DEC at millisecond precision. The EPOCH value comes from the active profile's allowed export labels. It does not change ICRS coordinates or imply a particular equinox. Both representations are covered by golden export tests.

## 6. Deliberate limitations

Declared lattices and generic footprints support independent orientations in a local plane. Compatibility inference remains designed for the near-axis-aligned T80/S-PLUS mosaic at ordinary survey declinations. It does not use full spherical polygon clipping, infer a rotated lattice, or model exact HEALPix footprints. The coverage score is a reproducible planning estimate and must be checked against the survey's final operational acceptance criteria before treating it as a formal completeness statement. Near the celestial poles, the RA/DEC rectangle approximation is not suitable; selected regions are validated to avoid the exact poles but the recommended operating area remains the southern survey footprint.

Scientific configuration migration: the bundled instrument/survey objects in
`frontend/src/profiles/splus-t80-south.json` use the ordinary validators and
registry loader. Legacy generation reads grid extents and effective overlap from
those profiles. Compatibility survey `grid_extent_deg` is independent of the
linked footprint; it preserves the legacy half-tile seed and pitch even when
a Gate 3 survey is associated with a different camera shape. The bundled
`[1.4,1.4]` survey grid extents duplicate the instrument dimensions deliberately
for that compatibility contract, rather than duplicating values in code. Compatibility inference and sampling constants remain in the explicit legacy
paths. Generic inference reads fractional policy and generic sampling reads
`CoveragePolicy.sampling`; Efficient selection reads `CoveragePolicy.efficient`.
Legacy tolerance duplicates still need a compatibility-reviewed profile migration;
T80 sampling compatibility migration remains deferred; G6C scientific validation
is complete within the documented local-model limits. Full import/export
UI remains Gate 7. All T80 scientific configuration must be sourced from ordinary
importable profile data by the v0.3.0 release.
