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
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
} from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const EINVAL = 22;
const KERNEL_EXPORT_NAMES = [
  "kernel_drain_wakeup_events",
  "kernel_get_memory_pages",
  "kernel_get_process_exit_signal",
  "kernel_handle_channel",
  "kernel_ipc_shmat_for_task",
  "kernel_ipc_shmdt_for_process",
  "kernel_set_current_tid",
  "kernel_validate_task",
] as const;

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

function kernelPointer(
  pointerWidth: 4 | 8,
  value: number,
): number | bigint {
  return pointerWidth === 8 ? BigInt(value) : value;
}

function makeHarness(
  pointerWidth: 4 | 8,
  callbacks: { readonly onKernelFatal?: (error: Error) => void },
  implementations: (
    worker: Record<string, any>,
    kernelMemory: WebAssembly.Memory,
  ) => Record<string, unknown>,
): {
  readonly worker: Record<string, any>;
  readonly channel: TestChannel;
  readonly gate: KernelEntryGate;
  readonly kernelMemory: WebAssembly.Memory;
  readonly implementations: Record<string, unknown>;
} {
  const channelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
    shared: true,
  });
  const channel: TestChannel = {
    pid: 41,
    memory: channelMemory,
    channelOffset: 0,
    i32View: new Int32Array(channelMemory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  const gate = new KernelEntryGate();
  let worker!: Record<string, any>;
  let mutableImplementations!: Record<string, unknown>;
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    kernelMemory,
    () => mutableImplementations,
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
    "IPC shmat entry test scratch",
    gatedInstance,
  );
  worker = createCentralizedKernelWorkerTestDouble({
    callbacks,
  }) as unknown as Record<string, any>;
  mutableImplementations = implementations(worker, kernelMemory);
  Object.assign(worker, {
    activeChannels: [channel],
    channelTids: new Map(),
    processes: new Map([[channel.pid, {
      pid: channel.pid,
      memory: channel.memory,
      channels: [channel],
      ptrWidth: pointerWidth,
      explicitMaxAddr: true,
    }]]),
    usePolling: true,
  });
  worker.testAuthority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch: scratch,
    tcpScratch: scratch,
  });
  return {
    worker,
    channel,
    gate,
    kernelMemory,
    implementations: mutableImplementations,
  };
}

function writeShmat(
  channel: TestChannel,
  shmid: number,
  requestedAddress: number,
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Shmat, true);
  for (const [index, value] of [
    BigInt(shmid),
    BigInt(requestedAddress),
    0n,
  ].entries()) {
    view.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, value, true);
  }
}

function readResult(channel: TestChannel): {
  readonly status: number;
  readonly retVal: number;
  readonly errno: number;
} {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  return {
    status: view.getUint32(CH_STATUS, true),
    retVal: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

describe("IPC shmat rollback entry authority", () => {
  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s rolls back the process mapping and Rust attachment under one exact entry",
    (_name, pointerWidth) => {
      const requestedAddress = 0x6_000;
      const allocatedAddress = 0x7_000;
      const segmentSize = 4_096;
      const syscallOrder: number[] = [];
      const syntheticArgs: bigint[][] = [];
      let shmdtReentryError: unknown;
      let harness!: ReturnType<typeof makeHarness>;
      const shmdt = vi.fn(() => {
        try {
          harness.gate.invokeKernelExport(
            "shmdt reentry probe",
            () => 0,
          );
        } catch (error) {
          shmdtReentryError = error;
        }
        return 0;
      });
      harness = makeHarness(pointerWidth, {}, (_worker, kernelMemory) => ({
        kernel_drain_wakeup_events: () => 0,
        kernel_get_memory_pages: () => 256,
        kernel_get_process_exit_signal: () => 0,
        kernel_handle_channel: (rawPointer: number | bigint) => {
          const view = new DataView(
            kernelMemory.buffer,
            Number(rawPointer),
            CH_TOTAL_SIZE,
          );
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscallOrder.push(syscall);
          syntheticArgs.push(
            Array.from({ length: 6 }, (_, index) =>
              view.getBigInt64(CH_ARGS + index * CH_ARG_SIZE, true)),
          );
          view.setBigInt64(
            CH_RETURN,
            BigInt(
              syscall === ABI_SYSCALLS.Mmap ? allocatedAddress : 0,
            ),
            true,
          );
          view.setUint32(CH_ERRNO, 0, true);
          return 0;
        },
        kernel_ipc_shmat_for_task: () => segmentSize,
        kernel_ipc_shmdt_for_process: shmdt,
        kernel_set_current_tid: () => 0,
        kernel_validate_task: () => 0,
      }));

      writeShmat(harness.channel, 17, requestedAddress);
      harness.worker.handleSyscall(harness.channel);

      expect(syscallOrder).toEqual([
        ABI_SYSCALLS.Mmap,
        ABI_SYSCALLS.Munmap,
      ]);
      expect(syntheticArgs[1]?.slice(0, 2)).toEqual([
        BigInt(allocatedAddress),
        BigInt(segmentSize),
      ]);
      expect(shmdt).toHaveBeenCalledExactlyOnceWith(41, 17);
      expect(shmdtReentryError).toBeInstanceOf(KernelReentrantEntryError);
      expect(
        (shmdtReentryError as KernelReentrantEntryError).activeExportName,
      ).toBe("kernel_ipc_shmdt_for_process");
      expect(readResult(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -EINVAL,
        errno: EINVAL,
      });
      expect(harness.worker.shmMappings.has(41)).toBe(false);
    },
  );

  it("poisons the generation when Rust attachment rollback is not proven", async () => {
    const onKernelFatal = vi.fn();
    let harness!: ReturnType<typeof makeHarness>;
    harness = makeHarness(
      4,
      { onKernelFatal },
      (_worker, kernelMemory) => ({
        kernel_drain_wakeup_events: () => 0,
        kernel_get_memory_pages: () => 256,
        kernel_get_process_exit_signal: () => 0,
        kernel_handle_channel: (rawPointer: number) => {
          const view = new DataView(
            kernelMemory.buffer,
            rawPointer,
            CH_TOTAL_SIZE,
          );
          const syscall = view.getUint32(CH_SYSCALL, true);
          view.setBigInt64(
            CH_RETURN,
            BigInt(syscall === ABI_SYSCALLS.Mmap ? 0x7_000 : 0),
            true,
          );
          view.setUint32(CH_ERRNO, 0, true);
          return 0;
        },
        kernel_ipc_shmat_for_task: () => 4_096,
        kernel_ipc_shmdt_for_process: () => -5,
        kernel_set_current_tid: () => 0,
        kernel_validate_task: () => 0,
      }),
    );
    writeShmat(harness.channel, 19, 0x6_000);

    expect(() => harness.worker.handleSyscall(harness.channel))
      .toThrow(/cannot roll back shmat attachment/);
    await Promise.resolve();

    expect(readResult(harness.channel).status).toBe(
      CHANNEL_STATUS_PENDING,
    );
    expect(onKernelFatal).toHaveBeenCalledOnce();
    expect(onKernelFatal.mock.calls[0]?.[0]).toMatchObject({
      name: "KernelIpcShmatRollbackError",
    });
    expect(() => harness.worker.getKernelMemoryPages())
      .toThrow(/cannot roll back shmat attachment/);
  });
});
