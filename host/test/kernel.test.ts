import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { CH_TOTAL_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
  KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
  KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
  KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
  STRUCT_SIZE_KERNEL_WAIT_RESULT,
  WAIT_CLD_KILLED,
} from "../src/generated/abi";
import { NodePlatformIO } from "../src/platform/node";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

type CapacityProbeDestination = "null" | "guarded";

interface RegisteredChannelWitness {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
}

interface CapacityProbeResult {
  readonly result: number;
  readonly guardedBytes: Uint8Array;
}

interface MqueueNotificationCapacityProbeOptions {
  readonly registrationWitness: RegisteredChannelWitness;
  readonly descriptor: number;
  readonly triggerNotification: boolean;
  readonly destination: CapacityProbeDestination;
  readonly capacity: number;
}

interface WaitableChildCapacityProbeOptions {
  readonly registrationWitness: RegisteredChannelWitness;
  readonly childPid: number;
  readonly destination: CapacityProbeDestination;
  readonly capacity: number;
}

interface CapacityProbeAuthority {
  probeMqueueNotificationCapacityForTest(
    options: MqueueNotificationCapacityProbeOptions,
  ): CapacityProbeResult;
  probeWaitableChildCapacityForTest(
    options: WaitableChildCapacityProbeOptions,
  ): CapacityProbeResult;
}

function capacityProbeAuthority(
  worker: ReturnType<typeof createCentralizedKernelWorkerTestDouble>,
): CapacityProbeAuthority {
  return worker.testAuthority as unknown as CapacityProbeAuthority;
}

function writeChannelSyscall(
  channel: RegisteredChannelWitness,
  syscallNr: number,
  args: readonly (number | bigint)[],
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, syscallNr, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
}

async function createRealKernelHarness() {
  const wasmBytes = readFileSync(resolveBinary("kernel.wasm"));
  const worker = createCentralizedKernelWorkerTestDouble({
    config: {
      maxWorkers: 4,
      dataBufferSize: 65536,
      useSharedMemory: true,
    },
    io: new NodePlatformIO(),
  });
  await worker.init(
    wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ),
  );

  const processMemory = new WebAssembly.Memory({
    initial: 3,
    maximum: 3,
    shared: true,
  });
  const pid = worker.createProcess(CAPTURED_STDIO);
  const [registeredChannel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory: processMemory,
      channelOffsets: [65536],
      pointerWidth: 4,
    });
  const channel = registeredChannel as RegisteredChannelWitness;
  let completion: { value: number; errno: number } | undefined;
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel: (
      _channel,
      _syscallNr,
      _origArgs,
      _argDescs,
      value,
      errno,
    ) => {
      completion = { value, errno };
    },
  });

  return {
    channel,
    issue(
      syscallNr: number,
      args: readonly (number | bigint)[],
    ): { value: number; errno: number } {
      completion = undefined;
      writeChannelSyscall(channel, syscallNr, args);
      worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
      if (completion === undefined) {
        throw new Error(`syscall ${syscallNr} did not complete synchronously`);
      }
      return completion;
    },
    pid,
    processMemory,
    worker,
  };
}

function expectUntouchedCanaries(
  probe: CapacityProbeResult,
  payloadBytes: number,
): void {
  expect(probe.guardedBytes).toEqual(
    new Uint8Array(payloadBytes + 2).fill(0xa5),
  );
}

function observedOptions<T extends object>(
  values: T,
  reads: ReturnType<typeof vi.fn>,
): T {
  return new Proxy(values, {
    get(target, property, receiver) {
      reads(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
}

function createCapacityProbeContractHarness() {
  const kernelMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
  const processMemory = new WebAssembly.Memory({
    initial: 3,
    maximum: 3,
    shared: true,
  });
  const mqueueProbeExport = vi.fn(() => 0);
  const waitableChildProbeExport = vi.fn(() => 0);
  let duringKernelHandle = (): void => {};
  const kernelHandle = vi.fn((pointer: number | bigint) => {
    duringKernelHandle();
    const channel = new DataView(kernelMemory.buffer, Number(pointer));
    channel.setBigInt64(CH_RETURN, 0n, true);
    channel.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const worker = createCentralizedKernelWorkerTestDouble();
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    4,
    {
      kernelExportNames: [
        "kernel_dequeue_signal",
        "kernel_get_process_exit_signal",
        "kernel_handle_channel",
        "kernel_mq_drain_notification",
        "kernel_set_current_tid",
        "kernel_wait_child_poll",
      ],
      kernelExports: {
        kernel_dequeue_signal: vi.fn(() => 0),
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_handle_channel: kernelHandle,
        kernel_mq_drain_notification: mqueueProbeExport,
        kernel_set_current_tid: vi.fn(() => 0),
        kernel_wait_child_poll: waitableChildProbeExport,
      },
    },
  );
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel: () => undefined,
  });
  const [registeredChannel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 42,
      memory: processMemory,
      channelOffsets: [0],
      pointerWidth: 4,
    });
  const channel = registeredChannel as RegisteredChannelWitness;

  return {
    authority: capacityProbeAuthority(worker),
    channel,
    dispatchOuterSyscall(): void {
      writeChannelSyscall(channel, ABI_SYSCALLS.Getpid, []);
      worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    },
    kernelHandle,
    mqueueProbeExport,
    processMemory,
    replaceRegistration(): RegisteredChannelWitness {
      const [replacement] =
        worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
          pid: channel.pid,
          memory: processMemory,
          channelOffsets: [CH_TOTAL_SIZE],
          pointerWidth: 4,
        });
      return replacement as RegisteredChannelWitness;
    },
    runDuringKernelHandle(operation: () => void): void {
      duringKernelHandle = operation;
    },
    waitableChildProbeExport,
  };
}

describe("CentralizedKernelWorker", () => {
  it("drains queued PTY output when a listener registers", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const queued = [
      encoder.encode("spidermonkey-node$ "),
      encoder.encode("ready\n"),
    ];
    const received: string[] = [];
    const kernelMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
    });
    const kernelWorker = createCentralizedKernelWorkerTestDouble();
    installKernelWorkerTestScratch(
      kernelWorker,
      kernelMemory,
      128,
      4,
      {
        kernelExports: {
          kernel_pty_master_read: (
            _ptyIdx: number,
            pointer: number,
            capacity: number,
          ) => {
            const data = queued.shift();
            if (data === undefined) return 0;
            expect(data.byteLength).toBeLessThanOrEqual(capacity);
            new Uint8Array(kernelMemory.buffer).set(data, pointer);
            return data.byteLength;
          },
        },
      },
    );

    kernelWorker.onPtyOutput(3, (data) => {
      received.push(decoder.decode(data));
    });

    // Each detached callback queues a fresh entry for the next chunk so no
    // scratch-bearing scope survives the observer boundary.
    for (let index = 0; index < 4; index++) await Promise.resolve();
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
    const harness = await createRealKernelHarness();
    const authority = capacityProbeAuthority(harness.worker);

    try {
      const queueNamePointer = 1024;
      const eventPointer = 2048;
      const queueName = new TextEncoder().encode(
        `/kernel-mq-drain-capacity-${harness.pid}\0`,
      );
      new Uint8Array(
        harness.processMemory.buffer,
        queueNamePointer,
        queueName.byteLength,
      ).set(queueName);
      const opened = harness.issue(ABI_SYSCALLS.MqOpen, [
        queueNamePointer,
        0o302, // O_RDWR | O_CREAT | O_EXCL
        0o600,
        0,
        0,
        4,
      ]);
      expect(opened.errno).toBe(0);
      expect(opened.value).toBeGreaterThanOrEqual(0x4000_0000);

      const event = new DataView(
        harness.processMemory.buffer,
        eventPointer,
        64,
      );
      event.setUint32(0, 0x89ab_cdef, true);
      event.setInt32(4, 10, true);
      event.setInt32(8, 0, true); // SIGEV_SIGNAL
      const notified = harness.issue(ABI_SYSCALLS.MqNotify, [
        opened.value,
        eventPointer,
        0,
        0,
        0,
        4,
      ]);
      expect(notified).toEqual({ value: 0, errno: 0 });

      expect(KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES).toBe(8);
      const nullDestination =
        authority.probeMqueueNotificationCapacityForTest({
          registrationWitness: harness.channel,
          descriptor: opened.value,
          triggerNotification: true,
          destination: "null",
          capacity: KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
        });
      expect(nullDestination.result).toBe(-14); // EFAULT
      expectUntouchedCanaries(
        nullDestination,
        KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
      );

      for (const capacity of [
        KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES - 1,
        KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES + 1,
      ]) {
        const rejected = authority.probeMqueueNotificationCapacityForTest({
          registrationWitness: harness.channel,
          descriptor: opened.value,
          triggerNotification: false,
          destination: "guarded",
          capacity,
        });
        expect(rejected.result).toBe(-22); // EINVAL
        expectUntouchedCanaries(
          rejected,
          KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
        );
      }

      const accepted = authority.probeMqueueNotificationCapacityForTest({
        registrationWitness: harness.channel,
        descriptor: opened.value,
        triggerNotification: false,
        destination: "guarded",
        capacity: KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
      });
      expect(accepted.result).toBe(1);
      expect(accepted.guardedBytes[0]).toBe(0xa5);
      expect(accepted.guardedBytes.at(-1)).toBe(0xa5);
      const notification = new DataView(
        accepted.guardedBytes.buffer,
        accepted.guardedBytes.byteOffset + 1,
        KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
      );
      expect(notification.getUint32(0, true)).toBe(harness.pid);
      expect(notification.getUint32(4, true)).toBe(10);
    } finally {
      harness.worker.unregisterProcess(harness.pid);
    }
  });

  it("preserves a waitable child until an exact-capacity result consumes it", async () => {
    const ECHILD = 10;
    const EFAULT = 14;
    const EINVAL = 22;
    const SIGTERM = 15;
    const harness = await createRealKernelHarness();
    const authority = capacityProbeAuthority(harness.worker);
    let childPid = 0;

    try {
      childPid =
        harness.worker.testAuthority.forkKernelProcessForAdvisoryLockTest(
          harness.pid,
          harness.pid,
        );
      expect(childPid).toBeGreaterThan(0);
      harness.worker.testAuthority.sendSignalForTest(childPid, SIGTERM);

      const nullDestination =
        authority.probeWaitableChildCapacityForTest({
          registrationWitness: harness.channel,
          childPid,
          destination: "null",
          capacity: STRUCT_SIZE_KERNEL_WAIT_RESULT,
        });
      expect(nullDestination.result).toBe(-EFAULT);
      expectUntouchedCanaries(
        nullDestination,
        STRUCT_SIZE_KERNEL_WAIT_RESULT,
      );

      for (const capacity of [
        STRUCT_SIZE_KERNEL_WAIT_RESULT - 1,
        STRUCT_SIZE_KERNEL_WAIT_RESULT + 1,
      ]) {
        const rejected = authority.probeWaitableChildCapacityForTest({
          registrationWitness: harness.channel,
          childPid,
          destination: "guarded",
          capacity,
        });
        expect(rejected.result).toBe(-EINVAL);
        expectUntouchedCanaries(
          rejected,
          STRUCT_SIZE_KERNEL_WAIT_RESULT,
        );
      }

      // WHY: the exact call returning this same child proves that none of the
      // rejected destinations selected or consumed its sole wait record.
      const accepted = authority.probeWaitableChildCapacityForTest({
        registrationWitness: harness.channel,
        childPid,
        destination: "guarded",
        capacity: STRUCT_SIZE_KERNEL_WAIT_RESULT,
      });
      expect(accepted.result).toBe(childPid);
      expect(accepted.guardedBytes[0]).toBe(0xa5);
      expect(accepted.guardedBytes.at(-1)).toBe(0xa5);
      const result = new DataView(
        accepted.guardedBytes.buffer,
        accepted.guardedBytes.byteOffset + 1,
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

      const consumed = authority.probeWaitableChildCapacityForTest({
        registrationWitness: harness.channel,
        childPid,
        destination: "guarded",
        capacity: STRUCT_SIZE_KERNEL_WAIT_RESULT,
      });
      expect(consumed.result).toBe(-ECHILD);
      expectUntouchedCanaries(consumed, STRUCT_SIZE_KERNEL_WAIT_RESULT);
    } finally {
      harness.worker.unregisterProcess(harness.pid);
    }
  });

  it("rejects busy capacity probes without reading or replaying their options", async () => {
    const harness = createCapacityProbeContractHarness();
    const mqueueReads = vi.fn();
    const waitReads = vi.fn();
    const mqueueOptions = observedOptions({
      registrationWitness: harness.channel,
      descriptor: 7,
      triggerNotification: false,
      destination: "guarded" as const,
      capacity: KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
    }, mqueueReads);
    const waitOptions = observedOptions({
      registrationWitness: harness.channel,
      childPid: 43,
      destination: "guarded" as const,
      capacity: STRUCT_SIZE_KERNEL_WAIT_RESULT,
    }, waitReads);
    const errors: unknown[] = [];
    harness.runDuringKernelHandle(() => {
      for (const probe of [
        () => harness.authority
          .probeMqueueNotificationCapacityForTest(mqueueOptions),
        () => harness.authority
          .probeWaitableChildCapacityForTest(waitOptions),
      ]) {
        try {
          probe();
        } catch (error) {
          errors.push(error);
        }
      }
    });

    harness.dispatchOuterSyscall();

    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/active|busy|cannot run/i);
    }
    expect(mqueueReads).not.toHaveBeenCalled();
    expect(waitReads).not.toHaveBeenCalled();
    expect(harness.mqueueProbeExport).not.toHaveBeenCalled();
    expect(harness.waitableChildProbeExport).not.toHaveBeenCalled();

    // A rejected immediate probe must not remain queued behind the outer
    // kernel export and read or execute after that exact scope is revoked.
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(mqueueReads).not.toHaveBeenCalled();
    expect(waitReads).not.toHaveBeenCalled();
    expect(harness.mqueueProbeExport).not.toHaveBeenCalled();
    expect(harness.waitableChildProbeExport).not.toHaveBeenCalled();
    expect(harness.kernelHandle).toHaveBeenCalledOnce();
  });

  it("rejects stale registered-channel witnesses before either capacity export", () => {
    const harness = createCapacityProbeContractHarness();
    const staleWitness = harness.channel;
    harness.replaceRegistration();

    expect(() => {
      harness.authority.probeMqueueNotificationCapacityForTest({
        registrationWitness: staleWitness,
        descriptor: 7,
        triggerNotification: false,
        destination: "guarded",
        capacity: KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES,
      });
    }).toThrow(TypeError);
    expect(() => {
      harness.authority.probeWaitableChildCapacityForTest({
        registrationWitness: staleWitness,
        childPid: 43,
        destination: "guarded",
        capacity: STRUCT_SIZE_KERNEL_WAIT_RESULT,
      });
    }).toThrow(TypeError);
    expect(harness.mqueueProbeExport).not.toHaveBeenCalled();
    expect(harness.waitableChildProbeExport).not.toHaveBeenCalled();
  });
});
