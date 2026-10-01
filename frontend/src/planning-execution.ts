import type { CoverageResult, RegionPlanResponse, UnavailableCoverage } from "./types";
import { CoverageUnavailableError } from "./science/coverage";
import { executePlanningOperation, type PlanningOperation } from "./science/planning-operation";

type Result = RegionPlanResponse | CoverageResult;
/** Minimal dedicated-worker transport, injectable without a browser for tests. */
export interface PlanningWorkerTransport {
  onmessage: ((event: MessageEvent<{ result?: Result; error?: { message: string; unavailable?: UnavailableCoverage } }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: PlanningOperation): void;
  terminate(): void;
}

/** Run one whole operation off the main thread when Workers are available.
 * @param request - Serializable scientific input and operation profile snapshot.
 * @param signal - Optional cancellation; termination rejects without publishing results.
 * @param createWorker - Optional test transport. Omission uses Vite's local module worker.
 * @returns A complete result only. Aborted or terminated transports cannot settle it again.
 * @throws Scientific errors, transport errors, or AbortError on cancellation.
 */
export function runPlanningOperation(request: PlanningOperation, signal?: AbortSignal,
  createWorker?: () => PlanningWorkerTransport): Promise<Result> {
  if (signal?.aborted) return Promise.reject(new DOMException("Planning cancelled", "AbortError"));
  if (!createWorker && typeof Worker === "undefined") return Promise.resolve().then(() => {
    if (signal?.aborted) throw new DOMException("Planning cancelled", "AbortError");
    return executePlanningOperation(request);
  });
  return new Promise((resolve, reject) => {
    let worker: PlanningWorkerTransport;
    try { worker = createWorker ? createWorker() : new Worker(new URL("./planning-worker.ts", import.meta.url), { type: "module" }); }
    catch (error) { reject(error); return; }
    let settled = false;
    const finish = (result?: Result, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.onmessage = null; worker.onerror = null;
      worker.terminate();
      if (error !== undefined) reject(error); else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException("Planning cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (signal?.aborted) { abort(); return; }
      if (data.error) finish(undefined, data.error.unavailable ? new CoverageUnavailableError(data.error.unavailable) : new Error(data.error.message));
      else if (data.result !== undefined) finish(data.result);
      else finish(undefined, new Error("Planning worker returned no result"));
    };
    worker.onerror = (event) => finish(undefined, new Error(event.message || "Planning worker failed"));
    try { worker.postMessage(request); } catch (error) { finish(undefined, error); }
  });
}
