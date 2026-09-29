# v0.3.0 release summary and Gate 9B2 audit

**Gate 9B2 PASS; Gate 9 PASS. Verdict: READY WITH NON-BLOCKING LIMITATIONS.**
Initially audited on 2026-09-28 at `7125181ccb5a4c48a1d8f4d47b86fc456ca051c0`
on `v0.3.0` on `tufao`, including the completed G9B1 polygon-intersection repair.
Final local validation on 2026-09-29 uses the previously validated candidate
`c37ad04943d8a93afd68f5da54ec6884abac2e71` plus the fullscreen stacking fix
and documentation cleanup recorded below. This records readiness before the
release-closure commit/push; no merge, tag, GitHub Release or deployment has
been performed.

## Release summary

v0.3.0 supports generic instrument/survey profiles through **Profile Schema v2**,
with browser authoring, validation, JSON import/export and session selection.
Instruments can declare rectangle, circle, simple polygon or compound/mosaic
footprints, including camera PA and detector transforms. Surveys supply declared
basis-vector lattices and bounded alignment inference, scale-aware sampled
coverage policies, manual workflows and profile-driven pointing CSV export.
Mixed catalogues retain independent instrument assignments; an empty catalogue
is a supported starting point. The bundled S-PLUS/T80-South profile uses the same
document validator/import contract as user profiles and retains frozen v0.2.0
compatibility. G9B1 fixes physical polygon overlap without changing coverage,
lattice, coordinate or export conventions.

The application remains browser-only React/TypeScript/Vite hosted as static
GitHub Pages files, with Aladin Lite for sky visualization. Local-plane sampled
coverage is not exact spherical coverage; thin/sub-pitch structures, strong
budget coarsening, large fields and extreme polar regimes remain outside the
validated precision model. Inference aligns a declared lattice rather than
discovering arbitrary grids. Complete coverage can leave gaps when available
sites cannot cover them. Profiles/plans have session lifetime; save JSON/CSV
before reloading. This is not an observing scheduler. See the
[profile guide](PROFILE_AUTHORING_GUIDE.md) and
[Gate 8 evidence](GATE8_AGNOSTICISM_VALIDATION.md).

## Version, dependencies and clean validation

The canonical application version was still `0.2.0` in `frontend/package.json`
and the two root-package entries of `frontend/package-lock.json`; all three now
read **0.3.0**. There is no application-version literal/badge in the UI or
workflow. README describes the current product; its dynamic Release badge
continues to describe published releases. Historical v0.2.0
references describe compatibility, not the current application version.
**Profile Schema stays 2** in bundled/imported profiles and validators.

`make clean` removed only project dependency/build artifacts, then `make setup`
performed `npm ci`. The sandbox initially denied esbuild process execution;
the same install succeeded with execution permission. This was an environment
restriction, not a lockfile failure. Local tools: Node 22.22.3 / npm 12.0.2;
Pages uses Node 24. No preexisting dist or dependency installation supplied the
result. The lockfile is present/consistent, `npm ls --all` succeeds, and there
are no missing required runtime dependencies. Package manifests and dependency
lock entries have no dependency changes relative to the v0.2.0 baseline; only
the application-version entries change in this gate.

The audit already invoked by npm reports five development-tool findings:
three moderate, one high and one critical, in Vitest/mocker, vite-node's nested
Vite and esbuild. The critical Vitest advisory concerns its UI server; this
repository runs `vitest run` and does not deploy a test/development server.
`npm audit --omit=dev` reports **zero vulnerabilities**. These are recorded
maintenance limitations, not vulnerabilities in the deployed static artifact.
No upgrades or new scanner were introduced; review the dev-tool advisories in
a separate dependency-maintenance task before exposing such servers.

Validation: `git diff --check`, `make test`, `make lint`, `make typecheck`,
`make build`, and `make check` PASS. **462 tests across 29 files** remain green,
including all 24 G9B1 regressions and all four Gate 8 test files (44 tests).
No scientific production code or fixture expectations changed in G9B2;
an additional standalone Gate 8 rerun was therefore unnecessary. The normal
full suite includes the matrix, T80 compatibility and bundled/imported-profile
equivalence tests. The focused `frontend/src/styles.test.mjs` regression verifies
that Aladin fullscreen stacks above the Jasytata topbar; real-artifact smoke
supplements the existing integration coverage. The final fix changes only CSS
stacking, with no scientific/planning behavior or fixture changes.

## Bundle decision

Production output: JavaScript **2,688.09 kB / 932.71 kB gzip**, CSS
**34.86 kB / 7.92 kB gzip**, and the logo **1,053.02 kB**.
Vite's 500 kB chunk warning is classification **A: acceptable known v0.3.0
limitation**. A temporary Vite `generateBundle` diagnostic (no config edits)
measured rendered modules before final chunk minification:

| Contributor | Rendered code | Approximate share |
| --- | ---: | ---: |
| One `aladin-lite/dist/aladin.js` module | 2,394,189 bytes | 84.4% |
| All application modules | 290,781 bytes | 10.3% |
| React DOM | 134,788 bytes | 4.8% |
| React, scheduler and helpers | 15,915 bytes | 0.6% |

These shares are module diagnostics, not exact post-minification/gzip
attribution. The runtime graph contains one Aladin module and one React/React
DOM implementation; nested tooling Vite/esbuild copies are not in production.
No accidental duplicate runtime library or test fixture was bundled. The
installed Aladin distribution is already a large packaged visualization
module; speculative splitting would change map initialization for limited
known benefit. Real-browser load/planning/export succeeds. Future work should
measure cold-load cost on slower devices/networks and evaluate Aladin loading
and logo compression separately, with the same static/base-path smoke.
The chunk threshold, fonts and suppression configuration remain unchanged.

## Static build, browser and deployment

`vite.config.ts` correctly emits `/jasytata/` for builds and `/` for development.
`main.tsx` mounts the React application; `npm run build` runs `tsc -b && vite
build`. Built HTML points to `/jasytata/assets/...`; the imported logo and
reference catalogue resolve under the same base. A plain Python static HTTP
server mounted dist at `/jasytata/`; HTML, JS, CSS, logo and
`/jasytata/data/tiles_nc.csv` all returned 200. The bundled profile is embedded
in JS and loaded/validated without a separate HTTP endpoint. No FastAPI,
Docker, backend or server computation was used.

The computer-use connector had no browser available. The installed Chrome
headless was successfully automated through DevTools with its sandbox active
and an isolated temporary profile. Screenshots and DOM observations confirmed
the real production shell, logo, sky map and default S-PLUS/T80 instrument.
Actual canvas clicks finalized a four-vertex sky polygon, generated four T80
pointings with 100% sampled coverage, accepted them and downloaded a 142-byte
`new_tiles.csv` containing `RA,DEC,EPOCH` and four rows. A generic circular
Schema v2 file was imported and selected with its declared fixed-anchor lattice.
The static reference added 4,774 rows; the only application-level request during
that action was `/jasytata/data/tiles_nc.csv`. Existing real-App integration
tests also exercise generic planning/acceptance/export, mixed catalogues and
the complete Gate 8 workflow matrix. This is automated headless validation,
not a manual desktop usability review. Subsequent manual local production-artifact
validation found Aladin fullscreen below the topbar (`z-index: 5`): Aladin's
fullscreen class had no stacking level. `.aladin-fullscreen { z-index: 1000; }`
fixes the defect. Entering fullscreen, using its exit control and returning to
the normal view were verified manually. The artifact was served by a plain
Python HTTP server with dist copied into `/tmp/jasytata-local/jasytata/`, matching
the production `/jasytata/` layout. `make preview` did not reliably reproduce
that layout (HTML loaded but production JavaScript returned 404), so README
now documents the mounted-artifact procedure. No backend calls were made.

All requested error smokes ran against that production artifact:

| Input/action | Visible result |
| --- | --- |
| Malformed JSON | `Malformed profile JSON: check JSON syntax` |
| Schema 3 | `Unsupported schema_version: 3; expected 2` |
| Duplicate generic profile | Registered instrument-ID conflict |
| Manual survey with a selected region | Explicit unavailable message; Generate plan disabled |
| One anchor with inference requiring four | `insufficient_anchors`; no silent declared-origin fallback |
| Export requiring undeclared camera PA | Explicit missing `camera_pa`; no additional CSV download |
| CSV with multiple available instruments | Choose/assign instrument alerts; planning disabled until assigned |

There were no uncaught exceptions, React state errors, failed application
assets, dynamic-import/base-path errors or backend requests. Headless software
WebGL emitted ReadPixels performance warnings. One external IRSA HiPS mirror
returned a CORS failure while other imagery loaded and the map/workflow
remained usable; external imagery availability remains a visualization
limitation. Chrome also requested an unreferenced root `/favicon.ico` (404);
this is its automatic optional favicon lookup, not a broken built-asset
reference. Neither finding affected planning/export.

Initial sandbox DNS and the web-fetch tool could not reach the public site.
Permitted direct HTTP checks subsequently returned 200 for
<https://elacerda.github.io/jasytata/>, its current JS/CSS/logo and reference CSV.
Its asset hashes/sizes differ from this candidate and it has no exposed app
version; this verifies existing deployment health, not v0.3.0 publication.
GitHub's Pages API confirms `build_type: workflow`. The existing
`.github/workflows/pages.yml` triggers on pushes to `main` or manual dispatch,
installs from the lockfile on Node 24, runs tests/lint/typecheck/build, uploads
only `frontend/dist`, then deploys with Pages/id-token permissions. All five
referenced action tags exist. Merging the candidate into main will use this
path; no deployment redesign or execution was performed.

## Compatibility, transitional code and operational limits

CRG-first navigation identified planning/profile/editor/export paths before
source inspection. Initial graph metadata matched HEAD (901 nodes, 67 files).
The version-file impact query is low risk but package JSON/docs are not indexed;
its empty radius is not proof of no consumers. Direct manifest/build checks
complete that gap. CRG also missed some imported-symbol relationships (for
example `resolveProfile` is called by the planning bridge); exact source and
tests take precedence. Final change/review queries and graph refresh cover the
original docs/version-only change. The final closure also reviews the CSS/test
surface directly because CSS is not indexed. CRG's radius estimate reports approximately
48,631 saved tokens against broad context; this is an indicative tool estimate,
not measured net savings across the audit.

| Finding | Classification and release decision |
| --- | --- |
| v1 `TilingProfile`, `resolveProfile`, inline `RECT_GRID_V1`, T80 adapter | Required compatibility: retained by frozen planner/coverage/adapter tests; absent from active authoring UI |
| `loadDefaultProfile`, `getProfiles`, `validateCustomProfile` facade exports | Safe transitional/obsolete active-UI wrappers: no App caller, no HTTP/backend behavior; unused exports are tree-shaken, retained under production freeze |
| Optional occupied-inline-ID guard on file import | Safe transitional compatibility, not used by current App; retained |
| Profile draft/editor state | Active Schema v2 authoring state, not the removed rectangular editor |
| PID-derived `group_id` | Required frozen legacy inference compatibility, namespaced by dataset |
| T80 constants/aliases | Validated bundled profile, default/reference assignment and display text |

No dangerous dead helper, stale feature flag, unused-local error or legacy
backend dependency was found. Nothing was removed for cleanliness. Generic
planning/inference/export dispatches by declared policy/model, not the spelling
of S-PLUS/T80 IDs; Gate 8 renaming/PID-independence regressions pass. Remaining
`custom` plus `RECT_GRID_V1` checks are the frozen inline adapter, while a Schema
v2 survey named `custom` is an ordinary registry entry.

The contextual sensitive-constant search found 1.4° geometry, 0.01° historical
pitch, 0.05°/0.10°/0.12° inference/occupancy equivalents, 0.995/0.03 Efficient
thresholds and the 90,000 sample budget sourced from the validated importable
T80 profile. Generic surveys consume their own policies. Remaining numerical
`0.01` uses are the documented cosine floor/local-plane numerical safeguard
and a legacy grid minimum extent, not a generic T80 coverage pitch. The App's
`1.4` SVG path coordinates are icon geometry. Algorithm tolerances, minimum
legacy grid rows and operational search bounds are distinct from telescope
configuration. No scientific-value migration was needed.

Runtime caps remain **1,200 lattice search/candidate sites**, **500 proposed
records for coverage/export**, **20,000 existing records**, and each survey's
declared full-grid sample budget. Oversized candidate/record work throws an
explicit error surfaced by the UI; sample-budget coarsening is reported in
diagnostics and can reduce precision. Generic inference keeps 32 consensus
seeds and the documented bounded neighbor hypotheses; these bound fitting
robustness rather than silently promising arbitrary-grid discovery. Ordinary
Gate 8 fixtures have 15/27/70/27 candidates and 15/24/13/23 accepted pointings;
generic grids use 6,408/8,880/6,020 cells below their 20,000-cell budgets.
No ordinary fixture hits a cap. Large plans should be divided into smaller
regions/exports rather than relying on truncation.

## Documentation and repository state

This file remains the v0.3.0 release summary and detailed audit under
`docs/legacy/`, alongside the retained development evidence; no duplicate
changelog was added. README now focuses on the product and links only the T80
guide, Profile Schema and algorithms. `docs/PROFILE_SCHEMA.md` still documents
Schema v2. Moved-document links and relative references are repaired; current
T80 workflow content is preserved. All 56 local Markdown/HTML links and anchors resolve
after the archive moves. Application metadata is 0.3.0; schema semantics remain
v2. The final build retains `/jasytata/` and includes the fullscreen stacking CSS.

Impeccable triage: **fixed: fullscreen stacking issue; suppressed: none; left standing: Inter warning**.

`frontend/dist` and `frontend/node_modules` are ignored and untracked by policy;
temporary browser/analysis artifacts live under `/tmp`. The final tracked diff
contains only the fullscreen CSS/regression, documentation moves/rename, README
cleanup, necessary link/factual corrections and this final audit update.
`.codex/` and `poly.txt` remain untracked and
untouched. Known non-blocking limitations are bundle/cold-load size, dev-tool
audit findings, external imagery availability, sampled/local-plane geometry,
bounded inference, runtime caps and session-only persistence.
