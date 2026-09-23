# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the implementation brief: FastAPI, Astropy, NumPy, Pydantic, React, TypeScript, Vite, and Aladin Lite v3.

## Users

Inferred from the explicit brief: astronomers and survey operators planning additional T80-South/S-PLUS sky coverage from an existing tile catalogue.

## Product Purpose

Load a T80-South tile catalogue, inspect its sky footprint, design new tile centers, and export the accepted additions in the catalogue's original CSV schema.

## Positioning

The planner can extend a locally inferred S-PLUS tile lattice from multiple catalogue anchors while preserving an explicit compatibility mode for the legacy tile generator.

## Operating Context

Users work with six-column catalogue CSV files, celestial coordinates, tile footprints, local survey geometry, and proposed export metadata. Aladin Lite provides the interactive sky view.

## Capabilities and Constraints

- Original catalogue rows are immutable and semantically preserved in updated exports.
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

