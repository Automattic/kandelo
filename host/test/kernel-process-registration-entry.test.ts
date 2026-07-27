import { describe, expect, it, vi } from "vitest";

import {
  CAPTURED_STDIO,
  createCentralizedKernelWorkerTestDouble,
  type CentralizedKernelWorker,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
  KernelReentrantEntryError,
} from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import {
  CH_TOTAL_SIZE,
  PROCESS_STATE_RUNNING,
} from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const KERNEL_EXPORT_NAMES = [
  "kernel_clear_process_metadata",
  "kernel_create_process_with_stdio",
  "kernel_get_process_state",
  "kernel_push_process_metadata_entry",
  "kernel_set_brk_base",
  "kernel_set_brk_limit",
  "kernel_set_max_addr",
  "kernel_set_mmap_base",
  "kernel_vblank",
] as const;

interface ProcessEntryHarness {
  readonly worker: CentralizedKernelWorker;
  readonly gatedInstance: WebAssembly.Instance;
  readonly kernelMemory: WebAssembly.Memory;
  readonly implementations: Record<string, unknown>;
}

function processMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 3,
    maximum: 3,
    shared: true,
  });
}

function makeHarness(
  implementations: Record<string, unknown>,
): ProcessEntryHarness {
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
    "process registration entry test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble();
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
    implementations,
  };
}

describe("kernel process registration entry authority", () => {
  it("publishes one complete registration from immutable metadata snapshots", () => {
    const argv = ["program", "first"];
    const env = ["A=original"];
    const clear = vi.fn(() => 0);
    const createProcess = vi.fn(() => 47);
    const getProcessState = vi.fn(() => PROCESS_STATE_RUNNING);
    const setBrkBase = vi.fn(() => 0);
    const setBrkLimit = vi.fn(() => 0);
    const setMaxAddr = vi.fn(() => 0);
    const setMmapBase = vi.fn(() => 0);
    const pushed: Array<{
      readonly kind: number;
      readonly bytes: Uint8Array;
    }> = [];
    let harness!: ProcessEntryHarness;
    const push = vi.fn((
      _pid: number,
      kind: number,
      pointer: number,
      length: number,
    ) => {
      pushed.push({
        kind,
        bytes: new Uint8Array(
          new Uint8Array(
            harness.kernelMemory.buffer,
            pointer,
            length,
          ),
        ),
      });
      // The source arrays remain caller-owned. Reentrant mutation after the
      // first Rust call must not replace later entries in this transaction.
      if (pushed.length === 1) {
        argv[1] = "replaced";
        env.push("B=late");
      }
      return 0;
    });
    harness = makeHarness({
      kernel_clear_process_metadata: clear,
      kernel_create_process_with_stdio: createProcess,
      kernel_get_process_state: getProcessState,
      kernel_push_process_metadata_entry: push,
      kernel_set_brk_base: setBrkBase,
      kernel_set_brk_limit: setBrkLimit,
      kernel_set_max_addr: setMaxAddr,
      kernel_set_mmap_base: setMmapBase,
      kernel_vblank: () => 0,
    });

    const pid = harness.worker.createProcess(CAPTURED_STDIO);
    const memory = processMemory();
    harness.worker.registerProcess(pid, memory, [65_536], {
      argv,
      env,
      brkBase: 70_000,
      brkLimit: 120_000,
      maxAddr: 130_000,
      mmapBase: 80_000,
      ptrWidth: 4,
    });

    expect(createProcess).toHaveBeenCalledWith(0, 0, 0);
    expect(getProcessState).toHaveBeenCalledWith(pid);
    expect(clear.mock.calls).toEqual([
      [pid, 0],
      [pid, 1],
    ]);
    expect(pushed.map(({ kind, bytes }) => ({
      kind,
      text: new TextDecoder().decode(bytes),
    }))).toEqual([
      { kind: 0, text: "program" },
      { kind: 0, text: "first" },
      { kind: 1, text: "A=original" },
    ]);
    expect(setBrkBase).toHaveBeenCalledWith(pid, 70_000);
    expect(setBrkLimit).toHaveBeenCalledWith(pid, 120_000);
    expect(setMaxAddr).toHaveBeenCalledWith(pid, 130_000);
    expect(setMmapBase).toHaveBeenCalledWith(pid, 80_000);
    expect(harness.worker.getProcessMemory(pid)).toBe(memory);
  });

  it("rejects synchronous authority roots during a live kernel export", async () => {
    const exportCalls = {
      clear: vi.fn(() => 0),
      create: vi.fn(() => 51),
      getState: vi.fn(() => PROCESS_STATE_RUNNING),
      push: vi.fn(() => 0),
      setBrkBase: vi.fn(() => 0),
      setBrkLimit: vi.fn(() => 0),
      setMaxAddr: vi.fn(() => 0),
      setMmapBase: vi.fn(() => 0),
    };
    const caught: unknown[] = [];
    let harness!: ProcessEntryHarness;
    const guestMemory = processMemory();
    harness = makeHarness({
      kernel_clear_process_metadata: exportCalls.clear,
      kernel_create_process_with_stdio: exportCalls.create,
      kernel_get_process_state: exportCalls.getState,
      kernel_push_process_metadata_entry: exportCalls.push,
      kernel_set_brk_base: exportCalls.setBrkBase,
      kernel_set_brk_limit: exportCalls.setBrkLimit,
      kernel_set_max_addr: exportCalls.setMaxAddr,
      kernel_set_mmap_base: exportCalls.setMmapBase,
      kernel_vblank: () => {
        const attempts: Array<() => unknown> = [
          () => harness.worker.createProcess(CAPTURED_STDIO),
          () => harness.worker.registerProcess(
            51,
            guestMemory,
            [65_536],
          ),
          () => harness.worker.setBrkBase(51, 70_000),
          () => harness.worker.setBrkLimit(51, 120_000),
          () => harness.worker.setMaxAddr(51, 130_000),
          () => harness.worker.setMmapBase(51, 80_000),
          () => (
            harness.worker as unknown as {
              replaceProcessMetadata(
                pid: number,
                kind: number,
                values: readonly string[],
              ): void;
            }
          ).replaceProcessMetadata(51, 0, ["program"]),
        ];
        for (const attempt of attempts) {
          try {
            attempt();
          } catch (error) {
            caught.push(error);
          }
        }
        return 0;
      },
    });

    (
      harness.gatedInstance.exports.kernel_vblank as () => number
    )();
    await Promise.resolve();

    expect(caught).toHaveLength(7);
    for (const error of caught) {
      expect(error).toBeInstanceOf(KernelReentrantEntryError);
    }
    for (const call of Object.values(exportCalls)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(harness.worker.getProcessMemory(51)).toBeUndefined();
  });

  it("does not publish host registration after a metadata-stage failure", () => {
    const harness = makeHarness({
      kernel_clear_process_metadata: () => 0,
      kernel_create_process_with_stdio: () => 63,
      kernel_get_process_state: () => PROCESS_STATE_RUNNING,
      kernel_push_process_metadata_entry: () => -5,
      kernel_set_brk_base: () => 0,
      kernel_set_brk_limit: () => 0,
      kernel_set_max_addr: () => 0,
      kernel_set_mmap_base: () => 0,
      kernel_vblank: () => 0,
    });
    const memory = processMemory();

    expect(() => harness.worker.registerProcess(
      63,
      memory,
      [65_536],
      { argv: ["program"] },
    )).toThrow();
    expect(harness.worker.getProcessMemory(63)).toBeUndefined();
  });
});
