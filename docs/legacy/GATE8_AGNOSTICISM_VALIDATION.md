# Gate 8 — Telescope/survey agnosticism validation

**PASS for the published v0.3.0 sampled local-plane support model.**
System under test starts at `f96d6fc` on `v0.3.0`.
Executed on `tufao`, 2026-09-28. Gate 9 remains open.

## Profiles and evidence

| Profile | Document / survey ID | Physical geometry | Placement / inference | Output |
| --- | --- | --- | --- | --- |
| A: S-PLUS/T80-South | Bundled `frontend/src/profiles/splus-t80-south.json`; `splus-t80-south` | Frozen 1.4° square | `legacy_splus`, historical inference | `RA,DEC,EPOCH`; decimal/sexagesimal compatibility |
| B: small circular survey | `frontend/src/data/gate8/circle.json`; `g8-circle` | 0.08° radius; 9.6′ diameter | 0.1° square basis; region center; generic rotating inference | `ALPHA,DELTA`; decimal; no epoch |
| C: rotated mosaic survey | `frontend/src/data/gate8/mosaic.json`; `g8-mosaic` | Two separated detectors: rectangle + polygon; offsets; +12°/−8° child rotations; parent PA 31° | 0.17°/0.15° basis at 11°; region center; generic rotating inference | `RA_HMS,DEC_DMS,PA,SURVEY`; sexagesimal; constant `G8-MOSAIC` |
| D: triangular wide survey | `frontend/src/data/gate8/triangular.json`; `g8-triangular` | 0.6° radius circle | `(0.8,0)`, `(0.4,0.4√3)`; region center; generic phase inference, rotation disabled | `RA_DEG,DEC_DEG,FRAME_EPOCH,TARGET,LABEL,PROGRAM` |

Validation profiles remain test fixtures. The default production preset remains
the actual bundled T80 document. Fixture provenance and catalogue construction
are documented in `frontend/src/data/gate8/README.md`; numeric results are asserted
from `results.json` in that directory.

## Integration matrix

| Capability | T80 | Small circle | Rotated mosaic | Triangular lattice |
| --- | --- | --- | --- | --- |
| Strict document → registry; canonical roundtrip | PASS | PASS | PASS | PASS |
| Zero catalogue → selection → plan → review/accept → coverage → CSV | PASS | PASS | PASS | PASS |
| Catalogue parsing, dataset assignment, immutable rows | PASS | PASS | PASS | PASS |
| Existing survey extension through active profile | PASS, frozen holdout | PASS | PASS | PASS, nonorthogonal basis |
| Complete sampled completion, deterministic order | PASS | PASS | PASS | PASS |
| Efficient policy integration | PASS, frozen previous suite | PASS | PASS | PASS |
| Native Aladin selection and physical render paths | PASS | PASS, 97-vertex circle | PASS, two separate rotated detector paths | PASS, 97-vertex circle |
| Manual and imported centers → review/cancel/accept/export | PASS | PASS | PASS | PASS |
| Fresh-state repeatability / byte-identical downloads | PASS | PASS | PASS | PASS |
| No-PID scientific workflow | Legacy boundary retained | PASS | PASS | PASS |
| Authoring/import path | Bundled common loader | PASS, G7B2 authored + G7A imported | PASS, G7A imported | PASS, G7A imported |

This combines real App integration, native Aladin structural tests, and scientific
integration across registry, CSV parser, datasets, planner, inference, coverage
and export. App tests retain the actual scientific APIs; only the remote map is
replaced with its render props. Separate native Aladin tests mock the external
library and inspect the actual polylines sent by `AladinMap`. No screenshot
comparison or second coverage implementation was introduced.

## Measured results

Empty-project selections complete under the sampled model:

| Profile | Candidates | Accepted Complete | Coverage | Accepted Efficient | Efficient coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| T80 | 15 | 15 | 100% | Frozen prior tests | Frozen prior tests |
| B | 27 | 24 | 100% | 12 | 94.132% |
| C | 70 | 13 | 100% | 9 | 99.156% |
| D | 27 | 23 | 100% | 11 | 94.217% |

Efficient floors/marginal thresholds are B `(0.8,0.25)`, C `(0.95,0.02)`,
D `(0.9,0.12)`. Tests verify remaining marginal gains against the existing masks
and physical `footprintArea`, and change policies to demonstrate different plan
sizes. Complete is unchanged by the restrictive Efficient policy.

| Profile | Characteristic scale (°) | Natural / effective step (°) | Samples / cap | Budget limited |
| --- | ---: | ---: | ---: | --- |
| B | 0.16 | 0.005 / 0.005 | 6,408 / 20,000 | false |
| C | 0.26 | 0.008125 / 0.008125 | 8,880 / 20,000 | false |
| D | 1.2 | 0.0375 / 0.0375 | 6,020 / 20,000 | false |

All ordinary fixtures stay below the 1,200 candidate and 500 export/proposal
limits; no cap truncation occurs. T80 retains its historical sample layout and
metric shape rather than generic sampling metadata.

B/C/D each recover nine inliers, 20 compatible pairs, phase `(0.2,0.3)`, integer
assignments and missing-cell continuation through the Gate 4 generator. Additional
inferred rotations are 13°/7°/0°, respectively. RMS residual fractions are about
`3.14e-12`, `2.09e-12`, `4.17e-13`. Extension accepts 14/7/13 new pointings and
reaches 100% sampled coverage. These results also run through CSV upload,
instrument assignment, active survey selection, proposal acceptance and download
in App. Insufficient/incompatible evidence explicitly throws; no declared-phase
fallback occurs. Strictly validated disabled-inference and manual variants prove
declared-lattice continuation and explicit automatic-planning refusal.

## Cross-cutting checks

- Mixed coverage: B circular source + D wide circular source + C mosaic output.
  Two source footprints cover 72.162% initially; seven C proposals reach 100%.
  The existing Gate 6 reference grid/mask helpers agree within 0.5 percentage
  points. Deliberately substituting C geometry for source instruments changes
  coverage by more than ten percentage points. Source values/assignments survive
  planning, acceptance, export and proposal removal.
- Resolved mosaic gap: a 0.04° selection at the empty camera center has zero
  single-pointing coverage; small selections at both rotated detector centers
  have full coverage. Single-pointing coverage of the larger C region is 26.784%,
  agreeing with the finer reference within 0.5 percentage points. Rendering uses
  two paths rather than a filled enclosing polygon.
- PA independence: rendered camera uses 31°; declared lattice is 11°; inferred
  lattice is 18° (11° + 7°). Accepted manual/imported/automatic pointings export
  `31.00000000`, never 11°, 7° or 18°.
- RA=0: B selects a region crossing zero at DEC −32°, enumerates sites on both
  sides, covers it, renders finite short wrapped edges and downloads canonical
  coordinates. Display vertices can round to 360 at machine precision; this
  does not alter canonical pointing centers or exported coordinates.
- Moderate declination: B −32°, C −25°, D +42°. Tests verify finite centers and
  local east/north basis equations, followed by canonical export roundtrips.
- Reversibility: generate/cancel, generate/accept/clear, disable/restore proposals
  and repeated downloads. Coverage responds to toggles and restores exactly.
  The product exposes disable/restore for proposals; original catalogue rows
  remain immutable rather than acquiring a new disable workflow.
- Authoring: B's actual two-stage browser editor produces the same geometry,
  tiling, inference, coverage and export policy as its fixture; registered output
  executes the same plan and byte-identical CSV. Empty optional descriptions do
  not affect scientific equivalence. G7A imports B/C/D through actual file bytes.
- Repeatability: fresh registries/App mounts reproduce candidate centers,
  proposal order, accepted order, coverage and CSV bytes for all four profiles.
  Inference repeats from fresh catalogue/registry state as well.

Representative exact first CSV rows:

```csv
ALPHA,DELTA
0.00000000,-32.10000000
```

```csv
RA_HMS,DEC_DMS,PA,SURVEY
10:00:00.000,-25:00:00.000,31.00000000,G8-MOSAIC
```

```csv
RA_DEG,DEC_DEG,FRAME_EPOCH,TARGET,LABEL,PROGRAM
73.92349382,42.00000000,J2000,PROPOSED_0001,PROPOSED_0001,g8-triangular
```

Headers, representative values, acceptance ordering and coordinate roundtrips
are asserted. Mixed-source export follows C's policy; source quality/PID/group
formats do not leak into new accepted pointings.

## T80 and scientific boundary audit

The actual 4,774-row reference catalogue is parsed/assigned. Frozen historical
holdout expectations remain: 14 new pointings, `extended_existing_grid`,
historical required centers, sample step 0.0119°, and 100% sampled completion.
App's reference-loader holdout subset is reviewed/accepted/downloaded; the
scientific integration verifies decimal and sexagesimal coordinate roundtrips
and CSV order. Previous frozen tests additionally retain the full-catalogue
large-overlap regression, exact formatting and observer workflow expectations.
No frozen expectation was edited.

CRG callers and source inspection confine PID-derived `group_id` to CSV parsing
and historical `inferLattice` grouping, reached through `planLegacyRegion`.
Generic `inferSurveyLattice` groups by dataset/instrument identity and ignores
PID/group metadata. B/C/D full workflows contain no PID; additional tests rename
profiles and inject unrelated PID/group values while preserving scientific
outputs. Generic dispatch uses declared tiling type, not T80 profile spelling.
Bundled defaults and explicit v1 compatibility adapters retain their documented
legacy configuration path; registered Schema v2 science uses profile values.

## Production correction

One reproducible operational defect was found before production was changed:
ordinary C planning repeatedly integrated the same adaptive detector-union area
inside every candidate/ranking iteration. The unfixed matrix did not complete
within a 50-second investigation run. A focused regression with three candidates
recorded nine calls where one integration suffices; it failed before the fix.

The narrow correction in `science/coverage.ts` computes that same area once per
`greedyChoose` and once per `measureMetrics`, passing the scalar to outside-area
and marginal-efficiency calculations. No global cache, quadrature change,
constants, geometry, scoring, tolerance or fixture expectation was altered.
The regression now verifies one call per operation. This addresses the existing
generic-compound/interactive planning contract and Gate 8 runtime sanity.

Other initial failures were test assumptions: import notices contain an explanatory
suffix; native selection preserves coordinates rather than optional null labels;
the first manual T80 test center lay outside its selected region and was moved
inside that unchanged frozen region. RA display endpoint rounding is described
above. These were corrected in new tests without changing production geometry,
sampling, the validation instruments or frozen expectations.

## Validation and review

| Required command | Result |
| --- | --- |
| `git diff --check` | PASS |
| `make test` | PASS: 437 tests, 27 files, about 44 seconds |
| `make lint` | PASS |
| `make typecheck` | PASS |
| `make build` | PASS; known >500 kB warning |
| `make check` | PASS on `tufao`; all 437 tests and lint/typecheck/build |

All 393 previous tests remain green. A separate run of the 44 Gate 8 tests
passes in about 14 seconds with two Vitest workers. Matrix operations and sample
arrays remain practical after the area correction; there is no formal benchmark.
The Gate 8 matrix adds 44 tests: 25 scientific integration, one focused area
regression, 14 App workflows and four native Aladin integration cases.

CRG was used first and confirmed HEAD freshness, then for symbol/relationship
navigation, production impact analysis, change detection and review context.
Its pre-fix impact estimate saved approximately 5,934 tokens (97%); change
detection estimated 18,994 (99%) and review context 6,083 (98%). These tool
estimates overlap and are not an additive measured saving. Untracked fixtures
and tests are directly inspected when absent from the initial graph. The final
graph is rebuilt after review (836 nodes, 15,645 edges, 62 indexed files). It
does not include the untracked new tests/fixtures, which are inspected directly.
No unexpected production caller requires a
different physical area. The new direct `measureMetrics` regression and full
workflow tests address the initial graph's caller-only test-gap flags.

Supported-model limits remain those of Gates 3/6: sampled local-plane coverage,
not exact continuous/spherical coverage; finite display circle sampling;
deterministic adaptive compound union area; no assurance of sub-pitch gap
resolution; budget coarsening and extreme polar regimes do not acquire new
accuracy guarantees. Ordinary fixtures above stay within the supported regime.

Gate 9 retains documentation/release work and the known Vite >500 kB warning
(bundle about 2,687 kB, gzip 932 kB). Impeccable triage: **fixed: none;
suppressed: none; left standing: Inter `overused-font` warning**. Fonts and
suppression rules are untouched. No commit, push, backend, persistence or later
scientific feature is introduced.
