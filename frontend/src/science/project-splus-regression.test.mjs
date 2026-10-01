import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import baseline from "../data/v0.5.0-gate4-splus-regression.json";
import referenceCsv from "../../public/data/tiles_nc.csv?raw";
import { parseCatalogueCsv } from "./catalogue";
import { planRegion } from "./planner";

const catalogue = parseCatalogueCsv(new TextEncoder().encode(referenceCsv), "tiles_nc.csv").tiles;
const byName = new Map(catalogue.map((tile) => [tile.name, tile]));

describe("Gate 4 direct pre-gate S-PLUS regression", () => {
  it.each(baseline.cases)("$id / $strategy matches the full response at Gate 3", (fixture) => {
    const existing = fixture.existing_names === null ? catalogue : fixture.existing_names.map((name) => byName.get(name));
    const result = planRegion(fixture.polygon, existing, undefined, undefined, fixture.strategy);
    expect(result.solution).toBe(fixture.solution);
    expect(result.tiles.length).toBe(fixture.selected_count); expect(result.candidate_centers.length).toBe(fixture.candidate_count);
    expect(result.metrics).toEqual(fixture.metrics);
    // Exact fingerprint includes coordinates/order, identities, inference, diagnostics,
    // masks' derived metrics, and the registered overlap behavior.
    expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(fixture.expected_sha256);
  });
});
