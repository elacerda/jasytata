# Product

Jasytata is a browser-based telescope/survey pointing and coverage planner.
It helps astronomers and survey operators inspect existing coverage, propose
additional pointings, or start a new project with no initial catalogue.
S-PLUS/T80-South is the bundled reference/default profile.

## Product invariants

- Static/browser-only operation: React, TypeScript, Vite and Aladin Lite, hosted
  on GitHub Pages. Catalogue parsing, profile validation, inference, planning,
  coverage and export run locally. No API backend, database or account persistence
  exists; external astronomy services supply map imagery.
- Original source catalogue rows and metadata remain unchanged.
- Each dataset has its own instrument assignment. Datasets may use different
  instruments; changing an assignment changes footprint interpretation rather
  than source rows. Selecting the active output survey does not rewrite them.
- Source coverage and inference participation are independent. Assigned source
  footprints contribute coverage even when excluded from inference; map visibility
  is only a display choice. `auto` uses the active instrument identity for generic
  inference, `include` admits an independent dataset/instrument group for a
  declared-lattice fit, and `exclude` removes inference evidence only.
- The active survey supplies output tiling, inference, coverage and export
  policy; its instrument reference supplies the output footprint.
- Proposals remain reversible: preview/cancel, accept, disable/restore and clear.
  Only enabled accepted proposals enter pointing export.
- Bundled, imported and browser-authored profiles converge to the same validated
  `ProfileRegistry`. Profiles persist only in the browser session and explicit
  JSON files; accepted pointing CSV is a separate deliverable.
- Coverage is a sampled estimate with visible assumptions and limits.
- Identical profiles, datasets, region and strategy, with the same accepted state
  and export options in the same software version, are intended to produce
  deterministic planning/export. This does not promise bitwise reproducibility
  across arbitrary future versions.

## Generic capability

Instruments support rectangular, circular, polygonal and compound/mosaic
footprints. Surveys declare a basis-vector lattice with region-centered or fixed
placement, or intentionally use manual tiling. Camera footprint PA is independent
of lattice orientation. Generic inference aligns existing centers to the declared
fundamental basis, with optional policy-controlled rotation and runtime phase;
it does not unconstrainedly discover an arbitrary lattice.

Complete targets all selected samples. Efficient uses the active survey's
coverage floor and marginal physical efficiency threshold. Export follows that
survey's configured columns and representation, independently of input headers.
Manual surveys support imported/manual pointings and coverage; automatic region
tiling is intentionally unavailable.

See the [generic workflow and authoring guide](docs/legacy/PROFILE_AUTHORING_GUIDE.md),
[Schema v2 contract](docs/PROFILE_SCHEMA.md) and
[algorithms](docs/ALGORITHM.md) for the operating details.

## Bundled T80 compatibility behavior

The bundled S-PLUS/T80-South JSON uses the same validators, registry and consumers
as user profiles, with `legacy_splus` explicitly selecting a compatibility
algorithm. Its 1.4° square footprint, 120″ effective overlap, historical row-wise
inference/grouping, supplemental gap-fill and default `RA,DEC,EPOCH=2000` output
are regression-protected behavior rather than universal product requirements.
Historical PID-derived `group_id` remains isolated to catalogue/legacy inference;
PID is not a generic scientific requirement. Generic inference uses dataset and
instrument identity, and optional export identifier mappings have no planner
meaning. Concrete observer instructions remain in the
[T80 guide](docs/T80_SOUTH_USER_GUIDE.md).

## Scope and limitations

Jasytata is not an observing scheduler. Exposure-time optimization, filter
sequencing, airmass, Moon constraints, weather, mount constraints, queue scheduling
and observatory control are out of scope.

Numerical coverage is sampled, not exact analytic geometry. Sub-pitch geometric
structure may be unresolved, extreme budget coarsening reduces accuracy, and
exact threshold decisions can be sampling-sensitive. Geometry uses local
tangent-plane approximations; large fields and extreme polar regimes do not
have validated precision. Complete does not invent extra generic lattice sites
to close gaps, and Efficient does not judge their scientific importance.
The polygon-origin false-positive in region intersection/contributor counts
was repaired in G9B1; the
[historical record](docs/legacy/V0.3.0_ROADMAP.md#g9b-blocker--polygon-intersection-false-positive)
documents the reproduction and regression coverage.

## Validation evidence

- [Gate 6C measured coverage validation](docs/legacy/GATE6C_COVERAGE_VALIDATION.md):
  normal resolved fixtures meet the 0.5-percentage-point criterion against
  independent finer quadrature; unresolved gaps, budgets and polar limits remain.
- [Gate 8 agnosticism validation](docs/legacy/GATE8_AGNOSTICISM_VALIDATION.md): T80,
  small circular FoV, rotated detector mosaic and triangular lattice through
  registry, planning, coverage, review and export.
- Historical `frontend/src/data/golden.json` and current
  `frontend/src/data/planner-contract.json`: frozen compatibility evidence.

Gate 9 is PASS with documented non-blocking limitations; see the
[final audit](docs/legacy/GATE9_RELEASE_AUDIT.md).
