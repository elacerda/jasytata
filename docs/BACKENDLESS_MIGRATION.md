# Backendless migration

## Runtime architecture

Jasytata is now a static React and TypeScript application. The browser parses catalogues, validates profiles, infers observing grids, plans region pointings, measures coverage, and exports CSV. `frontend/src/api.ts` preserves the UI-facing async facade but calls local TypeScript for every scientific operation. Production use needs no Python, FastAPI, database, Docker, secrets, server filesystem, or Jasytata `/api/*` requests. The retained Python backend is a scientific reference and fixture generator only.

Vite emits relative asset URLs (`base: "./"`). The 4,774-row supplied catalogue is a static asset at `frontend/public/data/tiles_nc.csv`, fetched relative to the deployed site base. `index.html` also uses a relative module entry. There is no client-side router or application route requiring a server fallback. The logo and other existing UI assets remain in place. `make dev` and `make run` launch only the frontend; `make backend` remains available for reference work.

## Responsibility map

| Old endpoint | Browser responsibility |
| --- | --- |
| `GET /api/profiles` | `profiles/loadProfile` and bundled validated definitions |
| `POST /api/profiles/validate` | `profiles/validateProfile` |
| `GET /api/catalogue/reference` | Static CSV asset plus `science/catalogue` |
| `POST /api/catalogue/parse` | Browser File bytes plus `science/catalogue` |
| `POST /api/centers/parse` | `science/catalogue.parseCenterText` |
| `POST /api/proposals/centers` | `science/catalogue.makeCenterProposals` |
| `POST /api/plan/region` | `science/planner`, `grid`, `geometry`, and `coverage` |
| `POST /api/coverage/region` | `science/coverage.measureActiveCoverage` |
| `POST /api/export` | `science/export.buildExportCsv` and Blob/Object URL download |
| `GET /api/health` | No browser responsibility |
| `GET /{frontend_path:path}` | Static site hosting |

`frontend/src/legacyBackend.ts` and the Vite API proxy are removed. The only explicit application `fetch` loads the bundled catalogue from the site's own static asset path. Aladin Lite still requests external sky survey/HiPS imagery at runtime. Its packaged code also contains an optional desktop SAMP hub connector (`http://localhost:`) and an `/api/v3/` URL for Aladin's own embed script; neither is a Jasytata service or used for scientific calculations. The development-only plan-input copy action uses the browser clipboard API, not HTTP.

## Scientific parity

Run `uv run --project backend python scripts/generate_parity_fixtures.py` to regenerate `frontend/src/data/golden.json` from the checked-in Python reference and catalogue. The committed fixture is self-contained for frontend tests and stores compact inputs and outputs rather than duplicating the full catalogue. The frontend test suite compares local TypeScript results directly with it; Python is not needed when running frontend tests.

The planner parity suite covers seven historical holdouts (including one-anchor fallback), six direct region cases (empty existing catalogue, RA wrap, triangle, concave polygon, tiny polygon, and custom profile), the separate historical holdout and fallback records, and the full 4,774-center existing-overlap regression. It compares the full ordered candidate and chosen-center sequences, solution and generation method, lattice spacings, anchor IDs and neighbor-pair counts, diagnostics, and all metrics. The overlap case checks existing-only coverage as well. Direct coverage fixtures cover zero, partial, disabled, overlapping, fully existing, and wrapped partial coverage. Additional contracts check spherical occupancy near a pole, real footprint slivers smaller than a sample cell, invalid polygon crossing, repeatability, and proposal enable/disable recalculation. Existing coordinate, catalogue, profile, proposal-center, and CSV fixtures remain in use.

Discrete outcomes, IDs, ordering, diagnostics, CSV bytes, and API metrics are compared **exactly**. The Python API rounds coverage fractions to five decimal places and areas/sample steps to four; matching those exposed values exactly prevents a tolerance from hiding a changed selection or sampling result. Python decimal tie cases are also fixture-tested against the IEEE-754 values. Proposal and candidate coordinates, inferred lattice spacings, and legacy grid centers use an absolute tolerance of **1e-10 degree** to account for JavaScript/Python floating-point operation differences (approximately 0.36 microarcseconds). No looser planner or coverage tolerance is used. The Python historical recovery scatter tolerance and independent overlap integration tolerance remain in the Python suite; they are not substitutes for the direct golden comparisons.

## Backend independence and next cleanup

The frontend application code contains zero Jasytata `/api/*` calls, backend base URLs, or port assumptions. The application-level backend-off test mounts the real App and local facade, loads the static reference catalogue, plans the large-overlap region, accepts a proposal, recomputes coverage, triggers CSV download, parses an uploaded catalogue, and stages pasted centers; it mocks the visual Aladin map and browser delivery mechanisms. A production Vite preview serves the built shell and catalogue while FastAPI port 8000 is stopped. No GUI browser was available in the validation environment, so interactive map rendering under the final GitHub Pages URL remains part of the deployment task.

The scientific and runtime conditions for deleting `backend/` are now satisfied: local planning and coverage pass golden parity and Python regressions, the runtime has no backend calls, and the static build runs with FastAPI stopped. Keep the Python reference until the next task has completed final repository cleanup, GitHub Pages base/path configuration, deployment, and an interactive browser smoke test of Aladin and its external imagery. Docker and Python tooling remain in the repository solely for reference/testing until that cleanup.
