import { describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

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
import { installKernelWorkerTestScratch, emptyProcessTimerCleanup } from "./kernel-worker-test-scratch";
import { ProcessMemoryCreatorGate } from "../src/process-memory-creator-gate";

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
  beforeAttach?: () => void,
  pointerWidth: 4 | 8 = 4,
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
  const onExit = vi.fn();
  const markProcessSignaled = vi.fn(() => 0);
  let execGeneration = 0n;
  const getExecGeneration = vi.fn((_pid: number, pointer: number | bigint) => {
    new DataView(kernelMemory.buffer).setBigUint64(Number(pointer), execGeneration, true);
    return 8;
  });
  let worker!: CentralizedKernelWorker;
  worker = createCentralizedKernelWorkerTestDouble({
    callbacks: {
      onExit,
      onClone: (attachment) => {
        if (autoAttach) {
          beforeAttach?.();
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
      execGeneration: 0n,
      channels: [channel],
      memory,
      ptrWidth: pointerWidth,
      explicitMaxAddr: true,
    }]]),
    threadForkContexts: new Map<string, { fnPtr: number; argPtr: number }>(),
    usePolling: true,
  });
  installKernelWorkerTestScratch(
    worker as unknown as Record<string, unknown>,
    kernelMemory,
    128,
    pointerWidth,
    {
      kernelExports: {
        kernel_drain_wakeup_events: vi.fn(() => 0),
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_get_process_state: vi.fn(() => 0),
        kernel_get_process_exec_generation: getExecGeneration,
        kernel_get_parent_pid: vi.fn(() => 1),
        kernel_mark_process_signaled: markProcessSignaled,
        kernel_publish_process_exit: vi.fn(() => 0),
        kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(kernelMemory),
        kernel_handle_channel: kernelHandleChannel,
        kernel_set_current_tid: vi.fn(() => 0),
        kernel_thread_exit: notifyThreadExit,
        kernel_validate_task: vi.fn(() => 0),
      },
    },
  );

  return {
    channel,
    setGeneration(value: bigint) { execGeneration = value; },
    setKernelTid(value: number) { kernelTid = value; },
    dispatch(args: readonly number[] = CLONE_ARGS) {
      writeCloneRequest(channel, args);
      (worker as any).handleSyscall(channel);
    },
    kernelHandleChannel,
    notifyThreadExit,
    onExit,
    markProcessSignaled,
    getExecGeneration,
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
  let execGeneration = 0n;
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
        execGeneration: 0n,
        memory,
        channels: [mainChannel],
        explicitMaxAddr: true,
      }],
    ]),
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
        kernel_get_process_exec_generation: (_pid: number, pointer: number | bigint) => {
          new DataView(kernelMemory.buffer).setBigUint64(Number(pointer), execGeneration, true);
          return 8;
        },
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
    setGeneration(value: bigint) { execGeneration = value; },
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
      expect(harness.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID, 0);
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
    const onClone = vi.fn(async (_attachment: unknown) => {});
    const harness = makeCloneHarness(onClone);
    const args = [...CLONE_ARGS];
    args[0] &= ~0x0020_0000;

    harness.dispatch(args);
    await flushCloneContinuation();

    expect(onClone.mock.calls[0][0]).toMatchObject({ ctidPtr: 0 });
    expect(harness.notifyThreadExit).not.toHaveBeenCalled();
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
      expect(harness.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID, 0);
      expect(readCloneCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: 12,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rolls back the actual allocated task after controlled stale-generation launch refusal", async () => {
    const onClone = vi.fn(async () => {});
    let h!: ReturnType<typeof makeCloneHarness>;
    h = makeCloneHarness(onClone, KERNEL_TID, true, () => h.setGeneration(1n));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch();
      await flushCloneContinuation();
      expect(onClone).not.toHaveBeenCalled();
      expect(h.notifyThreadExit).toHaveBeenCalledTimes(1);
      expect(h.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID, 0);
      // Rust already committed another image. Its old mailbox is no longer
      // ours to complete, even while host registration is catching up.
      expect(readCloneCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
      expect((h.worker as any).processes.get(PID).channels).toEqual([h.channel]);
      expect((h.worker as any).activeChannels).toEqual([h.channel]);
      expect((h.worker as any).channelTids.size).toBe(0);
      expect((h.worker as any).threadForkContexts.size).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("changed exec generation"));
    } finally { consoleError.mockRestore(); }
  });

  it("does not complete clone when the callback fails to consume its attachment", async () => {
    const onClone = vi.fn(async () => {});
    const harness = makeCloneHarness(onClone, KERNEL_TID, false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      harness.dispatch();
      await flushCloneContinuation();

      expect(harness.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID, 0);
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

  it("refuses the exec commit window before attaching a stale generation's channel", async () => {
    const h = makeChannelOwnershipHarness();
    const attachment = await h.issueThreadAttachment(KERNEL_TID);
    const original = (h.worker as any).processes.get(PID);
    h.setGeneration(1n); // Rust committed; the old host registration still occupies this PID.
    expect(() => h.worker.attachThreadChannel(attachment, firstThreadOffset))
      .toThrow(`Process ${PID} changed exec generation`);
    expect(h.validateTask).not.toHaveBeenCalled();
    expect(original.execGeneration).toBe(0n);
    expect(original.channels).toEqual([h.mainChannel]);
    expect((h.worker as any).activeChannels).toEqual([h.mainChannel]);
    expect((h.worker as any).threadForkContexts.size).toBe(0);
    // A refused attempt consumes its exact attachment; it cannot later be
    // redirected after the apparent generation mismatch is removed.
    h.setGeneration(0n);
    expectIngressFailureCause(() => h.worker.attachThreadChannel(attachment, firstThreadOffset),
      "Unknown, expired, or already consumed thread attachment");
  });

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


describe("clone teardown ownership", () => {
  const parentTidPointer = 0x6000;
  const cloneArgs = () => [
    CLONE_ARGS[0] | 0x0010_0000, CLONE_ARGS[1], parentTidPointer,
    CLONE_ARGS[3], CLONE_ARGS[4], 0,
  ];
  const cases = [["wasm32", 4], ["wasm64", 8]] as const;
  type Attachment = Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0];
  const parentTid = (h: ReturnType<typeof makeCloneHarness>) =>
    new DataView(h.channel.memory.buffer).getInt32(parentTidPointer, true);
  const wakeOriginal = (h: ReturnType<typeof makeCloneHarness>) =>
    (h.worker as any).completeChannelRaw(h.channel, -1, 4);

  it.each(cases)("%s rolls back before treating closed admission as terminal refusal", async (_name, width) => {
    const creators = new ProcessMemoryCreatorGate();
    await creators.closeAndWait();
    const creator = vi.fn(async () => {});
    // Both entry adapters use exactly this shared gate/handleClone wrapper.
    const h = makeCloneHarness(() => creators.run("a pthread Worker", creator), KERNEL_TID, false, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs());
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(h.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID, 0);
      expect(creator).not.toHaveBeenCalled();
      expect(parentTid(h)).toBe(0);
      expect(readCloneCompletion(h.channel)).toEqual({status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: 12});
      expect(consoleError).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s retires the allocation if teardown wins before the detached launch", async (_name, width) => {
    const onClone = vi.fn(async () => {});
    const h = makeCloneHarness(onClone, KERNEL_TID, false, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs());
      wakeOriginal(h);
      const terminal = readCloneCompletion(h.channel);
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(onClone).not.toHaveBeenCalled();
      expect(parentTid(h)).toBe(0);
      expect(readCloneCompletion(h.channel)).toEqual(terminal);
      expect(consoleError).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s rolls back a failed launch after its original channel already completed", async (_name, width) => {
    const launch = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let attachment!: Attachment;
    const h = makeCloneHarness(async (raw) => {
      attachment = raw as Attachment; started.resolve(); return launch.promise;
    }, KERNEL_TID, true, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await started.promise;
      wakeOriginal(h); const terminal = readCloneCompletion(h.channel);
      launch.reject(new Error("real Worker construction failed"));
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(readCloneCompletion(h.channel)).toEqual(terminal);
      expect(parentTid(h)).toBe(0);
      expect((h.worker as any).processes.get(PID).channels).toEqual([h.channel]);
      expect((h.worker as any).threadForkContexts.size).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("real Worker construction failed"));
      expectIngressFailureCause(() => h.worker.attachThreadChannel(attachment, 3 * WASM_PAGE_SIZE), "Unknown, expired, or already consumed thread attachment");
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s preserves a transferred live Worker until cooperative exit after caller wake", async (_name, width) => {
    const launched = Promise.withResolvers<void>();
    const quiescent = Promise.withResolvers<void>();
    const workers = new Map<number, Worker>();
    let thread: Worker | undefined;
    let exit!: Promise<unknown[]>;
    let h!: ReturnType<typeof makeCloneHarness>;
    h = makeCloneHarness(async () => {
      const child = (h.worker as any).processes.get(PID).channels[1];
      // A real disposable realm owns this synthetic guest mailbox. It can
      // acknowledge quiescence only after its actual SYS_EXIT wake arrives;
      // terminating it or rolling back its channel cannot manufacture proof.
      thread = new Worker(`
        const {parentPort, workerData: d} = require("node:worker_threads");
        const view = new DataView(d.memory.buffer, d.offset);
        const status = new Int32Array(d.memory.buffer, d.offset);
        parentPort.on("message", () => {
          view.setUint32(d.syscall, d.exitSyscall, true);
          for (let i=0;i<6;i++) view.setBigInt64(d.args+i*d.argSize, 0n, true);
          Atomics.store(status,d.status/4,d.pending);
          parentPort.postMessage("exit-pending");
          const result = Atomics.wait(status,d.status/4,d.pending,1500);
          parentPort.postMessage(result !== "timed-out" && Atomics.load(status,d.status/4) === d.complete
            ? "memory_quiescent" : "stalled");
          parentPort.close();
        });
        parentPort.postMessage("ready");
      `, {eval: true, workerData: {
        memory: h.channel.memory, offset: child.channelOffset,
        syscall: CH_SYSCALL, exitSyscall: ABI_SYSCALLS.Exit,
        args: CH_ARGS, argSize: CH_ARG_SIZE, status: CH_STATUS,
        pending: CHANNEL_STATUS_PENDING, complete: CHANNEL_STATUS_COMPLETE,
      }});
      workers.set(KERNEL_TID, thread);
      exit = once(thread, "exit");
      thread.on("message", (message) => {
        if (message === "exit-pending") (h.worker as any).handleSyscall(child);
        if (message === "memory_quiescent") quiescent.resolve();
        if (message === "stalled") quiescent.reject(new Error("transferred thread lost its cooperative exit channel"));
      });
      thread.on("exit", () => workers.delete(KERNEL_TID));
      await once(thread, "message");
      wakeOriginal(h); launched.resolve();
    }, KERNEL_TID, true, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await launched.promise;
      const terminal = readCloneCompletion(h.channel);
      thread!.postMessage("exit"); await quiescent.promise; await exit;
      expect(workers.size).toBe(0);
      expect(h.notifyThreadExit).toHaveBeenCalledExactlyOnceWith(PID, KERNEL_TID, 1);
      expect(readCloneCompletion(h.channel)).toEqual(terminal);
      expect(parentTid(h)).toBe(KERNEL_TID); // committed success is not rollback
      expect((h.worker as any).processes.get(PID).channels).toEqual([h.channel]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally { await thread?.terminate(); consoleError.mockRestore(); }
  });

  it.each(cases)("%s leaves transferred custody to exec teardown after Rust image replacement", async (_name, width) => {
    const launch = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const h = makeCloneHarness(async () => {started.resolve(); return launch.promise;}, KERNEL_TID, true, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await started.promise;
      const w = h.worker as any; const child = w.processes.get(PID).channels[1];
      const reads = h.getExecGeneration.mock.calls.length;
      h.setGeneration(1n); launch.resolve();
      await vi.waitFor(() => expect(h.getExecGeneration.mock.calls.length).toBeGreaterThan(reads));
      expect(h.notifyThreadExit).not.toHaveBeenCalled();
      expect(parentTid(h)).toBe(KERNEL_TID);
      expect(readCloneCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
      expect(w.processes.get(PID).channels).toEqual([h.channel, child]);
      // Exec already removed old Rust tasks. Its host generation owner
      // removes the transport after the old Worker relinquishes memory.
      w.removeChannel(PID, child.channelOffset);
      expect(w.processes.get(PID).channels).toEqual([h.channel]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s reports a successful but unattached callback after caller retirement", async (_name, width) => {
    const launch = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const h = makeCloneHarness(async () => {started.resolve(); return launch.promise;}, KERNEL_TID, false, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await started.promise; wakeOriginal(h);
      const terminal = readCloneCompletion(h.channel); launch.resolve();
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(parentTid(h)).toBe(0); expect(readCloneCompletion(h.channel)).toEqual(terminal);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onClone returned without attaching kernel tid"));
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s preserves a replacement parent-TID word while rolling back its own task", async (_name, width) => {
    const launch = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const h = makeCloneHarness(async () => {started.resolve(); return launch.promise;}, KERNEL_TID, true, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await started.promise;
      new DataView(h.channel.memory.buffer).setInt32(parentTidPointer, KERNEL_TID + 1, true);
      launch.reject(new Error("Worker launch failed after parent word replacement"));
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(h.notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID, 0);
      expect(parentTid(h)).toBe(KERNEL_TID + 1);
      expect(readCloneCompletion(h.channel)).toEqual({status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: 12});
      expect(consoleError).toHaveBeenCalledOnce();
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s withdraws exact attached transport before Rust task rollback", async (_name, width) => {
    const h = makeCloneHarness(async () => {throw new Error("launch failed after transport publication");}, KERNEL_TID, true, undefined, width);
    const atRustCleanup: Array<{channel: boolean; tid: boolean; fork: boolean}> = [];
    h.notifyThreadExit.mockImplementation(() => {
      const w = h.worker as any; const key = `${PID}:${2 * WASM_PAGE_SIZE}`;
      atRustCleanup.push({
        channel: w.processes.get(PID).channels.some((c: TestChannel) => c.channelOffset === 2 * WASM_PAGE_SIZE),
        tid: w.channelTids.has(key), fork: w.threadForkContexts.has(key),
      });
      return 0;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs());
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(atRustCleanup).toEqual([{channel: false, tid: false, fork: false}]);
      expect(parentTid(h)).toBe(0);
      expect(readCloneCompletion(h.channel)).toEqual({status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: 12});
      expect(consoleError).toHaveBeenCalledOnce();
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s cannot remove a new pthread reusing the old channel slot", async (_name, width) => {
    const launch = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const h = makeCloneHarness(async () => {started.resolve(); return launch.promise;}, KERNEL_TID, true, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await started.promise;
      const w = h.worker as any; const registration = w.processes.get(PID);
      const prior = registration.channels[1]; const replacement = {...prior};
      registration.channels[1] = replacement;
      w.activeChannels = [h.channel, replacement];
      w.channelTids.set(`${PID}:${prior.channelOffset}`, KERNEL_TID + 1);
      w.threadForkContexts.set(`${PID}:${prior.channelOffset}`, {fnPtr: 71, argPtr: 72});
      launch.reject(new Error("old worker launch failed"));
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(registration.channels).toEqual([h.channel, replacement]);
      expect(w.activeChannels).toEqual([h.channel, replacement]);
      expect(w.channelTids.get(`${PID}:${prior.channelOffset}`)).toBe(KERNEL_TID + 1);
      expect(w.threadForkContexts.get(`${PID}:${prior.channelOffset}`)).toEqual({fnPtr: 71, argPtr: 72});
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s cannot complete or detach a same-PID replacement image", async (_name, width) => {
    const launch = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const h = makeCloneHarness(async () => {started.resolve(); return launch.promise;}, KERNEL_TID, true, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await started.promise;
      const w = h.worker as any;
      const memory = new WebAssembly.Memory({initial: 16, maximum: 16, shared: true});
      const replacement = {...h.channel, memory, i32View: new Int32Array(memory.buffer, h.channel.channelOffset)};
      writeCloneRequest(replacement, cloneArgs());
      const view = new DataView(memory.buffer, replacement.channelOffset);
      view.setBigInt64(CH_RETURN, 987n, true); view.setUint32(CH_ERRNO, 77, true);
      new DataView(memory.buffer).setInt32(parentTidPointer, KERNEL_TID + 1, true);
      const registration = {pid: PID, memory, channels: [replacement], ptrWidth: width, explicitMaxAddr: true};
      w.processes.set(PID, registration); w.activeChannels = [replacement]; h.setGeneration(1n);
      launch.reject(new Error("old image launch failed"));
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(w.processes.get(PID)).toBe(registration); expect(w.activeChannels).toEqual([replacement]);
      expect(readCloneCompletion(replacement)).toEqual({status: CHANNEL_STATUS_PENDING, retVal: 987, errno: 77});
      expect(new DataView(memory.buffer).getInt32(parentTidPointer, true)).toBe(KERNEL_TID + 1);
      expect(parentTid(h)).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("old image launch failed"));
    } finally { consoleError.mockRestore(); }
  });

  it.each(cases)("%s keeps a later identical clone pending when the old launch rejects", async (_name, width) => {
    const oldLaunch = Promise.withResolvers<void>(); const newLaunch = Promise.withResolvers<void>();
    const oldStarted = Promise.withResolvers<void>(); const newStarted = Promise.withResolvers<void>();
    let h!: ReturnType<typeof makeCloneHarness>;
    h = makeCloneHarness(async (raw) => {
      const attachment = raw as Attachment;
      h.worker.attachThreadChannel(attachment, (attachment.tid === KERNEL_TID ? 2 : 3) * WASM_PAGE_SIZE);
      if (attachment.tid === KERNEL_TID) {oldStarted.resolve(); return oldLaunch.promise;}
      newStarted.resolve(); return newLaunch.promise;
    }, KERNEL_TID, false, undefined, width);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs()); await oldStarted.promise; wakeOriginal(h);
      h.setKernelTid(KERNEL_TID + 1); h.dispatch(cloneArgs()); await newStarted.promise;
      oldLaunch.reject(new Error("earlier clone failed after mailbox reuse"));
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(parentTid(h)).toBe(KERNEL_TID + 1);
      expect(readCloneCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
      expect((h.worker as any).channelTids.get(`${PID}:${3 * WASM_PAGE_SIZE}`)).toBe(KERNEL_TID + 1);
      newLaunch.resolve();
      await vi.waitFor(() => expect(readCloneCompletion(h.channel).status).toBe(CHANNEL_STATUS_COMPLETE));
      expect(readCloneCompletion(h.channel)).toEqual({status: CHANNEL_STATUS_COMPLETE, retVal: KERNEL_TID + 1, errno: 0});
      expect(h.notifyThreadExit).toHaveBeenCalledExactlyOnceWith(PID, KERNEL_TID, 0);
    } finally { consoleError.mockRestore(); }
  });

  it("rolls back a synchronous closed-gate refusal without claiming clone success", async () => {
    const creators = new ProcessMemoryCreatorGate(); await creators.closeAndWait();
    const h = makeCloneHarness(() => {creators.acquire("a pthread Worker"); return Promise.resolve();}, KERNEL_TID, false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs());
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(parentTid(h)).toBe(0); expect(consoleError).not.toHaveBeenCalled();
      expect(readCloneCompletion(h.channel)).toEqual({status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: 12});
    } finally { consoleError.mockRestore(); }
  });

  it("keeps a closed-gate rollback failure fatal until Rust accepts process termination", async () => {
    const creators = new ProcessMemoryCreatorGate(); await creators.closeAndWait();
    const h = makeCloneHarness(() => creators.run("a pthread Worker", async () => {}), KERNEL_TID, false);
    h.notifyThreadExit.mockReturnValue(-5);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs());
      await vi.waitFor(() => expect(h.onExit).toHaveBeenCalledOnce());
      expect(h.markProcessSignaled).toHaveBeenCalledExactlyOnceWith(PID, 11);
      expect(h.onExit).toHaveBeenCalledExactlyOnceWith(PID, 139);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("FATAL could not roll back allocated tid"));
      expect(readCloneCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
    } finally { consoleError.mockRestore(); }
  });

  it("keeps a genuine error visible even when its text copies closed admission", async () => {
    const h = makeCloneHarness(async () => {throw new Error("kernel worker is being destroyed; cannot start a pthread Worker");});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.dispatch(cloneArgs());
      await vi.waitFor(() => expect(h.notifyThreadExit).toHaveBeenCalledOnce());
      expect(consoleError).toHaveBeenCalledOnce(); expect(parentTid(h)).toBe(0);
      expect(readCloneCompletion(h.channel).errno).toBe(12);
    } finally { consoleError.mockRestore(); }
  });
});
