# Run C historical reconstruction acceptance

This historical acceptance record was measured by the former Python regression suite using ICRS centers from the bundled `frontend/public/data/tiles_nc.csv`. The suite removed holdout centers from planner input, retained neighboring real SPLUS centers from one local patch, and planned a polygon around hidden positions. Recovery used one-to-one matches by true spherical angular separation. Extras are proposals without a matched hidden center. Compact expected cases remain in `frontend/src/data/golden.json` and are checked by the TypeScript test suite.

The historical tolerance was **14.93 arcseconds**: twice the measured 95th percentile (**7.47 arcseconds**) of midpoint residuals for 1,701 uninterrupted three-center runs in the catalogue's SPLUS-b/n/d rows. This includes sexagesimal coordinate rounding and is far below an arcminute. A many-arcminute displacement fails. The committed golden cases preserve expected proposal coordinates independently of the current implementation.

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
