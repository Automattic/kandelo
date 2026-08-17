import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
  type CentralizedKernelWorker,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
  KernelReentrantEntryError,
} from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { CH_TOTAL_SIZE } from "../src/generated/abi";
import type { PlatformIO } from "../src/types";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const KERNEL_EXPORT_NAMES = [
  "kernel_drain_wakeup_events",
  "kernel_exec_commit",
  "kernel_exec_target_cancel",
  "kernel_exec_target_prepare",
  "kernel_exec_target_read",
  "kernel_exec_target_size",
  "kernel_fd_is_open",
  "kernel_find_listener_fd_by_accept_wake",
  "kernel_get_fd_accept_wake_idx",
  "kernel_process_secure_exec",
  "kernel_vblank",
] as const;

interface TestTcpListener {
  readonly server: { close(): void };
  readonly pid: number;
  readonly port: number;
  readonly connections: Set<unknown>;
}

interface ExecWorkerState {
  currentHandlePid: number;
  epollInterests: Map<
    string,
    Array<{ fd: number; events: number; data: bigint }>
  >;
  tcpListenerTargets: Map<
    number,
    Array<{ pid: number; fd: number; acceptWakeIdx?: number }>
  >;
  tcpListenerRRIndex: Map<number, number>;
  tcpListeners: Map<string, TestTcpListener>;
  tcpVirtualListenerKeys: Map<number, string>;
}

interface ExecEntryHarness {
  readonly worker: CentralizedKernelWorker;
  readonly gatedInstance: WebAssembly.Instance;
  readonly kernelMemory: WebAssembly.Memory;
  readonly implementations: Record<string, unknown>;
}

function execState(worker: CentralizedKernelWorker): ExecWorkerState {
  return worker as unknown as ExecWorkerState;
}

function makeHarness(
  implementations: Record<string, unknown>,
  io?: Partial<PlatformIO>,
): ExecEntryHarness {
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  const gate = new KernelEntryGate();
  const effectiveImplementations = {
    kernel_process_secure_exec: () => 0,
    ...implementations,
  };
  const rawInstance = createKernelScratchTestInstance(
    4,
    kernelMemory,
    () => effectiveImplementations,
    () => 4_096,
    4,
    KERNEL_EXPORT_NAMES,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const mainScratch = allocateKernelScratchRegion(
    kernelMemory,
    gatedInstance.exports.kernel_alloc_scratch as (size: number) => number,
    CH_TOTAL_SIZE,
    4,
    "exec entry test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble({
    io: io as PlatformIO | undefined,
  });
  const authority = (
    worker as unknown as {
      readonly testAuthority: {
        initializeKernelForTest(options: {
          readonly instance: WebAssembly.Instance;
          readonly gate: KernelEntryGate;
          readonly mainScratch: typeof mainScratch;
        }): void;
      };
    }
  ).testAuthority;
  authority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch,
  });
  return {
    worker,
    gatedInstance,
    kernelMemory,
    implementations: effectiveImplementations,
  };
}

describe("kernel exec entry authority", () => {
  it("carries secure-exec state out of the commit without re-entering the kernel", () => {
    const secureExec = vi.fn(() => 1);
    const harness = makeHarness({
      kernel_drain_wakeup_events: () => 0,
      kernel_exec_commit: () => 0,
      kernel_process_secure_exec: secureExec,
      kernel_fd_is_open: () => 0,
      kernel_find_listener_fd_by_accept_wake: () => -1,
      kernel_get_fd_accept_wake_idx: () => -1,
      kernel_vblank: () => 0,
    });

    expect(harness.worker.kernelExecCommit(7, 9, 31)).toBe(0);
    expect(harness.worker.takeCommittedExecSecureExec(7)).toBe(true);
    expect(secureExec).toHaveBeenCalledExactlyOnceWith(7);
    expect(() => harness.worker.takeCommittedExecSecureExec(7)).toThrow(
      "no committed secure-exec state for pid=7",
    );
  });

  it("marshals prepare/read/size/cancel under entry and preserves a 64-bit offset", () => {
    const preparedPath: number[] = [];
    const readWords: Array<[number, number]> = [];
    const cancel = vi.fn(() => 0);
    const commit = vi.fn(() => 0);
    const harness = makeHarness({
      kernel_drain_wakeup_events: () => 0,
      kernel_exec_commit: commit,
      kernel_exec_target_cancel: cancel,
      kernel_exec_target_prepare: (
        pid: number,
        callerTid: number,
        dirfd: number,
        pathPointer: number,
        pathLength: number,
        flags: number,
      ) => {
        expect([pid, callerTid, dirfd, flags]).toEqual([7, 9, -100, 0]);
        preparedPath.push(
          ...new Uint8Array(
            harness.kernelMemory.buffer,
            pathPointer,
            pathLength,
          ),
        );
        return 31;
      },
      kernel_exec_target_size: () => 3n,
      kernel_exec_target_read: (
        _ownerPid: number,
        _target: number,
        offsetLo: number,
        offsetHi: number,
        destination: number,
        capacity: number,
      ) => {
        readWords.push([offsetLo, offsetHi]);
        new Uint8Array(
          harness.kernelMemory.buffer,
          destination,
          capacity,
        ).set([4, 5, 6]);
        return 3;
      },
      kernel_fd_is_open: () => 0,
      kernel_find_listener_fd_by_accept_wake: () => -1,
      kernel_get_fd_accept_wake_idx: () => -1,
      kernel_vblank: () => 0,
    });

    expect(
      harness.worker.execTargetPrepare(7, 9, -100, "/bin/exact", 0),
    ).toBe(31);
    expect(new TextDecoder().decode(Uint8Array.from(preparedPath))).toBe(
      "/bin/exact",
    );
    expect(harness.worker.execTargetSize(7, 31)).toBe(3n);
    const destination = new Uint8Array(3);
    expect(
      harness.worker.execTargetRead(7, 31, 0x1_0000_0001n, destination),
    ).toBe(3);
    expect(readWords).toEqual([[1, 1]]);
    expect(destination).toEqual(Uint8Array.from([4, 5, 6]));
    expect(harness.worker.kernelExecCommit(7, 9, 31, 3)).toBe(0);
    expect(commit).toHaveBeenCalledExactlyOnceWith(7, 9, 31);
    expect(harness.worker.execTargetCancel(7, 31)).toBe(0);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(7, 31);
  });

  it("rejects synchronous exec results during a live export", async () => {
    const commit = vi.fn(() => 0);
    const drain = vi.fn(() => 0);
    const caught: unknown[] = [];
    let harness!: ExecEntryHarness;
    harness = makeHarness({
      kernel_drain_wakeup_events: drain,
      kernel_exec_commit: commit,
      kernel_fd_is_open: () => 0,
      kernel_find_listener_fd_by_accept_wake: () => -1,
      kernel_get_fd_accept_wake_idx: () => -1,
      kernel_vblank: () => {
        try {
          harness.worker.kernelExecCommit(7, 11, 13);
        } catch (error) {
          caught.push(error);
        }
        return 0;
      },
    });

    (harness.gatedInstance.exports.kernel_vblank as () => number)();
    await Promise.resolve();

    expect(caught).toHaveLength(1);
    for (const error of caught) {
      expect(error).toBeInstanceOf(KernelReentrantEntryError);
    }
    expect(commit).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();

    // Rejection does not queue an authority result or poison the generation.
    expect(harness.worker.kernelExecCommit(7, 11, 13)).toBe(0);
    expect(commit).toHaveBeenCalledExactlyOnceWith(7, 11, 13);
    expect(drain).toHaveBeenCalledOnce();
  });

  it("publishes a complete mirror plan before closing host listeners", () => {
    const observations: Array<{
      readonly phase: string;
      readonly epollPresent: boolean;
      readonly targetsPresent: boolean;
      readonly listenerPresent: boolean;
      readonly virtualKeyPresent: boolean;
      readonly currentHandlePid: number;
    }> = [];
    const observe = (phase: string, state: ExecWorkerState): void => {
      observations.push({
        phase,
        epollPresent: state.epollInterests.has("7:6"),
        targetsPresent: state.tcpListenerTargets.has(8080),
        listenerPresent: state.tcpListeners.has("7:4"),
        virtualKeyPresent: state.tcpVirtualListenerKeys.has(8080),
        currentHandlePid: state.currentHandlePid,
      });
    };
    const closeVirtual = vi.fn();
    let state!: ExecWorkerState;
    let committed = false;
    const closeServer = vi.fn(() => observe("server close", state));
    const harness = makeHarness(
      {
        kernel_drain_wakeup_events: () => {
          observe("wake drain", state);
          return 0;
        },
        kernel_exec_commit: () => {
          expect(state.currentHandlePid).toBe(7);
          committed = true;
          return 0;
        },
        kernel_fd_is_open: (_pid: number, _fd: number) => {
          expect(committed).toBe(true);
          // The scoped query phase must not expose a partial host replacement.
          expect(state.tcpListenerTargets.has(8080)).toBe(true);
          expect(state.tcpListeners.has("7:4")).toBe(true);
          return 0;
        },
        kernel_find_listener_fd_by_accept_wake: () => -1,
        kernel_get_fd_accept_wake_idx: () => -1,
        kernel_vblank: () => 0,
      },
      {
        network: {
          closeTcpListener: (key: string) => {
            closeVirtual(key);
            observe("virtual close", state);
          },
        },
      } as unknown as Partial<PlatformIO>,
    );
    state = execState(harness.worker);
    state.currentHandlePid = 0;
    state.epollInterests = new Map([
      ["7:6", [{ fd: 9, events: 1, data: 11n }]],
    ]);
    state.tcpListenerTargets = new Map([
      [8080, [{ pid: 7, fd: 4, acceptWakeIdx: 41 }]],
    ]);
    state.tcpListenerRRIndex = new Map([[8080, 3]]);
    state.tcpListeners = new Map([
      ["7:4", {
        server: { close: closeServer },
        pid: 7,
        port: 8080,
        connections: new Set(),
      }],
    ]);
    state.tcpVirtualListenerKeys = new Map([[8080, "virtual:7:4"]]);

    expect(harness.worker.kernelExecCommit(7, 11, 13)).toBe(0);

    expect(observations).toEqual([
      {
        phase: "wake drain",
        epollPresent: true,
        targetsPresent: true,
        listenerPresent: true,
        virtualKeyPresent: true,
        currentHandlePid: 0,
      },
      {
        phase: "virtual close",
        epollPresent: false,
        targetsPresent: false,
        listenerPresent: false,
        virtualKeyPresent: false,
        currentHandlePid: 0,
      },
      {
        phase: "server close",
        epollPresent: false,
        targetsPresent: false,
        listenerPresent: false,
        virtualKeyPresent: false,
        currentHandlePid: 0,
      },
    ]);
    expect(closeVirtual).toHaveBeenCalledExactlyOnceWith("virtual:7:4");
    expect(closeServer).toHaveBeenCalledOnce();
    expect(state.tcpListenerRRIndex.has(8080)).toBe(false);
  });

  it("keeps every host mirror intact when exec commit fails", () => {
    const fdIsOpen = vi.fn(() => 0);
    const harness = makeHarness({
      kernel_drain_wakeup_events: () => 0,
      kernel_exec_commit: () => -5,
      kernel_fd_is_open: fdIsOpen,
      kernel_find_listener_fd_by_accept_wake: () => -1,
      kernel_get_fd_accept_wake_idx: () => -1,
      kernel_vblank: () => 0,
    });
    const state = execState(harness.worker);
    const interests = [{ fd: 9, events: 1, data: 11n }];
    state.epollInterests = new Map([["7:6", interests]]);

    expect(harness.worker.kernelExecCommit(7, 11, 13)).toBe(-5);
    expect(state.epollInterests.get("7:6")).toBe(interests);
    expect(fdIsOpen).not.toHaveBeenCalled();
  });
});
