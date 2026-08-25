import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import * as browserEntry from "../src/browser";
import * as nodeEntry from "../src/index";
import * as privilegedProjectionModule from
  "../src/vfs/privileged-projection";
import {
  CentralizedKernelWorker,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";

const hiddenKernelNames = [
  "instance",
  "memory",
  "rawInstance",
  "kernelEntryGate",
  "getInstance",
  "getMemory",
  "initWithMemory",
  "buildImportObject",
  "writeKernelBytes",
  "hostFstat",
  "hostReaddir",
  "hostClosedir",
  "hostClose",
  "testAuthority",
] as const;

const hiddenWorkerNames = [
  "kernel",
  "kernelEntryGate",
  "kernelInstance",
  "kernelMemory",
  "scratchOffset",
  "scratchRegion",
  "tcpScratchRegion",
  "largeSpawnScratchInUse",
  "largeTransferScratchInUse",
  "kernelFatalError",
  "initialized",
  "getKernel",
  "getKernelInstance",
  "_handleSyscallInner",
  "bindKernelTidForChannel",
  "bindKernelTid",
  "getProcessExitSignal",
  "dequeueSignalForDelivery",
  "finishSignalTermination",
  "startTcpListener",
  "handleSyscallWithinKernelEntry",
  "retrySyscallWithinKernelEntry",
  "kernelInstanceForEntry",
  "kernelEntryContext",
  "invokeEntryScratchExport",
  "checkedScratchProducerByteLength",
  "rejectScratchTransfer",
  "scalarTransferSyscall",
  "copyFlattenedTransferInput",
  "copyFlattenedTransferOutput",
  "checkedChannelTransferResult",
  "checkedReservedTransferResult",
  "executeMainScratchTransfer",
  "cancelLargeTransferScratch",
  "executeReservedScratchTransfer",
  "handleFlattenedTransfer",
  "handleWritev",
  "handleLargeWrite",
  "handleLargeRead",
  "handleReadv",
  "handleSpawn",
  "cancelLargeSpawnScratch",
  "handleSpawnAfterResolve",
] as const;

const hiddenPackageSymbols = [
  "createWasmPosixKernelTestHarness",
  "getWasmPosixKernelRuntimeAccess",
  "createCentralizedKernelWorkerTestDouble",
  "createKernelEntryGatedInstance",
  "createKernelEntryScopedInstance",
  "invokeKernelEntryScopedOperation",
  "unwrapKernelEntryGatedInstance",
  "unwrapKernelEntryGatedExport",
  "kernelEntryInvokerForInstance",
  "kernelEntryGateForInstance",
  "KernelEntryGate",
  "createReviewedPrivilegedProgramPolicy",
  "readReviewedPrivilegedProgramPolicy",
  "attachReviewedPrivilegedProgramPolicy",
  "reviewedPrivilegedProgramPolicyForPlan",
  "publishPrivilegedProgramProduct",
  "snapshotPublishedPrivilegedProgramBrowserMount",
  "admitPrivilegedProgramProductCandidate",
  "admitPrivilegedProgramProductCandidateForTest",
  "validatePrivilegedProgramProductCandidate",
] as const;

describe("kernel authority boundary", () => {
  it("keeps raw Wasm authority and white-box hooks off production objects", () => {
    const kernel = new WasmPosixKernel({}, {});
    const worker = new CentralizedKernelWorker({}, {});

    for (const name of hiddenKernelNames) {
      expect(name in kernel, `WasmPosixKernel.${name}`).toBe(false);
      expect(Object.getOwnPropertyDescriptor(
        WasmPosixKernel.prototype,
        name,
      )).toBeUndefined();
    }
    for (const name of hiddenWorkerNames) {
      expect(name in worker, `CentralizedKernelWorker.${name}`).toBe(false);
      expect(Object.getOwnPropertyDescriptor(
        CentralizedKernelWorker.prototype,
        name,
      )).toBeUndefined();
    }
  });

  it("rejects reflected worker shadows and keeps kernel shadows inert", () => {
    const fakeMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const fakeInstance = { exports: { kernel_set_cwd: vi.fn(() => 0) } };
    const kernel = new WasmPosixKernel({}, {});
    const worker = new CentralizedKernelWorker({}, {});

    expect(Reflect.set(kernel, "memory", fakeMemory)).toBe(true);
    expect(Reflect.set(kernel, "instance", fakeInstance)).toBe(true);
    expect(Reflect.set(worker, "initialized", true)).toBe(false);
    expect(Reflect.set(worker, "kernelMemory", fakeMemory)).toBe(false);
    expect(Reflect.set(worker, "kernelInstance", fakeInstance)).toBe(false);
    expect(Reflect.set(worker, "largeSpawnScratchInUse", false)).toBe(false);
    expect(Reflect.set(worker, "largeTransferScratchInUse", false)).toBe(false);
    expect(Reflect.set(worker, "kernelFatalError", null)).toBe(false);

    expect(Reflect.get(kernel, "memory")).toBe(fakeMemory);
    expect(Reflect.get(worker, "kernelInstance")).toBeUndefined();
    // WHY: the kernel still ignores ordinary public shadows. The worker is
    // stricter because it crosses host observers while retaining entry-taking
    // methods: sealing prevents those observers from installing own-property
    // overrides ahead of the frozen reviewed prototype.
    expect(kernel.getMemoryPageCount()).toBeNull();
    expect(() => worker.setCwd(1, "/")).toThrow("Kernel not initialized");
    expect(fakeInstance.exports.kernel_set_cwd).not.toHaveBeenCalled();
  });

  it("rejects subclass prototypes that could override entry-taking methods", () => {
    class SubclassedWorker extends CentralizedKernelWorker {}

    expect(
      () => new SubclassedWorker({}, {}),
    ).toThrow(/subclass|exact CentralizedKernelWorker/i);
  });

  it("limits kernel test authority to one frozen seven-method companion", () => {
    const production = new WasmPosixKernel({}, {});
    const harness = createWasmPosixKernelTestHarness({});
    const authority = harness.testAuthority;
    const expectedNames = [
      "buildImportObject",
      "hostClose",
      "hostClosedir",
      "hostFstat",
      "hostOpendir",
      "hostReaddir",
      "writeKernelBytes",
    ];

    expect("testAuthority" in production).toBe(false);
    expect(harness).toBeInstanceOf(WasmPosixKernel);
    expect(Object.getOwnPropertyDescriptor(
      harness,
      "testAuthority",
    )).toEqual({
      configurable: false,
      enumerable: false,
      writable: false,
      value: authority,
    });
    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.ownKeys(authority).sort()).toEqual(expectedNames);
    for (const name of expectedNames) {
      expect(Object.getOwnPropertyDescriptor(authority, name)).toEqual({
        configurable: false,
        enumerable: true,
        writable: false,
        value: expect.any(Function),
      });
    }
    for (const name of [
      "instance",
      "memory",
      "kernelEntryGate",
      "scratchRegion",
      "getInstance",
      "getMemory",
    ]) {
      expect(name in authority).toBe(false);
    }
    expect(Reflect.set(authority, "hostClose", vi.fn())).toBe(false);
    expect(Reflect.defineProperty(authority, "arbitraryDispatch", {
      value: vi.fn(),
    })).toBe(false);
    expect(Reflect.setPrototypeOf(authority, {})).toBe(false);
    expect(Reflect.get(authority, "arbitraryDispatch")).toBeUndefined();
    expect(harness.getMemoryPageCount()).toBeNull();
  });

  it("limits worker test authority to one frozen exact-method companion", () => {
    const production = new CentralizedKernelWorker({}, {});
    const harness = createCentralizedKernelWorkerTestDouble();
    const authority = harness.testAuthority;
    const expectedNames = [
      "completeDetachedCopybackForTest",
      "completeImmediatePollTimeoutForCopybackTest",
      "completeSleepWithSignalCheckForTest",
      "configureScratchBoundaryHooksForTest",
      "dequeueSignalForDeliveryForTest",
      "discardStoppedProcessStateForTest",
      "dispatchRegisteredMainChannelForAdvisoryLockTest",
      "dispatchScratchBoundarySyscallForTest",
      "dispatchSpawnAfterResolveForTest",
      "dispatchSpawnPreflightForTest",
      "dispatchUntrackedExecForTaskAuthorityTest",
      "dispatchUntrackedExecveatForTaskAuthorityTest",
      "dispatchUntrackedForkForTaskAuthorityTest",
      "dispatchUntrackedThreadExitForTaskAuthorityTest",
      "drainWakeupEventsForTest",
      "forkKernelProcessForAdvisoryLockTest",
      "initializeKernelForTest",
      "inspectThreadTransportStateForLifecycleTest",
      "installParkedCloneCompletionForTest",
      "probeMqueueNotificationCapacityForTest",
      "probeWaitableChildCapacityForTest",
      "readKernelOwnedPathForTest",
      "replaceKernelForScratchBoundaryTest",
      "replaceProcessRegistrationForLifecycleTest",
      "replaceTcpScratchForScratchBoundaryTest",
      "resumeStoppedProcessForTest",
      "sendSignalForTest",
    ];

    expect("testAuthority" in production).toBe(false);
    expect(harness).toBeInstanceOf(CentralizedKernelWorker);
    expect(Object.getOwnPropertyDescriptor(
      harness,
      "testAuthority",
    )).toEqual({
      configurable: false,
      enumerable: false,
      writable: false,
      value: authority,
    });
    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.ownKeys(authority).sort()).toEqual(expectedNames);
    for (const name of expectedNames) {
      expect(Object.getOwnPropertyDescriptor(authority, name)).toEqual({
        configurable: false,
        enumerable: true,
        writable: false,
        value: expect.any(Function),
      });
    }
    for (const name of [
      "instance",
      "memory",
      "kernel",
      "kernelEntryGate",
      "scratchRegion",
      "getInstance",
      "getMemory",
      "arbitraryDispatch",
    ]) {
      expect(name in authority).toBe(false);
    }
    expect(
      Reflect.set(authority, "dispatchSpawnPreflightForTest", vi.fn()),
    ).toBe(false);
    expect(Reflect.defineProperty(authority, "arbitraryDispatch", {
      value: vi.fn(),
    })).toBe(false);
    expect(Reflect.setPrototypeOf(authority, {})).toBe(false);
  });

  it("omits deep test and raw-entry capabilities from supported packages", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      expect(entry.WasmPosixKernel).toBe(WasmPosixKernel);
      expect(entry.CentralizedKernelWorker).toBe(CentralizedKernelWorker);
      for (const symbol of hiddenPackageSymbols) {
        expect(symbol in entry, symbol).toBe(false);
      }
    }

    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { exports: Record<string, unknown> };
    expect(packageJson.exports).not.toHaveProperty("./kernel");
    expect(packageJson.exports).not.toHaveProperty("./kernel-worker");
    expect(packageJson.exports).not.toHaveProperty("./kernel-entry-gate");
    expect(packageJson.exports).not.toHaveProperty("./vfs/privileged-projection");
  });

  it("exposes no arbitrary-candidate privileged publication path", () => {
    expect(Reflect.has(
      privilegedProjectionModule,
      "admitPrivilegedProgramProductCandidate",
    )).toBe(false);
    expect(Reflect.has(
      privilegedProjectionModule,
      "admitPrivilegedProgramProductCandidateForTest",
    )).toBe(false);
    expect(typeof privilegedProjectionModule.validatePrivilegedProgramProductCandidate)
      .toBe("function");
  });
});
