# Product

## Platform

Static browser application hosted on GitHub Pages.

## Name

Jasytata

## Description

Browser-based telescope pointing and coverage planner.

## Stack

React, TypeScript, Vite, and Aladin Lite v3. All Jasytata catalogue parsing, profile validation, coordinate conversion, grid inference, region planning, coverage calculation, and CSV export execute client-side.

## Users

Astronomers and survey operators planning additional sky coverage from existing tile catalogues. The bundled S-PLUS/T80-South workflow supplies the initial compatibility case.

## Product Purpose

Load one or more tile catalogues, inspect their sky footprints, select a polygon, edit new tile centers, and export enabled additions as generic RA/DEC CSV.

## Positioning

The planner extends a locally inferred S-PLUS tile lattice where catalogue evidence supports it and preserves a documented fallback for legacy tile geometry.

## Operating Context

Users work with RA/DEC catalogue CSV files, arbitrary source metadata, celestial coordinates, tile footprints, local survey geometry, and profile-driven export epoch metadata. Aladin Lite provides interactive sky imagery, catalogue layers, and polygon selection. External astronomy services supply sky survey/HiPS imagery; Jasytata science does not depend on those services.

## Capabilities and Constraints

- Original catalogue rows are immutable and their source metadata remains available for inspection.
- Proposals remain separate until accepted; editing state lives in browser memory and is not persisted across reloads.
- No Jasytata backend, server, database, secrets, or server filesystem is required.
- The planner uses a documented local tangent approximation and sampled coverage estimates; it is not an exact spherical completeness engine.

## Evidence on Hand

- `frontend/src/data/golden.json`: outputs generated from the former Python scientific reference before its removal and validated against TypeScript.
- `frontend/public/data/tiles_nc.csv`: representative bundled catalogue.
- `docs/ALGORITHM.md`: assumptions, thresholds, score ordering, and limitations.

## Product Principles

- Preserve original catalogue rows.
- Make every generated center and inference decision inspectable.
- Keep legacy compatibility explicit and regression-tested.
- Require user acceptance before proposals enter export.
- Report estimated coverage with its assumptions and limits.
