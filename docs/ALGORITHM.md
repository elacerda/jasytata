# Scientific and planning algorithms

This document distinguishes the exact compatibility geometry in `SPLUS_LEGACY_GRID_V1` from the newer local-grid inference and coverage-selection layer. Geometry is implemented in `backend/app/science/geometry.py`; planning lives in `planner.py` and calls that module only for the fallback.

## 1. Coordinate conventions

- Coordinates are ICRS/equatorial in decimal degrees after parsing.
- Sexagesimal RA is interpreted as hour angle (`HH:MM:SS`); one hour equals 15 degrees.
- Sexagesimal DEC is interpreted in degrees (`±DD:MM:SS`). Astropy `Angle` and `Longitude` perform the conversions and RA normalization.
- The legacy grid treats RA/DEC as longitude/latitude offsets with a local `cos(dec)` approximation. It does not use a gnomonic or great-circle lattice.
- A tile is modeled for display and scoring as an axis-aligned 1.4° × 1.4° rectangle in local RA/DEC: ±0.7° in DEC and ±0.7° physical RA, where physical RA separation is `ΔRA × cos(tile_center_DEC)`.

## 2. `SPLUS_LEGACY_GRID_V1`

The compatibility constants are:

```text
tile size                  T = 1.4 deg
configured base overlap    O = 30 arcsec
legacy builder multiplier  m = 4
effective overlap          m O = 120 arcsec = 1/30 deg
center spacing             S = T - m O = 1.366666666... deg
```

For non-degenerate bounds, the first center is offset half a tile from the lower bounds. If the lower RA is `α₀` and the lower DEC is `δ₀`:

```text
δ_first = δ₀ + T/2
α_first = α₀ + (T/2) / cos(δ₀)
```

For successive rows:

```text
δ_(j+1) = δ_j + S
```

For each row `j`, RA centers step by:

```text
Δα_j = S / cos(δ_j)
α_(j,k+1) = α_(j,k) + Δα_j
```

The division by cosine is applied to the angular increment as in the reference's Astropy `Longitude` handling. This is a small-angle physical-spacing approximation: `Δα_j cos(δ_j) = S`. Centers stop at the upper input bounds, just as the legacy loops do. Reversed non-wrapping bounds are normalized to ascending bounds; RA intervals that cross zero must be explicitly marked as wrap intervals so the short interval is not mistaken for a 350° span. Degenerate fixed-coordinate axes retain the legacy behavior of placing that coordinate on the supplied boundary.

Golden tests import and execute `reference/create_tiles.py` for RA 143°–151°, DEC −40°–−20°. New and reference center sequences must match to better than `1e-10` degree in each coordinate. The implementation intentionally does not replace the half-tile seed with a modern centered-grid convention.

## 3. Local existing-grid inference

The selected polygon is unwrapped around its local RA center and must span at most 180°. For neighbor search, RA offsets are projected to a local horizontal coordinate:

```text
x = wrapped(α − α_center) cos(δ_center)
y = δ
```

Tiles are eligible anchors when their centers lie inside the region plus a 4.2° search margin (three tile widths) in both local axes. Neighbor pairs are compatible with the legacy grid when either:

- horizontal: `|Δy| ≤ τ` and `||Δx| − S| ≤ τ`, or
- adjacent row: `||Δy| − S| ≤ τ` and `|Δx| ≤ 0.75 S`.

The tolerance is `τ = 0.05°` (3 arcmin). This was calibrated against nearest-neighbor differences in the supplied catalogue: dense S-PLUS rows commonly show DEC steps around 1.354–1.359° and physical RA steps around 1.35°, within roughly 0.02° of the legacy 1.3667° step; the sparse HYDRA rows include physical RA steps around 1.40°, within 0.04°. The threshold is deliberately narrower than 0.1° so unrelated sub-degree and broad 1.5° patterns do not anchor an extension.

At least two compatible neighbor pairs and three distinct anchor tiles are required. The DEC and physical RA spacings are robust medians of the observed compatible steps (falling back to the other axis when one direction has no pair). The DEC phase is a circular mean modulo the inferred DEC spacing. RA phases are inferred row-by-row modulo the declination-corrected RA step; phases between anchor rows are interpolated cyclically. This preserves the observed local phase instead of restarting at the selection boundary. Candidate centers are extrapolated over the selected region plus a half-tile margin. They remain at those inferred lattice coordinates; optimization never continuously shifts a center.

Candidate centers within 0.12° physical separation of an existing center are removed as occupied. When inference does not meet the anchor count and phase-residual checks, the planner reports `legacy_bounds_fallback` and calls `SPLUS_LEGACY_GRID_V1` on the selected bounds. A successful fit is reported as `extended_existing_grid`, with stable anchor IDs and the inferred spacings included in diagnostics.

## 4. Coverage representation and scoring

The polygon's bounding rectangle is sampled as uniform RA/DEC cell centers; samples outside the polygon receive zero weight. Each interior sample is weighted by `cos(DEC)`, the spherical area element for a small RA/DEC cell. The minimum nominal sample pitch is 0.12°; very large regions increase the pitch as needed to keep the grid below 90,000 samples. A tile covers a selected sample when:

```text
|sample_DEC − tile_DEC| ≤ 0.7 deg
|wrapped(sample_RA − tile_RA) cos(tile_DEC)| ≤ 0.7 deg
```

All existing original and already accepted tiles are unioned before candidate selection. A candidate's incremental coverage is the weighted selected-region sample area newly covered on top of existing and previously selected proposal footprints.

Selection is deterministic greedy maximum incremental gain. Ties prefer, in order, less overlap with already covered selected-region samples, less estimated tile area outside the selected polygon, then stable coordinate order. Candidate coordinates are never perturbed. Outside area is estimated from sampled polygon cells covered by each tile; overlapping outside tile areas are summed, so this is an estimate of exported new footprint area rather than a spherical union.

Planning stops at 99.5% total sampled polygon coverage or when the best remaining gain is below 0.05% of the selected area. Every chosen center must add at least that much selected-area coverage. The stop threshold is a sampling tolerance, not a completeness guarantee.

Returned metrics include selected region area, existing tiles contributing sample coverage, anchor count, candidate count, new tile count, final selected-region coverage, incremental proposal coverage, redundant proposed footprint fraction, outside-region tile area, and sample pitch.

## 5. Export integrity

Original catalogue records retain the original strings for exactly `PID,NAME,RA,DEC,EPOC,STATUS`. They are emitted unchanged and are never regenerated from decimal coordinates. New proposals receive export metadata only at download time. Astropy serializes RA to three sexagesimal hour fields and DEC to three sexagesimal degree fields, rounded to integer seconds. Before writing either file, generated names are checked against every original name and all earlier names in the export sequence. Both export variants use the six-column source schema and are covered by parser round-trip tests.

## 6. Deliberate limitations

This planner is designed for the near-axis-aligned T80/S-PLUS mosaic at ordinary survey declinations. It does not use full spherical polygon clipping, infer a rotated lattice, or model exact HEALPix footprints. The coverage score is a reproducible planning estimate and must be checked against the survey's final operational acceptance criteria before treating it as a formal completeness statement. Near the celestial poles, the RA/DEC rectangle approximation is not suitable; selected regions are validated to avoid the exact poles but the recommended operating area remains the southern survey footprint.
