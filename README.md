<p align="center">
  <img src="frontend/src/assets/jasytata_logo.png" alt="Jasytata" width="700" />
</p>

# Jasytata

[![Release](https://img.shields.io/github/v/release/elacerda/jasytata?label=Release)](https://github.com/elacerda/jasytata/releases) [![Jasytata Online](https://img.shields.io/website?url=https%3A%2F%2Felacerda.github.io%2Fjasytata%2F&label=Jasytata%20Online)](https://elacerda.github.io/jasytata/) [![GitHub Pages](https://github.com/elacerda/jasytata/actions/workflows/pages.yml/badge.svg)](https://github.com/elacerda/jasytata/actions/workflows/pages.yml) [![License](https://img.shields.io/github/license/elacerda/jasytata)](LICENSE)

**Browser-based telescope pointing and coverage planner**

Jasytata plans telescope pointings and sky coverage. Use it to extend an existing pointing catalogue or create a new tiling plan from an instrument profile. Scientific computations run in the browser with React and TypeScript; Jasytata is a static application with no backend, server, Python, database, secrets, or server-side filesystem.

**Public application:** <https://elacerda.github.io/jasytata/>

Jasytata uses Aladin Lite for its interactive sky map. Aladin and its external HiPS astronomy services may make their own network requests; they do not provide Jasytata planning or catalogue processing.

Jasytata takes its name from a Kaiowá word recorded for “star”.

Repository: [github.com/elacerda/jasytata](https://github.com/elacerda/jasytata)

User guide: [T80-South User Guide](docs/T80_SOUTH_USER_GUIDE.md)

## Features

- Optionally load one or more CSV catalogues, each with independent visibility and metadata, to extend a project; new projects can use the active tile profile alone.
- Extend a compatible local grid from catalogue pointings, or use the active profile grid for new projects and when a local grid cannot be inferred.
- Display catalogue footprints on an Aladin Lite sky map, inspect ICRS positions, and select a polygon.
- Choose **Complete** or **Efficient** sampled-coverage planning.
- Add single pointings manually or import center lists; accept, review, and reversibly adjust proposals without changing original catalogue rows.
- Parse common decimal and sexagesimal RA/DEC formats and export enabled centers as CSV.
- Run as a browser-only static application, including deployment on GitHub Pages; Jasytata needs no server.

Typical workflow: choose the active profile → optionally load an existing catalogue → select a region → choose a coverage strategy → generate and review the plan → adjust proposals → export enabled centers. Session state is held in the browser and is cleared when the page reloads.

The supplied reference catalogue is bundled at `frontend/public/data/tiles_nc.csv`. Choose **Load reference** to try the application without preparing a CSV file.

## Scientific behavior

The default profile is **S-PLUS / T80-South**: 1.4° × 1.4° tile footprints with 120 arcseconds effective overlap and the `SPLUS_LEGACY_GRID_V1` fallback geometry. Planning first checks actual input pointings for a compatible local lattice. Candidate selection and coverage sampling run entirely in TypeScript. Coverage is a declination-weighted sample estimate, not a formal completeness certification.

**Complete coverage** is the default and attempts to cover every sampled point in the selected region. **Efficient coverage** uses the same planner and candidate ordering, but may stop once sampled coverage reaches at least 99.5% if the next tile would cover less than 3% of its physical footprint as new area inside the selected region. Efficient trades small residual uncovered regions for fewer exposures and does not assess their topology or scientific importance. Choose Complete when exhaustive sampled coverage is needed.

The compatibility decisions and limitations are described in [Scientific and planning algorithms](docs/ALGORITHM.md). The committed `frontend/src/data/golden.json` preserves former Python reference inputs and compatible behavior such as coordinate parsing, catalogue semantics, legacy grid geometry, and historical recovery centers. Reviewed expectations for the current sampled-coverage planner live in `frontend/src/data/planner-contract.json`.

## Development

Requirements: Node.js 24 LTS (or a compatible supported Node.js release) and npm.

```bash
git clone https://github.com/elacerda/jasytata.git
cd jasytata
cd frontend
npm ci
npm run dev
```

Vite prints the local URL, normally <http://localhost:5173/>. The dev server uses `/` as its base; production builds use `/jasytata/` for GitHub Pages. To run the repository-level checks from the root:

```bash
make test
make lint
make typecheck
make build
```

`make check` runs all four checks. `make preview` builds the production site and serves it locally; open the `/jasytata/` path on the preview server.

## Deployment

A GitHub Actions workflow tests and builds the static site when changes are pushed to `main`, then deploys only `frontend/dist` to GitHub Pages. It also supports manual runs with `workflow_dispatch`. The production site is <https://elacerda.github.io/jasytata/>.

## User guide and regression records

- [T80-South User Guide](docs/T80_SOUTH_USER_GUIDE.md)
- [Run C historical reconstruction acceptance](docs/RUN_C_ACCEPTANCE.md)
- [Run C large-overlap regression](docs/RUN_C_OVERLAP_REGRESSION.md)
- [Backendless migration record](docs/BACKENDLESS_MIGRATION.md)

## License

MIT. Copyright (c) 2026 Eduardo Lacerda. See [LICENSE](LICENSE).
