import { describe, expect, it, vi } from "vitest";

import { CentralizedKernelWorker } from "../src/kernel-worker";
import { WASM_PAGE_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
} from "../src/generated/abi";

const PID = 47;
const KERNEL_TID = 318;
const CHANNEL_OFFSET = WASM_PAGE_SIZE;
const CLONE_ARGS = [0x0021_0100, 0x0080_0000, 0, 0x0090_0000, 0x0004_0000, 0];

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
  const channel = { pid: PID, channelOffset: CHANNEL_OFFSET, memory };
  const processView = new DataView(memory.buffer, CHANNEL_OFFSET);
  processView.setUint32(CH_DATA, 11, true);
  processView.setUint32(CH_DATA + 4, 22, true);

  const kernelMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const kernelView = new DataView(kernelMemory.buffer);
  const completeChannel = vi.fn();
  const notifyThreadExit = vi.fn();
  const worker = Object.assign(
    Object.create(CentralizedKernelWorker.prototype),
    {
      callbacks: {},
      kernel: {
        toKernelPtr(value: number | bigint): number {
          return Number(value);
        },
      },
      kernelMemory,
      scratchOffset: 0,
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
      retireExactChannelAsyncState: vi.fn(),
      usePolling: true,
      completeChannel,
      notifyThreadExit,
      bindKernelTidForChannel: vi.fn(),
      kernelInstance: {
        exports: {
          kernel_get_process_exit_signal: vi.fn(() => -1),
          kernel_validate_task: vi.fn(() => 0),
          kernel_handle_channel: vi.fn(() => {
            kernelView.setBigInt64(CH_RETURN, BigInt(kernelTid), true);
            kernelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          }),
        },
      },
    },
  ) as CentralizedKernelWorker;
  (worker as any).callbacks = {
    onClone: (attachment: unknown) => {
      if (autoAttach) {
        worker.attachThreadChannel(
          attachment as Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0],
          2 * WASM_PAGE_SIZE,
        );
      }
      return onClone(attachment);
    },
  };

  return {
    channel,
    completeChannel,
    kernelHandleChannel: (worker as any).kernelInstance.exports.kernel_handle_channel,
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
  const mainChannel = {
    pid: PID,
    channelOffset: mainChannelOffset,
    memory,
    i32View: new Int32Array(memory.buffer, mainChannelOffset),
    consecutiveSyscalls: 0,
  };
  const validateTask = vi.fn(() => 0);
  const retireExactChannelAsyncState = vi.fn();
  const kernelMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const kernelView = new DataView(kernelMemory.buffer);
  let nextKernelTid = 0;
  const worker = Object.assign(
    Object.create(CentralizedKernelWorker.prototype),
    {
      callbacks: {},
      kernel: {
        toKernelPtr(value: number | bigint): number {
          return Number(value);
        },
      },
      kernelMemory,
      scratchOffset: 0,
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
      retireExactChannelAsyncState,
      threadCtidPtrs: new Map<string, number>(),
      threadForkContexts: new Map<string, { fnPtr: number; argPtr: number }>(),
      usePolling: true,
      completeChannel: vi.fn(),
      notifyThreadExit: vi.fn(),
      bindKernelTidForChannel: vi.fn(),
      kernelInstance: {
        exports: {
          kernel_get_process_exit_signal: vi.fn(() => -1),
          kernel_validate_task: validateTask,
          kernel_handle_channel: vi.fn(() => {
            kernelView.setBigInt64(CH_RETURN, BigInt(nextKernelTid), true);
            kernelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          }),
        },
      },
    },
  ) as CentralizedKernelWorker;

  return {
    mainChannel,
    memory,
    retireExactChannelAsyncState,
    validateTask,
    worker,
    issueThreadAttachment(tid: number, fnPtr = 11, argPtr = 22) {
      let attachment:
        | Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0]
        | undefined;
      nextKernelTid = tid;
      const processView = new DataView(memory.buffer, mainChannelOffset);
      processView.setUint32(CH_DATA, fnPtr, true);
      processView.setUint32(CH_DATA + 4, argPtr, true);
      (worker as any).callbacks = {
        onClone: (
          value: Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0],
        ) => {
          attachment = value;
          return new Promise<void>(() => {});
        },
      };
      (worker as any).handleClone(
        mainChannel,
        [0, 0x0080_0000, 0, 0x0090_0000, 0, 0],
      );
      if (!attachment) throw new Error("clone callback did not receive attachment");
      return attachment;
    },
  };
}

async function flushCloneContinuation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

    (first.worker as any).handleClone(first.channel, parentArgs);
    expect(first.kernelHandleChannel).not.toHaveBeenCalled();
    expect(first.completeChannel).toHaveBeenCalledWith(
      first.channel,
      ABI_SYSCALLS.Clone,
      parentArgs,
      undefined,
      -1,
      14,
    );

    const second = makeCloneHarness(onClone);
    const childArgs = [...CLONE_ARGS];
    childArgs[4] = invalidPtr;
    (second.worker as any).handleClone(second.channel, childArgs);
    expect(second.kernelHandleChannel).not.toHaveBeenCalled();
    expect(second.completeChannel).toHaveBeenCalledWith(
      second.channel,
      ABI_SYSCALLS.Clone,
      childArgs,
      undefined,
      -1,
      14,
    );
    expect(onClone).not.toHaveBeenCalled();
  });

  it("rolls back the exact Rust TID when the clone callback throws synchronously", () => {
    const launchError = new Error("synchronous worker construction failed");
    const onClone = vi.fn(() => {
      throw launchError;
    });
    const { channel, notifyThreadExit, worker } = makeCloneHarness(onClone);

    expect(() => (worker as any).handleClone(channel, CLONE_ARGS))
      .toThrow(launchError);
    expect(notifyThreadExit).toHaveBeenCalledOnce();
    expect(notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID);
  });

  it("does not track an unflagged child-TID pointer as clear-on-exit state", async () => {
    const onClone = vi.fn(async () => {});
    const { channel, worker } = makeCloneHarness(onClone);
    const args = [...CLONE_ARGS];
    args[0] &= ~0x0020_0000;

    (worker as any).handleClone(channel, args);
    await flushCloneContinuation();

    expect(onClone.mock.calls[0][0]).toMatchObject({ ctidPtr: 0 });
    expect((worker as any).threadCtidPtrs.size).toBe(0);
  });

  it("does not bind a pthread clone as the process leader when its mapping is missing", () => {
    const onClone = vi.fn(async () => {});
    const { channel, worker } = makeCloneHarness(onClone);
    const mainChannel = {
      pid: PID,
      channelOffset: 2 * WASM_PAGE_SIZE,
      memory: channel.memory,
    };
    const kernelHandleChannel = (worker as any).kernelInstance.exports
      .kernel_handle_channel as ReturnType<typeof vi.fn>;
    (worker as any).processes = new Map([
      [PID, { channels: [mainChannel, channel] }],
    ]);
    (worker as any).channelTids = new Map();
    delete (worker as any).bindKernelTidForChannel;
    const expected =
      `No kernel-validated TID for non-main channel ${CHANNEL_OFFSET} of process ${PID}`;

    expect(() => (worker as any).handleClone(channel, CLONE_ARGS)).toThrow(expected);
    expect(kernelHandleChannel).not.toHaveBeenCalled();
    expect(onClone).not.toHaveBeenCalled();
  });

  it("rejects zero before a host callback can attach an unallocated task", () => {
    const onClone = vi.fn(async () => {});
    const { channel, completeChannel, notifyThreadExit, worker } =
      makeCloneHarness(onClone, 0);

    (worker as any).handleClone(channel, CLONE_ARGS);

    expect(onClone).not.toHaveBeenCalled();
    expect(notifyThreadExit).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Clone,
      CLONE_ARGS,
      undefined,
      -1,
      5,
    );
  });

  it("ignores a host callback return value and completes with the Rust-assigned TID", async () => {
    // Deliberately emulate a stale callback that still returns a TID. The
    // current callback type is Promise<void>, and the runtime must likewise
    // ignore any value so the host cannot become an alternate TID authority.
    const onClone = vi.fn(async () => 999);
    const { channel, completeChannel, worker } = makeCloneHarness(onClone);

    (worker as any).handleClone(channel, CLONE_ARGS);
    await flushCloneContinuation();

    expect(onClone).toHaveBeenCalledWith(expect.objectContaining({
      pid: PID,
      tid: KERNEL_TID,
      fnPtr: 11,
      argPtr: 22,
      stackPtr: CLONE_ARGS[1],
      tlsPtr: CLONE_ARGS[3],
      ctidPtr: CLONE_ARGS[4],
      memory: channel.memory,
    }));
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Clone,
      CLONE_ARGS,
      undefined,
      KERNEL_TID,
      0,
    );
  });

  it("rolls back the exact Rust-assigned TID when host thread launch fails", async () => {
    const onClone = vi.fn(async () => {
      throw new Error("worker launch failed");
    });
    const { channel, completeChannel, notifyThreadExit, worker } =
      makeCloneHarness(onClone);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      (worker as any).handleClone(channel, CLONE_ARGS);
      await flushCloneContinuation();

      expect(notifyThreadExit).toHaveBeenCalledOnce();
      expect(notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID);
      expect(completeChannel).toHaveBeenCalledWith(
        channel,
        ABI_SYSCALLS.Clone,
        CLONE_ARGS,
        undefined,
        -1,
        12,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not complete clone when the callback fails to consume its attachment", async () => {
    const onClone = vi.fn(async () => {});
    const { channel, completeChannel, notifyThreadExit, worker } =
      makeCloneHarness(onClone, KERNEL_TID, false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      (worker as any).handleClone(channel, CLONE_ARGS);
      await flushCloneContinuation();

      expect(notifyThreadExit).toHaveBeenCalledWith(PID, KERNEL_TID);
      expect(completeChannel).toHaveBeenCalledWith(
        channel,
        ABI_SYSCALLS.Clone,
        CLONE_ARGS,
        undefined,
        -1,
        12,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("thread channel ownership", () => {
  const firstThreadOffset = 2 * WASM_PAGE_SIZE;
  const secondThreadOffset = 3 * WASM_PAGE_SIZE;
  const thirdThreadOffset = 4 * WASM_PAGE_SIZE;

  it("rejects a duplicate channel offset instead of remapping its TID", () => {
    const { issueThreadAttachment, validateTask, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      issueThreadAttachment(KERNEL_TID),
      firstThreadOffset,
    );

    expect(() => worker.attachThreadChannel(
      issueThreadAttachment(KERNEL_TID + 1),
      firstThreadOffset,
    ))
      .toThrow(
        `Channel offset ${firstThreadOffset} for process ${PID} is already registered`,
      );

    expect(validateTask).toHaveBeenCalledTimes(1);
    expect((worker as any).processes.get(PID).channels).toHaveLength(2);
    expect((worker as any).channelTids.get(`${PID}:${firstThreadOffset}`))
      .toBe(KERNEL_TID);
    expect((worker as any).threadForkContexts.get(`${PID}:${firstThreadOffset}`))
      .toEqual({ fnPtr: 11, argPtr: 22 });
  });

  it("rejects assigning one kernel TID to a second channel", () => {
    const { issueThreadAttachment, validateTask, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      issueThreadAttachment(KERNEL_TID),
      firstThreadOffset,
    );

    expect(() => worker.attachThreadChannel(
      issueThreadAttachment(KERNEL_TID),
      secondThreadOffset,
    ))
      .toThrow(
        `Kernel TID ${KERNEL_TID} is already attached to channel ${PID}:${firstThreadOffset}`,
      );

    expect(validateTask).toHaveBeenNthCalledWith(2, PID, KERNEL_TID);
    expect((worker as any).processes.get(PID).channels).toHaveLength(2);
    expect((worker as any).activeChannels).toHaveLength(2);
    expect((worker as any).channelTids.has(`${PID}:${secondThreadOffset}`))
      .toBe(false);
  });

  it("rejects a wrong-but-valid sibling TID for another clone channel", () => {
    const siblingTid = KERNEL_TID + 1;
    const { issueThreadAttachment, validateTask, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      issueThreadAttachment(KERNEL_TID),
      firstThreadOffset,
    );
    worker.attachThreadChannel(
      issueThreadAttachment(siblingTid),
      secondThreadOffset,
    );

    expect(() => worker.attachThreadChannel(
      issueThreadAttachment(siblingTid),
      thirdThreadOffset,
    ))
      .toThrow(
        `Kernel TID ${siblingTid} is already attached to channel ${PID}:${secondThreadOffset}`,
      );

    expect(validateTask).toHaveBeenLastCalledWith(PID, siblingTid);
    expect(validateTask).toHaveBeenCalledTimes(3);
    expect((worker as any).processes.get(PID).channels).toHaveLength(3);
    expect((worker as any).channelTids.has(`${PID}:${thirdThreadOffset}`))
      .toBe(false);
  });

  it("keeps concurrent pending TIDs bound to uncopyable one-shot attachments", () => {
    const siblingTid = KERNEL_TID + 1;
    const { issueThreadAttachment, worker } = makeChannelOwnershipHarness();
    const first = issueThreadAttachment(KERNEL_TID);
    const sibling = issueThreadAttachment(siblingTid, 33, 44);
    const forgedSibling = Object.freeze({
      ...sibling,
      tid: KERNEL_TID,
    }) as typeof sibling;

    expect(() => worker.attachThreadChannel(forgedSibling, firstThreadOffset))
      .toThrow("Unknown, expired, or already consumed thread attachment");

    worker.attachThreadChannel(first, firstThreadOffset);
    expect(() => worker.attachThreadChannel(first, thirdThreadOffset))
      .toThrow("Unknown, expired, or already consumed thread attachment");
    worker.attachThreadChannel(sibling, secondThreadOffset);

    expect((worker as any).channelTids.get(`${PID}:${firstThreadOffset}`))
      .toBe(KERNEL_TID);
    expect((worker as any).channelTids.get(`${PID}:${secondThreadOffset}`))
      .toBe(siblingTid);
    expect((worker as any).threadForkContexts.get(`${PID}:${secondThreadOffset}`))
      .toEqual({ fnPtr: 33, argPtr: 44 });
    expect((worker as any).addChannel).toBeUndefined();
  });

  it("releases channel ownership on removal so a later clone can reuse the slot", () => {
    const replacementTid = KERNEL_TID + 1;
    const { issueThreadAttachment, retireExactChannelAsyncState, worker } =
      makeChannelOwnershipHarness();
    worker.attachThreadChannel(
      issueThreadAttachment(KERNEL_TID, 11, 22),
      firstThreadOffset,
    );

    worker.removeChannel(PID, firstThreadOffset);

    expect(retireExactChannelAsyncState).toHaveBeenCalledOnce();
    expect((worker as any).channelTids.has(`${PID}:${firstThreadOffset}`))
      .toBe(false);
    expect((worker as any).threadForkContexts.has(`${PID}:${firstThreadOffset}`))
      .toBe(false);

    worker.attachThreadChannel(
      issueThreadAttachment(replacementTid, 33, 44),
      firstThreadOffset,
    );
    expect((worker as any).channelTids.get(`${PID}:${firstThreadOffset}`))
      .toBe(replacementTid);
    expect((worker as any).threadForkContexts.get(`${PID}:${firstThreadOffset}`))
      .toEqual({ fnPtr: 33, argPtr: 44 });
  });
});
