import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble, CentralizedKernelWorker
} from "../src/kernel-worker";
import { WASM_PAGE_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const PID = 47;
const KERNEL_TID = 318;
const CHANNEL_OFFSET = WASM_PAGE_SIZE;
const CLONE_ARGS = [0x0021_0100, 0x0080_0000, 0, 0x0090_0000, 0x0004_0000, 0];

interface TestChannel {
  readonly pid: number;
  readonly channelOffset: number;
  readonly memory: WebAssembly.Memory;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling?: boolean;
}

function writeCloneRequest(channel: TestChannel, args: readonly number[]): void {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_DATA, 11, true);
  view.setUint32(CH_DATA + 4, 22, true);
  view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Clone, true);
  for (let index = 0; index < args.length; index++) {
    view.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, BigInt(args[index]!), true);
  }
}

function readCloneCompletion(channel: TestChannel): {
  readonly status: number;
  readonly retVal: number;
  readonly errno: number;
} {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  return {
    status: view.getUint32(CH_STATUS, true),
    retVal: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

function makeCloneHarness(
  onClone: (...args: unknown[]) => Promise<unknown>,
  kernelTid = KERNEL_TID,
  autoAttach = true,
) {
  const memory = new WebAssembly.Memory({
    initial: 16,
    maximum: 16,
    shared: true,
  });
  const channel: TestChannel = {
    pid: PID,
    channelOffset: CHANNEL_OFFSET,
    memory,
    i32View: new Int32Array(memory.buffer, CHANNEL_OFFSET),
    consecutiveSyscalls: 0,
  };

  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernelHandleChannel = vi.fn((offset: number | bigint) => {
    const kernelView = new DataView(kernelMemory.buffer, Number(offset));
    kernelView.setBigInt64(CH_RETURN, BigInt(kernelTid), true);
    kernelView.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const notifyThreadExit = vi.fn(() => 0);
  let worker!: CentralizedKernelWorker;
  worker = createCentralizedKernelWorkerTestDouble({
    callbacks: {
      onClone: (attachment) => {
        if (autoAttach) {
          worker.attachThreadChannel(
            attachment,
            2 * WASM_PAGE_SIZE,
          );
        }
        return onClone(attachment) as Promise<void>;
      },
    },
  });
  Object.assign(worker, {
    currentHandlePid: 0,
    activeChannels: [channel],
    channelTids: new Map<string, number>(),
    execHandoffPids: new Set<number>(),
    hostReaped: new Set<number>(),
    processes: new Map([[PID, {
      pid: PID,
      channels: [channel],
      memory,
      explicitMaxAddr: true,
    }]]),
    threadCtidPtrs: new Map<string, number>(),
    threadForkContexts: new Map<string, { fnPtr: number; argPtr: number }>(),
    usePolling: true,
  });
  installKernelWorkerTestScratch(
    worker as unknown as Record<string, unknown>,
    kernelMemory,
    128,
    4,
    {
      kernelExports: {
        kernel_drain_wakeup_events: vi.fn(() => 0),
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_get_process_state: vi.fn(() => 0),
        kernel_handle_channel: kernelHandleChannel,
        kernel_set_current_tid: vi.fn(() => 0),
        kernel_thread_exit: notifyThreadExit,
        kernel_validate_task: vi.fn(() => 0),
      },
    },
  );

  return {
    channel,
    dispatch(args: readonly number[] = CLONE_ARGS) {
      writeCloneRequest(channel, args);
      (worker as any).handleSyscall(channel);
    },
    kernelHandleChannel,
    notifyThreadExit,
    worker,
  };
}

function makeChannelOwnershipHarness() {
  const memory = new WebAssembly.Memory({
    initial: 16,
    maximum: 16,
    shared: true,
  });
  const mainChannelOffset = WASM_PAGE_SIZE;
  const mainChannel: TestChannel = {
    pid: PID,
    channelOffset: mainChannelOffset,
    memory,
    i32View: new Int32Array(memory.buffer, mainChannelOffset),
    consecutiveSyscalls: 0,
  };
  const validateTask = vi.fn(() => 0);
  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  let nextKernelTid = 0;
  let receiveAttachment:
    | ((
        attachment: Parameters<
          CentralizedKernelWorker["attachThreadChannel"]
        >[0],
      ) => Promise<void>)
    | undefined;
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: {
      onClone: (attachment) => {
        if (!receiveAttachment) {
          throw new Error("clone attachment receiver is not armed");
        }
        return receiveAttachment(attachment);
      },
    },
  });
  Object.assign(worker, {
    currentHandlePid: 0,
    activeChannels: [mainChannel],
    channelTids: new Map<string, number>(),
    execHandoffPids: new Set<number>(),
    hostReaped: new Set<number>(),
    processes: new Map([
      [PID, {
        pid: PID,
        memory,
        channels: [mainChannel],
        explicitMaxAddr: true,
      }],
    ]),
    threadCtidPtrs: new Map<string, number>(),
    threadForkContexts: new Map<string, { fnPtr: number; argPtr: number }>(),
    usePolling: true,
  });
  installKernelWorkerTestScratch(
    worker as unknown as Record<string, unknown>,
    kernelMemory,
    128,
    4,
    {
      kernelExports: {
        kernel_drain_wakeup_events: vi.fn(() => 0),
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_get_process_state: vi.fn(() => 0),
        kernel_handle_channel: vi.fn((offset: number | bigint) => {
          const kernelView = new DataView(kernelMemory.buffer, Number(offset));
          kernelView.setBigInt64(CH_RETURN, BigInt(nextKernelTid), true);
          kernelView.setUint32(CH_ERRNO, 0, true);
          return 0;
        }),
        kernel_set_current_tid: vi.fn(() => 0),
        kernel_thread_exit: vi.fn(() => 0),
        kernel_validate_task: validateTask,
      },
    },
  );

  return {
    mainChannel,
    memory,
    validateTask,
    worker,
    async issueThreadAttachment(tid: number, fnPtr = 11, argPtr = 22) {
      let attachment:
        | Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0]
        | undefined;
      nextKernelTid = tid;
      receiveAttachment = (
        value: Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0],
      ) => {
        attachment = value;
        return new Promise<void>(() => {});
      };
      writeCloneRequest(
        mainChannel,
        [0, 0x0080_0000, 0, 0x0090_0000, 0, 0],
      );
      const processView = new DataView(memory.buffer, mainChannelOffset);
      processView.setUint32(CH_DATA, fnPtr, true);
      processView.setUint32(CH_DATA + 4, argPtr, true);
      (worker as any).handleSyscall(mainChannel);
      await flushCloneContinuation();
      if (!attachment) throw new Error("clone callback did not receive attachment");
      return attachment;
    },
  };
}

async function flushCloneContinuation(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
}

function expectIngressFailureCause(
  operation: () => void,
  expectedMessage: string,
): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const cause = (failure as Error & { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain(expectedMessage);
}

describe("kernel TID authority", () => {
  it("rejects invalid parent/child TID pointers before Rust allocates a task", () => {
    const onClone = vi.fn(async () => {});
    const first = makeCloneHarness(onClone);
    const invalidPtr = first.channel.memory.buffer.byteLength - 2;
    const parentArgs = [
      CLONE_ARGS[0] | 0x0010_0000,
      CLONE_ARGS[1],
      invalidPtr,
      CLONE_ARGS[3],
      CLONE_ARGS[4],
      0,
    ];

    first.dispatch(parentArgs);
    expect(first.kernelHandleChannel).not.toHaveBeenCalled();
    expect(readCloneCompletion(first.channel)).toEqual({
      status: CHANNEL_STATUS_COMPLETE,
      retVal: -1,
      errno: 14,
    });

    const second = makeCloneHarness(onClone);
    const childArgs = [...CLONE_ARGS];
    childArgs[4] = invalidPtr;
    second.dispatch(childArgs);
    expect(second.kernelHandleChannel).not.toHaveBeenCalled();
    expect(readCloneCompletion(second.channel)).toEqual({
      status: CHANNEL_STATUS_COMPLETE,
      retVal: -1,
      errno: 14,
    });
    expect(onClone).not.toHaveBeenCalled();
  });

  it("rolls back the exact Rust TID when the clone callback throws synchronously", async () => {
    const launchError = new Error("synchronous worker construction failed");
    const onClone = vi.fn(() => {
      throw launchError;
    });
    const harness = makeCloneHarness(onClone);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // A synchronous constructor failure is an asynchronous clone-transaction
      // failure at the mailbox boundary; it must roll back and complete the
      // caller rather than escape the worker listener.
      expect(() => harness.dispatch()).not.toThrow();
      await flushCloneContinuation();

      expect(harness.notifyThreadExit).toHaveBeenCalledOnce();
      expect(harness.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID);
      expect(readCloneCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: 12,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not track an unflagged child-TID pointer as clear-on-exit state", async () => {
    const onClone = vi.fn(async () => {});
    const harness = makeCloneHarness(onClone);
    const args = [...CLONE_ARGS];
    args[0] &= ~0x0020_0000;

    harness.dispatch(args);
    await flushCloneContinuation();

    expect(onClone.mock.calls[0][0]).toMatchObject({ ctidPtr: 0 });
    expect((harness.worker as any).threadCtidPtrs.size).toBe(0);
  });

  it("rejects zero before a host callback can attach an unallocated task", () => {
    const onClone = vi.fn(async () => {});
    const harness = makeCloneHarness(onClone, 0);

    harness.dispatch();

    expect(onClone).not.toHaveBeenCalled();
    expect(harness.notifyThreadExit).not.toHaveBeenCalled();
    expect(readCloneCompletion(harness.channel)).toEqual({
      status: CHANNEL_STATUS_COMPLETE,
      retVal: -1,
      errno: 5,
    });
  });

  it("ignores a host callback return value and completes with the Rust-assigned TID", async () => {
    // Deliberately emulate a stale callback that still returns a TID. The
    // current callback type is Promise<void>, and the runtime must likewise
    // ignore any value so the host cannot become an alternate TID authority.
    const onClone = vi.fn(async () => 999);
    const harness = makeCloneHarness(onClone);

    harness.dispatch();
    await flushCloneContinuation();

    expect(onClone).toHaveBeenCalledWith(expect.objectContaining({
      pid: PID,
      tid: KERNEL_TID,
      fnPtr: 11,
      argPtr: 22,
      stackPtr: CLONE_ARGS[1],
      tlsPtr: CLONE_ARGS[3],
      ctidPtr: CLONE_ARGS[4],
      memory: harness.channel.memory,
    }));
    expect(readCloneCompletion(harness.channel)).toEqual({
      status: CHANNEL_STATUS_COMPLETE,
      retVal: KERNEL_TID,
      errno: 0,
    });
  });

  it("rolls back the exact Rust-assigned TID when host thread launch fails", async () => {
    const onClone = vi.fn(async () => {
      throw new Error("worker launch failed");
    });
    const harness = makeCloneHarness(onClone);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      harness.dispatch();
      await flushCloneContinuation();

      expect(harness.notifyThreadExit).toHaveBeenCalledOnce();
      expect(harness.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID);
      expect(readCloneCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: 12,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not complete clone when the callback fails to consume its attachment", async () => {
    const onClone = vi.fn(async () => {});
    const harness = makeCloneHarness(onClone, KERNEL_TID, false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      harness.dispatch();
      await flushCloneContinuation();

      expect(harness.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID);
      expect(readCloneCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: 12,
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("thread channel ownership", () => {
  const firstThreadOffset = 2 * WASM_PAGE_SIZE;
  const secondThreadOffset = 3 * WASM_PAGE_SIZE;
  const thirdThreadOffset = 4 * WASM_PAGE_SIZE;

  it("rejects a duplicate channel offset instead of remapping its TID", async () => {
    const { issueThreadAttachment, validateTask, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      await issueThreadAttachment(KERNEL_TID),
      firstThreadOffset,
    );
    const duplicateOffsetAttachment =
      await issueThreadAttachment(KERNEL_TID + 1);

    expectIngressFailureCause(
      () => worker.attachThreadChannel(
        duplicateOffsetAttachment,
        firstThreadOffset,
      ),
      `Channel offset ${firstThreadOffset} for process ${PID} is already registered`,
    );

    expect(validateTask).toHaveBeenCalledTimes(1);
    expect((worker as any).processes.get(PID).channels).toHaveLength(2);
    expect((worker as any).channelTids.get(`${PID}:${firstThreadOffset}`))
      .toBe(KERNEL_TID);
    expect((worker as any).threadForkContexts.get(`${PID}:${firstThreadOffset}`))
      .toEqual({ fnPtr: 11, argPtr: 22 });
  });

  it("rejects assigning one kernel TID to a second channel", async () => {
    const { issueThreadAttachment, validateTask, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      await issueThreadAttachment(KERNEL_TID),
      firstThreadOffset,
    );
    const duplicateTidAttachment = await issueThreadAttachment(KERNEL_TID);

    expectIngressFailureCause(
      () => worker.attachThreadChannel(
        duplicateTidAttachment,
        secondThreadOffset,
      ),
      `Kernel TID ${KERNEL_TID} is already attached to channel ${PID}:${firstThreadOffset}`,
    );

    expect(validateTask).toHaveBeenNthCalledWith(2, PID, KERNEL_TID);
    expect((worker as any).processes.get(PID).channels).toHaveLength(2);
    expect((worker as any).activeChannels).toHaveLength(2);
    expect((worker as any).channelTids.has(`${PID}:${secondThreadOffset}`))
      .toBe(false);
  });

  it("rejects a wrong-but-valid sibling TID for another clone channel", async () => {
    const siblingTid = KERNEL_TID + 1;
    const { issueThreadAttachment, validateTask, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      await issueThreadAttachment(KERNEL_TID),
      firstThreadOffset,
    );
    worker.attachThreadChannel(
      await issueThreadAttachment(siblingTid),
      secondThreadOffset,
    );
    const duplicateSiblingAttachment =
      await issueThreadAttachment(siblingTid);

    expectIngressFailureCause(
      () => worker.attachThreadChannel(
        duplicateSiblingAttachment,
        thirdThreadOffset,
      ),
      `Kernel TID ${siblingTid} is already attached to channel ${PID}:${secondThreadOffset}`,
    );

    expect(validateTask).toHaveBeenLastCalledWith(PID, siblingTid);
    expect(validateTask).toHaveBeenCalledTimes(3);
    expect((worker as any).processes.get(PID).channels).toHaveLength(3);
    expect((worker as any).channelTids.has(`${PID}:${thirdThreadOffset}`))
      .toBe(false);
  });

  it("keeps concurrent pending TIDs bound to uncopyable one-shot attachments", async () => {
    const siblingTid = KERNEL_TID + 1;
    const { issueThreadAttachment, worker } = makeChannelOwnershipHarness();
    const first = await issueThreadAttachment(KERNEL_TID);
    const sibling = await issueThreadAttachment(siblingTid, 33, 44);

    worker.attachThreadChannel(first, firstThreadOffset);
    worker.attachThreadChannel(sibling, secondThreadOffset);

    expect((worker as any).channelTids.get(`${PID}:${firstThreadOffset}`))
      .toBe(KERNEL_TID);
    expect((worker as any).channelTids.get(`${PID}:${secondThreadOffset}`))
      .toBe(siblingTid);
    expect((worker as any).threadForkContexts.get(`${PID}:${secondThreadOffset}`))
      .toEqual({ fnPtr: 33, argPtr: 44 });
    expect((worker as any).addChannel).toBeUndefined();

    // A failed public ingress poisons this deliberately conservative test
    // generation, so make the one-shot replay assertion the final operation.
    expectIngressFailureCause(
      () => worker.attachThreadChannel(first, thirdThreadOffset),
      "Unknown, expired, or already consumed thread attachment",
    );
  });

  it("rejects a copied attachment with substituted identity", async () => {
    const { issueThreadAttachment, worker } = makeChannelOwnershipHarness();
    const attachment = await issueThreadAttachment(KERNEL_TID);
    const forged = Object.freeze({
      ...attachment,
      tid: KERNEL_TID + 1,
    }) as typeof attachment;

    expectIngressFailureCause(
      () => worker.attachThreadChannel(forged, firstThreadOffset),
      "Unknown, expired, or already consumed thread attachment",
    );
    expect((worker as any).channelTids.size).toBe(0);
    expect((worker as any).threadForkContexts.size).toBe(0);
  });

  it("releases channel ownership on removal so a later clone can reuse the slot", async () => {
    const replacementTid = KERNEL_TID + 1;
    const { issueThreadAttachment, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      await issueThreadAttachment(KERNEL_TID, 11, 22),
      firstThreadOffset,
    );

    worker.removeChannel(PID, firstThreadOffset);

    expect((worker as any).channelTids.has(`${PID}:${firstThreadOffset}`))
      .toBe(false);
    expect((worker as any).threadForkContexts.has(`${PID}:${firstThreadOffset}`))
      .toBe(false);

    worker.attachThreadChannel(
      await issueThreadAttachment(replacementTid, 33, 44),
      firstThreadOffset,
    );
    expect((worker as any).channelTids.get(`${PID}:${firstThreadOffset}`))
      .toBe(replacementTid);
    expect((worker as any).threadForkContexts.get(`${PID}:${firstThreadOffset}`))
      .toEqual({ fnPtr: 33, argPtr: 44 });
  });
});
