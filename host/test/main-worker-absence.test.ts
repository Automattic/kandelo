import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DeferredWorkerHandle, createWorkerAbsence } from "../src/deferred-worker-handle";
import { createWorkerQuiescence, prepareProcessWorkerAbsence, sealProcessWorkerAbsence,
  processWorkerRetirementProven, waitForProcessWorkerRetirement } from "../src/worker-quiescence";
import { MockWorkerHandle, type WorkerHandle } from "../src/worker-adapter";
import { ProcessMemoryAllocator, acquireForkMemoryClone, FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";
import { ProcessGenerationObservations, type ProcessGenerationEventData } from "../src/process-generation-observation";
import {
  ForkReplayGateCoordinator, observeForkReplayWorker, retireForkReplayWorker, waitForForkReplayRetirement,
} from "../src/fork-replay-gate";
import { VforkLifetimeCoordinator, VforkAddressSpaceBusyError } from "../src/vfork-lifetime";
import { ExactProcessGenerationDetachLedger } from "../src/process-generation-detach";
import { signalExitStatus } from "../src/trap-signals";
import { signalFromExitStatus } from "../src/process-lifecycle";
import { CH_TOTAL_SIZE } from "../src/generated/abi";

const PAGE = 65536, PARENT = 41, CHILD = 73;
type Host = "node" | "browser";
type Mode = "dead" | "stale" | "deferred" | "started" | "constructor-failure" | "started-stale";

/** Actual entry bodies and DeferredWorkerHandle, with bounded platform
 * dependencies. No normal guest/kernel is built or claimed by these controls. */
function actualMainLaunchControl(host: Host, ptrWidth: 4 | 8, vfork: boolean, mode: Mode,
  factory?: () => WorkerHandle) {
  const url = new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url);
  const source = ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
  const names = ["handleOrdinaryFork", "handleVfork", "installProcessWorkerListeners", "terminateTrackedWorker", "registerObservedProcess", "finishProcessExit"];
  const functions = names.map(name => {
    const found = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!found) throw Error(`missing actual ${host} ${name}`);
    return found.getText(source);
  }).join("\n");
  const code = ts.transpileModule(functions, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const allocator = new ProcessMemoryAllocator({maxMemories: 2, maxTotalBytes: 8 * PAGE, retirementBackpressureMs: 0});
  const parentLease = allocator.acquire({ptrWidth, initialPages: 4, maximumPages: 4});
  const memory = parentLease.memory;
  const events: ProcessGenerationEventData[] = [];
  const observations = new ProcessGenerationObservations(event => events.push(event)); observations.enable();
  const parent = {memory, memoryLease: parentLease, ptrWidth, programBytes: new ArrayBuffer(0), programModule: {},
    channelOffset: PAGE, argv: [], externrefGeneration: {id: 1},
    layout: {channelOffset: PAGE, maximumPages: 4, maxAddr: 4 * PAGE, mmapBase: 3 * PAGE},
    threadAllocator: {allocateHostControl: () => ({slotStartPage: 2, channelOffset: 2 * PAGE, tlsOffset: 0}), free: vi.fn()},
  };
  const processes = new Map<number, any>([[PARENT, parent]]);
  const lifetime = new VforkLifetimeCoordinator<any>();
  const admitted = Promise.withResolvers<any>();
  const preflight = Promise.withResolvers<void>();
  let generation: any;
  const actualAdmit = observations.admit.bind(observations);
  observations.admit = (pid, info, id) => {
    generation = info; const result = actualAdmit(pid, info, id); admitted.resolve(info); return result;
  };
  let start!: () => void, cancel!: () => void;
  let backing: WorkerHandle | undefined;
  let replay!: ForkReplayGateCoordinator;
  let teardownSnapshot: {mainAck: boolean; execAck: boolean; absent: boolean} | undefined;
  const createWorker = vi.fn(() => {
    if (mode === "constructor-failure") throw Error("factory entered and failed");
    backing = factory?.() ?? new MockWorkerHandle(); return backing;
  });
  const consumedLeases = new WeakSet<object>();
  const ledger = new ExactProcessGenerationDetachLedger<any>(
    pid => processes.get(pid), (pid, exact) => {if (processes.get(pid) === exact) processes.delete(pid);},
    (exact, result) => observations.retired(exact, result),
  );
  const detach = vi.fn(async ({pid, generation: exact, retire}: any) => ledger.detach({
    pid, generation: exact, memory: exact.memory,
    detach: (_pid, expected) => !processes.has(pid) || processes.get(pid)?.memory === expected,
    settle() {},
    async retire(commit) {await retire(commit); consumedLeases.add(exact.memoryLease);},
  }));
  let actual: any;
  const retireActual = (info = generation): Promise<void> => host === "node"
    ? actual.finish(CHILD, 0, info.worker, "exit")
    : actual.finish(CHILD, 0, 11, info.worker, "exit");
  const awaitTeardown = vi.fn(async () => {
    teardownSnapshot = {mainAck: generation.workerQuiescence.settled, execAck: generation.execRetirement.settled,
      absent: generation.workerAbsence?.proven ?? false};
    await retireActual();
  });
  const deps = {
    processes, processMemoryAllocator: allocator, sampleProcessMemoryStats: () => undefined, vforkMechanismTraceEnabled: false,
    prepareProcessWorkerAbsence, sealProcessWorkerAbsence, processWorkerRetirementProven, waitForProcessWorkerRetirement,
    traceVforkMechanism() {}, injectVforkWorkerStartFailure: false, injectedVforkWorkerStartFailure: false, acquireForkMemoryClone, DeferredWorkerHandle, createWorkerAbsence, createWorkerQuiescence,
    ForkReplayGateCoordinator, retireForkReplayWorker, waitForForkReplayRetirement, VforkAddressSpaceBusyError, observeForkReplayWorker: (gate: ForkReplayGateCoordinator, ...rest: any[]) => {
      replay = gate; (observeForkReplayWorker as any)(gate, ...rest);
    },
    retryKernelEntryResult: async (operation: () => unknown) => operation(), waitForProcessTeardowns: async () => {},
    CH_TOTAL_SIZE, FORK_SAVE_BUFFER_SIZE, WASM_PAGE_SIZE: PAGE, PAGE_SIZE: PAGE, PAGES_PER_THREAD: 1, PROCESS_FORK_MODE_VFORK: 1, SIGSEGV: 11,
    kernelWorker: {
      shouldLaunchPendingChild: () => true, registerProcess() {}, inheritProcessSharedMappings() {}, reserveHostRegionAt() {},
      processSecureExec: () => false, getKernelAbiVersion: () => 56, getKernelAbiContractDigest: () => "source-control",
      finalizePendingChildTermination: () => 0, killBlockedProcessForTeardown: async () => {},
      notifyHostProcessCrashed() {}, reapHostOwnedExitedProcess() {},
      startProcessWorkerWhenRunnable(_pid: number, _memory: WebAssembly.Memory, launch: () => void, stop: () => void) {
        start = launch; cancel = stop; preflight.resolve();
        if (mode === "dead" || mode === "stale") { stop(); return mode; }
        if (mode === "deferred") return mode;
        launch();
        if (backing instanceof MockWorkerHandle) backing.simulateMessage({type: "fork_replay_ready", pid: CHILD});
        return mode === "started-stale" ? "stale" : "started";
      },
    },
    externrefProcessOwner: {generationId: (value: {id: number}) => value.id, forkGenerationFromContinuation: () => ({generation: {id: 2}}), releaseGeneration: vi.fn()},
    forkHostImportOwnerRuntime: {createWorker: () => ({init: {}, close() {}})}, bindForkHostImports() {},
    workerAdapter: {createWorker}, allocateProcessGeneration: () => 2, threadAllocatorForLayout: () => parent.threadAllocator,
    observeProcessGenerations: true,
    vforkLifetimes: lifetime, generationObservations: observations, intentionallyTerminated: new WeakSet(), forkHostImportsByWorker: new WeakMap(),
    workerTeardowns: new Set(), handleExit() {},
    processTeardowns: new Map(), vmInterruptTimers: {clear() {}}, threadedProcessPids: new Set(),
    processWorkerTerminationSettleMs: () => 0, THREADED_WORKER_TERMINATION_SETTLE_MS: 250,
    PROCESS_WORKER_QUIESCENCE_WAIT_MS: 100, EXEC_WORKER_RETIREMENT_WAIT_MS: 5000,
    terminateThreadWorkers: async () => true, ownedJobs: {detached() {}}, post() {}, reportProcessExit() {}, reportHostDiagnostic: vi.fn(),
    completeVforkGenerationTeardown(info: any, safe: boolean, reason: "exit" | "signal", error: unknown) {
      const phase = lifetime.phaseForChild(info); if (phase === undefined) return;
      if (!safe) lifetime.requireAddressSpaceContainment(info, error);
      else if (phase === "starting") lifetime.completeWithoutBorrow(info, reason);
      else lifetime.completeAfterExactTeardown(info, reason);
    }, installCrashSafetyNet() {}, finalizeUnexpectedWorkerError() {throw Error("unexpected Worker error");},
    detachExactProcessGeneration: detach, reportRetainedProcessGeneration() {throw Error("unexpected retained generation");},
    releaseMainFramebufferGeneration: async () => true, awaitFinalizedProcessTeardown: awaitTeardown,
    finishVforkDisposition: async (_disposition: unknown, info: any) => [info.channelOffset],
    signalExitStatus, signalFromExitStatus,
  };
  actual = new Function(...Object.keys(deps), code + "\nreturn {fork:handleOrdinaryFork,vfork:handleVfork,terminate:terminateTrackedWorker,finish:finishProcessExit};")(...Object.values(deps));
  const continuation = {kind: "main", forkBufAddr: 3 * PAGE + 32};
  const pending: Promise<number[]> = vfork
    ? actual.vfork(PARENT, CHILD, memory, continuation, {prefixBytes: 32, scratchBytes: 0}, () => {})
    : actual.fork(PARENT, CHILD, 0, memory, continuation);
  // Some controls first inspect admission; observe expected eventual rejection
  // immediately so that test sequencing cannot create an unowned rejection.
  void pending.catch(() => {});
  return {pending, admitted: admitted.promise, preflight: preflight.promise, get generation() {return generation;}, get backing() {return backing;}, get replay() {return replay;},
    get teardownSnapshot() {return teardownSnapshot;}, events, observations, lifetime, processes, createWorker, detach,
    start: () => start(), cancel: () => cancel(), terminate: () => actual.terminate(generation.worker), retire: retireActual,
    async cleanup() {
      if (generation) await actual.terminate(generation.worker); else await backing?.terminate();
      if (generation && !consumedLeases.has(generation.memoryLease)) generation.memoryLease.releaseAfterForcedTermination();
      parentLease.releaseAfterForcedTermination(); allocator.clear();
    },
  };
}

for (const host of ["node", "browser"] as const) for (const width of [4, 8] as const) {
  describe(`${host} actual main launch (${width})`, () => {
    for (const vfork of [false, true]) {
      it(`${vfork ? "vfork" : "fork"} dead-before-start never invents a main ACK`, async () => {
        const r = actualMainLaunchControl(host, width, vfork, "dead");
        try {
          await r.pending;
          expect(r.createWorker).not.toHaveBeenCalled();
          expect(r.events).toContainEqual({kind: "admitted", pid: CHILD, executionId: 2});
          expect(r.teardownSnapshot).toMatchObject({mainAck: false, execAck: false});
          expect(r.generation.workerQuiescence.settled).toBe(false);
          expect(r.generation.workerAbsence?.proven).toBe(true);
          expect(r.events.at(-1)).toMatchObject({kind: "retired", mainFence: "missing", mainAbsent: true, leaseDisposition: "quiescent"});
          expect(r.generation.worker.start()).toBe(false); expect(r.createWorker).not.toHaveBeenCalled();
        } finally {await r.cleanup();}
      });

      it(`${vfork ? "vfork" : "fork"} attempted factory failure cannot prove absence or ACK`, async () => {
        const r = actualMainLaunchControl(host, width, vfork, "constructor-failure");
        try {
          if (vfork) await r.pending; else await expect(r.pending).rejects.toThrow("factory entered and failed");
          expect(r.createWorker).toHaveBeenCalledOnce();
          expect(r.generation.workerQuiescence.settled).toBe(false);
          expect(r.generation.execRetirement.settled).toBe(false);
          expect(DeferredWorkerHandle.sealNeverStarted(r.generation.worker)).toBe(false);
        } finally {await r.cleanup();}
      });
    }

    it("fork stale-before-start seals exact absence, not a message ACK", async () => {
      const r = actualMainLaunchControl(host, width, false, "stale");
      try {
        await expect(r.pending).rejects.toThrow("changed generation");
        expect(r.createWorker).not.toHaveBeenCalled();
        expect(r.generation.workerQuiescence.settled).toBe(false);
        expect(r.generation.workerAbsence?.proven).toBe(true);
        expect(r.generation.worker.start()).toBe(false); expect(r.createWorker).not.toHaveBeenCalled();
      } finally {await r.cleanup();}
    });

    for (const vfork of [false, true]) it(`${vfork ? "vfork" : "fork"} deferred cancellation seals main absence before retiring its lease`, async () => {
      const r = actualMainLaunchControl(host, width, vfork, "deferred");
      try {
        await r.preflight; r.cancel();
        if (vfork) await r.pending; else await expect(r.pending).rejects.toThrow("cancelled");
        expect(r.createWorker).not.toHaveBeenCalled();
        expect(r.generation.workerAbsence?.proven).toBe(true);
        expect(r.generation.workerQuiescence.settled).toBe(false);
        expect(r.generation.execRetirement.settled).toBe(false);
        expect(r.events.at(-1)).toMatchObject({kind: "retired", mainAbsent: true, mainFence: "missing", leaseDisposition: "quiescent"});
        expect(r.generation.worker.start()).toBe(false);
      } finally {await r.cleanup();}
    });

    it("attempted main without an ACK stays forced after native termination", async () => {
      const r = actualMainLaunchControl(host, width, false, "started");
      try {
        await r.pending; await r.retire();
        expect(r.createWorker).toHaveBeenCalledOnce();
        expect(r.generation.workerAbsence?.proven).toBe(false);
        expect(r.generation.workerQuiescence.settled).toBe(false);
        expect(r.events.at(-1)).toMatchObject({kind: "retired", mainAbsent: false, mainFence: "missing", leaseDisposition: "forced"});
      } finally {await r.cleanup();}
    });

    it("an old cancelled main cannot mutate a replacement generation at the same PID", async () => {
      const r = actualMainLaunchControl(host, width, false, "deferred");
      try {
        await r.preflight;
        const replacement = {memory: new WebAssembly.Memory({initial: 1}), worker: new MockWorkerHandle(),
          workerQuiescence: createWorkerQuiescence(), execRetirement: createWorkerQuiescence()};
        r.processes.set(CHILD, replacement); r.cancel();
        await expect(r.pending).rejects.toThrow("cancelled");
        expect(r.processes.get(CHILD)).toBe(replacement);
        expect(replacement.workerQuiescence.settled).toBe(false);
        expect(replacement.execRetirement.settled).toBe(false);
        expect(r.generation.workerAbsence?.proven).toBe(true);
        expect(r.events.at(-1)).toMatchObject({kind: "retired", registration: "superseded", mainAbsent: true, mainFence: "missing"});
        expect(r.generation.worker.start()).toBe(false); expect(r.createWorker).not.toHaveBeenCalled();
      } finally {await r.cleanup();}
    });

    for (const vfork of [false, true]) it(`${vfork ? "vfork" : "fork"} actual main listener accepts a disposable realm's own terminal ACK`, async () => {
      let realm!: Worker;
      const r = actualMainLaunchControl(host, width, vfork, "started", () => {
        realm = new Worker(`const {parentPort}=require('node:worker_threads');
          parentPort.on('message',()=>{});
          parentPort.once('message',()=>{parentPort.postMessage({type:'memory_quiescent',pid:${CHILD}});});
          parentPort.postMessage({type:'fork_replay_ready',pid:${CHILD}});`, {eval: true});
        return realm as unknown as WorkerHandle;
      });
      try {
        if (vfork) {await r.preflight; await r.replay.waitUntilReady();} else await r.pending;
        expect(r.generation.workerQuiescence.settled).toBe(false);
        const exit = once(realm, "exit"); realm.postMessage("return from actual realm control");
        await r.generation.workerQuiescence.promise; await r.retire(); await exit; await r.pending;
        expect(r.createWorker).toHaveBeenCalledOnce();
        expect(r.generation.workerQuiescence.settled).toBe(true);
        expect(DeferredWorkerHandle.sealNeverStarted(r.generation.worker)).toBe(false);
        expect(r.events.at(-1)).toMatchObject({kind: "retired", mainFence: "acknowledged", mainAbsent: false, leaseDisposition: "quiescent"});
      } finally {await r.cleanup();}
    });
  });
}

it("an unknown main handle never acquires absence from terminate or a timeout", async () => {
  const handle = new MockWorkerHandle();
  const generation = {worker: handle, workerQuiescence: createWorkerQuiescence(), execRetirement: createWorkerQuiescence()};
  const absent = vi.fn(); prepareProcessWorkerAbsence(generation, absent);
  await handle.terminate();
  expect(sealProcessWorkerAbsence(generation)).toBe(false);
  expect(await waitForProcessWorkerRetirement(generation, 0)).toBe(false);
  expect(generation.workerQuiescence.settled).toBe(false);
  expect(generation.execRetirement.settled).toBe(false);
  expect(absent).not.toHaveBeenCalled();
});
