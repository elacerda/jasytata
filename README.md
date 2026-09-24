<p align="center">
  <img src="frontend/src/assets/jasytata_logo.png" alt="Jasytata" width="700" />
</p>

# Jasytata

[![Release](https://img.shields.io/github/v/release/elacerda/jasytata?label=Release)](https://github.com/elacerda/jasytata/releases) [![Jasytata Online](https://img.shields.io/website?url=https%3A%2F%2Felacerda.github.io%2Fjasytata%2F&label=Jasytata%20Online)](https://elacerda.github.io/jasytata/) [![GitHub Pages](https://github.com/elacerda/jasytata/actions/workflows/pages.yml/badge.svg)](https://github.com/elacerda/jasytata/actions/workflows/pages.yml) [![License](https://img.shields.io/github/license/elacerda/jasytata)](LICENSE)

**Browser-based telescope pointing and coverage planner**

Jasytata plans telescope pointings and sky coverage from catalogue CSV files. Its scientific computations run in the browser using React and TypeScript. The application needs no backend, server, Python, database, secrets, or server-side filesystem.

**Public application:** <https://elacerda.github.io/jasytata/>

Jasytata uses Aladin Lite for its interactive sky map. Aladin and its external HiPS astronomy services may make their own network requests; they do not provide Jasytata planning or catalogue processing.

Jasytata takes its name from a Kaiowá word recorded for “star”.

Repository: [github.com/elacerda/jasytata](https://github.com/elacerda/jasytata)

User guide: [T80-South User Guide](docs/T80_SOUTH_USER_GUIDE.md)

## Features

- Display catalogue footprints on an Aladin Lite sky map, inspect ICRS positions, and select a polygon.
- Load multiple CSV catalogues with independent visibility and metadata.
- Parse common decimal and sexagesimal RA/DEC formats in the browser.
- Infer a local S-PLUS/T80-South grid or use the profile fallback, then review proposed centers and sampled coverage.
- Accept and reversibly edit a proposal without changing original catalogue rows.
- Export enabled proposed centers as decimal-degree or sexagesimal CSV.

Typical workflow: load a catalogue, select a region, generate and review a plan, accept it, adjust proposed fields if needed, and export the enabled centers. Session state is held in the browser and is cleared when the page reloads.

The supplied reference catalogue is bundled at `frontend/public/data/tiles_nc.csv`. Choose **Load reference** to try the application without preparing a CSV file.

## Scientific behavior

The default profile is **S-PLUS / T80-South**: 1.4° × 1.4° tile footprints with 120 arcseconds effective overlap and the `SPLUS_LEGACY_GRID_V1` fallback geometry. Planning first checks actual input pointings for a compatible local lattice. Candidate selection and coverage sampling run entirely in TypeScript. Coverage is a declination-weighted sample estimate, not a formal completeness certification.

The compatibility decisions and limitations are described in [Scientific and planning algorithms](docs/ALGORITHM.md). The committed golden fixture at `frontend/src/data/golden.json` and TypeScript tests preserve the former Python-reference outputs, including planner holdouts and large-catalogue overlap behavior.

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
