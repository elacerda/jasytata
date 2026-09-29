# Generic workflow and profile authoring

Jasytata is a browser-based telescope/survey pointing and coverage planner.
An **instrument** defines the camera footprint; a **survey** references that
instrument and defines how to place, infer, evaluate and export pointings.
S-PLUS/T80-South is the bundled reference/default pair. You can plan with another
pair through JSON import or browser authoring, without editing application code.

## Plan a project

1. Use the bundled pair, **Import profile**, or **Create profile** in **Survey profile**.
2. Optionally **Load catalogue** CSV files. RA/DEC can be decimal degrees or
   sexagesimal (RA hours, DEC degrees); map columns/RA units if prompted.
3. Set **Catalogue instrument** on each source dataset. Changing it changes
   footprint interpretation, while original CSV rows remain unchanged.
4. Choose **Inference participation** for each dataset.
5. Select the **Active survey** for output. Its linked instrument supplies the
   new pointing footprint; source instrument assignments remain independent.
6. **Select area** and draw the region; double-click to finalize the polygon.
7. Choose **Complete coverage** or **Efficient coverage**.
8. **Generate plan**, review footprints and metrics, then **Accept proposal** or
   **Cancel preview**. Disable/restore accepted tiles or **Clear proposal** as needed.
9. **Download new_tiles.csv** using the active survey's export policy.

A **new project with no initial catalogue** starts directly with the chosen
profile and region. No inference evidence is needed for declared new-survey
placement. For a manual survey, use **Single tile** or **Import centers**, review
and accept, measure coverage of a selected region, and export; automatic region
tiling is intentionally unavailable.

All assigned source catalogues contribute coverage. Map layer visibility does
not affect science. Inference participation is separate:

| Role | Meaning for generic lattice inference |
| --- | --- |
| `auto` | Eligible when the dataset instrument ID matches the active output instrument ID. |
| `include` | Admit the dataset as an independent group, even with a different instrument; its centers must still fit the active declared lattice. |
| `exclude` | Do not use its centers as inference anchors; coverage and occupied-center exclusion still use them. |

Groups are fitted independently by dataset/instrument identity, not merged into
one cloud. PID is not required. The bundled `legacy_splus` strategy retains its
historical grouping rules; see the [compatibility boundary](../PROFILE_SCHEMA.md#remaining-pidgroup-compatibility-boundary).
Changing an instrument assignment or the active survey invalidates generated
proposals, so choose them before accepting a plan.

## Create or import a profile

**Create profile** opens two stages: instrument geometry, then survey policies.
Fill the geometry and choose **Continue to survey**. **Back to instrument** keeps
the draft. Once the complete pair is valid, **Add profile** registers it;
**Download profile JSON** saves the draft without requiring registration.
Starters are editable examples, not scientific recommendations. Set dimensions,
spacing, tolerances and sampling for your own instrument/survey.

Registration makes the survey and instrument available in their selectors but
does not select the survey automatically. Select it explicitly when ready.
The create flow makes a new pair; it does not edit an existing registered profile
in place. To adapt a saved profile, edit its JSON and use new unique IDs.

Profile JSON contains exactly `{ "instrument": ..., "survey": ... }`; both
members declare numeric `schema_version: 2`. The survey's `instrument_id` must
match that file's instrument ID. **Unknown fields are rejected**, including
misspellings and extra runtime fields. `export.constant_fields` intentionally
allows free-form output column names, with string, finite number or boolean
values. This is not a general extension mechanism.

Duplicate instrument or survey IDs are rejected atomically, even for identical
configuration. Bundled profiles cannot be overwritten. Change both IDs and the
survey reference when importing a variant into the same session. The
[Schema v2 contract](../PROFILE_SCHEMA.md) is authoritative for exact fields,
validation, serialization and runtime exclusions. A complete example is the
[small-camera profile](../../frontend/src/profiles/fixtures/small-camera.json);
its values are an example rather than universal defaults.

Bundled, imported and authored profiles all converge to the same validated
`ProfileRegistry`. They persist only **in the browser session + explicit JSON
files**. **Export survey JSON** saves the active survey with its linked instrument.
Reload restores the bundled default and clears session work. No backend,
database or account persistence exists. Profile files do not save catalogue rows,
regions, inferred phase/rotation, proposals or coverage results; save accepted
pointings separately as CSV.

## Instrument: identity and footprint

Use a unique ID starting with a lowercase letter, followed by lowercase letters,
digits or hyphens, and a readable display name. Coordinates are ICRS; local
footprint dimensions, vertices and offsets are angular degrees in `[east, north]`
about a pointing center.

| Footprint | What to author |
| --- | --- |
| Rectangle | Width along local east and height along local north, before camera PA. |
| Circle | Radius (half the diameter). A circle has no declared PA field. |
| Polygon | At least three distinct ordered local vertices forming a simple, nonzero-area boundary. The closing edge is implicit; do not repeat the first vertex. |
| Compound/mosaic | A union of rectangle, circle or polygon children, each with an east/north offset and optional rotation about its own center. Nested compounds are unsupported. |

Detector gaps in a mosaic remain uncovered; overlapping detectors count once.
For rectangles, polygons and compounds, optional `position_angle_deg` is camera
PA in astronomical degrees east of north: positive angles turn north toward east.
A compound's parent PA rotates both child offsets and shapes. Child
`rotation_deg` and any child footprint PA compose with it; they describe detector
geometry rather than the exported camera orientation.

## Survey: placement and lattice basis

Give the survey its own ID/name and an instrument reference. Choose:

- **Lattice** for automatic region tiling at integer sites of two basis vectors.
- **Manual** for supplied pointings and coverage without automatic tiling.

`legacy_splus` is an explicit compatibility algorithm for historical S-PLUS row
geometry and grouping/inference. Its inferred/profile lattice constrains automatic
region candidates; sampled gaps may remain when no admissible site improves
coverage. It does not synthesize a supplemental phase or dither. It is not a
normal generic authoring preset. The browser create form offers lattice/manual;
bundled and imported legacy configurations remain supported.

A lattice is a repeating set of centers:

```text
P(i,j) = O + i*b1 + j*b2
```

`O` is the origin, and `i,j` are integers. Each `b` is `[east, north]` in local
degrees. Increasing `i` moves by `b1`; increasing `j` moves by `b2`. The vectors
encode spacing **and orientation**. They must be finite, nonzero and
non-collinear. There is no separate lattice PA field or universal overlap value.

| Layout example | `basis_deg = [b1, b2]` | Practical meaning |
| --- | --- | --- |
| Rectangular | `[[1,0],[0,0.8]]` | Centers 1° east apart and rows 0.8° north apart. |
| Rotated rectangular | `[[0.8660254,-0.5],[0.4,0.6928203]]` | The same 1°/0.8° orthogonal steps rotated +30° under the north-toward-east convention. |
| Staggered | `[[1,0],[0.5,0.8]]` | Each successive row shifts east by half the 1° spacing. |
| Triangular / hexagonal-center | `[[1,0],[0.5,0.8660254]]` | Equal nearest-neighbor spacing, with rows separated by √3/2 degrees; hexagonal center packing, not a hexagonal camera footprint. |

For the staggered example, `(0,0)` is `O`, `(1,0)` is `O+[1,0]`, and `(0,1)`
is `O+[0.5,0.8]`. These are local offsets, not raw RA increments; Jasytata applies
its local declination/cosine projection when producing ICRS centers. Rounded
example decimals approximate the exact trigonometric values.

Choose **region center** for a new local plan: the origin is the midpoint of
unwrapped region RA/DEC bounds, not the polygon centroid. Changing the region
can change placement. Choose **fixed anchor** to declare an ICRS RA/DEC site
`(0,0)` and planning-plane reference. The anchor's declination sets the local
cosine scale; it is not an exact global spherical survey grid.

### Camera footprint PA ≠ survey lattice orientation

A camera can be at PA 30° while centers lie on the rectangular
`[[1,0],[0,0.8]]` lattice. Its detector edges rotate, while the center steps stay
east/north. Conversely, a PA 0° camera can use the rotated basis above.

Gate 8's mosaic camera has PA 31°, declared lattice orientation 11°, and inferred
lattice orientation 18°. Its exported PA is **31°**, never the declared/inferred
lattice angle. These are independent physical choices; do not add a lattice PA
field to a JSON profile.

## Survey: inference policy

The profile declares the **fundamental lattice**. Jasytata aligns existing centers
to it; it does not unconstrainedly discover an arbitrary fundamental lattice.
`enabled` controls fitting and `allow_rotation` permits rigid rotation of the
basis without stretching it. Region-centered placement can infer phase. A fixed
anchor stays authoritative at zero phase; rotation, if allowed, is about it.

Spacing, phase and occupancy tolerances are fractions of the shorter basis-vector
length. They govern pair compatibility, center residuals and occupied-site
exclusion respectively. Minimum anchor-site and neighbor-pair counts set required
evidence. Do not confuse this inference scale with the footprint sampling scale.

Missing tiles and harmonics such as `2*b1` or `b1+b2` are supported by a bounded
local fit. Pair offsets are limited to two lattice indices per axis; catalogues
with only larger separations can lack usable evidence. Outliers, symmetry and
bounded hypothesis searches limit robustness. An attempted generic fit with
insufficient/incompatible evidence fails explicitly rather than silently resetting
phase. Disabled inference or no usable centers uses the declared placement.
See [alignment details](../ALGORITHM.md#generic-existing-grid-alignment-gate-5).

## Survey: coverage and Efficient policy

Coverage uses uniform samples of region bounds with declination weights. Its
**characteristic footprint scale** is the smaller rectangle side, circle diameter,
smaller intrinsic polygon bounding extent, or minimum child scale for a mosaic.
Camera PA, rotations and detector separation do not enlarge it.

```text
natural step = characteristic footprint scale / target samples per footprint axis
```

If the natural grid exceeds `max_samples`, the **effective step** coarsens to fit
the browser budget. The budget counts the full bounding rectangular grid,
including cells outside the polygon. Actual cell widths can be smaller than the
requested step because integer rows/columns evenly subdivide the bounds.
The [sampling contract](../PROFILE_SCHEMA.md#coverage-sampling-policy-gate-6a)
describes metadata and the separate legacy layout.

**Complete** targets all selected samples, stopping at completion, candidate
exhaustion or negligible gain. It does not invent off-lattice centers to close
remaining gaps. **Efficient** uses the same candidates/ranking and stops before
the next tile when current coverage is at least `min_coverage` **and** new sampled
physical area divided by output footprint area is strictly below
`min_marginal_efficiency`. Equality remains eligible. Both thresholds are profile
fractions in `[0,1]`; T80's 0.995/0.03 is not a generic default. Without an Efficient
policy, Complete works and Efficient fails explicitly.

Gate 6C measured normal resolved fixtures against independent finer quadrature
within 0.5 percentage point, tested scale/phase/declination and budget behavior,
and checked an Efficient stop with margins beyond measured sampling error.
That is measured evidence, not an arbitrary-profile guarantee. See the
[detailed Gate 6C report](GATE6C_COVERAGE_VALIDATION.md). The
[Gate 8 report](GATE8_AGNOSTICISM_VALIDATION.md) covers T80, small circular FoV,
rotated detector mosaic and non-orthogonal triangular lattice workflows.

The offset-polygon intersection defect is
[resolved in G9B1](V0.3.0_ROADMAP.md#g9b-blocker--polygon-intersection-false-positive).
The [release audit](GATE9_RELEASE_AUDIT.md) records final readiness and operational caps.

### Limits to consider before using a coverage result

- Numerical coverage is sampled, not exact analytic geometry.
- Sub-pitch gaps, thin region structure or small detectors may be unresolved.
- Extreme budget coarsening reduces accuracy; increasing requested density alone
  cannot recover information while the same budget remains limiting.
- Exact threshold decisions can be sensitive to sample placement/resolution.
- Current geometry uses local tangent-plane approximations. Large fields and
  extreme polar regimes are outside validated precision; fine sampling does not
  repair that sky model.

Efficient does not judge the topology or scientific importance of residual gaps.
Inspect the map and metrics against your survey's requirements.

## Survey: pointing export policy

Set RA/DEC column names and `decimal` (degrees, eight decimals) or `sexagesimal`
(RA hours, DEC degrees, milliseconds of seconds). Optional epoch is a descriptive
label with a default and allowed values; it performs no precession. Optional
constant fields are repeated on every row. Optional ID/name/group column mappings
produce acceptance-sequence IDs, proposal names (or IDs) and the survey ID as an
output cohort; they do not copy source PID/group values or affect science.

Optional PA exports **camera/pointing orientation** in degrees east of north.
Acceptance records an explicitly declared top-level footprint PA when needed.
Child rotations and lattice orientation are not substituted. **Missing requested
PA causes explicit failure; no implicit zero is invented.** Declare zero explicitly
if that is the intended camera orientation. Circles have no footprint PA field.

Export contains enabled accepted additions, not original catalogue rows. Output
follows the **active survey profile**, not input catalogue formatting. Columns and
row order are deterministic; repeated downloads of identical accepted state,
policy and epoch are identical. For identical profiles, datasets, region and
strategy, planning is intended to be deterministic in the same software version;
this does not promise bitwise reproducibility across arbitrary future versions.
See the [CSV contract](../PROFILE_SCHEMA.md#pointing-csv-contract-gate-7c) for exact
ordering, escaping, identifier numbering and limits.
