# Profile Schema v2

Schema v2 separates an instrument's physical geometry from a survey's planning
and data policies. An instrument profile describes the camera and its footprint;
a survey profile references an instrument and describes tiling, inference,
coverage, and export choices. This lets one instrument support multiple survey
policies without duplicating its geometry.

## Coordinates and footprints

Instrument positions use the canonical ICRS celestial frame. Footprint vertices
and component offsets use a local tangent plane centered on the telescope
pointing, in degrees as `[east, north]`. Position angles and component rotations
are astronomical degrees east of north: PA 0° leaves local north unchanged,
and positive PA rotates local north toward east. These conventions define the
data contract.

The `Footprint` discriminated union supports rectangles, circles, polygons, and
compound footprints. Rectangle width and height and circle radius are angular
degrees. Polygon vertices are distinct east/north offsets and describe a simple
closed boundary whose final edge back to the first vertex is implicit.

A compound footprint is a union of child footprints. Each child is translated
by its local east/north offset and may be rotated about its own center. An
optional compound PA rotates both the child offsets and child shapes; each
child's rotation then composes with the parent PA. Child footprints cannot
themselves be compound in v2, so detector gaps can be represented without
recursive mosaics.

## Gate 3 geometry behavior

The shared footprint engine uses the local tangent-plane model above for point
coverage, region intersection, physical area, and display boundaries. Rectangle
containment uses width and height; circle containment uses exact local distance
and its area is `πr²`; polygon containment uses an even-odd crossing rule and
absolute shoelace area. Polygon vertex order is retained. A point on a polygon
edge or vertex counts as inside.

Compound coverage and display are the union of child detector shapes. Gaps
between components stay uncovered. Compound area is a deterministic adaptive
estimate of the union, so overlapping children are not double-counted; its
boundary-cell resolution is 1/4096 of the compound bounding-box scale. Circle
boundaries are sampled for display only; their containment and area do not use
those samples.

Local offsets are translated to ICRS using wrapped RA and a tangent
approximation scaled by `max(cos(DEC), 0.01)`. This avoids a singular RA scale
near the poles and preserves RA-zero wrapping, but it is not exact spherical
geometry. Region intersection and rendered boundaries share this projection;
no celestial polygon clipping is performed.

## Survey policies

`TilingModel` dispatches to `legacy_splus`, `lattice`, or `manual`.

A generic lattice has one authoritative spacing representation:

```json
{
  "type": "lattice",
  "basis_deg": [[1, 0], [0.5, 1]],
  "origin": { "type": "region_center" }
}
```

The vectors are matrix columns in local `[east, north]` degrees. Integer sites
are `P(i,j) = O + i*b1 + j*b2`. Vectors must be finite, nonzero, and
non-collinear (the normalized determinant must exceed the schema's `1e-12`
numerical degeneracy threshold). Axis-aligned, rotated, staggered, and
triangular/hexagonal-center layouts use this same engine. For example, a
triangular lattice uses `[[s,0], [s/2,sqrt(3)*s/2]]`.

Lattice orientation is encoded only in these vectors; lattice
`position_angle_deg` and the former `origin_policy` field are rejected. Camera
PA belongs exclusively to the instrument footprint. A camera at PA 30° may use
an axis-aligned lattice, and a camera at PA 0° may use a rotated lattice.
Overlap is not a lattice parameter. The profile bridge can construct basis
vectors from custom v1 width/height minus overlap as an authoring convenience.
The published inline `RECT_GRID_V1` planner entry point retains its frozen
v0.2.0 row-generation/overlap-fill behavior. Registered Schema v2 `lattice`
surveys always use authoritative vectors and the new generic engine.

`origin` separates phase from geometry. `region_center` uses the midpoint of
continuous, unwrapped region RA bounds and DEC bounds, with RA normalized to
`[0,360)`. It is a bounds midpoint, not a polygon centroid. The same region and
profile produce the same phase and candidate sequence. `fixed_anchor` specifies
`{"type":"fixed_anchor", "ra_deg":150, "dec_deg":-30}` in ICRS, with RA in
`[0,360)` and DEC in `(-90,90)`. That anchor is both the planning tangent-plane
reference and integer site `(0,0)`. Changing the anchor shifts placement; its
DEC also sets the local cosine scale. This defines a local approximation, not
an exact global spherical survey grid.

Candidate generation projects the region, expands bounds by conservative
footprint reach, transforms the corners by the inverse basis, and enumerates
finite integer ranges with one integer of rounding padding. East reach accounts
for the difference between the planning-plane cosine and possible pointing
cosines. Order is explicitly `j` ascending, then `i` ascending. Gate 3 positive
footprint/region intersection retains candidates, including circles and mosaic
components. The existing 1,200 candidate budget is checked against the search
range before allocation. Regions whose footprint margin crosses the tangent
plane's RA branch require a smaller region or nearby anchor.

`manual` explicitly rejects automatic region planning with a survey-level
message. Manual pointings, imported centers, and generic footprint coverage
remain available. Generic plans select only declared lattice sites; they do not
infer a basis/phase or introduce a supplemental shifted lattice to close gaps.
Remaining sampled gaps are reported.

`InferencePolicy` holds scale-independent tolerances, evidence counts, and the
rotation allowance. `CoveragePolicy` holds target sampling density, a sample
cap, and optional Efficient stopping thresholds. Gate 6A consumes `sampling`
for generic lattice/manual coverage; Gate 6B consumes `efficient` for automatic
selection, including Schema v2 `legacy_splus`. `ExportPolicy` describes
coordinate columns and format, optional epoch and position-angle columns, and
constant output fields.

### Coverage sampling policy (Gate 6A)

Both `sampling.target_samples_per_footprint_axis` and `sampling.max_samples`
must be finite positive safe integers. There is no absolute `sample_step_deg`
profile field. The generic natural step is the footprint characteristic scale
in local degrees divided by the target samples per footprint axis. The scale
is the smaller rectangle side, circle diameter, smaller positive intrinsic
polygon bounding-box extent, or recursively the minimum child scale in a
compound. Footprint position angles, child rotations, and mosaic separations
do not enlarge that scale.

`max_samples` limits the actual full rectangular row-major grid, including
zero-weight cells outside the selected polygon. It therefore bounds allocation
and footprint-mask traversal, and is a conservative limit on positive-weight
containment tests. Natural sampling that fits keeps its step exactly; otherwise
the effective step coarsens analytically with inverse-square density, followed
by deterministic integer-count correction. All selected-region bounds remain
represented; no truncation or stochastic sampling is used.

Full bounds are evenly subdivided at cell centers. The effective step is a
maximum requested local pitch; integer subdivision can produce smaller actual
cell widths. Generic metrics expose unrounded `sampling` metadata with
characteristic/natural/effective steps, actual full-grid `sample_count`, the cap,
budget-limited flag, and actual east/north cell widths. See
[the sampling algorithm](ALGORITHM.md#scale-aware-sampling-gate-6a) for origin,
RA unwrap, ordering, and boundary details.

Coverage remains a sampled estimate using the existing local-plane geometry
and cos(DEC) weights. Small gaps or detectors can be missed at coarse resolution;
a grid with no polygon-interior cell fails explicitly. Exact spherical coverage,
adaptive refinement, and the G6C coverage-error matrix are not implemented.

### Complete and Efficient policy (Gate 6B)

Complete greedily targets every selected sample. It ignores `coverage.efficient`
and adds no coverage floor or marginal-efficiency stop. The existing safeguards
remain: selection stops at full sampled coverage, candidate exhaustion, or best
incremental gain below `1e-10` of selected-region weight. Declared lattices may
leave gaps if no declared site can cover them; Complete does not invent sites.

Efficient uses the same candidates, sampled grid, ranking, and full-coverage
safeguards. After ranking the best next tile and checking the incremental-gain
safeguard, it stops **before** selecting that tile only when both conditions hold:

```text
current sampled coverage >= coverage.efficient.min_coverage
new sampled physical area / footprintArea(output footprint)
    < coverage.efficient.min_marginal_efficiency
```

Equality at the marginal threshold remains eligible. Both fields must be finite
and in `[0,1]`: they are coverage/physical-efficiency fractions. The policy is
optional for Complete-only surveys; requesting Efficient without it fails
explicitly. Schema v2 never inherits T80 thresholds. The isolated v1 adapter in
`resolvePlanningProfile` supplies frozen inline/custom defaults from the bundled
T80 survey data because v1 has no `CoveragePolicy` field.

The numerator is newly covered selected-region sample weight times cell area in
square degrees, retaining cos(DEC) weighting. The denominator is the active
output instrument's physical local-plane area, independent of source datasets:
rectangle `width * height`, circle `pi * radius^2`, polygon absolute shoelace area,
or Gate 3's deterministic adaptive compound union estimate. Compound overlaps
count once and detector gaps are excluded; Efficient inherits that estimate's
boundary resolution, not the mosaic bounding-box area.

The Gate 6B audit confirms supplemental gap-fill and its rectangle spacing are
compatibility-only (`legacy_splus` and frozen inline v1); their geometry is
unchanged. Both compatibility selection passes now consume the resolved
Efficient policy. Generic occupancy still uses separation divided by basis scale
and `inference.occupancy_tolerance_fraction`; it never applies the compatibility
`0.12°` exclusion. The 1200 candidate caps reject oversized work before mask
selection; they are browser-computation safeguards, not scientific thresholds
or truncation rules. No generic failure in the focused tests requires changing
them. High-resolution error characterization remains G6C.

## Bundled T80/S-PLUS pair

`T80_SOUTH_INSTRUMENT_V2` defines the ICRS T80-South camera with a rectangular
1.4° × 1.4° footprint. `SPLUS_SURVEY_V2` references that instrument and selects
`legacy_splus`. It records inference fractions expressed against the 1.4° T80
footprint, the current three-anchor/two-neighbor minimum, the existing 140
samples-per-axis and 90,000-sample cap, consumed Efficient thresholds
`min_coverage: 0.995` and `min_marginal_efficiency: 0.03`, and the
RA/DEC/EPOCH export contract with epoch `2000`.

The bundled configuration is stored in
`frontend/src/profiles/splus-t80-south.json`, with `instrument` and `survey`
objects validated through the same Schema v2 validators and registry used for
ordinary profiles. Each object can be registered as user-supplied profile data;
Gate 7 still owns the import/export UI. The legacy tiling model declares
`grid_extent_deg: [1.4,1.4]` and `effective_overlap_arcsec: 120`. Grid extents and
overlap are consumed from survey profile data by `SPLUS_LEGACY_GRID_V1`; `adaptT80SplusV2ToV1` provides the transitional
historical default shape without duplicating those values.

The duplicated 1.4° extents in instrument and legacy survey data deliberately
preserve the inherited Gate 3 compatibility strategy when the linked footprint
is nonrectangular; there is no corresponding private numeric code constant.

T80 plans retain historical row inference, phase behavior, occupancy exclusion,
and supplemental overlap-fill, as well as legacy provenance `region_legacy` and
`region_extended`. New generic plans use `region_lattice` and
`solution: declared_lattice`, with integer coordinates retained internally in
proposal metadata. No frozen fixture values change.

## Remaining migration boundaries

Declared tiling, generic footprints, generic existing-grid inference (Gate 5),
generic scale-aware sampling (Gate 6A), and profile-driven selection (Gate 6B)
are operational. Scientific error validation (G6C), profile import/export UI and
configurable CSV output (Gate 7) remain deferred. Compatibility sampling uses
`legacySampleLayout` through the one-argument sampling adapter: `legacy_splus`
and inline v1 `RECT_GRID_V1` retain the frozen nominal 0.01-degree pitch,
90,000-cell cap, minimum eight cells per axis, and historical metric shape.
Sampling policy fields remain declarative for those paths. Compatibility
inference/sample constants still duplicate profile policy values. Efficient
thresholds are consumed from survey data. Remaining compatibility values must migrate
by release so all T80 scientific configuration is consumed from ordinary
importable profile data. The local cosine/wrapped-RA approximation remains;
large regions and near-pole planning do not become exact spherical geometry.
