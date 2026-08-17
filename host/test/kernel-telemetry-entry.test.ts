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
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const TELEMETRY_EXPORT_NAMES = [
  "kernel_get_fork_count",
  "kernel_get_memory_pages",
  "kernel_inject_mouse_event",
  "kernel_process_secure_exec",
  "kernel_spawn_scratch_retained_capacity",
  "kernel_vblank",
] as const;

interface TelemetryHarness {
  readonly worker: CentralizedKernelWorker;
  readonly gate: KernelEntryGate;
  readonly gatedInstance: WebAssembly.Instance;
  readonly implementations: Record<string, unknown>;
}

function kernelPointer(
  pointerWidth: 4 | 8,
  value: number,
): number | bigint {
  return pointerWidth === 8 ? BigInt(value) : value;
}

function makeHarness(
  pointerWidth: 4 | 8,
  options: {
    readonly gate?: KernelEntryGate;
    readonly exportNames?: readonly string[];
    readonly implementations?: Record<string, unknown>;
  } = {},
): TelemetryHarness {
  const gate = options.gate ?? new KernelEntryGate();
  const implementations: Record<string, unknown> = {
    kernel_get_fork_count: () => 11n,
    kernel_get_memory_pages: () => 321,
    kernel_inject_mouse_event: () => 0,
    kernel_process_secure_exec: () => 0,
    kernel_spawn_scratch_retained_capacity: () =>
      kernelPointer(pointerWidth, 84_386),
    kernel_vblank: () => 0,
    ...options.implementations,
  };
  const memory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    memory,
    () => implementations,
    () => kernelPointer(pointerWidth, 4_096),
    4,
    options.exportNames ?? TELEMETRY_EXPORT_NAMES,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const mainScratch = allocateKernelScratchRegion(
    memory,
    gatedInstance.exports.kernel_alloc_scratch as
      (capacity: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
    "telemetry entry test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble();
  worker.testAuthority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch,
  });
  return {
    worker,
    gate,
    gatedInstance,
    implementations,
  };
}

describe("kernel telemetry entry authority", () => {
  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s queries telemetry through one exact entry and validates capacity outside it",
    (_name, pointerWidth) => {
      const getForkCount = vi.fn(() => 11n);
      const getMemoryPages = vi.fn(() => 321);
      const getCapacity = vi.fn(() =>
        kernelPointer(pointerWidth, 84_386));
      const getSecureExec = vi.fn(() => 1);
      const harness = makeHarness(pointerWidth, {
        implementations: {
          kernel_get_fork_count: getForkCount,
          kernel_get_memory_pages: getMemoryPages,
          kernel_process_secure_exec: getSecureExec,
          kernel_spawn_scratch_retained_capacity: getCapacity,
        },
      });

      expect(harness.worker.getForkCount(47)).toBe(11n);
      expect(harness.worker.getKernelMemoryPages()).toBe(321);
      expect(harness.worker.getSpawnScratchCapacity()).toBe(84_386);
      expect(harness.worker.processSecureExec(47)).toBe(true);
      expect(getForkCount).toHaveBeenCalledExactlyOnceWith(47);
      expect(getMemoryPages).toHaveBeenCalledOnce();
      expect(getCapacity).toHaveBeenCalledOnce();
      expect(getSecureExec).toHaveBeenCalledExactlyOnceWith(47);

      harness.implementations.kernel_spawn_scratch_retained_capacity =
        () => pointerWidth === 8 ? -1n : -1;
      expect(() => {
        harness.worker.getSpawnScratchCapacity();
      }).toThrow(/invalid spawn scratch capacity/);

      // Invalid telemetry is a rejected diagnostic, not a trapped Rust
      // mutation. The same generation remains usable.
      harness.implementations.kernel_spawn_scratch_retained_capacity =
        () => kernelPointer(pointerWidth, 4_096);
      expect(harness.worker.getSpawnScratchCapacity()).toBe(4_096);

      for (const invalidMarker of [-3, 2]) {
        const invalidHarness = makeHarness(pointerWidth, {
          implementations: {
            kernel_process_secure_exec: () => invalidMarker,
          },
        });
        expect(() => invalidHarness.worker.processSecureExec(47)).toThrow(
          /secure-exec query pid=47 failed/,
        );
      }
    },
  );

  it("rejects result-bearing telemetry during a live export without queueing it", async () => {
    const forkCount = vi.fn(() => 13n);
    const memoryPages = vi.fn(() => 77);
    const capacity = vi.fn(() => 98_304);
    const secureExec = vi.fn(() => 1);
    const caught: unknown[] = [];
    let harness!: TelemetryHarness;
    harness = makeHarness(4, {
      implementations: {
        kernel_get_fork_count: forkCount,
        kernel_get_memory_pages: memoryPages,
        kernel_process_secure_exec: secureExec,
        kernel_spawn_scratch_retained_capacity: capacity,
        kernel_vblank: () => {
          for (const query of [
            () => harness.worker.getForkCount(51),
            () => harness.worker.getKernelMemoryPages(),
            () => harness.worker.getSpawnScratchCapacity(),
            () => harness.worker.processSecureExec(51),
          ]) {
            try {
              query();
            } catch (error) {
              caught.push(error);
            }
          }
          return 0;
        },
      },
    });

    (
      harness.gatedInstance.exports.kernel_vblank as () => number
    )();
    await Promise.resolve();

    expect(caught).toHaveLength(4);
    for (const error of caught) {
      expect(error).toBeInstanceOf(KernelReentrantEntryError);
    }
    expect(forkCount).not.toHaveBeenCalled();
    expect(memoryPages).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
    expect(secureExec).not.toHaveBeenCalled();

    expect(harness.worker.getForkCount(51)).toBe(13n);
    expect(harness.worker.getKernelMemoryPages()).toBe(77);
    expect(harness.worker.getSpawnScratchCapacity()).toBe(98_304);
    expect(harness.worker.processSecureExec(51)).toBe(true);
  });

  it("materializes optional/missing-export outcomes after scope revocation", () => {
    const vblank = vi.fn(() => 0);
    const harness = makeHarness(4, {
      exportNames: ["kernel_vblank"],
      implementations: { kernel_vblank: vblank },
    });

    expect(harness.worker.getForkCount(9)).toBe(0n);
    expect(() => {
      harness.worker.getKernelMemoryPages();
    }).toThrow("kernel_get_memory_pages export is unavailable");
    expect(() => {
      harness.worker.getSpawnScratchCapacity();
    }).toThrow(
      "kernel_spawn_scratch_retained_capacity export is unavailable",
    );

    // Missing optional/mismatched diagnostics must not poison the entry gate.
    expect(
      (harness.gatedInstance.exports.kernel_vblank as () => number)(),
    ).toBe(0);
    expect(vblank).toHaveBeenCalledOnce();
  });

  it("registers mouse wake scheduling only in the detached protocol phase", () => {
    const gate = new KernelEntryGate();
    const schedulingPhaseErrors: unknown[] = [];
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "setImmediate",
    );
    const scheduleImmediate = ((
      _operation: (...args: unknown[]) => void,
    ) => {
      try {
        gate.invokeKernelExport("scheduler phase probe", () => 0);
      } catch (error) {
        schedulingPhaseErrors.push(error);
      }
      return 1 as unknown as ReturnType<typeof setImmediate>;
    }) as typeof setImmediate;
    Object.defineProperty(globalThis, "setImmediate", {
      configurable: true,
      writable: true,
      value: scheduleImmediate,
    });
    let harness: TelemetryHarness;
    try {
      harness = makeHarness(4, {
        gate,
        exportNames: ["kernel_inject_mouse_event"],
        implementations: {
          kernel_inject_mouse_event: vi.fn(() => 0),
        },
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
    const state = harness.worker as unknown as {
      readonly pendingPipeReaders: Map<number, Set<unknown>>;
    };
    state.pendingPipeReaders.set(1, new Set());

    harness.worker.injectMouseEvent(1, 2, 3);

    expect(schedulingPhaseErrors).toHaveLength(1);
    expect(schedulingPhaseErrors[0]).toBeInstanceOf(
      KernelReentrantEntryError,
    );
    expect(
      (schedulingPhaseErrors[0] as KernelReentrantEntryError)
        .activeExportName,
    ).toBe("detached host phase");
  });
});
