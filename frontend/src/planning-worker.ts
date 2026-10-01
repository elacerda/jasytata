import { executePlanningOperation, type PlanningOperation } from "./science/planning-operation";
import { CoverageUnavailableError } from "./science/coverage";

// Dedicated one-operation worker: its only message is an entire final result.
self.onmessage = (event: MessageEvent<PlanningOperation>) => {
  try { self.postMessage({ result: executePlanningOperation(event.data) }); }
  catch (error) {
    self.postMessage({ error: { message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CoverageUnavailableError ? { unavailable: error.result } : {}) } });
  }
};
