# Run C large-overlap regression

The browser's 153.47 deg² polygon vertices and request body were unavailable. These measurements use a separate deterministic ICRS rectangle, RA 262°–277° and DEC −40° to −27°, against all 4,774 actual centers in `reference/tiles_nc.csv`. No browser vertices were inferred from screenshots.

| Measurement | Result |
| --- | ---: |
| Selected region area | 162.2592 deg² |
| Actual existing centers inside | 64 |
| Existing footprint contributors | 88 |
| Already covered | 80.970% |
| Independent 0.04° footprint integration | 81.077% |
| Proposed tiles | 20 |
| Minimum proposal-to-existing spherical separation | 1.36931° |
| Redundant proposal coverage | 1.694% |
| Final sampled coverage | 99.555% |

The test counts center containment and footprint intersection independently of the planner, and checks existing coverage with a finer declination-weighted grid. Every one of the 64 actual centers inside the polygon is separately asserted to contribute. It also checks every returned candidate against the 0.12° spherical occupancy threshold, and verifies that every proposal comes from an unoccupied returned lattice site. Frontend tests confirm that hiding a catalogue leaves the complete plan input and all displayed scientific metrics unchanged.

## Why anchor and contributor counts diverged

The counts have different spatial scopes. `_tiles_near_region` selects inference candidates using the polygon's **bounding rectangle plus a three-tile margin**; `_infer_lattice_group` reports the subset in compatible pairs. Neither count means “inside the polygon.” Existing coverage uses actual tile footprints against the polygon. A wide or irregular polygon can therefore have many inference anchors and comparatively few contributors.

There was also a frontend context bug: after an accepted plan, selecting another polygon cleared `pending` but retained `proposalContext`. `activeContext = pending ?? proposalContext` continued to show the old plan's anchor counts, while the coverage effect recomputed contributors and already-covered fraction for the new polygon. Loading another catalogue had the same stale-context risk. The fix clears that inference context when the scientific polygon or catalogue input changes, while retaining accepted proposal centers.

Backend history shows that the local row-pitch change did not route historical coverage through the inferred lattice: `plan_region` already passed `request.existing_tiles` directly to `_covered_mask` and `_contributing_tile_count`. The latter was sample-cell based and could miss a narrow positive footprint intersection; it now counts positive geometric polygon/footprint intersections. Candidate exclusion previously used a local planar separation; it now uses great-circle separation from every actual active input center. A polar regression distinguishes the two distance calculations.

Without the exact browser request, the specific 11-contributor result cannot be attributed to one of these paths conclusively. In Vite development mode, the finalized vertices can now be inspected and the exact last submitted plan request JSON can be copied from **Development: plan input**. This control is absent from the production build.
