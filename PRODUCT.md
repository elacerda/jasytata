# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the implementation brief: FastAPI, Astropy, NumPy, Pydantic, React, TypeScript, Vite, and Aladin Lite v3.

## Users

Astronomers and survey operators planning additional sky coverage from existing tile catalogues. The bundled S-PLUS/T80-South workflow supplies the initial compatibility case.

## Product Purpose

Load one or more tile catalogues, inspect their sky footprints, select a polygon, edit new tile centers, and export enabled additions as generic RA/DEC CSV.

## Positioning

The planner can extend a locally inferred S-PLUS tile lattice from multiple catalogue anchors while preserving an explicit compatibility mode for the legacy tile generator.

## Operating Context

Users work with RA/DEC catalogue CSV files, arbitrary source metadata, celestial coordinates, tile footprints, local survey geometry, and profile-driven export epoch metadata. Aladin Lite provides independent native catalogue layers and polygon interaction in the sky view.

## Capabilities and Constraints

- Original catalogue rows are immutable and their source metadata remains available for inspection.
- Proposals remain separate until accepted; editing state is client/in-memory only and is not persisted across reloads.
- The no-database MVP exposes parsing, planning, and export through a stateless FastAPI API.
- The planner uses a documented local tangent approximation and dense sampled coverage estimates; it is not a spherical polygon certification engine.

## Evidence on Hand

- `reference/create_tiles.py`: legacy geometry source.
- `reference/tiles_nc.csv`: representative source catalogue.
- No commercial or accuracy claims are asserted beyond tests against the included scientific reference.

## Product Principles

- Preserve original catalogue rows.
- Make every generated center and inference decision inspectable.
- Keep legacy compatibility explicit and regression-tested.
- Require user acceptance before proposals enter export.
- Report estimated coverage with its assumptions and limits.
