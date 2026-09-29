# Profile Schema v2

Schema v2 separates an instrument's physical geometry from a survey's planning
and data policies. An instrument profile describes the camera and its footprint;
a survey profile references an instrument and describes tiling, inference,
coverage, and export choices. This lets one instrument support multiple survey
policies without duplicating its geometry. For a practical workflow and examples,
see the [profile authoring guide](legacy/PROFILE_AUTHORING_GUIDE.md).

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

Valid simple polygons may be concave and need not contain their local origin.
Intersection tests their physical boundary after PA and component translation,
using strict containment, proper crossings, coincident edges with interiors on
the same side, and open edge fragments between vertex contacts. Either winding
is supported. Contributor/candidate intersection requires positive-area overlap;
contact only at an edge or vertex is excluded, while point containment remains
boundary-inclusive. The existing local geometry tolerance is `1e-12`.
The offset-polygon false-positive blocker is
[resolved in G9B1](legacy/V0.3.0_ROADMAP.md#g9b-blocker--polygon-intersection-false-positive);
Gate 9B2 is PASS; see the [release audit](legacy/GATE9_RELEASE_AUDIT.md).

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
remain available. Generic plans select only sites of the declared lattice,
optionally aligned by the inference policy as described below; they do not
introduce a supplemental shifted lattice to close gaps. Remaining sampled gaps
are reported. Inference aligns the declared fundamental basis rather than
discovering an arbitrary one: optional rigid rotation is policy-controlled,
region-centered phase can be inferred, and fixed anchors remain authoritative.
See [generic alignment](ALGORITHM.md#generic-existing-grid-alignment-gate-5)
for missing-tile/harmonic support, evidence limits and explicit failure outcomes.

`InferencePolicy` holds scale-independent tolerances, evidence counts, and the
rotation allowance. `CoveragePolicy` holds target sampling density, a sample
cap, and optional Efficient stopping thresholds. Gate 6A consumes `sampling`
for generic lattice/manual coverage; Gate 6B consumes `efficient` for automatic
selection, including Schema v2 `legacy_splus`. `ExportPolicy` describes
coordinate columns and format, optional epoch and position-angle columns, and
constant output fields and optional generated identifier column mappings. Gate 7C
consumes this same validated policy for all pointing CSV downloads.

### Versioned field validation (Gate 7A)

Each Schema v2 document contains only `instrument` and `survey`; each profile
and nested scientific policy accepts only its declared fields. With
`schema_version: 2`, an unrecognized key in the document, instrument, footprint
(including compound children), survey, tiling and origin, inference, coverage,
Efficient, or export objects is a validation error. Unknown keys are not
discarded or treated as extensions. The declared `export.constant_fields`
object is intentionally free-form because its keys are output column names;
that behavior applies only inside that object.

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
a grid with no polygon-interior cell fails explicitly. Gate 6C validates the
normal 64-per-axis fixtures against independent fine quadrature within 0.5
percentage point; this is a tested policy, not a generic default or a guarantee
for arbitrary caps or unresolved features. A 0.75-cell gap produces 0.78125 pp
error; strong budget coarsening and near-pole geometry retain explicit limits.
See [coverage validation](legacy/GATE6C_COVERAGE_VALIDATION.md) for measured scale,
declination, convergence, phase and budget results. Exact spherical coverage
and adaptive refinement are not implemented.

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

The Gate 6B audit confirms supplemental gap-fill remains only in the frozen
inline v1 rectangle compatibility path; its rectangle spacing and fill behavior
are unchanged. Registered Schema v2 `legacy_splus` stays on its inferred/profile
lattice and may report residual uncovered sampled area. Both the registered
`legacy_splus` and frozen inline v1 selection paths consume the resolved Efficient
policy. Generic occupancy still uses separation divided by basis scale and
`inference.occupancy_tolerance_fraction`; it never applies the compatibility
`0.12°` exclusion. The 1200 candidate caps reject oversized work before mask
selection; they are browser-computation safeguards, not scientific thresholds
or truncation rules. No generic failure in the focused tests requires changing
them. Gate 6C verifies a generic small-camera stop against high-resolution
coverage and marginal gain, with margins comfortably exceeding sampling error;
decisions exactly at a threshold cannot be guaranteed phase invariant.

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
Gate 7A supplies the JSON import/export UI. The legacy tiling model declares
`grid_extent_deg: [1.4,1.4]` and `effective_overlap_arcsec: 120`. Grid extents and
overlap are consumed from survey profile data by `SPLUS_LEGACY_GRID_V1`; `adaptT80SplusV2ToV1` provides the transitional
historical default shape without duplicating those values.

The duplicated 1.4° extents in instrument and legacy survey data deliberately
preserve the inherited Gate 3 compatibility strategy when the linked footprint
is nonrectangular; there is no corresponding private numeric code constant.

T80 plans retain historical row inference, phase behavior, occupancy exclusion,
and supplemental overlap-fill, as well as legacy provenance `region_legacy` and
`region_extended`. New generic plans use `region_lattice` and
`solution: declared_lattice` for declared placement or `extended_existing_grid`
for successful generic alignment, with integer coordinates retained internally in
proposal metadata. No frozen fixture values change.

## Compatibility boundary

Declared tiling, generic footprints, generic existing-grid inference (Gate 5),
generic scale-aware sampling (Gate 6A), and profile-driven selection (Gate 6B)
are operational. Scientific error validation (G6C) passes for the documented
resolved local geometries and policies. Gate 7A profile JSON import/export,
Gate 7B1 registry-backed selection/assignment, and Gate 7B2 instrument/survey
authoring and survey-policy-driven CSV output (Gate 7C) are complete.
Compatibility sampling uses `legacySampleLayout`: registered `legacy_splus`
surveys derive nominal pitch from the smaller legacy grid extent divided by
`target_samples_per_footprint_axis`, and budget from `max_samples`. Bundled T80
and the one-argument/inline v1 compatibility adapters retain the frozen nominal
0.01-degree pitch and 90,000-cell cap. The minimum eight cells per axis and
historical metric shape remain algorithm rules. A legacy budget below 64 is
rejected by the common
validator because the compatibility algorithm requires at least eight cells per
axis. Compatibility inference derives spacing, maximum phase residual, and
occupancy tolerances from their declared fractions times the smaller legacy grid
extent. Median phase residual must be at most half the declared maximum phase
tolerance, preserving the historical two-threshold rule. Enabled state and
anchor/pair minima are consumed from the survey. T80 reproduces exactly 0.05°,
0.1°, 0.12°, 0.01°, and 90,000 cells; no private duplicates of those parameters
remain. Inline v1 calls inherit the validated bundled defaults to preserve their
frozen contract. The minimum eight samples per axis, row grouping, nonrotating
row-wise compatibility inference, search topology, supplemental overlap-fill,
and numerical safeguards remain named algorithm rules. `allow_rotation` is used
by generic lattice inference; legacy_splus remains a nonrotating compatibility
algorithm. Efficient thresholds are consumed from survey data. The local cosine/wrapped-RA approximation remains;
large regions and near-pole planning do not become exact spherical geometry.

## Profile JSON lifecycle and selection

The user-facing file contract is the existing bundled structure:

```json
{
  "instrument": { "schema_version": 2, "id": "camera-id", "display_name": "Camera", "coordinate_frame": "icrs", "footprint": {} },
  "survey": { "schema_version": 2, "id": "survey-id", "display_name": "Survey", "instrument_id": "camera-id", "tiling": {}, "inference": {}, "coverage": {}, "export": {} }
}
```

The empty policy/geometry objects above are placeholders, not a valid profile.
A complete non-T80 example is
`frontend/src/profiles/fixtures/small-camera.json`: a 0.12° circular camera,
oblique lattice, fixed ICRS anchor, and its own inference/sampling/Efficient
policies. The instrument and survey remain separate objects; one file contains
exactly one associated pair, with no new packaging or root-level version.
Both members must explicitly declare numeric `schema_version: 2`. Missing,
string-valued, older, and future versions fail; the loader never guesses a
version or substitutes a default instrument.

`parseProfileJson(text)` parses JSON and calls `validateProfileDocument`, which
uses `validateInstrumentProfileV2` and `validateSurveyProfileV2` for structural
and scientific normalization and verifies the instrument reference. The same
validation handles the build-time bundled JSON object. Unknown fields in every
declared object are rejected; the free-form `export.constant_fields` map is the
only exception. The format defines no general extension mechanism. Known invalid
values are rejected without coercion, including geometry,
degenerate basis vectors, fixed anchors, inference fractions, coverage sampling,
Efficient thresholds, and export policy. `ProfileError` supplies small diagnostic
categories and human-readable explanations for JSON syntax, unsupported version,
structure, geometry, tiling, policy, references, and duplicate IDs.

`ProfileRegistry.registerProfileDocument` validates the entire pair and checks
both IDs before inserting either member. IDs remain unique **within each kind**;
ordinary import rejects any existing instrument or survey ID, even when its
configuration is identical. It never overwrites bundled T80. Conflicts and
invalid data leave the registry unchanged. Registry lookup is exact, listing
is sorted by ID, and registered/returned data is defensively copied. Direct
survey registration still requires an already registered instrument. The file
format's pair reference must resolve to that file's instrument.

In the Survey profile panel, **Import profile** opens a JSON file chooser and
shows success or a useful validation error. Successful imports appear immediately
in the active survey selector and catalogue instrument selectors through the
same `ProfileRegistry` used by planning, inference, coverage, and map footprints.
Import does not implicitly switch the active survey or clear a plan. The active
survey selects the output planning policy; its `instrument_id` resolves the
output instrument, with no independent output-instrument selector. Changing the
active survey invalidates generated proposals. Profiles live only in browser
memory for the current page session plus explicit exported JSON files; reload
restores the bundled S-PLUS survey and T80-South instrument defaults. Bundled,
imported and authored profiles converge to this same validated `ProfileRegistry`.
There is no backend, database or account persistence.

Each catalogue dataset has its own instrument assignment and inference
participation (`auto`, `include`, or `exclude`). The bundled reference catalogue
keeps its T80-South association. When only one instrument is registered, an
arbitrary catalogue retains that unique-instrument convenience default. Once
multiple instruments are available, an arbitrary catalogue requires an explicit
assignment before region planning. Assignment changes update dataset metadata,
leave original CSV rows unchanged, and invalidate generated proposals. `exclude`
removes a dataset from lattice inference only; its assigned footprint still
contributes to coverage and occupied-center exclusion. For generic inference,
`auto` requires the active instrument ID; `include` admits an independent
dataset/instrument group whose centers must still fit the active declared basis.
Groups are never merged into one cloud. All assigned source catalogues contribute
coverage independently of these roles and map visibility. Active output survey
selection does not rewrite source instrument assignments. A catalogue is optional
when the selected survey supports automatic tiling.

**Export survey JSON** downloads the active registered v2 survey together
with its linked instrument as `<survey-id>.json`. Validated profile IDs already
contain only lowercase letters, digits, and hyphens, so no identity mutation is
needed for browser filename safety. IDs must start with a lowercase letter.
`serializeProfile` revalidates and rebuilds
configuration, recursively sorts object keys, retains array ordering and JSON
numeric values, and emits pretty JSON with a final newline. Reimport preserves
scientific configuration and deterministic planning/coverage behavior. To import
an exported T80 file into a session already containing T80, duplicate rejection
is expected; equivalence tests use a fresh isolated registry.

**Create profile** uses two local stages and explicit final actions:

1. Instrument geometry: a canonical `InstrumentProfileV2` with identity,
   rectangle, circle, ordered local tangent-plane polygon, or compound footprint.
   A valid instrument enables **Continue to survey**.
2. Survey policies: a canonical `SurveyProfileV2`, always referencing that draft
   instrument. **Back to instrument** retains both stages; changing the
   instrument ID updates the document reference. Existing registry instruments
   cannot be substituted in this create-only flow.
3. Complete validation and actions: `validateProfileDocument({ instrument,
   survey })` is the same strict authority as imported JSON. **Profile valid**
   applies only to the complete document. **Add profile** validates again and
   calls `registerProfileDocument` atomically. Either duplicate ID fails without
   replacing or partially inserting anything; users can edit and retry.
   **Download profile JSON** calls the canonical `serializeProfile` path without
   registry insertion and can be used solely for a file-based workflow.

The survey form exposes exact Schema v2 identity, inference, coverage and export
fields. Lattice orientation is solely `basis_deg = [[east, north], [east, north]]`
with four directly editable degree values; no separate lattice angle exists.
`region_center` has no anchor fields; `fixed_anchor` stores RA/DEC in ICRS degrees
and has no runtime phase controls. Manual tiling stores only `{ type: "manual" }`:
coverage and manual/imported pointings work, automatic tiling is unavailable.
Choosing manual disables inference and resets its mandatory policy fields to
neutral starter values; hidden incomplete numeric buffers are discarded.

Inference uses `enabled`, the three dimensionless tolerance fractions,
`min_anchor_tiles`, `min_neighbor_pairs`, and `allow_rotation` exactly as in the
schema. Coverage uses relative `target_samples_per_footprint_axis` and the
browser `max_samples` budget, with an optional Efficient policy containing
`min_coverage` and `min_marginal_efficiency`. Leaving Efficient absent remains
meaningful: Complete works, and Efficient planning reports the established
missing-policy error. No Complete knobs or absolute sampling step are authored.

Export authoring includes RA/DEC columns, coordinate format, optional epoch
column/default/allowed values, optional position-angle column and free-form
`constant_fields`. Constant entries support string, finite number and boolean
values; add/remove keys and edit typed values. Existing keys are never silently
overwritten by another add. All column collisions and policy validity use the
shared validator. Optional generated ID/name/group output labels use the same
validation. These declarations are preserved in JSON and drive runtime pointing
CSV immediately after registration and survey selection.

Numeric text that is temporarily incomplete stays in UI-only buffers shared
with the instrument editor; empty text does not become zero and values are not
clamped. Complete-document validation/actions are unavailable until every active
numeric input is complete. Validator messages identify failing fields without a
parallel scientific validation model. Cancel, Close and Escape discard the whole
local draft without changing registry, active survey, assignments, proposals or
coverage. Successful registration refreshes survey and instrument choices, keeps
the current survey selected, and asks the user to select the new one. That
selection uses the existing G7B1 proposal invalidation path.

### Authoring starters and legacy compatibility

No universal scientific defaults are inferred from T80. Editable, labeled UI
starters are a 1° rectangle / square basis, region-centered origin, disabled
inference with zero tolerance fractions and one anchor/pair, 16 samples per
footprint axis, and a 10,000-sample budget. Efficient is absent until requested;
its editable example thresholds are 0.9 and 0.1. A fixed-anchor starter is (0°, 0°).
Epoch, PA column and constants are absent initially. These are draft values only;
scientific consumers read the resulting validated document without fallback
injection. Other instrument geometry examples remain editable. The former 1.4°
rectangle starter was removed; bundled T80 data and scientific behavior are
unchanged.

The public `legacy_splus` schema declares grid extents, effective overlap and the
same policies, but it explicitly selects the historical, nonrotating row/grid
algorithm, phase rules and supplemental overlap-fill. It is not a generic tiling
preset or a way to obtain arbitrary lattice orientation. The create-new editor
therefore offers lattice and manual; known legacy configurations remain fully
supported through bundled profiles and strict JSON import/export. This is an
authoring distinction, not a schema or validator restriction.

Focused authoring tests create a non-T80 rotated fixed-anchor survey through
browser fields, export before registration, reimport in an isolated registry and
compare every policy and deterministic planning result. Additional tests cover
region-centered generation without catalogues, policy consumption, manual
coverage/refusal, duplicate-safe registration, immediate selectors and
back/cancel isolation.

Only declarative configuration is exported. Inferred rotation/phase, runtime
anchors, assignments, inference quality, effective sample step, sample count,
budget-limited flag, actual cell dimensions, catalogue rows, proposals, disabled
and selected tiles, and polygon/UI state are excluded. Declared fixed anchors
and footprint position angles remain configuration and are preserved. Declared
`ExportPolicy` fields are preserved as data and drive the runtime pointing CSV
contract documented below. The pre-G7 inline v1 custom rectangle
editor is no longer exposed in the active planning UI because it bypassed the
selected Schema v2 survey policies. Generic Schema v2 instrument authoring is
available through **Create profile** together with complete survey authoring. Legacy inline APIs remain transitional and do not appear in the registry
selector.

S-PLUS/T80 is the bundled reference profile, available by default for observer
convenience. Its file and user imports share the document validators, registry
representation, and scientific consumers. The legacy UI-shape adapter no longer
restricts scientific use by T80 profile ID. Unknown registered survey IDs fail
explicitly, including in isolated registries; they cannot fall back to private
bundled data. Strategy identity (`legacy_splus`) selects compatibility algorithms,
not instrument or survey names. See the focused tests in
`frontend/src/profiles/document.test.ts` and browser controls in
`frontend/src/App.profile-files.test.tsx`.


## Pointing CSV contract (Gate 7C)

The governing `SurveyProfileV2.export` policy is authoritative for bundled,
imported and browser-authored profiles. The download API resolves that survey by
its exact registry ID and validates the policy again before serialization. Unknown
surveys and invalid policies fail explicitly; there is no S-PLUS fallback. Dataset
instruments and arbitrary source headers never select output format. The workspace
shows the policy's coordinate representation rather than keeping a second format
setting in React state.

`TileRecord.ra_deg` and `dec_deg` remain canonical ICRS decimal degrees, with RA
in `[0,360)` and DEC in `[-90,90]`. Formatting never modifies them. Output labels
`ra_column` and `dec_column` are arbitrary non-empty strings, with no inferred
scientific meaning. `coordinate_format: "decimal"` uses degrees with eight decimal
places and a locale-independent `.` separator. `"sexagesimal"` reuses the trusted
RA-hour/DEC-degree helpers with three decimal places in seconds. Historical sign
conventions remain: negative DEC (including negative zero) has `-`, nonnegative
DEC has no prefix. Rounding near RA 360° may produce `24:00:00.000`, equivalent to
0h and accepted by the existing coordinate parser. No precession is performed.

Absent `epoch` omits the column. When present, `epoch.column` names the output,
`epoch.default` supplies the descriptive value for every row, and the browser may
select only from `epoch.allowed`. A singleton allowed list defines a constant
epoch. Epoch is never read from a source row or interpreted as a coordinate
transformation. The bundled T80 policy supplies `EPOCH=2000`.

Absent `position_angle_column` omits PA. When requested, the pointing must carry
finite `position_angle_deg`: astronomical degrees east of north, matching the
footprint engine. On acceptance the browser copies an explicitly declared
**top-level** output instrument footprint PA when the proposal has no declared PA.
This records the camera orientation already used for that proposal's footprint;
it is independent of lattice basis orientation and inferred rotation. Compound
child rotations remain detector geometry, not camera PA. Circles have no declared
orientation. An absent footprint angle is not promoted to an export default of
zero: a requested PA with no declared value fails with a useful UI error before
creating a download. An explicitly declared zero is valid. PA uses eight decimal
places, with no angle normalization or invented value.

Optional `export.identifiers` adds these declarative output labels:

```json
{ "id_column": "TARGET", "name_column": "LABEL", "group_column": "COHORT" }
```

Each member is optional, but a present mapping must configure at least one
non-empty column. Generated IDs are `PROPOSED_0001`, `PROPOSED_0002`, etc. from the
complete accepted input sequence, before disabled rows are omitted. Names use the
proposal's declared non-empty name, or the generated ID. Group uses the governing
survey ID as an observer-facing output cohort. These values have no planner
meaning. Runtime proposal IDs, source `PID`, and legacy `group_id` are never used
as exported identifiers. Clearing proposals starts a new export sequence; exports
are not intended to maintain identifiers across independent browser sessions.

Columns are ordered explicitly: RA, DEC, optional epoch, optional PA, optional
ID, name, group in that semantic order, then `constant_fields` keys sorted by
Unicode code-unit order. This order is independent of JSON/JavaScript insertion
order and locale. Strict validation rejects unknown mapping fields, invalid
formats, empty labels and any duplicate between coordinates, epoch, PA,
identifiers and constants. Constants allow string, finite number and boolean
values; every row receives the same values, serialized consistently via `String`
(number decimal point, `true`/`false` for booleans). All header and data cells use
CSV escaping: comma, quote, CR or LF causes quotation, and embedded quotes double.
Row separators are CRLF with a final CRLF. Repeated exports of identical accepted
state and policy are byte-for-byte identical.

The browser retains the existing `new_tiles.csv` filename and **enabled accepted
proposals only** workflow. No full-catalogue export exists in this browser version;
source rows are rejected by the pointing exporter and remain immutable for
inspection/planning. Mixed datasets keep their own instruments for coverage and
inference, but accepted additions always use the active output survey policy.
No catalogue is required to plan, accept and export. An empty/all-disabled proposal
set keeps the download button disabled; the serializer also rejects it rather
than creating misleading rows. The existing 500-proposal export limit remains.

### Remaining PID/group compatibility boundary

`science/catalogue.ts` retains `NAME` as an inspection label and constructs a
historical PID-derived `group_id` solely for frozen S-PLUS inference.
`datasets.ts` namespaces that legacy group by upload to preserve independent
catalogues. Only `science/planner.ts`'s `inferLattice`, reached through
`planLegacyRegion` for the declared `legacy_splus` compatibility strategy, consumes
those source groups. Generic `science/lattice-inference.ts` groups by dataset and
instrument identity and ignores PID/group labels. Generic export rejects source
rows and consumes neither PID nor legacy group identity. Test fixtures retain PID
where they freeze T80 behavior or prove generic independence. There is no T80
profile-ID branch in export resolution, row construction or CSV serialization.
The v1 compatibility adapter's historical CSV-shape guard is confined to that
legacy adapter; registered v2 runtime export does not pass through it.

See the [Gate 8 validation matrix](legacy/GATE8_AGNOSTICISM_VALIDATION.md) and
[generic profile authoring guide](legacy/PROFILE_AUTHORING_GUIDE.md). Gate 9 is PASS; v0.3.0 is release ready with
[documented non-blocking limitations](legacy/GATE9_RELEASE_AUDIT.md).
