import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
  type CentralizedKernelCallbacks,
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
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_HANDLER,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  PROCESS_STATE_EXITED,
} from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { emptyProcessTimerCleanup } from "./kernel-worker-test-scratch";

const CLONE_PARENT_SETTID = 0x0010_0000;
const ENOMEM = 12;
const KERNEL_EXPORT_NAMES = [
  "kernel_commit_process_exit",
  "kernel_dequeue_signal",
  "kernel_drain_wakeup_events",
  "kernel_get_memory_pages",
  "kernel_get_parent_pid",
  "kernel_get_process_exit_signal",
  "kernel_get_process_state",
  "kernel_handle_channel",
  "kernel_inject_mouse_event",
  "kernel_input_event",
  "kernel_set_current_tid",
  "kernel_set_input_canvas_dims",
  "kernel_take_process_timer_cleanup",
  "kernel_thread_exit",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

interface LifecycleHarness {
  readonly worker: Record<string, any>;
  readonly channel: TestChannel;
  readonly kernelMemory: WebAssembly.Memory;
  readonly implementations: Record<string, unknown>;
  readonly gate: KernelEntryGate;
}

function kernelPointer(
  pointerWidth: 4 | 8,
  value: number,
): number | bigint {
  return pointerWidth === 8 ? BigInt(value) : value;
}

function makeHarness(
  pointerWidth: 4 | 8,
  callbacks: CentralizedKernelCallbacks,
  implementations: Record<string, unknown>,
): LifecycleHarness {
  const processMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
    shared: true,
  });
  const channel: TestChannel = {
    pid: 41,
    memory: processMemory,
    channelOffset: 0,
    i32View: new Int32Array(processMemory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  const mutableImplementations: Record<string, unknown> = {
    kernel_commit_process_exit: (status: number) => status & 0xff,
    kernel_dequeue_signal: () => 0,
    kernel_drain_wakeup_events: () => 0,
    kernel_get_memory_pages: () => 256,
    kernel_get_parent_pid: () => 0,
    kernel_get_process_exit_signal: () => 0,
    kernel_get_process_state: () => PROCESS_STATE_EXITED,
    kernel_handle_channel: () => 0,
    kernel_inject_mouse_event: () => 0,
    kernel_input_event: () => 0,
    kernel_set_current_tid: () => 0,
    kernel_set_input_canvas_dims: () => 0,
    kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(kernelMemory),
    kernel_thread_exit: () => 0,
    ...implementations,
  };
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    kernelMemory,
    () => mutableImplementations,
    () => kernelPointer(pointerWidth, 4_096),
    4,
    KERNEL_EXPORT_NAMES,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const mainScratch = allocateKernelScratchRegion(
    kernelMemory,
    gatedInstance.exports.kernel_alloc_scratch as
      (capacity: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
    "clone/exit entry test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks,
  }) as unknown as Record<string, any>;
  Object.assign(worker, {
    activeChannels: [channel],
    channelTids: new Map([[`${channel.pid}:${channel.channelOffset}`, channel.pid]]),
    currentHandlePid: 0,
    execHandoffPids: new Set<number>(),
    hostReaped: new Set<number>(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    processes: new Map([[channel.pid, {
      pid: channel.pid,
      memory: channel.memory,
      channels: [channel],
      ptrWidth: pointerWidth,
      explicitMaxAddr: true,
    }]]),
    relistenBatchSize: 64,
    relistenCount: 0,
    syscallRing: new Map(),
    syscallTraceCap: 64,
    syscallTraceEnabled: false,
    syscallTraceRing: [],
    threadForkContexts: new Map(),
    usePolling: true,
  });
  worker.testAuthority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch,
    tcpScratch: mainScratch,
  });
  return {
    worker,
    channel,
    kernelMemory,
    implementations: mutableImplementations,
    gate,
  };
}

function writeSyscall(
  channel: TestChannel,
  syscall: number,
  args: readonly bigint[],
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setInt32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      args[index] ?? 0n,
      true,
    );
  }
}

function channelResult(channel: TestChannel): {
  readonly status: number;
  readonly result: number;
  readonly errno: number;
} {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  return {
    status: view.getUint32(CH_STATUS, true),
    result: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

async function flushLifecycleContinuations(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
}

describe("clone and exit entry authority", () => {
  it.each([false, true])("rejects an obsolete clone completion after retirement (reject=%s)", async rejectLaunch => {
    let resolveLaunch!: () => void;
    let rejectLaunchPromise!: (error: Error) => void;
    const launch = new Promise<void>((resolve, reject) => {
      resolveLaunch = resolve;
      rejectLaunchPromise = reject;
    });
    const rollback = vi.fn(() => 0);
    const onExit = vi.fn();
    const harness = makeHarness(4, { onExit, onClone: () => launch }, {
      kernel_thread_exit: rollback,
      kernel_handle_channel: (pointer: number | bigint) => {
        const view = new DataView(harness.kernelMemory.buffer, Number(pointer));
        view.setBigInt64(CH_RETURN, 73n, true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      },
    });
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: vi.fn() });
    writeSyscall(harness.channel, ABI_SYSCALLS.Clone, [0n, 0x8000n, 0n, 0x9000n, 0n]);
    harness.worker.handleSyscall(harness.channel);
    await harness.worker.beginKernelTeardown();
    expect(channelResult(harness.channel).status).toBe(CHANNEL_STATUS_COMPLETE);
    writeSyscall(harness.channel, ABI_SYSCALLS.Exit, [137n]);
    if (rejectLaunch) rejectLaunchPromise(new Error("late launch rejection"));
    else resolveLaunch();
    await flushLifecycleContinuations();
    expect(channelResult(harness.channel).status).toBe(CHANNEL_STATUS_PENDING);
    expect(rollback).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    harness.worker.handleSyscall(harness.channel);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(harness.channel.pid, 137);
  });

  it.each([4, 8] as const)("retires parked and later sibling requests without repeating Rust exit for width %s", async width => {
    const commit = vi.fn((status: number) => status & 0xff);
    const onExit = vi.fn();
    const dispatch = vi.fn(() => 0);
    const harness = makeHarness(width, { onExit }, {
      kernel_commit_process_exit: commit,
      kernel_handle_channel: dispatch,
    });
    const sibling: TestChannel = {
      ...harness.channel,
      channelOffset: CH_TOTAL_SIZE,
      handling: true,
    };
    const lateSibling: TestChannel = {
      ...harness.channel,
      channelOffset: 2 * CH_TOTAL_SIZE,
      handling: false,
    };
    harness.worker.processes.get(harness.channel.pid).channels.push(sibling, lateSibling);
    harness.worker.activeChannels.push(sibling, lateSibling);
    harness.worker.channelTids.set(`${sibling.pid}:${sibling.channelOffset}`, 72);
    harness.worker.channelTids.set(`${lateSibling.pid}:${lateSibling.channelOffset}`, 73);
    const relisten = vi.fn();
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: relisten });
    writeSyscall(sibling, ABI_SYSCALLS.Read, [99n]);
    writeSyscall(lateSibling, ABI_SYSCALLS.Read, [98n]);
    new DataView(lateSibling.memory.buffer, lateSibling.channelOffset)
      .setInt32(CH_STATUS, CHANNEL_STATUS_COMPLETE, true);
    writeSyscall(harness.channel, ABI_SYSCALLS.ExitGroup, [7n]);

    harness.worker.handleSyscall(harness.channel);
    expect(commit).toHaveBeenCalledExactlyOnceWith(7);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(harness.channel.pid, 7);
    expect(channelResult(sibling)).toEqual({ status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 4 });
    const siblingView = new DataView(sibling.memory.buffer, sibling.channelOffset);
    expect(siblingView.getUint32(CH_SIG_SIGNUM, true)).toBe(9);
    expect(siblingView.getUint32(CH_SIG_HANDLER, true)).toBe(0);
    expect(relisten).toHaveBeenCalledWith(sibling);

    writeSyscall(lateSibling, ABI_SYSCALLS.Write, [98n]);
    harness.worker.handleSyscall(lateSibling);
    expect(channelResult(lateSibling)).toEqual({ status: CHANNEL_STATUS_COMPLETE, result: -1, errno: 4 });
    expect(new DataView(lateSibling.memory.buffer, lateSibling.channelOffset).getUint32(CH_SIG_SIGNUM, true)).toBe(9);
    expect(relisten).toHaveBeenCalledWith(lateSibling);

    for (const retired of [sibling, lateSibling]) {
      writeSyscall(retired, ABI_SYSCALLS.Exit, [137n]);
      harness.worker.handleSyscall(retired);
      expect(channelResult(retired)).toEqual({ status: CHANNEL_STATUS_COMPLETE, result: 0, errno: 0 });
    }
    expect(commit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [4, ABI_SYSCALLS.Exit], [4, ABI_SYSCALLS.ExitGroup],
    [8, ABI_SYSCALLS.Exit], [8, ABI_SYSCALLS.ExitGroup],
  ] as const)("commits a pending exit exactly once after terminal admission for width %s syscall %s", async (width, syscall) => {
    const commit = vi.fn((status: number) => status & 0xff);
    const onExit = vi.fn();
    const harness = makeHarness(width, { onExit }, { kernel_commit_process_exit: commit });
    writeSyscall(harness.channel, syscall, [7n]);
    expect(await harness.worker.beginKernelTeardown()).toEqual(new Set([harness.channel.pid]));
    expect(commit).not.toHaveBeenCalled();
    harness.worker.handleSyscall(harness.channel);
    harness.worker.handleSyscall(harness.channel);
    expect(commit).toHaveBeenCalledExactlyOnceWith(7);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(harness.channel.pid, 7);
    expect(channelResult(harness.channel).status).toBe(CHANNEL_STATUS_COMPLETE);
    expect(harness.worker.hostReaped.has(harness.channel.pid)).toBe(true);
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s rolls back an unattached clone through a fresh exact entry",
    async (_name, pointerWidth) => {
      const tid = 73;
      const parentTidPointer = 0x4000;
      const order: string[] = [];
      let rollbackReentryError: unknown;
      let harness!: LifecycleHarness;
      const getMemoryPages = vi.fn(() => {
        order.push("fresh callback query");
        return 256;
      });
      const threadExit = vi.fn((pid: number, removedTid: number) => {
        order.push("Rust rollback");
        expect(pid).toBe(harness.channel.pid);
        expect(removedTid).toBe(tid);
        expect(
          new DataView(harness.channel.memory.buffer).getInt32(
            parentTidPointer,
            true,
          ),
        ).toBe(0);
        try {
          harness.worker.getKernelMemoryPages();
        } catch (error) {
          rollbackReentryError = error;
        }
        return 0;
      });
      const onClone = vi.fn((attachment) => {
        order.push("host clone callback");
        expect(attachment.pid).toBe(harness.channel.pid);
        expect(attachment.tid).toBe(tid);
        expect(
          new DataView(harness.channel.memory.buffer).getInt32(
            parentTidPointer,
            true,
          ),
        ).toBe(tid);
        // The callback runs after the allocating scope was revoked. A
        // synchronous query therefore receives a wholly fresh entry.
        expect(harness.worker.getKernelMemoryPages()).toBe(256);
        return Promise.resolve();
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      harness = makeHarness(
        pointerWidth,
        { onClone },
        {
          kernel_get_memory_pages: getMemoryPages,
          kernel_handle_channel: (pointer: number | bigint) => {
            order.push("Rust clone allocation");
            const view = new DataView(harness.kernelMemory.buffer);
            view.setBigInt64(Number(pointer) + CH_RETURN, BigInt(tid), true);
            view.setUint32(Number(pointer) + CH_ERRNO, 0, true);
            return 0;
          },
          kernel_thread_exit: threadExit,
        },
      );
      const processView = new DataView(harness.channel.memory.buffer);
      processView.setUint32(CH_DATA, 11, true);
      processView.setUint32(CH_DATA + 4, 22, true);
      processView.setInt32(parentTidPointer, -1, true);
      writeSyscall(
        harness.channel,
        ABI_SYSCALLS.Clone,
        [
          BigInt(CLONE_PARENT_SETTID),
          0x8000n,
          BigInt(parentTidPointer),
          0x9000n,
          0n,
        ],
      );

      harness.worker.handleSyscall(harness.channel);
      expect(order).toEqual(["Rust clone allocation"]);

      await flushLifecycleContinuations();

      expect(order).toEqual([
        "Rust clone allocation",
        "host clone callback",
        "fresh callback query",
        "Rust rollback",
      ]);
      expect(rollbackReentryError).toBeInstanceOf(
        KernelReentrantEntryError,
      );
      expect(getMemoryPages).toHaveBeenCalledOnce();
      expect(threadExit).toHaveBeenCalledOnce();
      expect(channelResult(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        result: -1,
        errno: ENOMEM,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s publishes a complete exit before detached host callbacks",
    async (_name, pointerWidth) => {
      const order: string[] = [];
      const mouse = vi.fn(() => {
        order.push("queued mouse ingress");
        return 0;
      });
      const getMemoryPages = vi.fn(() => 512);
      let callbackReentryError: unknown;
      let orderAtCallback: string[] = [];
      let harness!: LifecycleHarness;
      const onExit = vi.fn((pid: number, status: number) => {
        order.push("host exit callback");
        orderAtCallback = [...order];
        expect(pid).toBe(harness.channel.pid);
        expect(status).toBe(7);
        expect(harness.worker.hostReaped.has(pid)).toBe(true);
        expect(channelResult(harness.channel).status).toBe(
          CHANNEL_STATUS_COMPLETE,
        );
        try {
          harness.worker.getKernelMemoryPages();
        } catch (error) {
          callbackReentryError = error;
        }
        harness.worker.injectMouseEvent(1, 2, 3);
        expect(mouse).not.toHaveBeenCalled();
      });
      harness = makeHarness(
        pointerWidth,
        { onExit },
        {
          kernel_commit_process_exit: (status: number) => {
            order.push("Rust exit commit");
            return status & 0xff;
          },
          kernel_drain_wakeup_events: () => {
            order.push("Rust wake drain");
            return 0;
          },
          kernel_get_memory_pages: getMemoryPages,
          kernel_get_parent_pid: () => {
            order.push("Rust parent query");
            return 0;
          },
          kernel_get_process_state: () => {
            order.push("Rust state proof");
            return PROCESS_STATE_EXITED;
          },
          kernel_inject_mouse_event: mouse,
        },
      );
      writeSyscall(harness.channel, ABI_SYSCALLS.Exit, [7n]);

      harness.worker.handleSyscall(harness.channel);

      expect(orderAtCallback).toEqual([
        "Rust exit commit",
        "Rust state proof",
        "Rust wake drain",
        "Rust parent query",
        "Rust wake drain",
        "host exit callback",
      ]);
      expect(callbackReentryError).toBeInstanceOf(
        KernelReentrantEntryError,
      );
      expect(getMemoryPages).not.toHaveBeenCalled();

      await flushLifecycleContinuations();

      expect(mouse).toHaveBeenCalledExactlyOnceWith(1, 2, 3);
      expect(order.at(-1)).toBe("queued mouse ingress");
      expect(order.indexOf("host exit callback")).toBeLessThan(
        order.indexOf("queued mouse ingress"),
      );
    },
  );

  it("defers evdev ingress raised from a detached host callback", async () => {
    const order: string[] = [];
    const inputEvent = vi.fn(() => {
      order.push("queued evdev record");
      return 0;
    });
    const canvasDims = vi.fn(() => {
      order.push("queued canvas dimensions");
      return 0;
    });
    let harness!: LifecycleHarness;
    const onExit = vi.fn(() => {
      order.push("host exit callback");
      harness.worker.setInputCanvasDims(1024, 768);
      harness.worker.injectInputEvent(0, 0x01, 30, 1);
      expect(canvasDims).not.toHaveBeenCalled();
      expect(inputEvent).not.toHaveBeenCalled();
    });
    harness = makeHarness(
      4,
      { onExit },
      {
        kernel_input_event: inputEvent,
        kernel_set_input_canvas_dims: canvasDims,
      },
    );
    writeSyscall(harness.channel, ABI_SYSCALLS.Exit, [7n]);

    harness.worker.handleSyscall(harness.channel);

    await flushLifecycleContinuations();

    expect(canvasDims).toHaveBeenCalledExactlyOnceWith(1024, 768);
    expect(inputEvent).toHaveBeenCalledExactlyOnceWith(0, 0x01, 30, 1);
    expect(order).toEqual([
      "host exit callback",
      "queued canvas dimensions",
      "queued evdev record",
    ]);
  });

  it("keeps host exit state private when Rust cannot prove the committed status", async () => {
    const onExit = vi.fn();
    const onKernelFatal = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    const harness = makeHarness(
      4,
      { onExit, onKernelFatal },
      {
        kernel_commit_process_exit: () => 6,
      },
    );
    writeSyscall(harness.channel, ABI_SYSCALLS.Exit, [7n]);

    expect(() => {
      harness.worker.handleSyscall(harness.channel);
    }).toThrow(
      "kernel committed exit status 6 for process 41; expected 7",
    );

    expect(onExit).not.toHaveBeenCalled();
    // The fatal latch is synchronous, but its host observer must not run until
    // the failing export's exact entry scope has been fully revoked.
    await flushLifecycleContinuations();
    expect(onKernelFatal).toHaveBeenCalledOnce();
    expect(harness.worker.hostReaped.has(harness.channel.pid)).toBe(false);
    expect(channelResult(harness.channel).status).toBe(
      CHANNEL_STATUS_PENDING,
    );
    consoleError.mockRestore();
  });
});
