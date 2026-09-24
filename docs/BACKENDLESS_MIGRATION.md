# Backendless migration record

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

The TypeScript suite retains the scientific regression authority and covers:

- Seven historical planner cases, including the one-anchor profile fallback.
- Six additional cases: empty catalogue, RA wraparound, triangle, concave polygon, tiny polygon, and a custom profile.
- The historical multi-center holdout and single-anchor fallback records.
- The full 4,774-center existing-overlap regression and existing-only coverage.
- Six direct coverage cases: zero, partial, disabled, overlap, full existing coverage, and wrapped partial coverage.
- Deterministic ordering, IDs, proposal decisions, profile behavior, polygon boundaries, spherical occupancy, real footprint slivers, coordinate formats, decimal rounding ties, catalogue columns, and exact CSV output.

Discrete decisions, identifiers, ordering, diagnostics, and exposed metrics are compared exactly. Coordinates, inferred spacings, and grid centers use an absolute tolerance of **1e-10 degree** (approximately 0.36 microarcseconds) for floating-point operation differences. Python-compatible decimal tie cases are stored in the fixture. No widening tolerance is used to hide a semantic mismatch.

## Removal and validation status

The Python/FastAPI implementation, its tests and manifests, the Docker runtime, and the Python fixture-generation script have been removed. The golden data and all TypeScript regression tests remain. Before removal, 58 Python reference tests passed. After removal, the application-level backend-off test exercises reference loading, region planning, overlap coverage, CSV download, uploaded catalogue parsing, and center import using the real App and local facade.

After backend removal, the repository-level checks are `make test`, `make lint`, `make typecheck`, `make build`, and `make check`. The GitHub Actions workflow runs tests, lint, typecheck, and the production build before uploading only `frontend/dist` to Pages. The workflow triggers on pushes to `main` and manual dispatch and uses the Pages artifact deployment actions.

GitHub Pages is configured with **GitHub Actions** as its deployment source. Workflow run [36054844513](https://github.com/elacerda/jasytata/actions/runs/36054844513) completed successfully after the setting was enabled. The production site is available at <https://elacerda.github.io/jasytata/>. HTTP checks returned 200 for the page, generated JavaScript and CSS, the imported logo, and `/jasytata/data/tiles_nc.csv`.

## Legitimate external networking

Jasytata itself makes one application-level network request for `data/tiles_nc.csv`, resolved relative to the deployment base. Aladin Lite uses external sky survey/HiPS imagery and its packaged code contains an optional desktop SAMP hub connector at localhost and an Aladin-owned embed URL containing `/api/v3/`. These are third-party visualization/protocol facilities; no Jasytata planning, parsing, profile, coverage, or export depends on them.

## Static hosting and routing

The app has no client-side history routes. The logo is imported through Vite, the reference catalogue is copied from `frontend/public`, and generated scripts/styles receive the `/jasytata/` base in production. GitHub Pages can serve the single application document directly without a server-side routing fallback.
