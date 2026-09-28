# Gate 6C — measured coverage accuracy

Gate 6 **PASS for the documented sampled local-plane model** at production HEAD
`b9ae9cb1555c`. G6A/G6B production code, scientific constants, and frozen T80
fixtures are unchanged. No numerical evidence required a production correction.
This conclusion covers representative resolved geometry and the tested policies;
it does not assert exact spherical coverage, accuracy for every user policy, or
resolution of sub-cell features. The narrow-gap and near-pole diagnostics below
are explicit limitations, not silently relaxed acceptance fixtures.

The executable matrix is `frontend/src/science/coverage-accuracy.test.ts`; the
unrounded machine-readable results, including actual cell dimensions, refinement,
budget sweeps and planning margins, are
[`coverage-validation.json`](../frontend/src/data/coverage-validation.json).

## Reference and acceptance criterion

`science/test-support/coverage-reference.ts` is test-only. It enumerates uniform
midpoint samples using an explicit local-degree pitch, independently of
`sampleRegion`, its layout/policy selection, and `max_samples`. It implements the
strict polygon ray-crossing mask independently and directly applies the shared
footprint containment predicates and sky-to-local projector, without production
`tileMask` bounds culling. RA unwrap and cos(DEC) weighting intentionally match
production: this isolates numerical sampling error, not coordinate-model error.
Neither this helper nor the results JSON is imported by application runtime.

The generic normal test policy is 64 samples per characteristic footprint axis
with a 90,000-cell cap; this is an explicitly tested policy, **not an installed
generic default**. T80 additionally exercises its bundled 140/90,000 policy and
its actual frozen compatibility layout. Normal reference pitch is scale/512
(eight times finer per axis than the generic normal policy). T80 uses scale/1024:
the initial 512-to-768 refinement changed coverage by 0.07463 pp, so the reference
was refined rather than weakening its criterion. Final 1024-to-1280 refinement
changes T80 by 0.04765 pp. Other normal 512-to-768 refinement changes are at most
0.00303 pp; the narrow-gap 512-to-1024 change is effectively zero.

After measuring the initial matrix, the acceptance criterion was fixed at
`abs(production - reference) < 0.005`, or **0.5 percentage point**. All normal
cases, including the 1,600-cell budget and planning integration, must satisfy
that same criterion. Reference refinement change must be below 0.0005 (0.05 pp).
Refinement stability is empirical evidence, not a rigorous quadrature error
bound. Independent analytic checks support it: full/half local rectangles give
1 and 0.5 in both grids; the T80 weighted overlap has analytic coverage
0.507354872, within 0.02401 pp of the primary reference; a contained small circle
agrees with pi*r²/region-area within 0.001 pp; the stress gap has exact weighted
coverage 0.9921875.

The normal geometry matrix errors range from 0.00038 to 0.24450 pp; the budget
sweep's non-extreme cases reach 0.24807 pp. The largest integration discrepancy
is 0.39747 pp before Efficient's second tile, still below 0.5 pp. The tested stop
margin is at least 2.806 pp above its coverage floor, more than five times the
criterion, with a roughly 0.40 marginal-efficiency margin. This supports the
tested decision, not every possible threshold. An exact or nearby threshold,
including a user-specified 0.995 floor, cannot promise phase-invariant decisions.

## Numerical matrix

Fractions are unrounded before computing error. Scale and pitches are local
degrees. `limited` refers to the principal rectangular grid, including exterior
cells. T80 compatibility dimensions are derived for the artifact because the
frozen API intentionally has no `sampling` object; its natural pitch is 0.01°.

| Case | Scale | Natural / effective step | Samples | Limited | Production | Reference | Absolute error | Error (pp) |
| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: |
| T80 frozen rectangle | 1.4 | .01 / .01 | 41,760 | no | .506109538 | .507114788 | .001005250 | .100525 |
| T80 geometry, generic bundled policy | 1.4 | .01 / .01 | 37,800 | no | .504669771 | .507114788 | .002445018 | .244502 |
| Small circle (1.875 arcmin diameter) | .03125 | .000488281 / .000488281 | 8,960 | no | .308035716 | .307233539 | .000802176 | .080218 |
| Degree circle | 1 | .015625 / .015625 | 8,960 | no | .308037113 | .307234936 | .000802177 | .080218 |
| Large circle (8° diameter) | 8 | .125 / .125 | 8,960 | no | .308125298 | .307431228 | .000694070 | .069407 |
| Rotated irregular polygon, PA 31° | .95 | .01484375 / .01484375 | 10,030 | no | .320938751 | .320994999 | .000056248 | .005625 |
| Compound, PA 17°, detector rotations +9°/-7° | .6 | .009375 / .009375 | 25,058 | no | .368307460 | .368303626 | .000003834 | .000383 |
| Same compound, slanted selected region | .6 | .009375 / .009375 | 25,058 | no | .352019430 | .352074531 | .000055101 | .005510 |
| Narrow gap stress | 1 | .015625 / .015625 | 1,536 | no | 1 | .992187500 | .007812500 | .781250 |
| Budget 1,600 | 1 | .015625 / .037343423 | 1,598 | yes | .306634716 | .307234936 | .000600220 | .060022 |
| RA=0 crossing, partial circle | .03125 | .000488281 / .000488281 | 8,960 | no | .308035716 | .307233539 | .000802176 | .080218 |

All required normal cases meet the criterion. The T80 generic case does not
replace the compatibility sampler or alter any golden value.

## Scale, density and grid phase

The three similar circles scale footprint diameter, region width/height
(1.75/1.25 diameters) and pointing offsets (east/north 0.5/0.25 diameters)
together by factors 1/32, 1 and 8. They have identical policy, 8,960 samples and
normalized pitch 1/64. Error spread is only **0.01081 pp across a 256-fold scale
range**. Reference fractions vary by 0.01977 pp at the largest scale because
cos(DEC) weighting and the pointing-centered local projection are not perfectly
scale invariant. This is comparable numerical accuracy without absolute-degree
tuning; it is not proof of spherical accuracy for an 8° footprint.

| Fixture | Density 16 error (pp) | Density 64 | Density 128 |
| --- | ---: | ---: | ---: |
| Small partial circle | .705218 | .080218 | .035575 |
| Rotated compound | .090982 | .000383 | .001131 |

Both improve strongly overall. The compound's 64-to-128 increase is small grid
aliasing, not divergence; perfect monotonicity is deliberately not required.
The low circle density does not meet the normal accuracy criterion.

Eight deterministic translations of a fully contained small circle through
fractions of one production cell preserve its physical overlap area while
moving the boundary relative to cell centers. Maximum error is 0.12207 pp and
production coverage range is **0.21205 pp**; reference range is approximately
1e-9 pp. This is measurable but below the acceptance tolerance and tested
planning margin. A separate rigid translation of region and footprint together
changes coverage by less than 1e-10 fraction: the grid is anchored to region
bounds, so a rigid translation alone is not a useful aliasing experiment.

## Detector gaps and budgets

The compound has two 0.6° x 0.8° children with different offsets and rotations,
an uncovered inter-detector gap and partial region overlap. Its minimum-child
scale of 0.6° resolves this gap at .009375° pitch. Agreement also holds for a
slanted selected polygon. These measurements support retaining the G6A scale
rule for resolved detector structure; they do not establish a universal guarantee.

The stress uses two 1° detectors separated by 3/256° = .01171875°, only 0.75 of
the .015625° production pitch. A 1.5° x .25° selected rectangle crosses that
gap. Production misses it completely and reports 100%; reference and analytic
integration give 99.21875%. The 0.78125 pp error intentionally exceeds normal
acceptance. This is the already documented sub-cell limitation, not an erroneous
containment or policy implementation. Resolving arbitrary smaller gaps would
require increasing density and possibly budget; Gate 6C does not force the
smallest gap into the characteristic scale or introduce adaptive algorithms.

| Declared cap | Actual cells | Effective step (°) | Error (pp) |
| ---: | ---: | ---: | ---: |
| 100 (stress) | 96 | .15625 | .515025 |
| 400 | 391 | .076086957 | .032826 |
| 900 | 875 | .050277010 | .248073 |
| 1,600 | 1,598 | .037343423 | .060022 |
| 90,000 (natural) | 8,960 | .015625 | .080218 |

The 900 budget worsens error by 0.16785 pp versus natural sampling; 1,600 happens
to improve it by 0.02020 pp. Aliasing prevents a monotonic budget/error relation.
All bounds remain represented, actual counts respect caps, and the main
budget-limited grid is deterministic. The very restrictive 100 budget breaches
normal accuracy: a computation bound is not an accuracy guarantee. Coarsening
metadata must inform interpretation; increasing the requested density cannot
recover information while the same cap remains active.

## RA, declination and polar model limits

RA=0 crossing matches the translated ordinary-RA partial circle in production
and reference to 1e-10 fraction; the unwrap convention remains unchanged.

| Region midpoint DEC | Production | Reference | Error (pp) |
| ---: | ---: | ---: | ---: |
| 0° | .308035716 | .307233539 | .080218 |
| -50° | .308078536 | .307223974 | .085456 |
| +50° | .307992895 | .307215191 | .077770 |
| +89.8° (unsupported diagnostic) | .297742342 | .296955058 | .078728 |

For equivalent 1.875-arcmin local geometry at ordinary declinations, production
spread is 0.00856 pp and reference spread 0.00183 pp. The small pointing-centered
projection/cosine-weight variations remain well below tolerance. This validates
these local fixtures through +/-50°, not a universal declination/extent cutoff.

The +89.8° diagnostic remains deterministic and finite but reference coverage
differs from the equatorial equivalent by **1.02785 pp**. Agreement between its
two resolutions does not validate its sky model. The dimensionless cosine floor
of .01 becomes active above about |DEC|=89.427°; rapid cosine variation and the
RA branch/local-plane approximation make this regime unsupported. Exact poles
remain rejected by region validation. No spherical/polar replacement is added.

## Complete and Efficient integration

A generic 1.875-arcmin square camera on a declared square lattice plans a
1.8 x 1.8-footprint region. Complete chooses nine tiles and reaches coverage 1
in both production and independent reference; it retains its sampled completion
definition and does not invent lattice sites.

Efficient uses an explicit non-T80 floor .4 and marginal threshold .8. It chooses
two tiles; independent high-resolution reranking also chooses two. Coverage is
.428061843 versus .431844394 (0.37826 pp discrepancy). Before tile two, coverage
is .304399533 versus .308374240, both more than .08 below the floor. At the stop,
coverage is .02806/.03184 above the floor, and best remaining marginal efficiency
is .400665869/.400043285, both comfortably below .8. Repeated production plans
are identical. Thus this stop is supported by resolution-independent margins;
an exact threshold boundary is not claimed to be invariant. Existing G6B and
frozen Complete/Efficient contracts remain additional regression protection.

## Scientific constant audit

| Value | Relevant end-state occurrences | Classification |
| --- | --- | --- |
| 0.01 | `coverage.ts` legacy pitch; `grid.ts` legacy enumeration lower span; cosine floors in coverage, footprint projection and lattice bounds | Legacy compatibility; legacy operational bound; dimensionless projection safeguard, respectively |
| 90000 | Bundled survey `coverage.sampling.max_samples`; `LEGACY_MAX_REGION_SAMPLES` | Profile policy/data; explicit compatibility cap |
| 0.995 | Bundled `coverage.efficient.min_coverage`, consumed by selection and v1 adapter | Profile policy/data; v1 compatibility source |
| 0.03 | Bundled `coverage.efficient.min_marginal_efficiency`, consumed by selection and v1 adapter | Profile policy/data; v1 compatibility source |
| 0.12 | `OCCUPIED_CENTER_TOLERANCE_DEG` / `excludeOccupied` | Legacy compatibility only; generic occupancy is basis-relative |
| 0.10 | Derived `2 * INFERENCE_TOLERANCE_DEG` maximum phase residual | Legacy compatibility only; no generic absolute-degree phase rule |
| 0.05 | `INFERENCE_TOLERANCE_DEG` for legacy rows/pairs/spacing/phase | Legacy compatibility only |
| 1200 | Planner candidate/gap-fill caps; `AladinMap.tsx` display slice | Operational browser safeguards, not scientific angular thresholds |

Other occurrences in golden data, validation inputs, tests and explanatory
documentation are fixture/unrelated values, not hidden generic policy. The .01
cosine floor is dimensionless and is not a generic .01° sampling rule. Generic
science reads profile sampling, Efficient and normalized inference policy.
Remaining legacy tolerance/pitch duplicates are explicit compatibility migration
work; this gate neither migrates them nor changes their frozen behavior.

## Execution and scope

The new suite has 20 tests and takes roughly 4–6 seconds locally in isolation.
References cache scalar results for identical geometry/pitch, never production
answers. Circle references use 573,440 cells; compound references use about
1.6 million, with one refinement about 3.6 million. T80's two finer resolutions
use about 2.0/3.2 million cells once each, shared by scalar cache between generic
and compatibility evaluations. These focused exceptions are required by the
reference stability check; no reference computation runs in the browser.
The opt-in command below prints the measured table; routine test runs stay quiet:

```bash
cd frontend
VITE_G6C_REPORT=1 npm test -- --run src/science/coverage-accuracy.test.ts
```

Final repository validation: `git diff --check`, `make test`, `make lint`,
`make typecheck`, `make build` and `make check` all pass. There are 279 passing
tests in 18 files (20 new tests); the standalone full run took 30.60 seconds,
and the test phase of `make check` took 29.76 seconds. The new suite took
5.70/5.34 seconds inside those parallel runs; this is worker time, not a measured
increase in total wall time. Build retains its existing large-chunk warning.
`golden.json`, `planner-contract.json` and `efficient-contract.json` have no diff.

CRG MCP context was fresh at HEAD before source navigation. Final `detect_changes`
and `get_review_context` ran, followed by incremental/full rebuild and another
review. CRG estimated roughly 29,000 tokens saved (99–100%, heuristic); this is
not measured token telemetry. The new untracked test/helper files were not
indexed even after full rebuild, so its zero affected-node/test-gap output is
not evidence about those files. Direct review covered reference independence,
runtime import isolation, required scientific cases and diagnostic exceptions.
No CLI fallback, production impact change, commit or push was used; `poly.txt`
was untouched.

Gate 6 is scientifically complete for the documented model: T80, arcminute and
multi-degree scale, rotated polygons, resolved compound gaps, scale invariance,
bounded computation and Complete/Efficient integration all have measured passing
evidence. Sub-pitch gaps, extreme budget coarsening and polar/spherical geometry
remain explicit limits. Gate 7+ retains profile/export UX and the roadmap's later
work; no later-gate UI, adaptive sampling, exact clipping or spherical engine was
implemented. Compatibility configuration migration still requires its own review.
