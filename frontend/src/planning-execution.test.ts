import { describe, expect, it, vi } from "vitest";
import { runPlanningOperation, type PlanningWorkerTransport } from "./planning-execution";
import { executePlanningOperation, planningGeometryContext, serializedPlanningChoices, type PlanningOperation } from "./science/planning-operation";
import { performancePlans, runPerformancePlan } from "./science/gate6-performance-workloads";
import { profileRegistry, createBundledProfileRegistry } from "./profiles/registry";
import { planRegion } from "./science/planner";
import { projectCoverageProfile } from "./profiles/planning";
import { CoverageUnavailableError } from "./science/coverage";

function request(fixture = performancePlans[0]): PlanningOperation {
  return { kind: "plan", polygon: fixture.polygon, existingTiles: [], projectSource: fixture.source,
    instruments: profileRegistry.listAnyInstrumentProfiles(), surveys: profileRegistry.listAnySurveyProfiles() };
}
function transport() {
  const worker: PlanningWorkerTransport = { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  return worker;
}

describe("Gate 6 serializable operation and dedicated transport", () => {
  it.each(performancePlans)("$id cloned request retains entire scientific result", (fixture) => {
    const input = request(fixture); const before = structuredClone(input);
    expect(executePlanningOperation(structuredClone(input))).toEqual(runPerformancePlan(fixture));
    expect(input).toEqual(before);
  });
  it("coverage operation matches the frozen nominal-plan metrics after acceptance", () => {
    const fixture = performancePlans[0]; const plan = runPerformancePlan(fixture);
    const instrument = profileRegistry.resolveInstrumentProfile(fixture.source.instrumentId);
    if (instrument.schema_version !== 3) throw new Error("Expected v3 fixture");
    const input = request(fixture);
    input.kind = "coverage"; input.proposedTiles = plan.tiles; input.profileId = instrument.id;
    input.profile = projectCoverageProfile(instrument);
    input.geometryChoices = { coverageBasis: "single_exposure", measurementBasis: instrument.footprint_semantics.role, outputInstrumentId: instrument.id };
    expect(executePlanningOperation(structuredClone(input))).toEqual(plan.metrics);
  });
  it("canonical PA/sequence choices reproduce the synchronous registered lookup", () => {
    const fixture = performancePlans[3]; const input = request(fixture);
    input.geometryChoices = { outputInstrumentId: fixture.source.instrumentId, outputStrategyId: fixture.source.strategyId,
      coverageBasis: "effective_sequence", measurementBasis: "nominal_envelope" };
    const result = executePlanningOperation(structuredClone(input));
    expect(result).toEqual(planRegion(fixture.polygon, [], undefined, undefined, "complete", profileRegistry,
      planningGeometryContext(input.geometryChoices, profileRegistry), fixture.source));
    expect(result).toEqual(runPerformancePlan(fixture));
  });
  it("custom callbacks and density cannot be silently replaced by transport defaults", () => {
    const choices = { coverageBasis: "single_exposure" } as const;
    const context = planningGeometryContext(choices, profileRegistry);
    expect(serializedPlanningChoices(context)).toEqual(choices);
    expect(serializedPlanningChoices({ ...context })).toBeUndefined();
    context.sequenceForTile = () => undefined;
    expect(serializedPlanningChoices(context)).toBeUndefined();
    const changed = planningGeometryContext(choices, profileRegistry);
    changed.targetSamplesPerFootprintAxis = 64;
    expect(serializedPlanningChoices(changed)).toBeUndefined();
  });
  it("supports imported profiles in an isolated operation registry", () => {
    const registry = createBundledProfileRegistry(); const real = registry.resolveInstrumentProfile("vlt-muse-wfm");
    registry.registerInstrumentProfileV3({ ...real, id: "gate6-imported-geometry" });
    const input = request(); input.projectSource = { ...input.projectSource!, instrumentId: "gate6-imported-geometry" };
    input.instruments = registry.listAnyInstrumentProfiles(); input.surveys = registry.listAnySurveyProfiles();
    expect(executePlanningOperation(input)).toEqual(planRegion(input.polygon, [], undefined, undefined, "complete", registry, undefined, input.projectSource));
    expect(() => profileRegistry.resolveAnyInstrumentProfile("gate6-imported-geometry")).toThrow();
  });
  it("publishes only a complete response and terminates its transport", async () => {
    const worker = transport(); const input = request();
    const pending = runPlanningOperation(input, undefined, () => worker);
    expect(worker.postMessage).toHaveBeenCalledWith(input);
    const result = executePlanningOperation(structuredClone(input));
    worker.onmessage?.(new MessageEvent("message", { data: { result } }));
    expect(await pending).toEqual(result); expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
  });
  it("cancelled run publishes no partial result, and a late old response cannot overwrite the newer run", async () => {
    const oldWorker = transport(); const newWorker = transport(); const controller = new AbortController();
    const input = request(); const before = structuredClone(input);
    let published: unknown = null;
    const old = runPlanningOperation(input, controller.signal, () => oldWorker).then((value) => { published = value; });
    const rejection = expect(old).rejects.toMatchObject({ name: "AbortError" });
    const lateHandler = oldWorker.onmessage!;
    controller.abort(); await rejection;
    expect(published).toBeNull(); expect(oldWorker.terminate).toHaveBeenCalledOnce();
    const newer = runPlanningOperation(request(performancePlans[2]), undefined, () => newWorker).then((value) => { published = value; });
    const newResult = executePlanningOperation(request(performancePlans[2]));
    newWorker.onmessage?.(new MessageEvent("message", { data: { result: newResult } })); await newer;
    lateHandler(new MessageEvent("message", { data: { result: executePlanningOperation(input) } }));
    expect(published).toEqual(newResult); expect(input).toEqual(before);
  });
  it("pre-cancellation never creates a worker", async () => {
    const controller = new AbortController(); controller.abort(); const factory = vi.fn(transport);
    await expect(runPlanningOperation(request(), controller.signal, factory)).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
  });
  it("scientific refusals retain their typed unavailable result", async () => {
    const worker = transport(); const pending = runPlanningOperation(request(), undefined, () => worker);
    const unavailable = { coverage_basis: "target_access", coverage_status: "unsupported_basis" } as const;
    worker.onmessage?.(new MessageEvent("message", { data: { error: { message: "refused", unavailable } } }));
    await expect(pending).rejects.toBeInstanceOf(CoverageUnavailableError);
    await expect(pending).rejects.toMatchObject({ result: unavailable });
  });
  it("worker entry point posts only complete results or serialized typed errors", async () => {
    const scope = { onmessage: null as ((event: MessageEvent<PlanningOperation>) => void) | null, postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    try {
      await import("./planning-worker");
      const input = request(performancePlans[2]);
      scope.onmessage?.(new MessageEvent("message", { data: structuredClone(input) }));
      expect(scope.postMessage).toHaveBeenLastCalledWith({ result: executePlanningOperation(input) });
      const refused = request(); refused.projectSource = { ...refused.projectSource!, instrumentId: "subaru-pfs-target-access" };
      scope.onmessage?.(new MessageEvent("message", { data: refused }));
      expect(scope.postMessage).toHaveBeenLastCalledWith({ error: expect.objectContaining({
        unavailable: { coverage_basis: "target_access", coverage_status: "unsupported_basis" },
      }) });
    } finally { vi.unstubAllGlobals(); }
  });
  it("worker startup, postMessage and runtime failures reject without a result", async () => {
    await expect(runPlanningOperation(request(), undefined, () => { throw new Error("startup"); })).rejects.toThrow("startup");
    const worker = transport(); vi.mocked(worker.postMessage).mockImplementation(() => { throw new Error("clone"); });
    await expect(runPlanningOperation(request(), undefined, () => worker)).rejects.toThrow("clone");
    expect(worker.terminate).toHaveBeenCalledOnce();
    const runtime = transport(); const pending = runPlanningOperation(request(), undefined, () => runtime);
    runtime.onerror?.(new ErrorEvent("error", { message: "runtime" }));
    await expect(pending).rejects.toThrow("runtime"); expect(runtime.terminate).toHaveBeenCalledOnce();
  });
});
