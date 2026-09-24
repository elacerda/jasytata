# Backendless migration

## Target

Jasytata will be a static React and TypeScript site served from GitHub Pages. The browser will parse catalogues, validate profiles, compute tile proposals and coverage, and export CSV. Production use will require no Python, FastAPI, database, Docker, secrets, server filesystem, or `/api/*` calls. The Python backend remains temporarily as the scientific reference. The current build is **transitional**: region planning and coverage still call it.

Vite emits relative asset URLs (`base: "./"`). The supplied 4,774-row catalogue is a static frontend asset at `frontend/public/data/tiles_nc.csv`; the browser parses the same CSV format used for uploads. The existing logo, interface, and session state are unchanged.

## Responsibility map

| Old endpoint | Client responsibility | Status |
| --- | --- | --- |
| `GET /api/profiles` | `profiles/loadProfile` and bundled validated definition | Local |
| `POST /api/profiles/validate` | `profiles/validateProfile` | Local |
| `GET /api/catalogue/reference` | Static CSV asset plus `science/catalogue` | Local |
| `POST /api/catalogue/parse` | Browser File bytes plus `science/catalogue` | Local |
| `POST /api/centers/parse` | `science/catalogue.parseCenterText` | Local |
| `POST /api/proposals/centers` | `science/catalogue.makeCenterProposals` | Local |
| `POST /api/export` | `science/export.buildExportCsv` and Blob/Object URL download | Local |
| `POST /api/plan/region` | Grid inference, candidate ranking and proposal planning | **FastAPI dependency** in `frontend/src/legacyBackend.ts` |
| `POST /api/coverage/region` | Sampled coverage and footprint intersections | **FastAPI dependency** in `frontend/src/legacyBackend.ts` |
| `GET /api/health` | No application function; remove with backend | Backend only |
| `GET /{frontend_path:path}` | GitHub Pages static hosting | Backend only |

`frontend/src/api.ts` remains the UI-facing local facade. All remaining `/api/*` requests are confined to `legacyBackend.ts`. The Vite development proxy exists only to support these two transitional operations.

## Scientific parity

`uv run --project backend python scripts/generate_parity_fixtures.py` regenerates `frontend/src/data/golden.json` from the checked-in Python implementation and reference catalogue. The fixture includes coordinate input and formatting, RA wrap, catalogue rows and column mapping, the installed profile, center import, exact CSV output, a wrapped polygon and legacy grid centers, a multi-center historical holdout, a single-anchor fallback, and the full reference-catalogue overlap regression. It stores only the selected holdout names, compact proposal centers, and metrics rather than copying the full catalogue into JSON.

Frontend Vitest checks exact equality for profile fields, column names, source strings, metadata, identifiers, CSV bytes, and formatted sexagesimal strings. Decimal-degree coordinate outputs use an absolute tolerance of **1e-10 degree**, below the precision of the input catalogue and roughly 0.36 microarcseconds. Future geometry and coverage tests should use explicit angular or area tolerances derived from the existing Python tests: the legacy center-grid comparison uses 1e-10 degree, historical center recovery uses twice the measured 95th-percentile lattice scatter (currently 14.93 arcseconds), and the independent large-overlap coverage integration permits a 0.015 fraction difference because its sampling pitch differs. A direct port of the same sampling algorithm should use substantially tighter floating-point tolerances and compare counts and decisions exactly.

The fixture records the planner outputs but browser tests do not yet compare them, because that code has not been ported. The Python holdout and overlap tests remain the authoritative regression checks during this phase.

## Backend deletion gate

Port `backend/app/science/geometry.py`, `grid.py`, and `planner.py` into pure TypeScript modules, including polygon validation, spherical center occupancy, existing footprint intersection, lattice inference, greedy selection, and sampled coverage. Compare the new functions against the committed holdout, wrap, and overlap fixtures and the Python regression tests. Then remove both calls from `legacyBackend.ts`, the Vite proxy, backend serving, and Python/Docker runtime assumptions. Confirm a production build works as a static site under the GitHub Pages repository path before removing the Python reference implementation.
