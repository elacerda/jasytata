# Tile Planner

Tile Planner displays astronomical catalogue footprints on an Aladin Lite sky map and prepares auditable tile proposals. Its bundled S-PLUS/T80-South catalogue is the initial compatibility profile. Catalogue rows and proposed rows stay separate until acceptance and export. The application has no database; browser state is the working session.

The supplied `reference/tiles_nc.csv` is bundled as a quick-start catalogue. Use **Load reference** to exercise the interface without locating the file yourself. Other CSV files need only RA and DEC columns.

## Features

- Aladin Lite v3 pan, zoom, ICRS position inspection, native catalogue layers, zoom-dependent tile footprints, region bounds, anchors, and candidate lattice positions.
- Multiple simultaneous CSV datasets with distinct colors, independent visibility, and source metadata inspection.
- Single sky-click proposals, pasted RA/DEC center imports, and rectangular region selection using Aladin's pixel-to-world conversion.
- `SPLUS_LEGACY_GRID_V1` geometry and a deterministic existing-grid inference layer.
- Automatic planning and exact fixed-N planning. N counts only new proposal tiles.
- Proposal preview, accept/cancel, individual deletion, clear, and undo.
- New-only and complete updated CSV exports with naming controls and collision validation.

## Architecture

```text
backend/app/science/       Astropy geometry, parsing, inference, coverage, CSV export
backend/app/models.py      Typed Pydantic request/response models
backend/profiles/           Validated, file-backed observing profiles
backend/app/main.py        Stateless FastAPI endpoints and production static serving
frontend/src/              React/TypeScript workspace and Aladin Lite v3 overlays
reference/                  Legacy generator and representative source catalogue
docs/ALGORITHM.md           Scientific and planner behavior
```

The frontend keeps independent uploaded datasets and accepted proposals in client state. Each CSV creates a native Aladin catalogue layer with its own color and visibility; planning receives the union of visible dataset pointings. Backend calls are stateless: catalogue parsing returns canonical decimal-degree centers plus every source row's original CSV values and arbitrary non-coordinate metadata; every planning/export request carries its current session inputs. The production FastAPI process serves `frontend/dist` when that directory exists. Development runs Vite and FastAPI separately.

## Observing profiles

YAML files in `backend/profiles/` define an instrument's tile width and height in degrees, effective edge overlap in arcseconds, ICRS/J2000 coordinates, and a generation algorithm. The installed default is `splus-t80-south` (S-PLUS / T80-South): 1.4° × 1.4°, 120 arcsec effective overlap, and `SPLUS_LEGACY_GRID_V1`. The historical helper used a 30 arcsec base overlap multiplied internally by four; profile files use the physically meaningful 120 arcsec value. Add another YAML file with a distinct identifier and `RECT_GRID_V1` to describe another rectangular instrument. `GET /api/profiles` exposes installed profiles to clients; region planning accepts `profile_id`.

## Development setup

Requirements: Python 3.12+, Node.js 20+, npm, and `uv`.

```bash
make setup
make dev
```

Open the Vite URL printed by the frontend command, normally `http://localhost:5173`. FastAPI runs at `http://localhost:8000`; its interactive API docs are at `/docs`.

To build and run the production-serving FastAPI app:

```bash
make run
```

`make run` builds the frontend first, then starts FastAPI on port 8000. The Makefile keeps the `uv` cache in an ignored workspace directory, which also makes the commands work in restricted environments.

The sky imagery comes from Aladin Lite's configured HiPS survey service, so the browser needs network access to the survey host. Catalogue parsing, planning, and export remain local to this application.

## Input catalogue

The bundled S-PLUS example uses:

```csv
PID,NAME,RA,DEC,EPOC,STATUS
HYDRA,HYDRA_0011,10:03:05,-23:54:31,2000,1
```

The importer discovers common RA and DEC headers, including `ra`, `ra_deg`, `dec`, and `dec_deg`, without requiring any other column. Ambiguous or unrecognized headers prompt for a RA/DEC column choice and a numeric RA unit. Colon-separated RA sexagesimal values are hours; decimal RA values are degrees unless the selected unit or `ra_hours` header explicitly declares hours. DEC sexagesimal and decimal values use degrees. Astropy converts coordinates to canonical ICRS decimal degrees. Every other column remains attached as metadata and all original values are retained. Invalid rows report their CSV line number.

Center import accepts comma, semicolon, or whitespace separated RA/DEC pairs, one per line. It accepts sexagesimal RA + DEC and decimal-degree RA + DEC; a `RA,DEC` heading may be included.

## Geometry and inference

The explicit compatibility algorithm is `SPLUS_LEGACY_GRID_V1`. It keeps the legacy half-tile seed at the lower RA/DEC bounds, the 1.4° tile size, the legacy 4× overlap multiplier, and a row-dependent RA correction. The original helper's configured overlap is 30 arcsec, so each step uses an **effective 120 arcsec (2 arcmin) overlap** and center spacing `1.4° - 120/3600° = 1.366666…°`. RA increments divide that spacing by `cos(dec)`.

For selected regions near a regular catalogue lattice, the planner checks neighboring original/accepted centers within three tile widths, fits row/column phases using multiple neighbor pairs, and continues that local pattern. The catalogue-calibrated inference tolerance is 0.05° (3 arcmin). If there are too few consistent anchors, the response explicitly reports `legacy_bounds_fallback` and uses `SPLUS_LEGACY_GRID_V1` on the selected bounds. Candidate centers remain on the inferred lattice; coverage scoring chooses among them without moving their coordinates.

Automatic mode adds tiles until sampled selected-region coverage reaches 95% or no candidate makes a useful contribution. Fixed mode returns exactly N new tiles or rejects the request if fewer than N non-occupied lattice candidates add incremental selected-area coverage. Existing footprints are counted before proposal scoring. See [docs/ALGORITHM.md](docs/ALGORITHM.md) for projection assumptions, inference, thresholds, score ordering, and known limits.

## Export

The two downloads always have exactly this header:

```text
PID,NAME,RA,DEC,EPOC,STATUS
```

`new_tiles.csv` contains accepted proposed tiles only. `tiles_nc_updated.csv` contains original S-PLUS-compatible rows first, with their values preserved, followed by the accepted proposals. The updated export is available when exactly one compatible catalogue is loaded; generic export across datasets is planned for the next development run. New rows receive the configured PID, prefix + zero-padded sequence, EPOC, and STATUS (default `-5`). RA is written as integer-second sexagesimal hours and DEC as integer-second sexagesimal degrees. Export fails with a useful message if any generated NAME collides with an existing or earlier new NAME. Both downloads can be parsed again by this application.

## API

- `GET /api/health`
- `GET /api/profiles`
- `GET /api/catalogue/reference`
- `POST /api/catalogue/parse` (multipart CSV upload)
- `POST /api/centers/parse`
- `POST /api/proposals/centers`
- `POST /api/plan/region`
- `POST /api/export`

All payloads use explicit Pydantic models. No API state is persisted between requests.

## Tests and quality checks

```bash
make test
make lint
make typecheck
make build
```

Backend tests execute the checked-in legacy helper for golden coordinates and exercise the supplied 4,774-row catalogue, Astropy coordinate conversion, lattice inference/fallback, occupied-center exclusion, deterministic exact-N and automatic planning, export schema, name collision checks, and reload round trips. Frontend tests cover RA-wrap selection bounds, declination-corrected tile footprints, coordinate-column mapping, two concurrent datasets, independent native Aladin catalogue visibility, and source metadata.

## Known limits

- Tile boundaries and coverage scores use an axis-aligned 1.4° RA/DEC rectangle approximation rather than a full spherical polygon intersection.
- The region planner uses a dense, declination-weighted sample grid capped at 90,000 points; the returned coverage is an estimate, not a survey-completeness certification.
- Region selection is limited to an eastward RA interval no wider than 180° and declinations strictly between the poles. The current planner models the approximately axis-aligned S-PLUS grid and does not infer rotated or warped survey tilings.
- Sessions are client/in-memory only. Reloading the browser discards accepted proposals; export before closing the session.
- The initial UI uses Aladin Lite's DSS2 color HiPS background; access to remote HiPS tiles depends on network availability.
