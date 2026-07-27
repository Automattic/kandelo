import { describe, expect, it, vi } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
  CentralizedKernelWorker,
  isCurrentProcessGeneration,

} from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_DATA,
  CH_DATA_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_HANDLER,
  CH_SIG_SI_CODE,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  HOST_INTERCEPTED_SYSCALLS,
} from "../src/generated/abi";
import { EXEC_RETIRE_SIGNAL_CODE } from "../src/worker-protocol";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

describe("exec host-state transition", () => {
  it("retires only the exact pending exec generation without relistening", () => {
    const memory = new WebAssembly.Memory({
      initial: 5,
      maximum: 5,
      shared: true,
    });
    const mainChannel = createChannel(7, memory, 0);
    const threadChannel = createChannel(7, memory, 3 * 65536);
    const main = new DataView(memory.buffer, mainChannel.channelOffset);
    const thread = new DataView(memory.buffer, threadChannel.channelOffset);
    Atomics.store(
      mainChannel.i32View,
      CH_STATUS / 4,
      CHANNEL_STATUS_PENDING,
    );
    Atomics.store(
      threadChannel.i32View,
      CH_STATUS / 4,
      CHANNEL_STATUS_PENDING,
    );
    main.setUint32(CH_SYSCALL, ABI_SYSCALLS.Read, true);
    thread.setUint32(
      CH_SYSCALL,
      HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE,
      true,
    );

    const worker = createWorker({
      processes: new Map([[
        7,
        { pid: 7, memory, channels: [mainChannel, threadChannel] },
      ]]),
    });

    expect(worker.wakeProcessWorkersForExecRetirement(7, memory)).toEqual(
      new Set([0, 3 * 65536]),
    );
    for (const view of [main, thread]) {
      expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-1);
      expect(view.getUint32(CH_ERRNO, true)).toBe(4);
      expect(view.getUint32(CH_SIG_SIGNUM, true)).toBe(9);
      expect(view.getUint32(CH_SIG_HANDLER, true)).toBe(0);
      expect(view.getUint32(CH_SIG_SI_CODE, true)).toBe(
        EXEC_RETIRE_SIGNAL_CODE,
      );
    }

    const replacement = new WebAssembly.Memory({
      initial: 5,
      maximum: 5,
      shared: true,
    });
    expect(() =>
      worker.wakeProcessWorkersForExecRetirement(7, replacement)
    ).toThrow("generation changed");
  });

  it("rejects an async continuation from a replaced process generation", () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1 });
    const newMemory = new WebAssembly.Memory({ initial: 1 });
    const oldGeneration = { memory: oldMemory };
    const newGeneration = { memory: newMemory };
    const processes = new Map([[7, oldGeneration]]);

    expect(isCurrentProcessGeneration(
      processes,
      7,
      oldGeneration,
      oldMemory,
    )).toBe(true);
    processes.set(7, newGeneration);
    expect(isCurrentProcessGeneration(
      processes,
      7,
      oldGeneration,
      oldMemory,
    )).toBe(false);
    expect(isCurrentProcessGeneration(
      processes,
      7,
      newGeneration,
      oldMemory,
    )).toBe(false);
    expect(isCurrentProcessGeneration(
      processes,
      7,
      newGeneration,
      newMemory,
      true,
    )).toBe(false);
  });

  it("drops discarded-image async and thread-channel state", async () => {
    vi.useFakeTimers();
    try {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const otherMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const mainChannel = createChannel(7, memory, 0);
      const threadChannel = createChannel(7, memory, 256);
      const otherChannel = createChannel(8, otherMemory, 0);
      const sleepTimer = setTimeout(() => {}, 60_000);
      const threadSleepTimer = setTimeout(() => {}, 60_000);
      const otherSleepTimer = setTimeout(() => {}, 60_000);
      const worker = createWorker({
        processes: new Map([
          [7, { channels: [mainChannel, threadChannel], memory }],
          [8, { channels: [otherChannel], memory: otherMemory }],
        ]),
        activeChannels: [mainChannel, threadChannel, otherChannel],
        waitingForChild: [
          { parentPid: 7, channel: mainChannel },
          { parentPid: 8, channel: otherChannel },
        ],
        pendingSleeps: new Map([
          [mainChannel, { timer: sleepTimer, channel: mainChannel }],
          [threadChannel, { timer: threadSleepTimer, channel: threadChannel }],
          [otherChannel, { timer: otherSleepTimer, channel: otherChannel }],
        ]),
        pendingFutexWaits: new Map([
          [threadChannel, { futexIndex: 4 }],
          [otherChannel, { futexIndex: 5 }],
        ]),
        pendingCancels: new Set([threadChannel, otherChannel]),
        stoppedPids: new Set([7, 8]),
        parkedChannelCompletions: new Map([
          [mainChannel, { prepared: {}, relistenRequested: true }],
          [otherChannel, { prepared: {}, relistenRequested: true }],
        ]),
        deferredStoppedChannels: new Map([
          [threadChannel, true],
          [otherChannel, true],
        ]),
        channelTids: new Map([
          ["7:256", 11],
          ["8:0", 8],
        ]),
        threadForkContexts: new Map([
          ["7:256", { fnPtr: 1, argPtr: 2 }],
          ["8:0", { fnPtr: 3, argPtr: 4 }],
        ]),
        threadCtidPtrs: new Map([
          ["7:11", 0x1000],
          ["8:8", 0x2000],
        ]),
      });
      const notify = vi.spyOn(Atomics, "notify");
      const parkedMain = worker.parkedChannelCompletions.get(mainChannel);
      worker.parkedChannelCompletions.delete(mainChannel);
      worker.stoppedPids.delete(7);
      const pendingAttachment = await issueThreadAttachment(
        worker,
        mainChannel,
        11,
      );
      if (parkedMain) {
        worker.parkedChannelCompletions.set(mainChannel, parkedMain);
      }
      worker.stoppedPids.add(7);

      worker.prepareProcessForExec(7);

      expect(worker.processes.has(7)).toBe(true);
      expect(worker.processes.get(7).channels).toEqual([]);
      expect(worker.isExecHandoffActive(7)).toBe(true);
      expectGateFailureCause(
        () => worker.attachThreadChannel(pendingAttachment, 512),
        "replacing its image",
      );
      expect(worker.processes.has(8)).toBe(true);
      expect(worker.activeChannels).toEqual([otherChannel]);
      expect(worker.waitingForChild).toEqual([
        { parentPid: 8, channel: otherChannel },
      ]);
      expect(worker.pendingSleeps.has(mainChannel)).toBe(false);
      expect(worker.pendingSleeps.has(threadChannel)).toBe(false);
      expect(worker.pendingSleeps.has(otherChannel)).toBe(true);
      expect(worker.pendingFutexWaits.has(threadChannel)).toBe(false);
      expect(worker.pendingFutexWaits.has(otherChannel)).toBe(true);
      expect(worker.pendingCancels.has(threadChannel)).toBe(false);
      expect(worker.pendingCancels.has(otherChannel)).toBe(true);
      expect(worker.stoppedPids.has(7)).toBe(true);
      expect(worker.stoppedPids.has(8)).toBe(true);
      expect(worker.parkedChannelCompletions.has(mainChannel)).toBe(false);
      expect(worker.parkedChannelCompletions.has(otherChannel)).toBe(true);
      expect(worker.deferredStoppedChannels.has(threadChannel)).toBe(false);
      expect(worker.deferredStoppedChannels.has(otherChannel)).toBe(true);
      expect(worker.channelTids.has("7:256")).toBe(false);
      expect(worker.channelTids.get("8:0")).toBe(8);
      expect(worker.threadForkContexts.has("7:256")).toBe(false);
      expect(worker.threadForkContexts.has("8:0")).toBe(true);
      expect(worker.threadCtidPtrs.has("7:11")).toBe(false);
      expect(worker.threadCtidPtrs.get("8:8")).toBe(0x2000);
      expect(notify).toHaveBeenCalledWith(
        expect.any(Int32Array),
        4,
        1,
      );
      clearTimeout(otherSleepTimer);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("rejects an old-memory clone after replacement registration", async () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1 });
    const newMemory = new WebAssembly.Memory({ initial: 1 });
    const oldChannel = createChannel(7, oldMemory, 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [oldChannel], memory: oldMemory }]]),
      activeChannels: [oldChannel],
    });
    const pendingAttachment = await issueThreadAttachment(
      worker,
      oldChannel,
      11,
      1,
      2,
    );
    worker.processes.set(7, { channels: [], memory: newMemory });

    expectGateFailureCause(
      () => worker.attachThreadChannel(pendingAttachment, 512),
      "changed memory generation",
    );
    expect(worker.processes.get(7).channels).toEqual([]);
  });

  it("keeps concurrent sleeps independent across one process's threads", async () => {
    vi.useFakeTimers();
    try {
      const memory = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
      const mainChannel = createChannel(7, memory, 0);
      const threadChannel = createChannel(7, memory, 0x10000);
      const mainDetachedOutput = [{
        ptr: 0x800,
        bytes: Uint8Array.of(1),
      }];
      const threadDetachedOutput = [{
        ptr: 0x900,
        bytes: Uint8Array.of(2),
      }];
      const worker = createWorker({
        processes: new Map([[7, {
          channels: [mainChannel, threadChannel],
          memory,
        }]]),
      });
      Atomics.store(
        mainChannel.i32View,
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
        CHANNEL_STATUS_PENDING,
      );
      Atomics.store(
        threadChannel.i32View,
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
        CHANNEL_STATUS_PENDING,
      );

      expect(worker.handleSleepDelay(
        mainChannel,
        ABI_SYSCALLS.Usleep,
        [50_000],
        0,
        0,
        undefined,
        mainDetachedOutput,
      )).toBe(true);
      expect(worker.handleSleepDelay(
        threadChannel,
        ABI_SYSCALLS.Usleep,
        [10_000],
        0,
        0,
        undefined,
        threadDetachedOutput,
      )).toBe(true);
      expect(worker.pendingSleeps.size).toBe(2);

      await vi.advanceTimersByTimeAsync(10);
      expect(Atomics.load(
        threadChannel.i32View,
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      )).not.toBe(CHANNEL_STATUS_PENDING);
      expect(new Uint8Array(memory.buffer)[0x900]).toBe(2);
      expect(Atomics.load(
        mainChannel.i32View,
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      )).toBe(CHANNEL_STATUS_PENDING);
      expect(worker.pendingSleeps.has(mainChannel)).toBe(true);

      await vi.advanceTimersByTimeAsync(40);
      expect(Atomics.load(
        mainChannel.i32View,
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      )).not.toBe(CHANNEL_STATUS_PENDING);
      expect(new Uint8Array(memory.buffer)[0x800]).toBe(1);
      expect(worker.pendingSleeps.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a stale retry before consulting replacement process state", () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1 });
    const newMemory = new WebAssembly.Memory({ initial: 1 });
    const oldChannel = createChannel(7, oldMemory, 0);
    const newChannel = createChannel(7, newMemory, 0);
    const getProcessExitSignal = vi.fn(() => 11);
    const handleProcessTerminated = vi.fn();
    const handleSyscall = vi.fn();
    const worker = createWorker({
      processes: new Map([[7, { channels: [newChannel], memory: newMemory }]]),
      getProcessExitSignal,
      handleProcessTerminated,
      handleSyscall,
    });

    worker.retrySyscall(oldChannel);

    expect(getProcessExitSignal).not.toHaveBeenCalled();
    expect(handleProcessTerminated).not.toHaveBeenCalled();
    expect(handleSyscall).not.toHaveBeenCalled();
  });

  it("does not wake a signal-dead image after async exec failure", async () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const channel = createChannel(7, memory, 0);
    const pathPtr = 0x100;
    new Uint8Array(memory.buffer).set(
      new TextEncoder().encode("/bin/missing\0"),
      pathPtr,
    );
    let finishExec!: (result: number) => void;
    const launched = new Promise<number>((resolve) => {
      finishExec = resolve;
    });
    const getProcessExitSignal = vi.fn(() => 11);
    const onExit = vi.fn();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onExec: vi.fn(() => launched),
        onExit,
      },
      kernelInstance: {
        exports: { kernel_get_process_exit_signal: getProcessExitSignal },
      },
    });

    writeChannelSyscall(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE,
      [pathPtr, 0, 0],
    );
    worker.handleSyscall(channel);
    await flushMicrotasksUntil(
      () => worker.callbacks.onExec.mock.calls.length === 1,
      "exec callback did not start",
    );
    finishExec(-3);
    await flushMicrotasksUntil(
      () => worker.hostReaped.has(7),
      "signal-dead exec image was not reaped",
    );

    expect(getProcessExitSignal).toHaveBeenCalledWith(7);
    expect(onExit).toHaveBeenCalledWith(7, 139);
    expect(readChannelStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
  });

  it("does not wake a normally reaped image after async exec failure", async () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const channel = createChannel(7, memory, 0);
    const pathPtr = 0x100;
    new Uint8Array(memory.buffer).set(
      new TextEncoder().encode("/bin/missing\0"),
      pathPtr,
    );
    let finishExec!: (result: number) => void;
    const launched = new Promise<number>((resolve) => {
      finishExec = resolve;
    });
    const getProcessExitSignal = vi.fn(() => 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: { onExec: vi.fn(() => launched) },
      kernelInstance: {
        exports: { kernel_get_process_exit_signal: getProcessExitSignal },
      },
    });

    writeChannelSyscall(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE,
      [pathPtr, 0, 0],
    );
    worker.handleSyscall(channel);
    await flushMicrotasksUntil(
      () => worker.callbacks.onExec.mock.calls.length === 1,
      "exec callback did not start",
    );
    worker.hostReaped.add(7);
    getProcessExitSignal.mockClear();
    finishExec(-3);
    await flushMicrotasks();

    expect(getProcessExitSignal).not.toHaveBeenCalled();
    expect(readChannelStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
  });

  it("does not create a spawn child after async resolution loses its parent channel", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = createChannel(7, memory, 0);
    const bytes = new Uint8Array(memory.buffer);
    const pathPtr = 0x100;
    const path = new TextEncoder().encode("/bin/child");
    bytes.set(path, pathPtr);
    const blobPtr = 0x200;
    bytes.fill(0, blobPtr, blobPtr + 40);
    let resolveProgram!: (value: ReturnType<typeof resolvedProgram>) => void;
    const program = new Promise<ReturnType<typeof resolvedProgram>>((resolve) => {
      resolveProgram = resolve;
    });
    const kernelSpawn = vi.fn(() => 100);
    const onSpawn = vi.fn(async () => 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onResolveSpawn: vi.fn(() => program),
        onSpawn,
      },
      kernelInstance: {
        exports: { kernel_spawn_process: kernelSpawn },
      },
    });

    writeChannelSyscall(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      [pathPtr, path.length, blobPtr, 40, 0, 0],
    );
    worker.handleSyscall(channel);
    await flushMicrotasksUntil(
      () => worker.callbacks.onResolveSpawn.mock.calls.length === 1,
      "spawn resolution did not start",
    );
    worker.processes.get(7).channels = [];
    resolveProgram(resolvedProgram());
    await flushMicrotasks();

    expect(kernelSpawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(readChannelStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
  });

  it("rejects an unlaunchable spawn before creating a child or applying file actions", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = createChannel(7, memory, 0);
    const bytes = new Uint8Array(memory.buffer);
    const pathPtr = 0x100;
    const path = new TextEncoder().encode("/bin/malformed");
    bytes.set(path, pathPtr);
    const blobPtr = 0x200;
    bytes.fill(0, blobPtr, blobPtr + 40);
    const kernelSpawn = vi.fn(() => 100);
    const onSpawn = vi.fn(async () => 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onResolveSpawn: vi.fn(async () => ({ errno: 8 })),
        onSpawn,
      },
      kernelInstance: {
        exports: { kernel_spawn_process: kernelSpawn },
      },
    });

    writeChannelSyscall(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      [pathPtr, path.length, blobPtr, 40, 0, 0],
    );
    worker.handleSyscall(channel);
    await flushMicrotasksUntil(
      () => readChannelStatus(channel) !== CHANNEL_STATUS_PENDING,
      "unlaunchable spawn did not complete",
    );

    expect(kernelSpawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(readChannelCompletion(channel)).toEqual({
      status: CHANNEL_STATUS_COMPLETE,
      returnValue: -1,
      errno: 8,
    });
  });

  it("keeps a created spawn child but suppresses stale parent completion", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = createChannel(7, memory, 0);
    const pathPtr = 0x100;
    const path = new TextEncoder().encode("/bin/child");
    new Uint8Array(memory.buffer).set(path, pathPtr);
    const blobPtr = 0x200;
    new Uint8Array(memory.buffer).fill(0, blobPtr, blobPtr + 40);
    let finishSpawn!: (result: number) => void;
    const spawned = new Promise<number>((resolve) => {
      finishSpawn = resolve;
    });
    const kernelSpawn = vi.fn(() => 100);
    const removeProcess = vi.fn();
    const onSpawn = vi.fn(() => spawned);
    const program = resolvedProgram();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onResolveSpawn: vi.fn(async () => program),
        onSpawn,
      },
      kernelMemory: new WebAssembly.Memory({ initial: 2 }),
      kernelInstance: {
        exports: {
          kernel_spawn_process: kernelSpawn,
          kernel_remove_process: removeProcess,
        },
      },
    });

    writeChannelSyscall(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      [pathPtr, path.length, blobPtr, 40, 0, 0],
    );
    worker.handleSyscall(channel);
    await flushMicrotasks();
    expect(worker.callbacks.onResolveSpawn).toHaveBeenCalledOnce();
    expect(
      kernelSpawn,
      JSON.stringify(readChannelCompletion(channel)),
    ).toHaveBeenCalledOnce();
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(onSpawn).toHaveBeenCalledWith(7, 100, program, []);
    worker.processes.get(7).channels = [];
    finishSpawn(0);
    await flushMicrotasks();

    expect(kernelSpawn).toHaveBeenCalled();
    expect(removeProcess).not.toHaveBeenCalled();
    expect(readChannelStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
  });

  it("installs spawn-child listener mirrors before async worker launch", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = createChannel(7, memory, 0);
    const pathPtr = 0x100;
    const path = new TextEncoder().encode("/bin/child");
    new Uint8Array(memory.buffer).set(path, pathPtr);
    const blobPtr = 0x200;
    new Uint8Array(memory.buffer).fill(0, blobPtr, blobPtr + 40);
    let finishSpawn!: (result: number) => void;
    const spawned = new Promise<number>((resolve) => {
      finishSpawn = resolve;
    });
    const close = vi.fn();
    const listener = {
      server: { close },
      pid: 7,
      port: 8080,
      connections: new Set(),
    };
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onResolveSpawn: vi.fn(async () => resolvedProgram()),
        onSpawn: vi.fn(() => spawned),
      },
      kernelMemory: new WebAssembly.Memory({ initial: 2 }),
      kernelInstance: {
        exports: {
          kernel_spawn_process: () => 100,
          kernel_remove_process: vi.fn(),
          kernel_get_fd_accept_wake_idx: (_pid: number, fd: number) =>
            fd === 4 ? 41 : -1,
          kernel_find_listener_fd_by_accept_wake:
            (_pid: number, wakeIdx: number) => wakeIdx === 41 ? 4 : -1,
        },
      },
      tcpListenerTargets: new Map([[8080, [{
        pid: 7,
        fd: 4,
        acceptWakeIdx: 41,
      }]]]),
      tcpListenerRRIndex: new Map([[8080, 0]]),
      tcpListeners: new Map([["7:4", listener]]),
    });

    writeChannelSyscall(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      [pathPtr, path.length, blobPtr, 40, 0, 0],
    );
    worker.handleSyscall(channel);
    await flushMicrotasks();
    expect(worker.callbacks.onResolveSpawn).toHaveBeenCalledOnce();
    expect(
      worker.callbacks.onSpawn,
      JSON.stringify(readChannelCompletion(channel)),
    ).toHaveBeenCalledOnce();

    expect(worker.tcpListenerTargets.get(8080)).toContainEqual({
      pid: 100,
      fd: 4,
      acceptWakeIdx: 41,
    });
    worker.cleanupTcpListeners(7);
    expect(close).not.toHaveBeenCalled();
    expect(worker.pickListenerTarget(8080)).toBeNull();

    const childMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    worker.registerProcess(100, childMemory, [0]);
    expect(worker.pickListenerTarget(8080)).toEqual({ pid: 100, fd: 4 });

    finishSpawn(0);
    await flushMicrotasks();
  });

  it("drops a stale channel listener after the pid is re-registered", async () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const newMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const oldChannel = createChannel(7, oldMemory, 0);
    const newChannel = createChannel(7, newMemory, 0);
    const kernelHandleChannel = vi.fn(() => 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [oldChannel], memory: oldMemory }]]),
      activeChannels: [oldChannel],
      usePolling: false,
      relistenBatchSize: 64,
      kernelInstance: {
        exports: { kernel_handle_channel: kernelHandleChannel },
      },
    });

    let wake!: (value: "ok") => void;
    const waited = new Promise<"ok">((resolve) => { wake = resolve; });
    const waitAsync = vi.spyOn(Atomics, "waitAsync").mockReturnValue({
      async: true,
      value: waited,
    } as any);
    try {
      worker.listenOnChannel(oldChannel);
      worker.processes.set(7, { channels: [newChannel], memory: newMemory });
      worker.activeChannels = [newChannel];
      wake("ok");
      await waited;
      await Promise.resolve();

      expect(waitAsync).toHaveBeenCalledTimes(1);
      expect(kernelHandleChannel).not.toHaveBeenCalled();

      // Even if the discarded mailbox becomes pending later, entering the
      // listener directly cannot dispatch it into the replacement process.
      Atomics.store(oldChannel.i32View, 0, 1);
      worker.listenOnChannel(oldChannel);
      expect(kernelHandleChannel).not.toHaveBeenCalled();
    } finally {
      waitAsync.mockRestore();
    }
  });

  it("keeps replacement retry state when an old-generation timer fires", () => {
    vi.useFakeTimers();
    try {
      const oldMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const newMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const oldChannel = createChannel(7, oldMemory, 0);
      const newChannel = createChannel(7, newMemory, 0);
      const kernelHandleChannel = vi.fn(() => 0);
      const worker = createWorker({
        processes: new Map([[7, { channels: [oldChannel], memory: oldMemory }]]),
        kernelInstance: {
          exports: { kernel_handle_channel: kernelHandleChannel },
        },
        profileData: null,
      });

      worker.handleBlockingRetry(oldChannel, 999, [0, 0, 0, 0, 0, 0]);
      vi.advanceTimersByTime(5);

      worker.processes.set(7, { channels: [newChannel], memory: newMemory });
      worker.handleBlockingRetry(newChannel, 999, [0, 0, 0, 0, 0, 0]);
      expect(worker.pendingPollRetries.has(oldChannel)).toBe(true);
      expect(worker.pendingPollRetries.has(newChannel)).toBe(true);

      vi.advanceTimersByTime(5);
      expect(worker.pendingPollRetries.has(oldChannel)).toBe(false);
      expect(worker.pendingPollRetries.has(newChannel)).toBe(true);
      expect(kernelHandleChannel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts bounded metadata above 64 KiB and rejects truthful overflows", () => {
    const worker = createWorker({});
    const aboveHistoricalLimit = Array.from({ length: 20 }, () => "x".repeat(4096));

    expect(worker.validateExecMetadata(["program"], aboveHistoricalLimit)).toBe(0);
    expect(worker.validateExecMetadata(["x".repeat(65_537)], [])).toBe(-7);
    expect(worker.validateExecMetadata([], Array.from({ length: 1024 }, () => "x".repeat(4096))))
      .toBe(-7);
  });

  it("accounts ARG_MAX using the exec caller's pointer width", () => {
    const worker = createWorker({});
    const nearBoundary = Array(8192).fill("x".repeat(504));

    expect(worker.validateExecMetadata(nearBoundary, [], 4)).toBe(0);
    expect(worker.validateExecMetadata(nearBoundary, [], 8)).toBe(-7);
  });

  it("reads long exec metadata without truncation and rejects oversized entries", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const arrayPtr = 0x100;
    const stringPtr = 0x1000;
    view.setUint32(arrayPtr, stringPtr, true);
    view.setUint32(arrayPtr + 4, 0, true);
    bytes.fill("a".charCodeAt(0), stringPtr, stringPtr + 5000);
    bytes[stringPtr + 5000] = 0;
    const worker = createWorker({});

    const parsed = worker.readStringArrayFromProcess(bytes, arrayPtr, 4);
    expect(parsed).toEqual({ values: ["a".repeat(5000)] });

    bytes.fill("b".charCodeAt(0), stringPtr, stringPtr + 65_537);
    bytes[stringPtr + 65_537] = 0;
    expect(worker.readStringArrayFromProcess(bytes, arrayPtr, 4)).toEqual({ errno: 7 });
  });

  it("accepts a pointer array whose terminator follows 1024 entries", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const arrayPtr = 0x100;
    const stringPtr = 0x2000;
    bytes[stringPtr] = "x".charCodeAt(0);
    bytes[stringPtr + 1] = 0;
    for (let i = 0; i < 1024; i++) {
      view.setUint32(arrayPtr + i * 4, stringPtr, true);
    }
    view.setUint32(arrayPtr + 1024 * 4, 0, true);
    const worker = createWorker({});

    const parsed = worker.readStringArrayFromProcess(bytes, arrayPtr, 4);
    expect("values" in parsed && parsed.values).toHaveLength(1024);
  });

  it("rejects overlong or inaccessible exec paths instead of truncating them", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const bytes = new Uint8Array(memory.buffer);
    const pathPtr = 0x1000;
    const worker = createWorker({});

    bytes.fill("a".charCodeAt(0), pathPtr, pathPtr + 4095);
    bytes[pathPtr + 4095] = 0;
    expect(worker.readExecPathFromProcess(bytes, pathPtr)).toEqual({
      value: "a".repeat(4095),
    });

    bytes.fill("b".charCodeAt(0), pathPtr, pathPtr + 4096);
    bytes[pathPtr + 4096] = 0;
    expect(worker.readExecPathFromProcess(bytes, pathPtr)).toEqual({ errno: 36 });

    bytes[bytes.byteLength - 1] = "c".charCodeAt(0);
    expect(worker.readExecPathFromProcess(bytes, bytes.byteLength - 1)).toEqual({ errno: 14 });
    expect(worker.readExecPathFromProcess(bytes, 0)).toEqual({ errno: 14 });
  });

  it("replaces metadata entry by entry and clears an empty environment", () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 2 });
    const clears: Array<[number, number]> = [];
    const pushes: Array<{ pid: number; kind: number; bytes: Uint8Array }> = [];
    const worker = createWorker({
      kernelMemory,
      toKernelPtr: (value: number) => value,
      kernelInstance: {
        exports: {
          kernel_clear_process_metadata: (pid: number, kind: number) => {
            clears.push([pid, kind]);
            return 0;
          },
          kernel_push_process_metadata_entry: (
            pid: number,
            kind: number,
            ptr: number,
            len: number,
          ) => {
            pushes.push({
              pid,
              kind,
              bytes: new Uint8Array(kernelMemory.buffer, ptr, len).slice(),
            });
            if (pushes.length === 1) kernelMemory.grow(1);
            return 0;
          },
        },
      },
    });

    worker.replaceProcessMetadata(7, 0, ["program", ""]);
    worker.replaceProcessMetadata(7, 1, []);

    expect(clears).toEqual([[7, 0], [7, 1]]);
    expect(pushes.map(entry => ({
      pid: entry.pid,
      kind: entry.kind,
      value: new TextDecoder().decode(entry.bytes),
    }))).toEqual([
      { pid: 7, kind: 0, value: "program" },
      { pid: 7, kind: 0, value: "" },
    ]);
  });

  it.each([
    "kernel_clear_process_metadata",
    "kernel_push_process_metadata_entry",
  ])("fails loudly when required metadata export %s is absent", (missing) => {
    const kernelMemory = new WebAssembly.Memory({ initial: 2 });
    const clear = vi.fn(() => 0);
    const push = vi.fn(() => 0);
    const exports: Record<string, unknown> = {
      kernel_clear_process_metadata: clear,
      kernel_push_process_metadata_entry: push,
    };
    delete exports[missing];
    const worker = createWorker({
      kernelMemory,
      toKernelPtr: (value: number) => value,
      kernelInstance: { exports },
    });
    const scratchBefore = new Uint8Array(kernelMemory.buffer).slice();

    expect(() => worker.replaceProcessMetadata(7, 0, ["program", "arg"]))
      .toThrow(/required bounded process metadata exports/);
    expect(clear).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(new Uint8Array(kernelMemory.buffer)).toEqual(scratchBefore);
  });

  it("flushes file-backed mappings before commit and forgets them afterward", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const channel = { pid: 7, memory };
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const writes: Array<{ fd: number; length: number; offset: number }> = [];
    const kernelHandleChannel = vi.fn((scratch: number) => {
      const view = new DataView(kernelMemory.buffer, scratch);
      const length = Number(view.getBigInt64(
        CH_ARGS + 2 * CH_ARG_SIZE,
        true,
      ));
      writes.push({
        fd: Number(view.getBigInt64(CH_ARGS, true)),
        length,
        offset: Number(view.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true)),
      });
      view.setBigInt64(CH_RETURN, BigInt(length), true);
      return 0;
    });
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, { fd: 4, fileOffset: 0x2000, len: 0x3000, writable: true }],
      ])]]),
      kernelMemory,
      kernelInstance: {
        exports: { kernel_handle_channel: kernelHandleChannel },
      },
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);

    expect(writes).toEqual([{
      fd: 4,
      length: 0x3000,
      offset: 0x2000,
    }]);
    expect(worker.sharedMappings.has(7)).toBe(true);
    expect(worker.finalizeAddressSpaceForExec(7)).toBe(0);
    expect(worker.sharedMappings.has(7)).toBe(false);
  });

  it("retains mapping trackers when a pre-commit flush fails", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const worker = createWorker({
      processes: new Map([[7, { channels: [{ pid: 7, memory }], memory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, { fd: 4, fileOffset: 0, len: 0x1000, writable: true }],
      ])]]),
      kernelMemory,
      kernelInstance: {
        exports: {
          kernel_handle_channel: (scratch: number) => {
            new DataView(kernelMemory.buffer, scratch)
              .setBigInt64(CH_RETURN, 0n, true);
            return 0;
          },
        },
      },
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(-5);
    expect(worker.sharedMappings.has(7)).toBe(true);
  });

  it("does not flush read-only shared mappings during exec", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernelHandleChannel = vi.fn(() => 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [{ pid: 7, memory }], memory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, { fd: 4, fileOffset: 0, len: 0x1000, writable: false }],
      ])]]),
      kernelInstance: {
        exports: { kernel_handle_channel: kernelHandleChannel },
      },
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);
    expect(kernelHandleChannel).not.toHaveBeenCalled();
  });

  it("tracks mmap writeback only for kernel-classified writable regular fds", () => {
    const worker = createWorker({
      kernelInstance: {
        exports: {
          kernel_fd_supports_mmap_writeback: (_pid: number, fd: number) =>
            fd === 4 ? 1 : 0,
        },
      },
    });

    expect(worker.fdSupportsMmapWriteback(7, 4)).toBe(true);
    expect(worker.fdSupportsMmapWriteback(7, 5)).toBe(false);
  });

  it("reacquires pwrite scratch views after kernel memory growth", () => {
    const processMemory = new WebAssembly.Memory({ initial: 2 });
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 4 });
    const channel = createChannel(7, processMemory, 0);
    let calls = 0;
    const worker = createWorker({
      currentHandlePid: 0,
      processes: new Map([[7, { channels: [channel], memory: processMemory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, {
          fd: 4,
          fileOffset: 0,
          len: CH_DATA_SIZE + 4,
          writable: true,
        }],
      ])]]),
      kernelMemory,
      kernelInstance: {
        exports: {
          kernel_handle_channel: (offset: number) => {
            const args = new DataView(kernelMemory.buffer, offset);
            const requested = Number(args.getBigInt64(
              CH_ARGS + 2 * CH_ARG_SIZE,
              true,
            ));
            kernelMemory.grow(1);
            new DataView(kernelMemory.buffer, offset).setBigInt64(
              CH_RETURN,
              BigInt(requested),
              true,
            );
            calls++;
          },
        },
      },
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);
    expect(calls).toBe(2);
    expect(worker.currentHandlePid).toBe(0);
  });

  it("copies SysV mappings before commit and detaches them afterward", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 0x1000, 4).set([1, 2, 3, 4]);
    const kernelMemory = new WebAssembly.Memory({ initial: 2 });
    const writeChunk = vi.fn(() => 4);
    const readChunk = vi.fn((_id: number, _offset: number, outPtr: number, len: number) => {
      new Uint8Array(kernelMemory.buffer, outPtr, len).fill(0);
      return len;
    });
    const detach = vi.fn(() => 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [{ pid: 7, memory }], memory }]]),
      shmMappings: new Map([[7, new Map([
        [0x1000, {
          segId: 3,
          size: 4,
          readOnly: false,
          snapshot: new Uint8Array(4),
          seenVersion: 0,
        }],
      ])]]),
      shmSegmentVersions: new Map([[3, 0]]),
      currentHandlePid: 0,
      kernelMemory,
      getKernelMem: () => new Uint8Array(kernelMemory.buffer),
      toKernelPtr: (value: number) => value,
      kernelInstance: {
        exports: {
          kernel_ipc_shm_read_chunk: readChunk,
          kernel_ipc_shm_write_chunk: writeChunk,
          kernel_ipc_shmdt_for_process: detach,
        },
      },
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);
    expect(writeChunk).toHaveBeenCalledWith(
      3,
      0,
      workerScratchPointer(worker) + CH_DATA,
      4,
    );
    expect(detach).not.toHaveBeenCalled();
    expect(worker.shmMappings.has(7)).toBe(true);

    expect(worker.finalizeAddressSpaceForExec(7)).toBe(0);
    expect(detach).toHaveBeenCalledWith(7, 3);
    expect(worker.shmMappings.has(7)).toBe(false);
  });

  it("validates the caller before setup and prunes closed epoll mirrors", () => {
    let ambientPid = 0;
    let preparedCaller = 0;
    const openFds = new Set([6, 8]);
    const worker = createWorker({
      currentHandlePid: 0,
      kernelInstance: {
        exports: {
          kernel_exec_prepare: (_pid: number, tid: number) => {
            ambientPid = worker.currentHandlePid;
            preparedCaller = tid;
            return 0;
          },
          kernel_exec_setup_for_thread: (_pid: number, _tid: number) => {
            ambientPid = worker.currentHandlePid;
            return 0;
          },
          kernel_fd_is_open: (_pid: number, fd: number) => openFds.has(fd) ? 1 : 0,
        },
      },
      epollInterests: new Map([
        ["7:6", [
          { fd: 8, events: 1, data: 11n },
          { fd: 9, events: 1, data: 12n },
        ]],
        ["7:10", []],
      ]),
    });

    expect(worker.kernelExecPrepare(7, 11)).toBe(0);
    expect(preparedCaller).toBe(11);
    expect(ambientPid).toBe(7);
    expect(worker.currentHandlePid).toBe(0);
    expect(worker.kernelExecSetup(7, 11)).toBe(0);
    expect(ambientPid).toBe(7);
    expect(worker.currentHandlePid).toBe(0);
    expect(worker.epollInterests.get("7:6")).toEqual([
      { fd: 8, events: 1, data: 11n },
    ]);
    expect(worker.epollInterests.has("7:10")).toBe(false);
  });

  it("fails loudly when either exact-caller exec export is absent", () => {
    const missingPrepare = createWorker({
      currentHandlePid: 0,
      kernelInstance: {
        exports: { kernel_exec_setup_for_thread: vi.fn(() => 0) },
      },
    });
    const missingSetup = createWorker({
      currentHandlePid: 0,
      kernelInstance: {
        exports: { kernel_exec_prepare: vi.fn(() => 0) },
      },
    });

    expect(() => missingPrepare.kernelExecPrepare(7, 11)).toThrow(
      "Kernel missing required kernel_exec_prepare export",
    );
    expect(() => missingSetup.kernelExecSetup(7, 11)).toThrow(
      "Kernel missing required kernel_exec_setup_for_thread export",
    );
  });

  it("remaps a TCP listener mirror to its surviving fd alias", () => {
    let committed = false;
    const close = vi.fn();
    const listener = {
      server: { close },
      pid: 7,
      port: 8080,
      connections: new Set(),
    };
    const worker = createWorker({
      currentHandlePid: 0,
      kernelInstance: {
        exports: {
          kernel_exec_setup_for_thread: () => {
            committed = true;
            return 0;
          },
          kernel_fd_is_open: (_pid: number, fd: number) => committed && fd === 2048 ? 1 : 0,
          kernel_get_fd_accept_wake_idx: (_pid: number, fd: number) => {
            if (fd === 2048) return 41;
            return !committed && fd === 4 ? 41 : -1;
          },
          kernel_find_listener_fd_by_accept_wake: (_pid: number, wakeIdx: number) =>
            committed && wakeIdx === 41 ? 2048 : -1,
        },
      },
      tcpListenerTargets: new Map([[8080, [{ pid: 7, fd: 4 }]]]),
      tcpListenerRRIndex: new Map([[8080, 0]]),
      tcpListeners: new Map([["7:4", listener]]),
    });

    expect(worker.kernelExecSetup(7, 7)).toBe(0);
    expect(worker.tcpListenerTargets.get(8080)).toEqual([{ pid: 7, fd: 2048 }]);
    expect(worker.tcpListeners.has("7:4")).toBe(false);
    expect(worker.tcpListeners.get("7:2048")).toEqual(listener);
    expect(close).not.toHaveBeenCalled();
  });

  it("remaps a listener after its original mirrored fd was already closed", () => {
    const listener = {
      server: { close: vi.fn() },
      pid: 7,
      port: 8080,
      connections: new Set(),
    };
    const worker = createWorker({
      currentHandlePid: 0,
      kernelInstance: {
        exports: {
          kernel_exec_setup_for_thread: () => 0,
          kernel_fd_is_open: (_pid: number, fd: number) => fd === 2048 ? 1 : 0,
          kernel_get_fd_accept_wake_idx: (_pid: number, fd: number) =>
            fd === 2048 ? 41 : -1,
          kernel_find_listener_fd_by_accept_wake: (_pid: number, wakeIdx: number) =>
            wakeIdx === 41 ? 2048 : -1,
        },
      },
      tcpListenerTargets: new Map([[8080, [{
        pid: 7,
        fd: 4,
        acceptWakeIdx: 41,
      }]]]),
      tcpListenerRRIndex: new Map([[8080, 0]]),
      tcpListeners: new Map([["7:4", listener]]),
    });

    expect(worker.kernelExecSetup(7, 7)).toBe(0);
    expect(worker.tcpListenerTargets.get(8080)).toEqual([{
      pid: 7,
      fd: 2048,
      acceptWakeIdx: 41,
    }]);
    expect(worker.tcpListeners.get("7:2048")).toEqual(listener);
    expect(listener.server.close).not.toHaveBeenCalled();
  });

  it("finalizes signal death during the exec handoff exactly once", () => {
    const getParentPid = vi.fn(() => 0);
    const onExit = vi.fn();
    const worker = createWorker({
      hostReaped: new Set(),
      callbacks: { onExit },
      kernelInstance: {
        exports: {
          kernel_get_parent_pid: getParentPid,
          kernel_get_process_exit_signal: () => 15,
        },
      },
      sharedMappings: new Map([[7, new Map([[0x1000, { fd: 4 }]])]]),
    });

    expect(worker.finalizeExecHandoffTermination(7)).toBe(15);
    expect(worker.finalizeExecHandoffTermination(7)).toBe(15);
    expect(getParentPid).toHaveBeenCalledOnce();
    expect(getParentPid).toHaveBeenCalledWith(7);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(7, 143);
    expect(worker.sharedMappings.has(7)).toBe(false);
  });

  it("fails when the required process-exit-signal export is absent", () => {
    const worker = createWorker({
      kernelInstance: {
        exports: {
          kernel_get_process_exit_signal: undefined,
        },
      },
    });

    expectGateFailureCause(
      () => worker.finalizeExecHandoffTermination(7),
      "Kernel missing required kernel_get_process_exit_signal export",
    );
  });

  it("does not launch a signal-dead pending child or roll back its zombie", () => {
    const getParentPid = vi.fn(() => 0);
    const onExit = vi.fn();
    const removeProcess = vi.fn();
    const listenerClose = new Map([
      [8, vi.fn()],
      [9, vi.fn()],
      [10, vi.fn()],
      [11, vi.fn()],
    ]);
    const worker = createWorker({
      hostReaped: new Set(),
      callbacks: { onExit },
      kernelInstance: {
        exports: {
          kernel_get_parent_pid: getParentPid,
          kernel_get_process_exit_signal: (pid: number) => {
            if (pid === 8) return 9;
            if (pid === 9) return -1;
            if (pid === 10) return 0;
            return -3;
          },
          kernel_remove_process: removeProcess,
        },
      },
      tcpListeners: new Map(
        Array.from(listenerClose, ([pid, close]) => [
          `${pid}:4`,
          {
            server: { close },
            pid,
            port: 8000 + pid,
            connections: new Set(),
          },
        ]),
      ),
      epollInterests: new Map([
        ["8:4", [{ fd: 6, events: 1, data: 1n }]],
        ["9:4", [{ fd: 6, events: 1, data: 2n }]],
        ["10:4", [{ fd: 6, events: 1, data: 3n }]],
        ["11:4", [{ fd: 6, events: 1, data: 4n }]],
      ]),
    });

    expect(worker.shouldLaunchPendingChild(8)).toBe(false);
    expect(worker.shouldLaunchPendingChild(9)).toBe(true);
    expect(worker.shouldLaunchPendingChild(10)).toBe(false);
    expect(worker.shouldLaunchPendingChild(11)).toBe(false);
    expect(getParentPid).toHaveBeenCalledWith(8);
    expect(onExit).toHaveBeenCalledWith(8, 137);
    expect(listenerClose.get(8)).toHaveBeenCalledOnce();
    expect(listenerClose.get(9)).not.toHaveBeenCalled();
    expect(listenerClose.get(10)).toHaveBeenCalledOnce();
    expect(listenerClose.get(11)).toHaveBeenCalledOnce();
    expect(worker.epollInterests.has("8:4")).toBe(false);
    expect(worker.epollInterests.has("9:4")).toBe(true);
    expect(worker.epollInterests.has("10:4")).toBe(false);
    expect(worker.epollInterests.has("11:4")).toBe(false);
    expect(removeProcess).not.toHaveBeenCalled();
  });
});

const workerKernelExports = new WeakMap<
  CentralizedKernelWorker,
  Record<string, unknown>
>();
const workerKernelMemories = new WeakMap<
  CentralizedKernelWorker,
  WebAssembly.Memory
>();
const workerScratchPointers = new WeakMap<CentralizedKernelWorker, number>();

function createWorker(overrides: Record<string, unknown>): any {
  const callbacks = (overrides.callbacks ?? {}) as ConstructorParameters<
    typeof CentralizedKernelWorker
  >[2];
  const io = (overrides.io ?? { network: undefined }) as ConstructorParameters<
    typeof CentralizedKernelWorker
  >[1];
  const worker = createCentralizedKernelWorkerTestDouble({ callbacks, io });

  // Seed only real writable state slots. Method shadows and raw
  // instance/memory fields are deliberately ignored: the test must exercise
  // the frozen production methods against one genuine gated Wasm instance.
  for (const [name, value] of Object.entries(overrides)) {
    if (name === "callbacks" || name === "io") continue;
    if (Object.prototype.hasOwnProperty.call(worker, name)) {
      Reflect.set(worker, name, value);
    }
  }

  const suppliedInstance = overrides.kernelInstance as
    | { exports?: Record<string, unknown> }
    | undefined;
  const suppliedExports = suppliedInstance?.exports ?? {};
  const exports: Record<string, unknown> = { ...suppliedExports };
  if (!Object.prototype.hasOwnProperty.call(
    suppliedExports,
    "kernel_get_process_exit_signal",
  )) {
    exports.kernel_get_process_exit_signal = vi.fn(() => -1);
  }
  if (!Object.prototype.hasOwnProperty.call(
    suppliedExports,
    "kernel_handle_channel",
  )) {
    exports.kernel_handle_channel = vi.fn(() => 0);
  }
  for (const name of [
    "kernel_drain_wakeup_events",
    "kernel_get_parent_pid",
    "kernel_get_process_state",
    "kernel_set_current_tid",
    "kernel_thread_exit",
    "kernel_validate_task",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(suppliedExports, name)) {
      exports[name] = vi.fn(() => 0);
    }
  }

  const kernelMemory = overrides.kernelMemory instanceof WebAssembly.Memory
    ? overrides.kernelMemory
    : new WebAssembly.Memory({ initial: 4, maximum: 8 });
  const requestedPointerWidth = (
    overrides.kernel as { getKernelPtrWidth?: () => unknown } | undefined
  )?.getKernelPtrWidth?.();
  const pointerWidth = requestedPointerWidth === 8 ? 8 : 4;
  const scratchPointer = typeof overrides.scratchPointer === "number"
    ? overrides.scratchPointer
    : 128;
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    scratchPointer,
    pointerWidth,
    {
      kernelExports: exports,
      kernelExportNames: Object.entries(exports)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name),
    },
  );
  workerKernelExports.set(worker, exports);
  workerKernelMemories.set(worker, kernelMemory);
  workerScratchPointers.set(worker, scratchPointer);
  return worker;
}

function workerScratchPointer(worker: CentralizedKernelWorker): number {
  const pointer = workerScratchPointers.get(worker);
  if (pointer === undefined) throw new Error("test worker has no scratch pointer");
  return pointer;
}

function expectGateFailureCause(
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

async function issueThreadAttachment(
  worker: CentralizedKernelWorker,
  channel: ReturnType<typeof createChannel>,
  tid: number,
  fnPtr = 1,
  argPtr = 2,
) {
  let attachment: Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0]
    | undefined;
  new DataView(channel.memory.buffer, channel.channelOffset)
    .setUint32(CH_DATA, fnPtr, true);
  new DataView(channel.memory.buffer, channel.channelOffset)
    .setUint32(CH_DATA + 4, argPtr, true);
  (worker as any).callbacks = {
    onClone: (
      value: Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0],
    ) => {
      attachment = value;
      return new Promise<void>(() => {});
    },
  };
  const exports = workerKernelExports.get(worker);
  if (!exports) throw new Error("test worker has no gated export resolver");
  const kernelMemory = workerKernelMemories.get(worker);
  if (!kernelMemory) throw new Error("test worker has no kernel Memory");
  exports.kernel_handle_channel = vi.fn(
    (offset: number | bigint) => {
      const scratchPointer = workerScratchPointers.get(worker);
      if (scratchPointer === undefined || Number(offset) !== scratchPointer) {
        throw new Error("clone did not use the owned test scratch region");
      }
      const kernelView = new DataView(kernelMemory.buffer, Number(offset));
      kernelView.setBigInt64(CH_RETURN, BigInt(tid), true);
      return 0;
    },
  );
  const processView = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  processView.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  processView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Clone, true);
  for (let index = 0; index < 6; index++) {
    processView.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, 0n, true);
  }
  (worker as any).handleSyscall(channel);
  for (let index = 0; index < 8 && !attachment; index++) {
    await Promise.resolve();
  }
  if (!attachment) throw new Error("clone callback did not receive attachment");
  return attachment;
}

function resolvedProgram() {
  const programBytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ]).buffer;
  return {
    programBytes,
    programModule: new WebAssembly.Module(programBytes),
    argv: [],
  };
}

function writeChannelSyscall(
  channel: ReturnType<typeof createChannel>,
  syscall: number,
  args: readonly number[],
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
}

function readChannelStatus(
  channel: ReturnType<typeof createChannel>,
): number {
  return new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  ).getUint32(CH_STATUS, true);
}

function readChannelCompletion(
  channel: ReturnType<typeof createChannel>,
): { status: number; returnValue: number; errno: number } {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  return {
    status: view.getUint32(CH_STATUS, true),
    returnValue: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

async function flushMicrotasks(turns = 16): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
  }
}

async function flushMicrotasksUntil(
  condition: () => boolean,
  failureMessage: string,
  turns = 32,
): Promise<void> {
  for (let index = 0; index < turns; index++) {
    if (condition()) return;
    await Promise.resolve();
  }
  if (!condition()) throw new Error(failureMessage);
}

function createChannel(pid: number, memory: WebAssembly.Memory, channelOffset: number): any {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}
