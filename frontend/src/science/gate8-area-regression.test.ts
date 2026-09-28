import { afterEach, expect, it, vi } from "vitest";
import { cases } from "../data/gate8/fixtures";
import * as engine from "./footprint-engine";
import { greedyChoose, measureMetrics, sampleRegion, tileMask } from "./coverage";

afterEach(() => vi.restoreAllMocks());

it("Gate 8 mosaic area is integrated once per selection/measurement, independently of candidate count", () => {
  const fixture = cases[2], footprint = fixture.document.instrument.footprint;
  const grid = sampleRegion(fixture.region, footprint, fixture.document.survey.coverage);
  const candidates = [-0.1, 0, 0.1].map((offset) => {
    const [ra, dec] = engine.localOffsetToSky(fixture.origin, [offset, 0]);
    return { center: [ra, dec] as [number, number], mask: tileMask(grid, ra, dec, footprint) };
  });
  const area = engine.footprintArea(footprint);
  // Count integrations without repeatedly paying the real adaptive quadrature cost.
  const integrate = vi.spyOn(engine, "footprintArea").mockReturnValue(area);
  const empty = new Uint8Array(grid.ra.length);
  const chosen = greedyChoose(candidates, empty, grid, footprint);
  expect(chosen.length).toBeGreaterThan(1);
  expect(integrate).toHaveBeenCalledTimes(1);
  integrate.mockClear();
  const metrics = measureMetrics(chosen, empty, grid, 0, footprint);
  expect(metrics.selected_region_coverage).toBeGreaterThan(0);
  expect(integrate).toHaveBeenCalledTimes(1);
});
