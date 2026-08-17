import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
  KernelReentrantEntryError,
} from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { CH_TOTAL_SIZE } from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { emptyProcessTimerCleanup } from "./kernel-worker-test-scratch";

const KERNEL_EXPORT_NAMES = [
  "kernel_drain_wakeup_events",
  "kernel_get_memory_pages",
  "kernel_inject_datagram",
  "kernel_remove_process",
  "kernel_take_process_timer_cleanup",
] as const;

function kernelPointer(
  pointerWidth: 4 | 8,
  value: number,
): number | bigint {
  return pointerWidth === 8 ? BigInt(value) : value;
}

function processMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
    shared: true,
  });
}

function makeHarness(
  pointerWidth: 4 | 8,
  options: {
    readonly gate?: KernelEntryGate;
    readonly io?: Record<string, unknown>;
    readonly implementations?: Record<string, unknown>;
  } = {},
): {
  readonly worker: Record<string, any>;
  readonly gate: KernelEntryGate;
  readonly implementations: Record<string, unknown>;
} {
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  const implementations: Record<string, unknown> = {
    kernel_drain_wakeup_events: () => 0,
    kernel_get_memory_pages: () => 256,
    kernel_inject_datagram: () => 0,
    kernel_remove_process: () => 0,
    kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(kernelMemory),
    ...options.implementations,
  };
  const gate = options.gate ?? new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    kernelMemory,
    () => implementations,
    () => kernelPointer(pointerWidth, 4_096),
    4,
    KERNEL_EXPORT_NAMES,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const scratch = allocateKernelScratchRegion(
    kernelMemory,
    gatedInstance.exports.kernel_alloc_scratch as
      (capacity: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
    "network cleanup entry test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble({
    io: options.io as any,
  }) as unknown as Record<string, any>;
  worker.testAuthority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch: scratch,
    tcpScratch: scratch,
  });
  return { worker, gate, implementations };
}

function networkSnapshot(worker: Record<string, any>): {
  readonly udp: string[];
  readonly targetPorts: number[];
  readonly listenerKeys: string[];
  readonly virtualPorts: number[];
  readonly connectionPids: number[];
  readonly processPids: number[];
} {
  return {
    udp: [...worker.udpBindings].sort(),
    targetPorts: [...worker.tcpListenerTargets.keys()].sort(),
    listenerKeys: [...worker.tcpListeners.keys()].sort(),
    virtualPorts: [...worker.tcpVirtualListenerKeys.keys()].sort(),
    connectionPids: [...worker.tcpConnections.keys()].sort(),
    processPids: [...worker.processes.keys()].sort(),
  };
}

describe("network cleanup entry authority", () => {
  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s publishes complete UDP/TCP cleanup before reentrant host callbacks",
    async (_name, pointerWidth) => {
      const callbackSnapshots: ReturnType<typeof networkSnapshot>[] = [];
      const reentryErrors: unknown[] = [];
      const order: string[] = [];
      let nestedUnregisterError: unknown;
      let harness!: ReturnType<typeof makeHarness>;

      const observe = (label: string): void => {
        order.push(label);
        callbackSnapshots.push(networkSnapshot(harness.worker));
        try {
          harness.gate.invokeKernelExport(
            "network cleanup callback probe",
            () => 0,
          );
        } catch (error) {
          reentryErrors.push(error);
        }
      };
      const finalServer = {
        close: vi.fn(() => observe("server close")),
      };
      const sharedServer = {
        close: vi.fn(() => observe("shared server close")),
      };
      const network = {
        connect: vi.fn(),
        connectStatus: vi.fn(() => 0),
        send: vi.fn(() => 0),
        recv: vi.fn(() => new Uint8Array()),
        close: vi.fn(),
        getaddrinfo: vi.fn(() => new Uint8Array([127, 0, 0, 1])),
        unbindUdp: vi.fn(() => {
          observe("UDP unbind");
          try {
            // This root returns a synchronous ownership result, so it cannot
            // truthfully queue behind the detached publication in progress.
            harness.worker.unregisterProcess(41);
          } catch (error) {
            nestedUnregisterError = error;
          }
        }),
        closeTcpListener: vi.fn(() => observe("virtual listener close")),
      };
      const removeProcess = vi.fn(() => 0);
      harness = makeHarness(pointerWidth, {
        io: { network },
        implementations: { kernel_remove_process: removeProcess },
      });

      const memory41 = processMemory();
      const memory42 = processMemory();
      Object.assign(harness.worker, {
        processes: new Map([
          [41, {
            pid: 41,
            memory: memory41,
            channels: [],
            ptrWidth: pointerWidth,
            explicitMaxAddr: true,
          }],
          [42, {
            pid: 42,
            memory: memory42,
            channels: [],
            ptrWidth: pointerWidth,
            explicitMaxAddr: true,
          }],
        ]),
        udpBindings: new Set(["41:7", "42:9"]),
        tcpListenerTargets: new Map([
          [8_000, [{ pid: 41, fd: 4 }]],
          [8_001, [{ pid: 41, fd: 5 }, { pid: 42, fd: 6 }]],
        ]),
        tcpListenerRRIndex: new Map([
          [8_000, 0],
          [8_001, 1],
        ]),
        tcpVirtualListenerKeys: new Map([
          [8_000, "virtual:8000"],
          [8_001, "virtual:8001"],
        ]),
        tcpListeners: new Map([
          ["41:4", {
            server: finalServer,
            pid: 41,
            port: 8_000,
            connections: new Set(),
          }],
          ["41:5", {
            server: sharedServer,
            pid: 41,
            port: 8_001,
            connections: new Set(),
          }],
        ]),
        tcpConnections: new Map([
          [41, []],
          [42, []],
        ]),
        usePolling: true,
      });

      harness.worker.unregisterProcess(41);
      for (let index = 0; index < 4; index++) await Promise.resolve();

      expect(order).toEqual([
        "UDP unbind",
        "virtual listener close",
        "server close",
      ]);
      const completeState = {
        udp: ["42:9"],
        targetPorts: [8_001],
        listenerKeys: ["42:6"],
        virtualPorts: [8_001],
        connectionPids: [42],
        processPids: [42],
      };
      expect(callbackSnapshots).toEqual([
        completeState,
        completeState,
        completeState,
      ]);
      expect(reentryErrors).toHaveLength(3);
      for (const error of reentryErrors) {
        expect(error).toBeInstanceOf(KernelReentrantEntryError);
        expect(
          (error as KernelReentrantEntryError).activeExportName,
        ).toBe("detached host phase");
      }
      expect(nestedUnregisterError).toBeInstanceOf(
        KernelReentrantEntryError,
      );
      expect(harness.worker.unregisterProcess(41)).toBe(true);
      expect(removeProcess).toHaveBeenCalledExactlyOnceWith(41);
      expect(network.unbindUdp).toHaveBeenCalledExactlyOnceWith("41:7");
      expect(network.closeTcpListener)
        .toHaveBeenCalledExactlyOnceWith("virtual:8000");
      expect(finalServer.close).toHaveBeenCalledOnce();
      expect(sharedServer.close).not.toHaveBeenCalled();
      expect(harness.worker.tcpListenerRRIndex.get(8_001)).toBe(0);
      expect(harness.worker.tcpVirtualListenerKeys.get(8_001))
        .toBe("virtual:8001");
      expect(harness.worker.tcpListeners.get("42:6")?.server)
        .toBe(sharedServer);
      expect(harness.worker.getKernelMemoryPages()).toBe(256);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s schedules UDP wake work only after the exact entry is revoked",
    (_name, pointerWidth) => {
      const gate = new KernelEntryGate();
      const schedulingErrors: unknown[] = [];
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "setImmediate",
      );
      Object.defineProperty(globalThis, "setImmediate", {
        configurable: true,
        writable: true,
        value: (() => {
          try {
            gate.invokeKernelExport("UDP scheduler phase probe", () => 0);
          } catch (error) {
            schedulingErrors.push(error);
          }
          return 1 as unknown as ReturnType<typeof setImmediate>;
        }) as typeof setImmediate,
      });

      let harness: ReturnType<typeof makeHarness>;
      try {
        harness = makeHarness(pointerWidth, {
          gate,
          implementations: {},
        });
      } finally {
        if (originalDescriptor === undefined) {
          Reflect.deleteProperty(globalThis, "setImmediate");
        } else {
          Object.defineProperty(
            globalThis,
            "setImmediate",
            originalDescriptor,
          );
        }
      }
      const memory = processMemory();
      harness.worker.processes.set(41, {
        pid: 41,
        memory,
        channels: [],
        ptrWidth: pointerWidth,
        explicitMaxAddr: true,
      });
      harness.worker.pendingPipeReaders.set(7, new Set());

      expect(harness.worker.injectUdpDatagram(41, {
        srcAddr: new Uint8Array([10, 0, 0, 1]),
        srcPort: 1_000,
        dstAddr: new Uint8Array([10, 0, 0, 2]),
        dstPort: 2_000,
        data: new Uint8Array([1, 2, 3]),
      })).toBe(0);

      expect(schedulingErrors).toHaveLength(1);
      expect(schedulingErrors[0]).toBeInstanceOf(
        KernelReentrantEntryError,
      );
      expect(
        (schedulingErrors[0] as KernelReentrantEntryError).activeExportName,
      ).toBe("detached host phase");
    },
  );
});
