# Tile Planner

Tile Planner displays astronomical catalogue footprints on an Aladin Lite sky map and prepares auditable tile proposals. Its bundled S-PLUS/T80-South catalogue is the initial compatibility profile. Catalogue rows and proposed rows stay separate until acceptance and export. The application has no database; browser state is the working session.

The supplied `reference/tiles_nc.csv` is bundled as a quick-start catalogue. Use **Load reference** to exercise the interface without locating the file yourself. Other CSV files need only RA and DEC columns.

## Features

- Aladin Lite v3 pan, zoom, ICRS position inspection, native catalogue layers, zoom-dependent tile footprints, polygon selection, anchors, and candidate lattice positions.
- Multiple simultaneous CSV datasets with distinct colors, independent visibility, and source metadata inspection.
- Single sky-click proposals, pasted RA/DEC center imports, and native Aladin polygon selection with ICRS vertices.
- `SPLUS_LEGACY_GRID_V1` geometry and a deterministic existing-grid inference layer.
- Deterministic polygon-aware planning from every loaded catalogue, independent of map-layer visibility.
- Proposal preview and acceptance, reversible per-tile enable/disable, Restore all, Remove all, and independent Clear proposal/Clear selection actions.
- Generic `RA,DEC,EPOCH` export of enabled proposals in decimal degrees or sexagesimal coordinates.

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

The frontend keeps independent uploaded datasets and accepted proposals in client state. Each CSV creates a native Aladin catalogue layer with its own color and visibility; planning receives the union of visible dataset pointings and enabled proposal centers. Backend calls are stateless: catalogue parsing returns canonical decimal-degree centers plus every source row's original CSV values and arbitrary non-coordinate metadata; every planning/export request carries its current session inputs. Disabled proposals remain in memory and appear as crosses, but are excluded from planning, coverage, and export. Coverage is recomputed after manual edits without creating replacement tiles. The production FastAPI process serves `frontend/dist` when that directory exists. Development runs Vite and FastAPI separately.

## Observing profiles

YAML files in `backend/profiles/` define an instrument's tile width and height in degrees, effective edge overlap in arcseconds, ICRS coordinates, a generation algorithm, and allowed export epoch labels. The installed default is `splus-t80-south` (S-PLUS / T80-South): 1.4° × 1.4°, 120 arcsec effective overlap, `SPLUS_LEGACY_GRID_V1`, and the sole export epoch option `2000`. The historical helper used a 30 arcsec base overlap multiplied internally by four; profile files use the physically meaningful 120 arcsec value. Add another YAML file with a distinct identifier and `RECT_GRID_V1` to describe another rectangular instrument. `GET /api/profiles` exposes installed profiles to clients; region planning accepts `profile_id`.

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

For selected regions near a regular catalogue lattice, the planner measures east-west neighbor spacing at each pair's mean declination, retains observed declination rows, and checks each row's RA phase against its anchors before continuing the local pattern. Missing rows interpolate from observed rows; new edge rows use local extrapolation. The catalogue-calibrated inference tolerance is 0.05° (3 arcmin). If there are too few consistent anchors, the response explicitly reports `legacy_bounds_fallback` and uses `SPLUS_LEGACY_GRID_V1` around the polygon bounds with a half-tile margin. Candidate centers remain on the inferred lattice; coverage scoring chooses among them without moving their coordinates.

The planner adds useful lattice centers until sampled selected-polygon coverage reaches 99.5% or no candidate makes a meaningful contribution. Existing footprints are counted before proposal scoring. Polygon bounds accelerate candidate generation; sample scoring uses only the polygon interior. See [docs/ALGORITHM.md](docs/ALGORITHM.md) for projection assumptions, inference, thresholds, score ordering, and known limits.

## Export

The enabled new-tile download, `new_tiles.csv`, has this header:

```text
RA,DEC,EPOCH
```

The file contains only currently enabled proposed centers. Decimal degrees are the default and use eight digits after the decimal point. The sexagesimal option uses Astropy, with RA in hours and DEC in degrees to millisecond precision. The EPOCH column repeats the profile-approved catalogue epoch label for practical CSV interoperability. It is metadata, not an ICRS equinox or a precession/proper-motion operation. The S-PLUS profile currently permits only `2000`. Imported metadata, including source PID, NAME, EPOC, and STATUS, remains available in tile inspection but is never copied to generated rows. The generic file reloads through the same catalogue importer.

## API

- `GET /api/health`
- `GET /api/profiles`
- `GET /api/catalogue/reference`
- `POST /api/catalogue/parse` (multipart CSV upload)
- `POST /api/centers/parse`
- `POST /api/proposals/centers`
- `POST /api/plan/region`
- `POST /api/coverage/region`
- `POST /api/export`

All payloads use explicit Pydantic models. No API state is persisted between requests.

## Tests and quality checks

```bash
make test
make lint
make typecheck
make build
```

Backend tests execute the checked-in legacy helper for golden coordinates and exercise the supplied 4,774-row catalogue, Astropy coordinate conversion, polygon validation and sampling, lattice inference/fallback, occupied-center exclusion, deterministic planning, profile epoch rules, and generic export round trips. Frontend tests cover RA-wrap polygon selection, declination-corrected tile footprints, coordinate-column mapping, two concurrent datasets, reversible proposal editing, independent native Aladin catalogue visibility, and source metadata.

## Known limits

- Tile footprints use an axis-aligned 1.4° RA/DEC rectangle approximation; selected-area coverage is sampled inside the chosen polygon rather than computed by exact spherical clipping.
- The region planner uses a dense, declination-weighted sample grid capped at 90,000 points; the returned coverage is an estimate, not a survey-completeness certification.
- Region selection supports simple polygons with a local RA span no wider than 180° and declinations strictly between the poles. The current planner models the approximately axis-aligned S-PLUS grid and does not infer rotated or warped survey tilings.
- Sessions are client/in-memory only. Reloading the browser discards accepted proposals; export before closing the session.
- The initial UI uses Aladin Lite's DSS2 color HiPS background; access to remote HiPS tiles depends on network availability.
