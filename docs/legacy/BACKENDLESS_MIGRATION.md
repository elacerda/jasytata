# Migration notes and backendless history

## v0.2.x to v0.3.0

- **Existing T80 users:** the bundled S-PLUS/T80-South profile remains selected by
  default; catalogue loading, region planning, proposal review and enabled-addition
  export remain the observer workflow. Scientific compatibility is preserved.
- **New capability:** generic instruments/surveys, mixed catalogue assignments,
  a new project with no initial catalogue, JSON profile import/export and browser
  authoring. See the [generic guide](PROFILE_AUTHORING_GUIDE.md).
- **Profile format:** new public profile files use Schema v2, one instrument and
  its associated survey. There is no promised migration of hypothetical publicly
  released v0.2.x profile files; transitional inline v1 APIs are a compatibility
  boundary, not the file format.
- **Backend:** still none. React/TypeScript/Vite runs in the browser, with static
  GitHub Pages hosting and no database/account persistence.
- **Source rows:** existing catalogue CSV values are unchanged. Assigning an
  instrument changes their interpreted footprints, not their source data.
- **Visible terminology:** **Survey profile**, **Active survey**, **Catalogue
  instrument**, **Inference participation**, **Complete coverage** and
  **Efficient coverage** distinguish output policy, source geometry and inference.
- **Pointing export:** format now belongs to the active survey rather than an
  independent download setting. The bundled default remains decimal
  `RA,DEC,EPOCH=2000`; a sexagesimal variant declares that format in its profile.
  Save/select variants before planning because a survey change clears proposals.

Profiles live only in the browser session and explicit JSON files. Save accepted
pointings as CSV separately. Consult the [T80 observer guide](../T80_SOUTH_USER_GUIDE.md)
and [Schema v2 contract](../PROFILE_SCHEMA.md).

The sections below record the earlier backend removal; they are historical
provenance, not current backend/Docker deployment instructions.

## Former architecture

The original Jasytata deployment used a React/Vite frontend backed by a stateless FastAPI application. Python handled profile validation, coordinate and catalogue parsing, legacy grid generation, lattice inference, proposal selection, sampled coverage, and CSV serialization. The Docker runtime included Python, NumPy, Astropy, Pydantic, and FastAPI and served both the API and built frontend.

## Final architecture

Jasytata is a static React and TypeScript application hosted at <https://elacerda.github.io/jasytata/>. All Jasytata scientific computation runs in the browser. The production build uses Vite base `/jasytata/`; local development uses `/`. The application requires no Python runtime, FastAPI, NumPy, Astropy, backend server, database, Docker runtime, Orion deployment, secrets, or server filesystem.

| Former responsibility | Current browser implementation |
| --- | --- |
| Installed profile listing and validation | `frontend/src/profiles` |
| Reference and uploaded catalogue parsing | `frontend/src/science/catalogue.ts`; static reference CSV at `frontend/public/data/tiles_nc.csv` |
| RA/DEC parsing and formatting | `frontend/src/science/coordinates.ts` |
| Proposal center creation | `frontend/src/science/catalogue.ts` |
| Legacy and rectangular tile grids | `frontend/src/science/grid.ts` |
| Polygon validation, bounds, footprint intersection, lattice inference, proposal planning | `frontend/src/science/geometry.ts` and `planner.ts` |
| Sampled existing and proposed coverage | `frontend/src/science/coverage.ts` |
| CSV serialization and browser download | `frontend/src/science/export.ts` and Blob/Object URL in `frontend/src/api.ts` |
| Static site routing and assets | GitHub Pages serves Vite output from `frontend/dist` |

`frontend/src/api.ts` remains an async UI facade. It calls local TypeScript modules. The former `/api/*` responsibilities have no Jasytata HTTP equivalents. The only application `fetch` loads the bundled catalogue through `import.meta.env.BASE_URL`.

## Scientific parity and fixture provenance

`frontend/src/data/golden.json` was generated from the former Python scientific reference and the bundled S-PLUS catalogue before the Python implementation was removed. During migration, the Python fixture generator produced compact expected inputs and outputs, and the TypeScript planner, coverage, coordinate, catalogue, profile, and export tests were compared directly against those outputs. The Python generator was intentionally removed with its implementation dependency; golden values are committed and are never regenerated from TypeScript.

At that backend migration, the T80 compatibility planning contract changed: nominal coverage pitch became 0.01°, every sampled polygon cell was targeted, small gains remained eligible, and a supplemental lattice closed gaps. That describes the v0.2.x behavior. The v0.3.1 correction keeps registered `legacy_splus` proposals on their inferred/profile lattice and reports any residual sampled gaps; supplemental fill remains only in the frozen inline v1 rectangle compatibility path. These are compatibility details, not generic survey defaults; v0.3.0 generic sampling is scale-aware and declared lattices do not add supplemental sites. `golden.json` therefore remains immutable historical input and compatibility evidence. The current planner and direct-coverage expectations live in `frontend/src/data/planner-contract.json`; they were reviewed against polygon geometry and independent invariants. Planner tests retain the old lattice candidates, inference data, and recovered historical centers where those are still compatible, but do not assert obsolete Python proposal ordering or sampled metrics.

The TypeScript suite retains the scientific regression authority and covers:

- Seven historical planner cases, including the one-anchor profile fallback.
- Six additional cases: empty catalogue, RA wraparound, triangle, concave polygon, tiny polygon, and a custom profile.
- The historical multi-center holdout and single-anchor fallback records.
- The full 4,774-center existing-overlap regression and existing-only coverage.
- Six direct coverage cases: zero, partial, disabled, overlap, full existing coverage, and wrapped partial coverage.
- Deterministic ordering, IDs, proposal decisions, profile behavior, polygon boundaries, spherical occupancy, real footprint slivers, coordinate formats, decimal rounding ties, catalogue columns, and exact CSV output.

Compatible solution modes, identifiers, lattice evidence, and historical center positions remain checked. Current proposal counts, sampled areas, coverage fractions, and pitch use explicit committed contract values; independent checks cover metric identities and coverage recomputation. Coordinates, inferred spacings, and grid centers use an absolute tolerance of **1e-10 degree** (approximately 0.36 microarcseconds) for floating-point operation differences. Python-compatible decimal tie cases remain in the historical fixture.

## Removal and validation status

The Python/FastAPI implementation, its tests and manifests, the Docker runtime, and the Python fixture-generation script have been removed. The golden data and all TypeScript regression tests remain. Before removal, 58 Python reference tests passed. After removal, the application-level backend-off test exercises reference loading, region planning, overlap coverage, CSV download, uploaded catalogue parsing, and center import using the real App and local facade.

After backend removal, the repository-level checks are `make test`, `make lint`, `make typecheck`, `make build`, and `make check`. The GitHub Actions workflow runs tests, lint, typecheck, and the production build before uploading only `frontend/dist` to Pages. The workflow triggers on pushes to `main` and manual dispatch and uses the Pages artifact deployment actions.

GitHub Pages is configured with **GitHub Actions** as its deployment source. Workflow run [36054844513](https://github.com/elacerda/jasytata/actions/runs/36054844513) completed successfully after the setting was enabled. The production site is available at <https://elacerda.github.io/jasytata/>. HTTP checks returned 200 for the page, generated JavaScript and CSS, the imported logo, and `/jasytata/data/tiles_nc.csv`.

## Legitimate external networking

Jasytata itself makes one application-level network request for `data/tiles_nc.csv`, resolved relative to the deployment base. Aladin Lite uses external sky survey/HiPS imagery and its packaged code contains an optional desktop SAMP hub connector at localhost and an Aladin-owned embed URL containing `/api/v3/`. These are third-party visualization/protocol facilities; no Jasytata planning, parsing, profile, coverage, or export depends on them.

## Static hosting and routing

The app has no client-side history routes. The logo is imported through Vite, the reference catalogue is copied from `frontend/public`, and generated scripts/styles receive the `/jasytata/` base in production. GitHub Pages can serve the single application document directly without a server-side routing fallback.
