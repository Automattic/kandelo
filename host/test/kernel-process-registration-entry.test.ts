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
  PROCESS_METADATA_KIND_ARGV,
  PROCESS_METADATA_KIND_ENVIRONMENT,
  PROCESS_STATE_RUNNING,
} from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const KERNEL_EXPORT_NAMES = [
  "kernel_create_process_with_stdio",
  "kernel_get_process_state",
  "kernel_process_metadata_begin",
  "kernel_process_metadata_cancel",
  "kernel_process_metadata_commit",
  "kernel_process_metadata_stage",
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
  pointerWidth: 4 | 8 = 4,
): ProcessEntryHarness {
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 8,
  });
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    kernelMemory,
    () => implementations,
    () => pointerWidth === 8 ? 4_096n : 4_096,
    4,
    KERNEL_EXPORT_NAMES,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const mainScratch = allocateKernelScratchRegion(
    kernelMemory,
    gatedInstance.exports.kernel_alloc_scratch as
      (size: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
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
  it("rejects kernel Memory as process Memory before any export runs", () => {
    const calls = Object.fromEntries(KERNEL_EXPORT_NAMES.map((name) => [
      name,
      vi.fn(() => name === "kernel_get_process_state"
        ? PROCESS_STATE_RUNNING
        : 0),
    ]));
    const harness = makeHarness(calls);

    expect(() => harness.worker.registerProcess(
      41,
      harness.kernelMemory,
      [65_536],
    )).toThrow("Process Memory must not alias kernel Memory");

    for (const call of Object.values(calls)) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it.each([4, 8] as const)(
    "publishes one complete wasm%s registration from immutable metadata snapshots",
    (pointerWidth) => {
    const argv = ["program", "first"];
    const env = ["A=original"];
    const begin = vi.fn(() => 41);
    const cancel = vi.fn(() => 0);
    const commit = vi.fn(() => 0);
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
    const stage = vi.fn((
      _pid: number,
      _token: number,
      kind: number,
      pointer: number | bigint,
      length: number,
    ) => {
      pushed.push({
        kind,
        bytes: new Uint8Array(
          new Uint8Array(
            harness.kernelMemory.buffer,
            Number(pointer),
            length,
          ),
        ),
      });
      // The source arrays remain caller-owned. Reentrant mutation after the
      // first Rust call must not replace later entries in this transaction.
      if (pushed.length === 1) {
        argv[1] = "replaced";
        env.push("B=late");
        // Rust entry allocation may grow kernel memory. The next entry must
        // reacquire the current buffer through a fresh scratch lease.
        harness.kernelMemory.grow(1);
      }
      return 0;
    });
    harness = makeHarness({
      kernel_create_process_with_stdio: createProcess,
      kernel_get_process_state: getProcessState,
      kernel_process_metadata_begin: begin,
      kernel_process_metadata_cancel: cancel,
      kernel_process_metadata_commit: commit,
      kernel_process_metadata_stage: stage,
      kernel_set_brk_base: setBrkBase,
      kernel_set_brk_limit: setBrkLimit,
      kernel_set_max_addr: setMaxAddr,
      kernel_set_mmap_base: setMmapBase,
      kernel_vblank: () => 0,
    }, pointerWidth);

    const pid = harness.worker.createProcess(CAPTURED_STDIO);
    const memory = processMemory();
    harness.worker.registerProcess(pid, memory, [65_536], {
      argv,
      env,
      brkBase: 70_000,
      brkLimit: 120_000,
      maxAddr: 130_000,
      mmapBase: 80_000,
      ptrWidth: pointerWidth,
    });

    expect(createProcess).toHaveBeenCalledWith(0, 0, 0);
    expect(getProcessState).toHaveBeenCalledWith(pid);
    expect(begin).toHaveBeenCalledWith(pid);
    expect(commit).toHaveBeenCalledWith(pid, 41);
    expect(cancel).not.toHaveBeenCalled();
    expect(pushed.map(({ kind, bytes }) => ({
      kind,
      text: new TextDecoder().decode(bytes),
    }))).toEqual([
      { kind: PROCESS_METADATA_KIND_ARGV, text: "program" },
      { kind: PROCESS_METADATA_KIND_ARGV, text: "first" },
      { kind: PROCESS_METADATA_KIND_ENVIRONMENT, text: "A=original" },
    ]);
    const kernelPointer = (value: number): number | bigint =>
      pointerWidth === 8 ? BigInt(value) : value;
    expect(setBrkBase).toHaveBeenCalledWith(pid, kernelPointer(70_000));
    expect(setBrkLimit).toHaveBeenCalledWith(pid, kernelPointer(120_000));
    expect(setMaxAddr).toHaveBeenCalledWith(pid, kernelPointer(130_000));
    expect(setMmapBase).toHaveBeenCalledWith(pid, kernelPointer(80_000));
    expect(harness.worker.getProcessMemory(pid)).toBe(memory);
    },
  );

  it("rejects synchronous authority roots during a live kernel export", async () => {
    const exportCalls = {
      create: vi.fn(() => 51),
      getState: vi.fn(() => PROCESS_STATE_RUNNING),
      metadataBegin: vi.fn(() => 1),
      metadataCancel: vi.fn(() => 0),
      metadataCommit: vi.fn(() => 0),
      metadataStage: vi.fn(() => 0),
      setBrkBase: vi.fn(() => 0),
      setBrkLimit: vi.fn(() => 0),
      setMaxAddr: vi.fn(() => 0),
      setMmapBase: vi.fn(() => 0),
    };
    const caught: unknown[] = [];
    let harness!: ProcessEntryHarness;
    const guestMemory = processMemory();
    harness = makeHarness({
      kernel_create_process_with_stdio: exportCalls.create,
      kernel_get_process_state: exportCalls.getState,
      kernel_process_metadata_begin: exportCalls.metadataBegin,
      kernel_process_metadata_cancel: exportCalls.metadataCancel,
      kernel_process_metadata_commit: exportCalls.metadataCommit,
      kernel_process_metadata_stage: exportCalls.metadataStage,
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
            { argv: ["program"], env: [] },
          ),
          () => harness.worker.setBrkBase(51, 70_000),
          () => harness.worker.setBrkLimit(51, 120_000),
          () => harness.worker.setMaxAddr(51, 130_000),
          () => harness.worker.setMmapBase(51, 80_000),
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

    expect(caught).toHaveLength(6);
    for (const error of caught) {
      expect(error).toBeInstanceOf(KernelReentrantEntryError);
    }
    for (const call of Object.values(exportCalls)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(harness.worker.getProcessMemory(51)).toBeUndefined();
  });

  it.each([
    { argv: ["program"] },
    { env: ["A=value"] },
  ])("rejects a partial metadata pair before entering the kernel", (metadata) => {
    const harness = makeHarness({});
    expect(() => harness.worker.registerProcess(
      52,
      processMemory(),
      [65_536],
      metadata,
    )).toThrow(/replace argv and environment together/);
  });

  it.each([4, 8] as const)(
    "cancels a later wasm%s environment-stage ENOMEM without publishing either vector",
    (pointerWidth) => {
      let liveArgv = ["old-program", "old-argument"];
      let liveEnvironment = ["OLD=value"];
      let nextToken = 70;
      let active: {
        readonly token: number;
        readonly argv: string[];
        readonly environment: string[];
      } | undefined;
      let failLaterEnvironmentStage = true;
      let harness!: ProcessEntryHarness;
      const begin = vi.fn((_pid: number) => {
        const transaction = {
          token: nextToken++,
          argv: [] as string[],
          environment: [] as string[],
        };
        active = transaction;
        return transaction.token;
      });
      const stage = vi.fn((
        _pid: number,
        token: number,
        kind: number,
        pointer: number | bigint,
        length: number,
      ) => {
        if (active?.token !== token) return -22;
        const value = new TextDecoder().decode(new Uint8Array(
          harness.kernelMemory.buffer,
          Number(pointer),
          length,
        ));
        if (
          failLaterEnvironmentStage
          && kind === PROCESS_METADATA_KIND_ENVIRONMENT
          && active.environment.length === 1
        ) {
          failLaterEnvironmentStage = false;
          return -12;
        }
        const destination = kind === PROCESS_METADATA_KIND_ARGV
          ? active.argv
          : active.environment;
        destination.push(value);
        return 0;
      });
      const commit = vi.fn((_pid: number, token: number) => {
        if (active?.token !== token) return -22;
        liveArgv = active.argv;
        liveEnvironment = active.environment;
        active = undefined;
        return 0;
      });
      const cancel = vi.fn((_pid: number, token: number) => {
        if (active?.token !== token) return -22;
        active = undefined;
        return 0;
      });
      const setBrkBase = vi.fn(() => 0);
      const setBrkLimit = vi.fn(() => 0);
      const setMaxAddr = vi.fn(() => 0);
      const setMmapBase = vi.fn(() => 0);
      harness = makeHarness({
        kernel_create_process_with_stdio: () => 63,
        kernel_get_process_state: () => PROCESS_STATE_RUNNING,
        kernel_process_metadata_begin: begin,
        kernel_process_metadata_cancel: cancel,
        kernel_process_metadata_commit: commit,
        kernel_process_metadata_stage: stage,
        kernel_set_brk_base: setBrkBase,
        kernel_set_brk_limit: setBrkLimit,
        kernel_set_max_addr: setMaxAddr,
        kernel_set_mmap_base: setMmapBase,
        kernel_vblank: () => 0,
      }, pointerWidth);
      const memory = processMemory();

      expect(() => harness.worker.registerProcess(
        63,
        memory,
        [65_536],
        {
          argv: ["new-program"],
          env: ["NEW=first", "NEW=second"],
          brkBase: 70_000,
          brkLimit: 120_000,
          maxAddr: 130_000,
          mmapBase: 80_000,
          ptrWidth: pointerWidth,
        },
      )).toThrow(/errno 12/);
      expect(commit).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledWith(63, 70);
      expect(active).toBeUndefined();
      expect(liveArgv).toEqual(["old-program", "old-argument"]);
      expect(liveEnvironment).toEqual(["OLD=value"]);
      expect(harness.worker.getProcessMemory(63)).toBeUndefined();
      expect(setBrkBase).not.toHaveBeenCalled();
      expect(setBrkLimit).not.toHaveBeenCalled();
      expect(setMaxAddr).not.toHaveBeenCalled();
      expect(setMmapBase).not.toHaveBeenCalled();

      harness.worker.registerProcess(63, memory, [65_536], {
        argv: ["retry-program", ""],
        env: [],
        brkBase: 70_000,
        brkLimit: 120_000,
        maxAddr: 130_000,
        mmapBase: 80_000,
        ptrWidth: pointerWidth,
      });
      expect(begin.mock.calls).toEqual([
        [63],
        [63],
      ]);
      expect(commit).toHaveBeenCalledWith(63, 71);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(liveArgv).toEqual(["retry-program", ""]);
      expect(liveEnvironment).toEqual([]);
      const kernelPointer = (value: number): number | bigint =>
        pointerWidth === 8 ? BigInt(value) : value;
      expect(setBrkBase).toHaveBeenCalledWith(63, kernelPointer(70_000));
      expect(setBrkLimit).toHaveBeenCalledWith(63, kernelPointer(120_000));
      expect(setMaxAddr).toHaveBeenCalledWith(63, kernelPointer(130_000));
      expect(setMmapBase).toHaveBeenCalledWith(63, kernelPointer(80_000));
      expect(harness.worker.getProcessMemory(63)).toBe(memory);
    },
  );

  it("does not enter cancellation after a metadata-stage Wasm trap", () => {
    const cancel = vi.fn(() => 0);
    const harness = makeHarness({
      kernel_create_process_with_stdio: () => 64,
      kernel_get_process_state: () => PROCESS_STATE_RUNNING,
      kernel_process_metadata_begin: () => 90,
      kernel_process_metadata_cancel: cancel,
      kernel_process_metadata_commit: () => 0,
      kernel_process_metadata_stage: () => {
        throw new Error("metadata stage trap");
      },
      kernel_set_brk_base: () => 0,
      kernel_set_brk_limit: () => 0,
      kernel_set_max_addr: () => 0,
      kernel_set_mmap_base: () => 0,
      kernel_vblank: () => 0,
    });

    expect(() => harness.worker.registerProcess(
      64,
      processMemory(),
      [65_536],
      { argv: ["program"], env: [] },
    )).toThrow(/kernel export kernel_process_metadata_stage failed/);
    expect(cancel).not.toHaveBeenCalled();
    expect(harness.worker.getProcessMemory(64)).toBeUndefined();
  });
});
