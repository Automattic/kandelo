import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { CH_TOTAL_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
  KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
  KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
  KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
  KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
  PROCESS_STATE_EXITED,
  STRUCT_SIZE_KERNEL_WAIT_RESULT,
  WAIT_CLD_KILLED,
  WAIT_EVENT_EXITED,
} from "../src/generated/abi";
import type { KernelScratchLease } from "../src/kernel-scratch";
import { NodePlatformIO } from "../src/platform/node";

describe("CentralizedKernelWorker", () => {
  it("drains queued PTY output when a listener registers", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const queued = [
      encoder.encode("spidermonkey-node$ "),
      encoder.encode("ready\n"),
    ];
    const received: string[] = [];
    const kernelWorker = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      ptyOutputCallbacks: new Map<number, (data: Uint8Array) => void>(),
      ptyMasterRead: () => queued.shift() ?? null,
    }) as CentralizedKernelWorker;

    kernelWorker.onPtyOutput(3, (data) => {
      received.push(decoder.decode(data));
    });

    expect(received).toEqual(["spidermonkey-node$ ", "ready\n"]);
  });

  it("should initialize the kernel from wasm bytes", async () => {
    const wasmBytes = readFileSync(resolveBinary("kernel.wasm"));

    const kernelWorker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    await kernelWorker.init(
      wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    );

    // If init doesn't throw, the kernel loaded and initialized successfully
    // Verify we can register a process without error
    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: 256,
      shared: true,
    });
    const channelOffset = (256 - 2) * 65536;
    memory.grow(256 - 17);

    const pid = kernelWorker.createProcess(CAPTURED_STDIO);
    kernelWorker.registerProcess(pid, memory, [channelOffset]);

    // Unregister to clean up
    kernelWorker.unregisterProcess(pid);
  });

  it("requires a nonnull exact-capacity mqueue notification destination", async () => {
    const wasmBytes = readFileSync(resolveBinary("kernel.wasm"));
    const kernelWorker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kernelWorker.init(
      wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    );

    const processMemory = new WebAssembly.Memory({
      initial: 17,
      maximum: 256,
      shared: true,
    });
    const channelOffset = (256 - 2) * 65536;
    processMemory.grow(256 - 17);
    const pid = kernelWorker.createProcess(CAPTURED_STDIO);
    kernelWorker.registerProcess(pid, processMemory, [channelOffset]);

    type ScratchArgument = {
      readonly offset: number;
      readonly length: number;
    };
    const scratchArgument = (
      offset: number,
      length: number,
    ): ScratchArgument => ({ offset, length });
    const internals = kernelWorker as any;
    const pointerWidth = internals.kernel.getKernelPtrWidth() as 4 | 8;
    const setCurrentTid = internals.kernelInstance.exports
      .kernel_set_current_tid as (pid: number, tid: number) => number;
    const issue = (
      syscall: number,
      prepare: (
        lease: KernelScratchLease,
      ) => Array<number | bigint | ScratchArgument>,
    ): { value: number; errno: number } =>
      internals.scratchRegion.withLease((lease: KernelScratchLease) => {
        lease.fill(0, 0, CH_TOTAL_SIZE);
        const args = prepare(lease);
        const channel = lease.dataView(0, CH_TOTAL_SIZE);
        channel.setUint32(CH_SYSCALL, syscall, true);
        channel.setUint32(CH_ERRNO, 0, true);
        channel.setBigInt64(CH_RETURN, 0n, true);
        for (let index = 0; index < 6; index++) {
          const argument = args[index] ?? 0;
          if (typeof argument === "object") {
            channel.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, 0n, true);
            lease.writeAddress(
              CH_ARGS + index * CH_ARG_SIZE,
              argument.offset,
              argument.length,
              pointerWidth === 8 ? "u64-le" : "u32-to-u64-le",
            );
          } else {
            channel.setBigInt64(
              CH_ARGS + index * CH_ARG_SIZE,
              BigInt(argument),
              true,
            );
          }
        }
        expect(setCurrentTid(pid, pid)).toBe(0);
        lease.invokeKernelExport("kernel_handle_channel", [
          lease.exportPointer(0, CH_TOTAL_SIZE),
          CH_TOTAL_SIZE,
          pid,
        ]);
        return {
          value: Number(channel.getBigInt64(CH_RETURN, true)),
          errno: channel.getUint32(CH_ERRNO, true),
        };
      });

    try {
      const queueName = new TextEncoder().encode(
        `/kernel-mq-drain-capacity-${pid}\0`,
      );
      const opened = issue(ABI_SYSCALLS.MqOpen, (lease) => {
        lease.copyFrom(queueName, CH_DATA);
        return [
          scratchArgument(CH_DATA, queueName.byteLength),
          0o302, // O_RDWR | O_CREAT | O_EXCL
          0o600,
          0,
          0,
          4,
        ];
      });
      expect(opened.errno).toBe(0);
      expect(opened.value).toBeGreaterThanOrEqual(0x4000_0000);

      const notified = issue(ABI_SYSCALLS.MqNotify, (lease) => {
        const sigeventSize = 64;
        const event = lease.dataView(CH_DATA, sigeventSize);
        event.setUint32(0, 0x89ab_cdef, true);
        event.setInt32(4, 10, true);
        event.setInt32(8, 0, true); // SIGEV_SIGNAL
        return [
          opened.value,
          scratchArgument(CH_DATA, sigeventSize),
          0,
          0,
          0,
          4,
        ];
      });
      expect(notified).toEqual({ value: 0, errno: 0 });

      const sent = issue(ABI_SYSCALLS.MqTimedsend, (lease) => {
        lease.copyFrom(new Uint8Array([0x51]), CH_DATA);
        return [
          opened.value,
          scratchArgument(CH_DATA, 1),
          1,
          0,
          0,
          4,
        ];
      });
      expect(sent).toEqual({ value: 0, errno: 0 });

      expect(KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES).toBe(8);
      internals.scratchRegion.withLease((lease: KernelScratchLease) => {
        const outputOffset = CH_DATA + 64;
        const guardedLength = KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES + 2;
        lease.fill(0xa5, outputOffset, guardedLength);
        const drain = internals.kernelInstance.exports
          .kernel_mq_drain_notification as (
            pointer: number | bigint,
            capacity: number,
          ) => number;
        const nullPointer = pointerWidth === 8 ? 0n : 0;

        expect(
          drain(nullPointer, KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES),
        ).toBe(-14); // EFAULT
        expect(
          lease.invokeKernelExport("kernel_mq_drain_notification", [
            lease.exportPointer(
              outputOffset + 1,
              KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES - 1,
            ),
            KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES - 1,
          ]),
        ).toBe(-22); // EINVAL
        expect(
          lease.invokeKernelExport("kernel_mq_drain_notification", [
            lease.exportPointer(
              outputOffset + 1,
              KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES + 1,
            ),
            KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES + 1,
          ]),
        ).toBe(-22); // EINVAL
        expect(lease.copyOut(outputOffset, guardedLength)).toEqual(
          new Uint8Array(guardedLength).fill(0xa5),
        );

        expect(
          lease.invokeKernelExport("kernel_mq_drain_notification", [
            lease.exportPointer(
              outputOffset + 1,
              KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
            ),
            KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
          ]),
        ).toBe(1);
        const output = lease.copyOut(outputOffset, guardedLength);
        expect(output[0]).toBe(0xa5);
        expect(output[guardedLength - 1]).toBe(0xa5);
        const notification = new DataView(
          output.buffer,
          output.byteOffset + 1,
          KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
        );
        expect(notification.getUint32(0, true)).toBe(pid);
        expect(notification.getUint32(4, true)).toBe(10);
      });
    } finally {
      kernelWorker.unregisterProcess(pid);
    }
  });

  it("preserves a waitable child until an exact-capacity result consumes it", async () => {
    const ECHILD = 10;
    const EFAULT = 14;
    const EINVAL = 22;
    const ESRCH = 3;
    const SIGTERM = 15;
    const wasmBytes = readFileSync(resolveBinary("kernel.wasm"));
    const kernelWorker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kernelWorker.init(
      wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    );

    const processMemory = new WebAssembly.Memory({
      initial: 17,
      maximum: 256,
      shared: true,
    });
    const channelOffset = (256 - 2) * 65536;
    processMemory.grow(256 - 17);
    const parentPid = kernelWorker.createProcess(CAPTURED_STDIO);
    kernelWorker.registerProcess(parentPid, processMemory, [channelOffset]);

    const internals = kernelWorker as any;
    const pointerWidth = internals.kernel.getKernelPtrWidth() as 4 | 8;
    const exports = internals.kernelInstance.exports as WebAssembly.Exports;
    const forkProcess = exports.kernel_fork_process as (
      parentPid: number,
      callerTid: number,
    ) => number;
    const markProcessSignaled = exports.kernel_mark_process_signaled as (
      pid: number,
      signum: number,
    ) => number;
    const getProcessState = exports.kernel_get_process_state as (
      pid: number,
    ) => number;
    const removeProcess = exports.kernel_remove_process as (
      pid: number,
    ) => number;
    const waitChildPoll = exports.kernel_wait_child_poll as (
      parentPid: number,
      callerTid: number,
      targetPid: number,
      eventMask: number,
      flags: number,
      resultPtr: number | bigint,
      resultCapacity: number,
    ) => number;
    let childPid = 0;

    try {
      childPid = forkProcess(parentPid, parentPid);
      expect(childPid).toBeGreaterThan(0);
      expect(markProcessSignaled(childPid, SIGTERM)).toBe(0);
      expect(getProcessState(childPid)).toBe(PROCESS_STATE_EXITED);

      internals.scratchRegion.withLease((lease: KernelScratchLease) => {
        const outputOffset = CH_DATA + 256;
        const guardedLength = STRUCT_SIZE_KERNEL_WAIT_RESULT + 2;
        const nullPointer = pointerWidth === 8 ? 0n : 0;
        const pollWithCapacity = (capacity: number): number =>
          lease.invokeKernelExport("kernel_wait_child_poll", [
            parentPid,
            parentPid,
            childPid,
            WAIT_EVENT_EXITED,
            0,
            lease.exportPointer(outputOffset + 1, capacity),
            capacity,
          ]);
        lease.fill(0xa5, outputOffset, guardedLength);

        // WHY: destination rejection must precede event selection, or a bad
        // host borrow could silently consume the parent's only wait record.
        expect(waitChildPoll(
          parentPid,
          parentPid,
          childPid,
          WAIT_EVENT_EXITED,
          0,
          nullPointer,
          STRUCT_SIZE_KERNEL_WAIT_RESULT,
        )).toBe(-EFAULT);
        expect(getProcessState(childPid)).toBe(PROCESS_STATE_EXITED);

        expect(
          pollWithCapacity(STRUCT_SIZE_KERNEL_WAIT_RESULT - 1),
        ).toBe(-EINVAL);
        expect(getProcessState(childPid)).toBe(PROCESS_STATE_EXITED);

        expect(
          pollWithCapacity(STRUCT_SIZE_KERNEL_WAIT_RESULT + 1),
        ).toBe(-EINVAL);
        expect(getProcessState(childPid)).toBe(PROCESS_STATE_EXITED);
        expect(lease.copyOut(outputOffset, guardedLength)).toEqual(
          new Uint8Array(guardedLength).fill(0xa5),
        );

        expect(
          pollWithCapacity(STRUCT_SIZE_KERNEL_WAIT_RESULT),
        ).toBe(childPid);
        const output = lease.copyOut(outputOffset, guardedLength);
        expect(output[0]).toBe(0xa5);
        expect(output[guardedLength - 1]).toBe(0xa5);
        const result = new DataView(
          output.buffer,
          output.byteOffset + 1,
          STRUCT_SIZE_KERNEL_WAIT_RESULT,
        );
        expect(
          result.getInt32(KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET, true),
        ).toBe(SIGTERM);
        expect(
          result.getInt32(KERNEL_WAIT_RESULT_SI_CODE_OFFSET, true),
        ).toBe(WAIT_CLD_KILLED);
        expect(
          result.getInt32(KERNEL_WAIT_RESULT_SI_STATUS_OFFSET, true),
        ).toBe(SIGTERM);

        expect(getProcessState(childPid)).toBe(-ESRCH);
        expect(
          pollWithCapacity(STRUCT_SIZE_KERNEL_WAIT_RESULT),
        ).toBe(-ECHILD);
      });
    } finally {
      if (childPid > 0 && getProcessState(childPid) >= 0) {
        removeProcess(childPid);
      }
      kernelWorker.unregisterProcess(parentPid);
    }
  });
});
