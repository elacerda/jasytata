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

The selected polygon is unwrapped around its local RA center and must span at most 180°. Neighbor pairs are measured in local physical east-west degrees at the pair's mean declination:

```text
Δx = |wrapped(α₂ − α₁)| cos((δ₁ + δ₂) / 2)
Δy = |δ₂ − δ₁|
```

Tiles are eligible anchors when their centers lie inside the region plus a 4.2° search margin (three tile widths) in both local axes. Neighbor pairs are compatible with the legacy grid when either:

- horizontal: `|Δy| ≤ τ` and `||Δx| − S| ≤ τ`, or
- adjacent row: `||Δy| − S| ≤ τ` and `|Δx| ≤ 0.75 S`.

The tolerance is `τ = 0.05°` (3 arcmin). This was calibrated against nearest-neighbor differences in the supplied catalogue: dense S-PLUS rows commonly show DEC steps around 1.354–1.359° and physical RA steps around 1.35°, within roughly 0.02° of the legacy 1.3667° step; the sparse HYDRA rows include physical RA steps around 1.40°, within 0.04°. The threshold is deliberately narrower than 0.1° so unrelated sub-degree and broad 1.5° patterns do not anchor an extension.

At least two compatible neighbor pairs, two horizontal pairs, and three distinct anchor tiles are required. DEC and physical RA spacings are robust medians of observed compatible steps; when vertical neighbors are absent, DEC spacing falls back to the active profile. Anchor centers are clustered into declination rows, retaining each observed row's actual DEC instead of forcing one constant spacing across a broad region. Each observed row also retains its own measured physical RA pitch. RA phases are inferred and residual-checked independently within each observed row, measured relative to the selected region's RA center. Missing rows interpolate from observed row coordinates, phases, and RA pitches; rows beyond the observed range extrapolate from nearby rows. Candidate centers are extended over the selected region plus a half-tile margin. They remain on those inferred lattice coordinates; optimization never continuously shifts a center. If row phases are inconsistent, the planner reports `profile_fallback` rather than labeling an unsupported phase as an existing-grid extension.

Candidate centers within 0.12° **great-circle angular separation** of an actual input center are removed as occupied. This exclusion is wider than the 0.10° maximum accepted phase residual plus the Run C 14.93-arcsecond historical holdout tolerance, while remaining much smaller than the roughly 1.35° spacing between distinct sites. Occupancy compares every candidate with actual loaded centers; it does not use inferred row membership. When inference does not meet the anchor count and phase-residual checks, the planner reports `profile_fallback` and calls the active profile's grid builder on polygon bounds expanded by half a tile. The bounds accelerate lattice construction; polygon samples decide whether each candidate contributes. A successful fit is reported as `extended_existing_grid`. Structured inference diagnostics distinguish nearby candidate tiles from the stable IDs of anchors in compatible neighbor pairs and report the selected pair count and inferred spacings. The nearby count comes from polygon **bounds plus a three-tile search margin**, so it can substantially exceed the number of tiles inside the selected polygon. Fallback reports nearby candidates but zero matched anchors, zero compatible pairs, and no inferred spacings. Coverage recalculation does not replace inference diagnostics.

## 4. Coverage representation and scoring

The polygon's bounding rectangle is sampled as uniform RA/DEC cell centers; samples outside the polygon receive zero weight. Each interior sample is weighted by `cos(DEC)`, the spherical area element for a small RA/DEC cell. The minimum nominal sample pitch is 0.12°; very large regions increase the pitch as needed to keep the grid below 90,000 samples. A tile covers a selected sample when:

```text
|sample_DEC − tile_DEC| ≤ 0.7 deg
|wrapped(sample_RA − tile_RA) cos(tile_DEC)| ≤ 0.7 deg
```

All actual existing original and already accepted enabled tile footprints are unioned before candidate selection. This stage reads the request's pointings directly, without filtering through anchor IDs, row phases, lattice candidates, or map visibility. A candidate's incremental coverage is the weighted selected-region sample area newly covered on top of existing and previously selected proposal footprints. "Existing contributors" separately counts actual tile rectangles with positive geometric intersection against the polygon; it does not depend on sample-cell hits. Every actual tile centered inside the polygon therefore counts as a contributor, including when a boundary sliver is smaller than the coverage sample pitch.

The scientific stages are: actual input footprints → existing coverage; actual input centers → lattice inference; inferred or profile lattice → candidates; actual input centers → spherical candidate occupancy; unoccupied candidates plus uncovered samples → proposals; existing footprints plus enabled proposal footprints → final coverage. The selected-area coverage fraction remains a numerical sample estimate, while contributor membership is a geometric intersection count.

Selection is deterministic greedy maximum incremental gain. Ties prefer, in order, less overlap with already covered selected-region samples, less estimated tile area outside the selected polygon, then stable coordinate order. Candidate coordinates are never perturbed. Outside area is estimated from sampled polygon cells covered by each tile; overlapping outside tile areas are summed, so this is an estimate of exported new footprint area rather than a spherical union.

Planning stops at 99.5% total sampled polygon coverage or when the best remaining gain is below 0.05% of the selected area. Every chosen center must add at least that much selected-area coverage. The stop threshold is a sampling tolerance, not a completeness guarantee.

Returned coverage metrics include selected polygon area, existing tiles contributing sample coverage, new tile count, already-covered and final coverage fractions, incremental proposal coverage, remaining uncovered fraction and area, redundant proposed footprint fraction, outside-polygon tile area, and sample pitch. Manual enable/disable changes call the coverage endpoint to recompute these figures without replanning. The displayed candidate lattice count comes from the planning response's candidate center list.

## 5. Export integrity

Original catalogue records retain every source CSV string and arbitrary non-coordinate metadata for display. Generated records contain only ICRS positions, an enabled flag, and generation provenance. Generic export writes currently enabled centers with `RA,DEC,EPOCH`: decimal-degree RA/DEC at eight fractional digits by default, or Astropy-formatted sexagesimal hour-angle RA and degree DEC at millisecond precision. The EPOCH value comes from the active profile's allowed export labels. It does not change ICRS coordinates or imply a particular equinox. Both representations are covered by importer round-trip tests.

## 6. Deliberate limitations

This planner is designed for the near-axis-aligned T80/S-PLUS mosaic at ordinary survey declinations. It does not use full spherical polygon clipping, infer a rotated lattice, or model exact HEALPix footprints. The coverage score is a reproducible planning estimate and must be checked against the survey's final operational acceptance criteria before treating it as a formal completeness statement. Near the celestial poles, the RA/DEC rectangle approximation is not suitable; selected regions are validated to avoid the exact poles but the recommended operating area remains the southern survey footprint.
