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
  "kernel_exec_prepare",
  "kernel_exec_setup_for_thread",
  "kernel_fd_is_open",
  "kernel_find_listener_fd_by_accept_wake",
  "kernel_get_fd_accept_wake_idx",
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
  const rawInstance = createKernelScratchTestInstance(
    4,
    kernelMemory,
    () => implementations,
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
  return { worker, gatedInstance, implementations };
}

describe("kernel exec entry authority", () => {
  it("rejects synchronous exec results during a live export", async () => {
    const prepare = vi.fn(() => 0);
    const setup = vi.fn(() => 0);
    const drain = vi.fn(() => 0);
    const caught: unknown[] = [];
    let harness!: ExecEntryHarness;
    harness = makeHarness({
      kernel_drain_wakeup_events: drain,
      kernel_exec_prepare: prepare,
      kernel_exec_setup_for_thread: setup,
      kernel_fd_is_open: () => 0,
      kernel_find_listener_fd_by_accept_wake: () => -1,
      kernel_get_fd_accept_wake_idx: () => -1,
      kernel_vblank: () => {
        for (const operation of [
          () => harness.worker.kernelExecPrepare(7, 11),
          () => harness.worker.kernelExecSetup(7, 11),
        ]) {
          try {
            operation();
          } catch (error) {
            caught.push(error);
          }
        }
        return 0;
      },
    });

    (harness.gatedInstance.exports.kernel_vblank as () => number)();
    await Promise.resolve();

    expect(caught).toHaveLength(2);
    for (const error of caught) {
      expect(error).toBeInstanceOf(KernelReentrantEntryError);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();

    // Rejection does not queue an authority result or poison the generation.
    expect(harness.worker.kernelExecPrepare(7, 11)).toBe(0);
    expect(harness.worker.kernelExecSetup(7, 11)).toBe(0);
    expect(prepare).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledTimes(2);
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
        kernel_exec_prepare: () => 0,
        kernel_exec_setup_for_thread: () => {
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

    expect(harness.worker.kernelExecSetup(7, 11)).toBe(0);

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

  it("keeps every host mirror intact when exec setup fails", () => {
    const fdIsOpen = vi.fn(() => 0);
    const harness = makeHarness({
      kernel_drain_wakeup_events: () => 0,
      kernel_exec_prepare: () => 0,
      kernel_exec_setup_for_thread: () => -5,
      kernel_fd_is_open: fdIsOpen,
      kernel_find_listener_fd_by_accept_wake: () => -1,
      kernel_get_fd_accept_wake_idx: () => -1,
      kernel_vblank: () => 0,
    });
    const state = execState(harness.worker);
    const interests = [{ fd: 9, events: 1, data: 11n }];
    state.epollInterests = new Map([["7:6", interests]]);

    expect(harness.worker.kernelExecSetup(7, 11)).toBe(-5);
    expect(state.epollInterests.get("7:6")).toBe(interests);
    expect(fdIsOpen).not.toHaveBeenCalled();
  });
});
