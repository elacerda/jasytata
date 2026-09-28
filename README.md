<p align="center">
  <img src="frontend/src/assets/jasytata_logo.png" alt="Jasytata" width="700" />
</p>

# Jasytata

[![Release](https://img.shields.io/github/v/release/elacerda/jasytata?label=Release)](https://github.com/elacerda/jasytata/releases) [![Jasytata Online](https://img.shields.io/website?url=https%3A%2F%2Felacerda.github.io%2Fjasytata%2F&label=Jasytata%20Online)](https://elacerda.github.io/jasytata/) [![GitHub Pages](https://github.com/elacerda/jasytata/actions/workflows/pages.yml/badge.svg)](https://github.com/elacerda/jasytata/actions/workflows/pages.yml) [![License](https://img.shields.io/github/license/elacerda/jasytata)](LICENSE)

**Jasytata is a browser-based telescope/survey pointing and coverage planner.**

Extend an existing pointing catalogue or start a **new project with no initial
catalogue**. S-PLUS/T80-South is the bundled reference/default profile;
user-defined instrument and survey profiles supply other geometries and policies.

**Live application:** <https://elacerda.github.io/jasytata/>

React/TypeScript/Vite runs catalogue parsing, planning, coverage and export in
the browser. GitHub Pages serves the static application: no API backend or
database is required. Aladin Lite supplies the sky map and accesses external
astronomy/HiPS imagery services.

Jasytata takes its name from a Kaiowá word recorded for “star”.

## What you can plan

- Rectangle, circle, polygon and compound/mosaic instrument footprints, including
  camera position angle and detector offsets/rotations.
- Generic lattices with rectangular, rotated, staggered or triangular center
  layouts, or manual/imported pointings. Basis vectors encode lattice orientation
  independently of camera PA.
- Mixed catalogues with their own **Catalogue instrument** assignment and
  **Inference participation**. Source footprints contribute coverage independently
  of their use as inference evidence.
- **Complete coverage** targeting every selected sample, or **Efficient coverage**
  stopping according to the active survey's coverage/marginal-efficiency policy.
- Browser profile authoring, strict Schema v2 JSON import/export, reversible
  proposal review, and CSV export of enabled accepted pointings using the active
  survey's column/coordinate/epoch/PA/identifier/constant-field policy.

## Typical workflow

1. Use the bundled profile, **Import profile**, or **Create profile**.
2. Optionally **Load catalogue** (or **Load reference** for the bundled T80 example).
3. Assign each catalogue's instrument and choose its inference participation.
4. Select the **Active survey** for output.
5. **Select area**, draw the region, and choose Complete or Efficient.
6. **Generate plan**, review, **Accept proposal**, and disable/restore tiles as needed.
7. **Download new_tiles.csv** under the survey's export policy.

Without catalogues, start at profile selection and draw a region. Manual surveys
use **Single tile** or **Import centers** and coverage review instead of automatic
region tiling. Profiles and plans live in the browser session; save profiles as
JSON and accepted pointings as CSV before reloading.

## Scientific scope and limits

Generic inference aligns existing centers to the profile's declared fundamental
lattice; it does not discover an arbitrary lattice. The bundled T80 profile
selects the explicit `legacy_splus` compatibility algorithm, preserving the
observer workflow and historical grouping/inference behavior.

Coverage is a scale-aware, uniformly sampled local-plane estimate, **not exact
analytic geometry**. Sub-pitch structure may be unresolved; extreme sample-budget
coarsening reduces accuracy, and threshold decisions can depend on sampling.
Local tangent-plane approximations limit large fields and extreme polar regimes,
which are outside validated precision. Complete can still leave gaps when the
available lattice sites cannot cover them. A known polygon-intersection
false-positive case is tracked as a [G9B release blocker](docs/V0.3.0_ROADMAP.md#g9b-blocker--polygon-intersection-false-positive).

Jasytata is not an observing scheduler. Exposure-time optimization, filter
sequencing, airmass, Moon constraints, weather, mount constraints, queue scheduling
and observatory control are out of scope.

The [Gate 8 validation report](docs/GATE8_AGNOSTICISM_VALIDATION.md) records T80,
small circular FoV, rotated detector mosaic and non-orthogonal triangular-lattice
workflows. The [Gate 6C report](docs/GATE6C_COVERAGE_VALIDATION.md) records measured
sampling accuracy and limits; neither report promises accuracy for arbitrary
user profiles.

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

## Documentation

- [Generic workflow and profile authoring guide](docs/PROFILE_AUTHORING_GUIDE.md)
- [Product definition and invariants](PRODUCT.md)
- [Profile Schema v2 file contract](docs/PROFILE_SCHEMA_V2.md)
- [Scientific and planning algorithms](docs/ALGORITHM.md)
- [T80-South observer guide](docs/T80_SOUTH_USER_GUIDE.md)
- [v0.2.x → v0.3.0 migration](docs/BACKENDLESS_MIGRATION.md#v02x-to-v030)
- [Release roadmap](docs/V0.3.0_ROADMAP.md)
- [Run C historical acceptance](docs/RUN_C_ACCEPTANCE.md) and
  [overlap regression](docs/RUN_C_OVERLAP_REGRESSION.md)

## License

MIT. Copyright (c) 2026 Eduardo Lacerda. See [LICENSE](LICENSE).
