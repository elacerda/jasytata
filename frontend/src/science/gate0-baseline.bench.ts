import { bench, describe } from "vitest";
import type { CoveragePolicy, Footprint, GenericLatticeTiling, SkyPolygon } from "../types";
import { DEFAULT_PROFILE } from "../profiles";
import { greedyChoose, sampleRegion, tileMask } from "./coverage";
import { footprintIntersectsRegion, localOffsetToSky } from "./footprint-engine";
import { candidateLatticeRange, generateLatticeCandidates, latticePlanningOrigin, latticePoint } from "./lattice";
import { planRegion } from "./planner";
import { performanceBox, performanceCompound, performancePlans, runPerformancePlan } from "./gate6-performance-workloads";

const benchmarkOptions = { time: 250, warmupTime: 100 };

/** Build a rectangular local east/north region using the existing v0.4 projection. */
function localBox(widthDeg: number, heightDeg: number, raDeg: number, decDeg: number): SkyPolygon {
  const center = { ra_deg: raDeg, dec_deg: decDeg };
  const offsets: [number, number][] = [
    [-widthDeg / 2, -heightDeg / 2],
    [widthDeg / 2, -heightDeg / 2],
    [widthDeg / 2, heightDeg / 2],
    [-widthDeg / 2, heightDeg / 2],
  ];
  const vertices = offsets.map(([east, north]) => {
    const [ra_deg, dec_deg] = localOffsetToSky(center, [east, north]);
    return { ra_deg, dec_deg };
  });
  return { vertices };
}

interface SamplingFixture {
  id: string;
  region: SkyPolygon;
  footprint: Footprint;
  policy: CoveragePolicy;
}

const samplingFixtures: SamplingFixture[] = [
  {
    id: "small-region",
    region: localBox(0.05, 0.03, 150, -25),
    footprint: { type: "circle", radius_deg: 0.02 },
    policy: { sampling: { target_samples_per_footprint_axis: 32, max_samples: 100_000 } },
  },
  {
    id: "medium-region",
    region: localBox(0.6, 0.4, 150, -25),
    footprint: { type: "rectangle", width_deg: 0.16, height_deg: 0.12 },
    policy: { sampling: { target_samples_per_footprint_axis: 32, max_samples: 100_000 } },
  },
  {
    id: "large-region",
    region: localBox(3, 1.5, 150, -25),
    footprint: { type: "rectangle", width_deg: 0.8, height_deg: 0.6 },
    policy: { sampling: { target_samples_per_footprint_axis: 24, max_samples: 100_000 } },
  },
  {
    id: "wide-field-footprint",
    region: localBox(10, 5, 150, -25),
    footprint: { type: "circle", radius_deg: 1.5 },
    policy: { sampling: { target_samples_per_footprint_axis: 32, max_samples: 100_000 } },
  },
  {
    id: "small-footprint-high-resolution",
    region: localBox(0.04, 0.03, 150, -25),
    footprint: { type: "circle", radius_deg: 0.003 },
    policy: { sampling: { target_samples_per_footprint_axis: 64, max_samples: 200_000 } },
  },
  {
    id: "ra-wrap",
    region: localBox(0.5, 0.25, 359.85, 30),
    footprint: { type: "circle", radius_deg: 0.05 },
    policy: { sampling: { target_samples_per_footprint_axis: 32, max_samples: 100_000 } },
  },
  {
    id: "high-declination",
    region: localBox(0.35, 0.2, 149.9, 82),
    footprint: { type: "rectangle", width_deg: 0.1, height_deg: 0.08 },
    policy: { sampling: { target_samples_per_footprint_axis: 32, max_samples: 100_000 } },
  },
];

const latticeRegion = localBox(1.5, 1.5, 150, 0);
const latticeFootprint: Footprint = { type: "circle", radius_deg: 0.008 };
const latticeTiling: GenericLatticeTiling = {
  type: "lattice",
  basis_deg: [[0.025, 0], [0, 0.025]],
  origin: { type: "region_center" },
};
const latticeOrigin = latticePlanningOrigin(latticeRegion, latticeTiling);
const latticeRange = candidateLatticeRange(latticeRegion, latticeTiling.basis_deg, latticeOrigin, latticeFootprint);
const rawLatticeSites: Array<{ ra_deg: number; dec_deg: number }> = [];
for (let j = latticeRange.j_min; j <= latticeRange.j_max; j += 1) {
  for (let i = latticeRange.i_min; i <= latticeRange.i_max; i += 1) {
    const point = latticePoint(i, j, latticeTiling.basis_deg);
    const [ra_deg, dec_deg] = localOffsetToSky(latticeOrigin, [point.x_deg, point.y_deg]);
    if (Math.abs(dec_deg) < 90) rawLatticeSites.push({ ra_deg, dec_deg });
  }
}
const enumeratedLatticeSites = generateLatticeCandidates(latticeRegion, latticeTiling, latticeFootprint, 5_000);
const planRegionFixture = localBox(3, 1.5, 150, -25);
const completeFixturePlan = planRegion(planRegionFixture, []);
const efficientFixturePlan = planRegion(planRegionFixture, [], DEFAULT_PROFILE.id, undefined, "efficient");
const samplingGridSizes = samplingFixtures.map(({ id, region, footprint, policy }) => ({
  id,
  sample_count: sampleRegion(region, footprint, policy).ra.length,
}));

console.info("v0.5.0 Gate 0 benchmark inputs", JSON.stringify({
  sampling_grids: samplingGridSizes,
  candidate_enumeration: {
    region_local_degrees: [1.5, 1.5],
    basis_degrees: latticeTiling.basis_deg,
    coefficient_range: latticeRange,
    raw_search_sites: rawLatticeSites.length,
    admissible_sites: enumeratedLatticeSites.length,
    explicit_enumerator_budget: 5_000,
  },
  planner_selection: {
    region_local_degrees: [3, 1.5],
    profile: DEFAULT_PROFILE.id,
    candidate_count: completeFixturePlan.candidate_centers.length,
    sample_count: sampleRegion(planRegionFixture).ra.length,
    complete_pointings: completeFixturePlan.tiles.length,
    efficient_pointings: efficientFixturePlan.tiles.length,
  },
}));

describe("v0.5.0 Gate 0 performance baseline", () => {
  for (const fixture of samplingFixtures) {
    bench(`region sampling: ${fixture.id}`, () => {
      sampleRegion(fixture.region, fixture.footprint, fixture.policy);
    }, benchmarkOptions);
  }

  bench("candidate enumeration: thousands of lattice sites", () => {
    generateLatticeCandidates(latticeRegion, latticeTiling, latticeFootprint, 5_000);
  }, benchmarkOptions);

  bench("coverage intersection: lattice sites against selected region", () => {
    let intersections = 0;
    for (const site of rawLatticeSites) {
      if (footprintIntersectsRegion(latticeFootprint, site, latticeRegion)) intersections += 1;
    }
    void intersections;
  }, benchmarkOptions);

  bench("planner selection and candidate ranking: Complete", () => {
    planRegion(planRegionFixture, []);
  }, benchmarkOptions);

  bench("planner selection and candidate ranking: Efficient", () => {
    planRegion(planRegionFixture, [], DEFAULT_PROFILE.id, undefined, "efficient");
  }, benchmarkOptions);
});

// Gate 6 extends the canonical harness without replacing Gate 0 inputs.
const maskGrid = sampleRegion(performanceBox(0.4, 0.3), performanceCompound,
  { sampling: { target_samples_per_footprint_axis: 8, max_samples: 100_000 } });
const maskCenters = Array.from({ length: 120 }, (_, index) => [149.84 + (index % 12) * 0.03, -0.12 + Math.floor(index / 12) * 0.025] as [number, number]);
const selectorCandidates = maskCenters.map((center) => ({ center, mask: tileMask(maskGrid, center[0], center[1], performanceCompound) }));
console.info("Gate 6 additional inputs", JSON.stringify({
  mask_samples: maskGrid.ra.length, mask_candidates: maskCenters.length,
  plans: performancePlans.map((fixture) => { const result = runPerformancePlan(fixture); return {
    id: fixture.id, candidates: result.candidate_centers.length, samples: result.metrics.sampling?.sample_count,
    selected: result.tiles.length, stop: result.selection_stop,
  }; }),
}));
describe("v0.5.0 Gate 6 measured paths", () => {
  bench("candidate masks: rotated compound", () => {
    for (const [ra, dec] of maskCenters) tileMask(maskGrid, ra, dec, performanceCompound);
  }, benchmarkOptions);
  bench("greedyChoose: compound masks", () => {
    greedyChoose(selectorCandidates, new Uint8Array(maskGrid.ra.length), maskGrid, performanceCompound, 0.999);
  }, benchmarkOptions);
  for (const fixture of performancePlans) for (const strategy of ["complete", "efficient"] as const) {
    bench(`project planning: ${fixture.id} / ${strategy}`, () => { runPerformancePlan(fixture, strategy); }, benchmarkOptions);
  }
});
