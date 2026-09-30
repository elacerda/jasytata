# Scientific and planning algorithms

Jasytata is a browser-based telescope/survey pointing and coverage planner. This document distinguishes declared local-plane lattices, the compatibility geometry in `SPLUS_LEGACY_GRID_V1`, existing-grid inference, and coverage selection. The current implementation is in `frontend/src/science/geometry.ts`, `grid.ts`, `lattice.ts`, `planner.ts`, and `coverage.ts`. `frontend/src/data/golden.json` preserves former Python reference data for coordinates, catalogue semantics, exports, legacy grid geometry, and compatible lattice evidence. `frontend/src/data/planner-contract.json` records reviewed outcomes under the current sampling and coverage contract.

## 1. Coordinate conventions

- Coordinates are ICRS/equatorial in decimal degrees after parsing.
- Sexagesimal RA is interpreted as hour angle (`HH:MM:SS`); one hour equals 15 degrees.
- Sexagesimal DEC is interpreted in degrees (`±DD:MM:SS`). TypeScript coordinate helpers preserve the former Astropy parsing and RA normalization behavior.
- The legacy grid treats RA/DEC as longitude/latitude offsets with a local `cos(dec)` approximation. It does not use a gnomonic or great-circle lattice.
- Generic instrument footprints are rectangles, circles, polygons or compound/mosaic unions in local `[east,north]` angular degrees. Camera PA and child rotations follow astronomical positive north-toward-east rotation.
- The bundled T80 compatibility footprint is an axis-aligned 1.4° × 1.4° rectangle: ±0.7° in DEC and ±0.7° physical RA, where physical RA separation is `ΔRA × cos(tile_center_DEC)`. These dimensions are not a generic product assumption.
- Camera footprint PA and lattice orientation are independent. Basis vectors encode lattice orientation; no separate lattice PA field exists. A PA 30° camera can use an east/north lattice, or a PA 0° camera can use a rotated lattice. See the [practical basis examples](legacy/PROFILE_AUTHORING_GUIDE.md#survey-placement-and-lattice-basis).

## 2. `SPLUS_LEGACY_GRID_V1` compatibility geometry

The explicit `legacy_splus` strategy supplies historical row/grid semantics, not a generic survey-authoring preset. The bundled profile supplies its dimensions and effective overlap. The historical derivation is:

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
Generic grouping does not read CSV `PID` or PID-derived `group_id`. Historical
catalogue parsing/legacy inference intentionally retains that coupling inside
`legacy_splus`; it is not a generic scientific requirement. Export identifier
mappings are independent of source grouping.

Generic occupancy compares every enabled actual pointing with a candidate in
the same local plane, using `separation/s <= occupancy_tolerance_fraction`.
It does not use the legacy 0.12-degree threshold. Gate 5 changed only occupancy. Gate 6A now derives generic coverage pitch and
its sample cap from the survey policy; Gate 6B consumes profile Efficient thresholds.
The RA-wrap-safe Gate 3 projection, cosine clamp, branch limits, and near-pole
limitations still apply. Neither inference nor generation fits an exact spherical
lattice. Symmetry-equivalent rotations/assignments are canonically ranked; a
unique historical integer labeling cannot be recovered from unlabeled centers.

## 3. Compatibility existing-grid inference

The values below describe the bundled T80 reference. Registered `legacy_splus`
surveys derive spacing/phase/occupancy tolerances from their policy fractions
times the smaller legacy grid extent, and consume enabled state and anchor/pair
minima from the profile. Nonrotating row grouping, two-horizontal-pair evidence,
median phase residual at most half the maximum tolerance, and search topology
remain explicit compatibility algorithm rules. The inferred/profile lattice is
the admissible candidate set: Complete selects useful lattice sites until none
improves sampled coverage, and any residual uncovered samples are reported.
Legacy S-PLUS planning does not synthesize a supplemental phase or dither.
`allow_rotation` applies to generic inference, not this legacy strategy.

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

### Role-aware scale and budget (v0.4 Gate 6B)

Coverage basis is explicit: `observed_area`, `nominal_envelope`, or unclassified
compatibility `legacy_v2`. `target_access` area metrics are unsupported.
Role filtering precedes effective PA/sequence geometry, positive-area intersection,
resolution selection and mask union. Only v3 observed-area footprints enter
observed metrics; envelope diagnostics require an explicit envelope request.
V2 is never auto-classified. Sequence unions retain their instrument's role.

The required local pitch is `s_min/N`, N>=8. The minimum is across all eligible
intersecting source and output candidate exposure footprints. Characteristic
scale is the shorter rectangle side, circle diameter, polygon minimum
support-line width, or minimum compound child scale. Mosaic offsets, PA and
sequence span do not replace constituent scale. V3 supplies declared N; v2 mixed
runs use a run-level eight, optionally raised without profile mutation.

Generic rows use DEC span divided by required pitch. Columns use RA span times
the maximum clamped cosine over the region DEC interval expanded by contributing
footprint north reach. Ceiling subdivision guarantees pitch in every contributing
pointing's local frame, while retaining the existing wrapped-RA/cos(DEC) model.
All full-bound cells are enumerated row-major at half-cell centers; region
membership remains strict ray crossing and weights remain per-row cos(DEC).

The full rectangular cell count must fit `max_samples`. A bounded coarser grid
can supply diagnostic pitch/count metadata, but becomes machine-readable
`under_resolved`. Metrics publish no fractions/areas for it; Complete/Efficient
and low-level metric/greedy functions refuse it through a typed error. No coarse
answer is authoritative. Resolved results expose basis, geometry selection,
contributing roles/fidelity, required/actual pitch, dimensions/count/budget/status
and a conservative numerical bound. The bound covers boundary cells through
segment/circle tubes plus midpoint-weight variation; physical/projection error
is unquantified. See the [full proof, result shapes and references](V0.4.0_COVERAGE_ROLE_SAMPLING_VALIDATION.md).

Pure registered `legacy_splus` retains `legacySampleLayout`, policy-derived
nominal pitch and cap, eight-cell minimum and historical numeric fields. Inline
v1 retains its frozen layout and supplemental semantics. Their runtime result
basis/status is `legacy_v2` / `legacy_compatible`, with no new generic sampling
promise. Mixed scales or v3 geometry activate the generic correctness contract.

All applicable actual existing original and already accepted enabled tile footprints are unioned before candidate selection, after scientific basis filtering. This stage reads the request's pointings directly, without filtering through anchor IDs, row phases, lattice candidates, or map visibility. A candidate's incremental coverage is the weighted selected-region sample area newly covered on top of existing and previously selected proposal footprints. "Existing contributors" counts actual instrument footprints with positive geometric intersection against the polygon, independently of sample-cell hits, including boundary slivers smaller than the sample pitch. Pointing-center containment alone is not a universal contributor test: a mosaic can have a central gap and a polygon can exclude its local origin.

Polygon/rectangle intersection uses actual boundaries after PA and component
translation: strict containment, proper crossings, coincident edges with
interiors on the same side, and open edge fragments between vertex contacts.
Simple concave polygons and either winding are supported. Boundary-only contact
has zero area and is excluded, preserving the existing contributor contract.
The local geometry tolerance remains `1e-12`; circle/edge distance remains
analytic. This classifies topology without increasing coverage sampling density.

The scientific stages are: actual input footprints → existing coverage; actual input centers → lattice inference; inferred or profile lattice → candidates; actual input centers → candidate occupancy (generic local-plane, legacy spherical); unoccupied candidates plus uncovered samples → proposals; existing footprints plus enabled proposal footprints → final coverage. The selected-area coverage fraction remains a numerical sample estimate, while contributor membership is a geometric intersection count.

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

Supplemental gap-fill remains available only to the frozen inline v1
`RECT_GRID_V1` compatibility path. That path may phase a supplemental lattice
halfway between centers around uncovered-sample bounds, anchored to the nearest
stable inferred tile where available, with spacing capped at 90% of compatibility
tile width and height. Registered `legacy_splus` surveys do not run this second
pass: Complete and Efficient use the same admissible lattice, with Efficient
applying only its configured stopping policy. Generic declared lattices also
report residual gaps without adding supplemental spacing or phase. Generic
occupancy continues to use the Gate 5 basis-relative fraction; the legacy
spherical `0.12°` exclusion remains isolated.
The 1200-candidate safeguards reject excess browser work without truncating
candidates; focused generic tests reveal no reason to change these operational
limits. Outside area subtracts sampled inside area from generic physical footprint
area; overlapping outside tile areas are summed rather than unioned.

Efficient does not assess the topology or scientific importance of residual gaps.
Select Complete when exhaustive sampled coverage is required.

The reported 100% target means every selected sample is covered under the applicable metric basis; it is not continuous gap-free or spectroscopic completeness. Generic runs exceeding their scientific-resolution budget publish no fraction or completion claim. Pure historical compatibility runs retain their separately labeled estimates.

Returned coverage metrics include selected polygon area, existing footprints with positive geometric intersection, new tile count, already-covered and final coverage fractions, incremental proposal coverage, remaining uncovered fraction and area, redundant proposed footprint fraction, outside-polygon tile area, and sample pitch. Manual enable/disable changes call the browser-local coverage function to recompute these figures without replanning. There is no HTTP coverage endpoint. The displayed candidate lattice count comes from the planning response's candidate center list.

## 5. Export integrity

Original catalogue records retain every source CSV string and arbitrary metadata
for inspection. Enabled accepted additions are exported according to the active
survey's validated `export` policy, independently of source headers/instruments.
RA/DEC labels are configurable; decimal degrees use eight decimals and sexagesimal
uses RA hours/DEC degrees with millisecond precision. Optional epoch is descriptive
metadata, not precession. Optional constants and ID/name/group labels follow
profile policy, not source PID or internal IDs.

Exported PA is declared camera/pointing orientation in degrees east of north,
never lattice orientation or inferred lattice rotation. Acceptance records an
explicit top-level output footprint PA when needed; child rotations are detector
geometry. Missing requested PA fails explicitly; no implicit zero is invented.
An explicitly declared zero is valid. Columns, constants and accepted-row order
are deterministic. See the [complete CSV contract](PROFILE_SCHEMA.md#pointing-csv-contract-gate-7c)
for numbering, epoch choices, escaping and limits. The bundled T80 default remains
`RA,DEC,EPOCH=2000`; historical decimal and sexagesimal formatting stays protected.

## 6. Deliberate limitations

The offset-polygon intersection blocker is
[resolved in G9B1](legacy/V0.3.0_ROADMAP.md#g9b-blocker--polygon-intersection-false-positive).
Contributor counting and candidate filtering now test physical polygon overlap
without assuming local-origin containment. Gate 9B2 is PASS; see the
[release audit](legacy/GATE9_RELEASE_AUDIT.md).

- Resolved coverage is a numerical estimate in the declared basis with a
  conservative error bound; 100% means all selected samples are covered, not
  proven gap-free detector coverage or depth/completeness.
- Sub-pitch gaps and thin regions remain subject to the reported bound. Generic
  budget coarsening yields an unavailable result without an authoritative
  fraction. Pure legacy compatibility retains its historical numerical limits.
- Exact coverage/marginal-efficiency threshold decisions can be sensitive to
  sampling. Measured ordinary validation margins are not a universal guarantee.
- Geometry uses local wrapped-RA/cosine tangent approximations rather than full
  spherical polygon clipping or exact HEALPix footprints. Large extents and RA
  branch limits may require a smaller region or nearer fixed anchor.
- Extreme polar regimes are outside validated precision. Exact poles are rejected;
  finer sampling does not repair the sky model. Gate 6C's ordinary local fixtures
  through ±50° do not establish a universal declination/extent cutoff.
- Generic inference is a bounded alignment to a declared fundamental lattice,
  not arbitrary-lattice discovery. Compatibility inference remains the separate
  near-axis-aligned T80/S-PLUS row algorithm; it does not infer lattice rotation.
- Declared generic lattices do not add off-lattice centers to close gaps. Manual
  surveys intentionally support supplied pointings/coverage without auto-tiling.
  Browser candidate/proposal limits reject work without truncation. Generic
  sampling budgets refuse authoritative metrics/planning when under-resolved.

The [Gate 6C measured report](legacy/GATE6C_COVERAGE_VALIDATION.md) documents accuracy,
convergence, budgets and polar diagnostics. The
[Gate 8 matrix](legacy/GATE8_AGNOSTICISM_VALIDATION.md) validates T80, small circular FoV,
rotated detector mosaic and non-orthogonal triangular lattice. Camera PA/lattice
independence is exercised explicitly. These evidence artifacts retain their
reproducible fixture results.

Bundled scientific configuration lives in
`frontend/src/profiles/splus-t80-south.json` and uses the same strict validators
and registry as imported/authored profiles. Legacy grid extents deliberately
remain independent of the linked footprint to preserve compatibility; no generic
width/height-only profile restriction follows. Registered v2 inference, sampling,
Efficient and export consume their declared policies. Inline v1 adapters inherit
validated bundled defaults; named compatibility algorithm rules remain isolated.

Planning/export are intended to be deterministic for identical profiles, datasets,
region, strategy, accepted state and export options in the same software version.
There is no claim of bitwise reproducibility across arbitrary future versions.
Jasytata remains browser-only with no API backend or database. It is not an
observing scheduler: exposure-time optimization, filter sequencing, airmass, Moon
constraints, weather, mount constraints, queue scheduling and observatory control
are outside scope. The archived [v0.3.0 release audit](legacy/GATE9_RELEASE_AUDIT.md)
records that version's historical Gate 9 disposition and limitations.
