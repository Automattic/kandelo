import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { CentralizedKernelCallbacks } from "../src/kernel-worker";
const implementationRoot = process.env.KANDELO_FORK_OWNERSHIP_BEFORE_ROOT;
const implementationPath = implementationRoot
  ? `${implementationRoot}/host/src/kernel-worker.ts`
  : new URL("../src/kernel-worker.ts", import.meta.url).pathname;
const {createCentralizedKernelWorkerTestDouble} = await import(implementationPath) as typeof import("../src/kernel-worker");
import { WASM_PAGE_SIZE } from "../src/constants";
import { writeForkContinuationAnchor } from "../src/fork-continuation";
import { FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";
import { ProcessMemoryCreatorGate } from "../src/process-memory-creator-gate";
import { EXIT_RETIRE_SIGNAL_CODE } from "../src/worker-protocol";
import { emptyProcessTimerCleanup, installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  CHANNEL_STATUS_COMPLETE, CHANNEL_STATUS_PENDING, CH_ARGS, CH_ARG_SIZE,
  CH_STATUS, CH_SYSCALL, CH_RETURN, CH_ERRNO, CH_SIG_SIGNUM, CH_SIG_SI_CODE, HOST_INTERCEPTED_SYSCALLS, WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
} from "../src/generated/abi";

const PARENT = 77;
const CHILD = 347;
const OFFSET = WASM_PAGE_SIZE;
const widths = [["wasm32", 4], ["wasm64", 8]] as const;
type ForkHandler = NonNullable<CentralizedKernelCallbacks["onFork"]>;

function makeHarness(onFork: ForkHandler, width: 4 | 8) {
  const memory = new WebAssembly.Memory({initial: 4, maximum: 4, shared: true});
  const kernelMemory = new WebAssembly.Memory({initial: 2, maximum: 2});
  const generations = new Map([[PARENT, 0n]]);
  const timerCleanup = vi.fn(emptyProcessTimerCleanup(kernelMemory));
  const removed = vi.fn((pid: number): number => {
    const present = generations.delete(pid);
    return present ? 0 : -3;
  });
  let nextChild = CHILD;
  const signaled = vi.fn(() => 0);
  const onKernelFatal = vi.fn();
  const onExit = vi.fn();
  const forkStarted = vi.fn(onFork);
  const exitSignal = vi.fn(() => -1);
  const execGeneration = vi.fn((pid: number, pointer: number | bigint, capacity: number) => {
    if (capacity !== 8) return -22;
    const value = generations.get(pid);
    if (value === undefined) return -3;
    new DataView(kernelMemory.buffer).setBigUint64(Number(pointer), value, true);
    return 8;
  });
  const worker = createCentralizedKernelWorkerTestDouble({callbacks: {onFork: forkStarted, onKernelFatal, onExit}});
  installKernelWorkerTestScratch(worker, kernelMemory, 128, width, {
    kernelExports: {
      kernel_get_process_exec_generation: execGeneration,
      kernel_fork_process: vi.fn(() => {const pid = nextChild++; generations.set(pid, 0n); return pid;}),
      kernel_clear_fork_child: vi.fn(() => 0),
      kernel_drain_wakeup_events: vi.fn(() => 0),
      kernel_get_parent_pid: vi.fn(() => PARENT),
      kernel_get_process_exit_signal: exitSignal,
      kernel_get_process_state: vi.fn(() => 0),
      kernel_set_current_tid: vi.fn(() => 0),
      kernel_remove_process: removed,
      kernel_mark_process_signaled: signaled,
      kernel_publish_process_exit: vi.fn(() => 0),
      kernel_take_process_timer_cleanup: timerCleanup,
      kernel_get_fd_accept_wake_idx: vi.fn(() => 42),
    },
  });
  const [channel] = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
    pid: PARENT, memory, channelOffsets: [OFFSET], pointerWidth: width,
  });
  if (!channel) throw new Error("missing parent channel");
  (worker as any).tcpListenerTargets = new Map([[8080, [{pid: PARENT, fd: 3, acceptWakeIdx: 42}]]]);
  const write = (target = channel, syscall: number = HOST_INTERCEPTED_SYSCALLS.SYS_FORK) => {
    const view = new DataView(target.memory.buffer, target.channelOffset);
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    view.setUint32(CH_SYSCALL, syscall, true);
    for (let i = 0; i < 6; i++) view.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
  };
  const completion = (target = channel) => {
    const view = new DataView(target.memory.buffer, target.channelOffset);
    return {status: view.getUint32(CH_STATUS, true), result: Number(view.getBigInt64(CH_RETURN, true)), errno: view.getUint32(CH_ERRNO, true)};
  };
  const dispatch = (syscall: number = HOST_INTERCEPTED_SYSCALLS.SYS_FORK) => {
    writeForkContinuationAnchor(memory, OFFSET - FORK_SAVE_BUFFER_SIZE, width, 2 * WASM_PAGE_SIZE + WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(f => f.bytes === width)!.chunkHeaderSize);
    write(channel, syscall);
    if (syscall === HOST_INTERCEPTED_SYSCALLS.SYS_VFORK) new DataView(memory.buffer, OFFSET).setBigInt64(CH_ARGS, 32n, true);
    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
  };
  const wake = () => (worker as any).completeChannelRaw(channel, -1, 4);
  return {worker, memory, channel, dispatch, write, completion, wake, generations, removed, signaled, onExit, onKernelFatal, timerCleanup, forkStarted, exitSignal, execGeneration};
}

const started = (h: ReturnType<typeof makeHarness>, count = 1) =>
  vi.waitFor(() => expect(h.forkStarted).toHaveBeenCalledTimes(count));
const removed = (h: ReturnType<typeof makeHarness>) =>
  vi.waitFor(() => expect(h.removed).toHaveBeenCalledWith(CHILD));

async function expectFatalParentRetirement(h: ReturnType<typeof makeHarness>) {
  await vi.waitFor(() => expect(h.onExit).toHaveBeenCalledExactlyOnceWith(PARENT, 128 + 11));
  expect(h.signaled).toHaveBeenCalledExactlyOnceWith(PARENT, 11);
  // Rust records signal death; the old mailbox wakes with the terminal
  // retirement marker so its parked Worker can unwind.
  expect(h.completion()).toEqual({status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 4});
  const view = new DataView(h.memory.buffer, h.channel.channelOffset);
  expect(view.getUint32(CH_SIG_SIGNUM, true)).toBe(9);
  expect(view.getUint32(CH_SIG_SI_CODE, true)).toBe(EXIT_RETIRE_SIGNAL_CODE);
}

// These controls drive the actual fork dispatcher and fresh kernel-entry
// continuation. Mock Rust exports model only its PID/image ledger; replacing
// a mailbox or image exercises the production ownership checks, not a copy.
describe("fork allocation ownership across asynchronous admission", () => {
  it.each(widths)("%s rolls back before classifying privately closed admission", async (_name, width) => {
    const gate = new ProcessMemoryCreatorGate(); await gate.closeAndWait();
    const creator = vi.fn(async () => [] as number[]);
    const h = makeHarness(() => gate.run("a fork process Worker", creator), width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await removed(h);
      expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
      expect(h.generations.has(CHILD)).toBe(false);
      expect((h.worker as any).tcpListenerTargets.get(8080)).toEqual([{pid: PARENT, fd: 3, acceptWakeIdx: 42}]);
      expect(creator).not.toHaveBeenCalled();
      expect(h.completion()).toEqual({status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 12});
      expect(error).not.toHaveBeenCalled(); expect(h.onKernelFatal).not.toHaveBeenCalled();
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s rolls back an admitted allocation canceled by terminal destroy", async (_name, width) => {
    const gate = new ProcessMemoryCreatorGate();
    let rejectAllocation!: (reason: unknown) => void;
    const allocation = new Promise<number[]>((_, reject) => { rejectAllocation = reject; });
    const h = makeHarness(() => gate.run("pending fork construction", () => allocation), width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h);
      expect(h.generations.has(CHILD)).toBe(true);
      const drained = gate.closeAndWait();
      rejectAllocation(gate.closedAdmissionCancellation("pending fork construction"));
      await removed(h); await drained;
      expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
      expect(h.generations.has(CHILD)).toBe(false);
      expect((h.worker as any).tcpListenerTargets.get(8080)).toEqual([{pid: PARENT, fd: 3, acceptWakeIdx: 42}]);
      expect(h.completion()).toEqual({status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 12});
      expect(error).not.toHaveBeenCalled();
      expect(h.onKernelFatal).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it.each(widths)("%s vfork retains its original request and returns a real admission failure", async (_name, width) => {
    const gate = new ProcessMemoryCreatorGate(); await gate.closeAndWait();
    const h = makeHarness(() => gate.runUntilCommitted("a vfork process Worker", async () => []), width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(HOST_INTERCEPTED_SYSCALLS.SYS_VFORK); await removed(h);
      expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
      expect(h.completion()).toEqual({status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 12});
      expect(error).not.toHaveBeenCalled();
    } finally {error.mockRestore();}
  });

  for (const reason of [new Error("kernel worker is being destroyed; cannot start a fork process Worker"), undefined]) {
    it.each(widths)(`%s preserves genuine rejection diagnostics (${String(reason)})`, async (_name, width) => {
      const h = makeHarness(() => Promise.reject(reason), width);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        h.dispatch(); await removed(h);
        expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
        expect(error).toHaveBeenCalledWith(expect.stringContaining(`fork worker launch failed: ${String(reason)}`));
        expect(h.completion()).toEqual({status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 12});
      } finally {error.mockRestore();}
    });
  }

  it.each(widths)("%s cleans up after the original request already completed", async (_name, width) => {
    const launch = Promise.withResolvers<number[]>();
    const h = makeHarness(() => launch.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h); h.wake(); const terminal = h.completion();
      launch.reject(new Error("construction failed")); await removed(h);
      expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
      expect(h.completion()).toEqual(terminal);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("construction failed"));
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s cleans up without writing a same-offset replacement Memory", async (_name, width) => {
    const launch = Promise.withResolvers<number[]>();
    const h = makeHarness(() => launch.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h);
      const replacementMemory = new WebAssembly.Memory({initial: 4, maximum: 4, shared: true});
      h.generations.set(PARENT, 1n);
      const [replacement] = h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({pid: PARENT, memory: replacementMemory, channelOffsets: [OFFSET], pointerWidth: width});
      h.write(replacement); const before = new Uint8Array(replacementMemory.buffer).slice();
      launch.reject(new Error("old creator failed")); await removed(h);
      expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
      expect(new Uint8Array(replacementMemory.buffer)).toEqual(before);
      expect((h.worker as any).processes.get(PARENT).memory).toBe(replacementMemory);
      expect(h.signaled).not.toHaveBeenCalled(); expect(h.onKernelFatal).not.toHaveBeenCalled();
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s never overwrites another pending request on its reused channel", async (_name, width) => {
    const first = Promise.withResolvers<number[]>();
    const second = Promise.withResolvers<number[]>();
    let calls = 0;
    const h = makeHarness(() => ++calls === 1 ? first.promise : second.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h); h.wake();
      // A fresh fork on the same mailbox has a distinct captured request.
      h.dispatch(); await started(h, 2);
      const pending = h.completion(); first.reject(new Error("old fork failed")); await removed(h);
      expect(h.completion()).toEqual(pending);
      expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD);
      expect(h.generations.has(CHILD + 1)).toBe(true);
      second.resolve([]); await vi.waitFor(() => expect(h.completion().status).toBe(CHANNEL_STATUS_COMPLETE));
      expect(h.completion()).toEqual({status: CHANNEL_STATUS_COMPLETE, result: CHILD + 1, errno: 0});
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s preserves a replacement child image and makes uncertain cleanup fatal", async (_name, width) => {
    const launch = Promise.withResolvers<number[]>();
    const h = makeHarness(() => launch.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h); h.generations.set(CHILD, 1n);
      launch.reject(new Error("creator failed after replacement")); await vi.waitFor(() => expect(h.onExit).toHaveBeenCalledOnce());
      expect(h.removed).not.toHaveBeenCalled(); expect(h.generations.get(CHILD)).toBe(1n);
      expect(h.signaled).toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("changed image ownership"));
      await expectFatalParentRetirement(h);
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s never removes a replacement child's host registration", async (_name, width) => {
    const launch = Promise.withResolvers<number[]>();
    const h = makeHarness(() => launch.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h);
      const childMemory = new WebAssembly.Memory({initial: 4, maximum: 4, shared: true});
      h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({pid: CHILD, memory: childMemory, channelOffsets: [OFFSET], pointerWidth: width});
      launch.reject(new Error("creator rejected with a live child")); await vi.waitFor(() => expect(h.onExit).toHaveBeenCalledOnce());
      expect(h.removed).not.toHaveBeenCalled();
      expect((h.worker as any).processes.get(CHILD).memory).toBe(childMemory);
      expect(h.signaled).toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("unconfirmed host Memory registration"));
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s never signals a replacement caller when rollback fails", async (_name, width) => {
    const launch = Promise.withResolvers<number[]>();
    const h = makeHarness(() => launch.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h); h.generations.set(CHILD, 1n); h.generations.set(PARENT, 1n);
      const replacementMemory = new WebAssembly.Memory({initial: 4, maximum: 4, shared: true});
      h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({pid: PARENT, memory: replacementMemory, channelOffsets: [OFFSET], pointerWidth: width});
      launch.reject(new Error("creator rejected after parent exec")); await vi.waitFor(() => expect(h.onKernelFatal).toHaveBeenCalledOnce());
      expect(h.removed).not.toHaveBeenCalled(); expect(h.signaled).not.toHaveBeenCalled();
      expect(h.onKernelFatal).toHaveBeenCalledOnce();
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s preserves transferred child ownership after the parent image changed", async (_name, width) => {
    const launch = Promise.withResolvers<number[]>();
    const h = makeHarness(() => launch.promise, width);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await started(h); h.generations.set(PARENT, 1n);
      const before = h.completion();
      launch.resolve([OFFSET]);
      // The platform registered its fulfillment continuation before this
      // await; completing the actual launch Promise observes that boundary.
      await h.forkStarted.mock.results[0]!.value;
      expect(h.removed).not.toHaveBeenCalled(); expect(h.generations.has(CHILD)).toBe(true);
      expect(h.completion()).toEqual(before); expect(error).not.toHaveBeenCalled();
    } finally {error.mockRestore();}
  });

  it.each(widths)("%s reports rollback failure even for privately closed admission", async (_name, width) => {
    const gate = new ProcessMemoryCreatorGate(); await gate.closeAndWait();
    const h = makeHarness(() => gate.run("a fork process Worker", async () => []), width);
    h.removed.mockImplementation(() => -5);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(); await removed(h);
      expect(h.generations.has(CHILD)).toBe(true);
      expect(h.signaled).toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("could not roll back fork child"));
      await expectFatalParentRetirement(h);
    } finally {error.mockRestore();}
  });
});

// Extract the real callback body so host adapter parity is exercised without
// evaluating worker-entry module startup or substituting a replica wrapper.
for (const host of ["node", "browser"] as const) {
  it(`${host} publishes no job owner or process event before fork creator admission`, async () => {
    const url = implementationRoot ? new URL(`file://${implementationRoot}/host/src/${host}-kernel-worker-entry.ts`) : new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url);
    const source = ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
    let callback: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "onFork"
        && ts.isArrowFunction(node.initializer)) callback = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(source); if (!callback) throw new Error("missing actual onFork callback");
    const code = ts.transpileModule(`const onFork = ${callback.getText(source)};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
    for (const mode of [0, 1]) {
      const processMemoryCreators = new ProcessMemoryCreatorGate(); await processMemoryCreators.closeAndWait();
      const ownedJobs = {inherit: vi.fn(), exited: vi.fn(), detached: vi.fn()};
      const post = vi.fn(); const handleFork = vi.fn();
      const actual = new Function("processMemoryCreators", "ownedJobs", "post", "handleFork", "processes", "PROCESS_FORK_MODE_VFORK", code + "\nreturn onFork;")(
        processMemoryCreators, ownedJobs, post, handleFork, new Map(), 1,
      );
      await expect(actual({parentPid: PARENT, childPid: CHILD, mode})).rejects.toThrow("being destroyed");
      expect(ownedJobs.inherit).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(handleFork).not.toHaveBeenCalled();
    }
  });
}

it.each(widths)("%s transferred fork child can still report a real realm fence after its parent wakes", async (_name, width) => {
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number[]>();
  let realm: Worker | undefined;
  let childMemory!: WebAssembly.Memory;
  let h!: ReturnType<typeof makeHarness>;
  h = makeHarness(async () => {
    // Host generation installation follows the revoked detached launch stack.
    await Promise.resolve();
    childMemory = new WebAssembly.Memory({initial: 4, maximum: 4, shared: true});
    h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({pid: CHILD, memory: childMemory, channelOffsets: [OFFSET], pointerWidth: width});
    realm = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      const status=new Int32Array(workerData.memory.buffer,workerData.offset);
      parentPort.on('message',()=>{Atomics.store(status,0,77);parentPort.postMessage('memory_quiescent');parentPort.close();});
      parentPort.postMessage('ready');`, {eval: true, workerData: {memory: childMemory, offset: OFFSET}});
    await once(realm, "message"); published.resolve(); return release.promise;
  }, width);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    h.dispatch(); await published.promise; h.wake(); const terminal = h.completion();
    release.resolve([OFFSET]);
    await h.forkStarted.mock.results[0]!.value;
    expect(h.removed).not.toHaveBeenCalled(); expect((h.worker as any).processes.get(CHILD).memory).toBe(childMemory);
    const exited = once(realm!, "exit"); const fence = once(realm!, "message");
    realm!.postMessage("retire"); expect(await fence).toEqual(["memory_quiescent"]); await exited;
    expect(Atomics.load(new Int32Array(childMemory.buffer, OFFSET), 0)).toBe(77);
    // The real realm's fence arrives despite the discarded parent result.
    // Final unregister is exact-Memory guarded and reaps once. It belongs to
    // the child's actual terminal fence, never the stale parent continuation.
    expect(h.worker.unregisterProcess(CHILD, childMemory)).toBe(true);
    expect(h.worker.unregisterProcess(CHILD, childMemory)).toBe(true); // idempotent absent generation
    expect(h.timerCleanup.mock.calls.filter(([pid]) => pid === CHILD)).toHaveLength(1);
    expect(h.removed).toHaveBeenCalledExactlyOnceWith(CHILD); expect(h.completion()).toEqual(terminal);
    expect(error).not.toHaveBeenCalled();
  } finally {await realm?.terminate(); error.mockRestore();}
});
