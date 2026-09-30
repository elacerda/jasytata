import type { CoverageResult, PlanMetrics } from "../../types";
import { measureActiveCoverage } from "../coverage";

/** Require a resolved metric in fixtures whose numeric expectations are frozen.
 * @param result - Runtime union requiring explicit status inspection.
 * @returns Resolved numeric metrics without altering scientific expectations.
 * @throws If the fixture unexpectedly becomes unavailable.
 */
export function requireResolvedCoverage(result: CoverageResult): PlanMetrics {
  if (result.coverage_status !== "resolved" && result.coverage_status !== "legacy_compatible") throw new Error(`Unexpected coverage status: ${result.coverage_status}`);
  return result;
}

/** Resolve coverage and assert the scientific precondition before numeric checks.
 * @param args - Unmodified production coverage arguments.
 * @returns Metrics of a fixture that must remain resolved.
 */
export function measureResolvedCoverage(...args: Parameters<typeof measureActiveCoverage>): PlanMetrics {
  return requireResolvedCoverage(measureActiveCoverage(...args));
}
