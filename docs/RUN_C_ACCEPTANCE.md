# Run C historical reconstruction acceptance

The holdout tests select ICRS centers from `reference/tiles_nc.csv`, remove them from the planner input, retain neighboring real SPLUS centers from one local patch, and plan a polygon around the hidden positions. Recovery uses one-to-one matches by true spherical angular separation. Extras are proposals without a matched hidden center.

The tolerance is **14.93 arcseconds**: twice the measured 95th percentile (**7.47 arcseconds**) of midpoint residuals for 1,701 uninterrupted three-center runs in the catalogue's SPLUS-b/n/d rows. This includes sexagesimal coordinate rounding and is far below an arcminute. A many-arcminute displacement fails. The test recalculates this threshold from the reference CSV and requires it to stay below 18 arcseconds.

| Region | Hidden | Recovered | Recovery fraction | Median residual | Max residual | Extras | Mode |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| SPLUS-b interior single | 1 | 1 | 100% | 4.4″ | 4.4″ | 0 | `extended_existing_grid` |
| SPLUS-b three holes in one row | 3 | 3 | 100% | 3.3″ | 3.3″ | 0 | `extended_existing_grid` |
| SPLUS-b holes across adjacent rows | 4 | 4 | 100% | 2.2″ | 8.8″ | 0 | `extended_existing_grid` |
| SPLUS-n northern declinations | 2 | 2 | 100% | 3.6″ | 3.6″ | 0 | `extended_existing_grid` |
| SPLUS-b row edge continuation | 2 | 2 | 100% | 0.0″ | 0.0″ | 0 | `extended_existing_grid` |
| SPLUS-d southern declinations | 2 | 2 | 100% | 6.0″ | 6.0″ | 0 | `extended_existing_grid` |
| SPLUS-b one retained neighbor | 1 | 0 | 0% | — | — | 4 | `profile_fallback` |

The fallback row tests insufficient anchor evidence: one retained neighbor cannot establish a lattice. Its four profile-grid proposals are reported as extras rather than treated as a historical reconstruction.

A separate deterministic rectangle spanning RA 255°–287° and DEC −44.5° to −18° exercises the broader SPLUS-b regime. It yields `extended_existing_grid`, 99.49% sampled coverage, and 1.26% redundant proposal coverage using only the SPLUS-b catalogue subset. The browser's polygon vertices were not captured, so this regression checks solution quality without asserting its reported count of 75 proposals.
