import { describe, expect, it, vi } from "vitest";
import {
  CentralizedKernelWorker,
  isCurrentProcessGeneration,
} from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_DATA_SIZE,
  CH_RETURN,
  HOST_INTERCEPTED_SYSCALLS,
} from "../src/generated/abi";

describe("exec host-state transition", () => {
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

  it("drops discarded-image async and thread-channel state", () => {
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

      worker.prepareProcessForExec(7);

      expect(worker.processes.has(7)).toBe(true);
      expect(worker.processes.get(7).channels).toEqual([]);
      expect(worker.isExecHandoffActive(7)).toBe(true);
      expect(() => worker.addChannel(7, 512)).toThrow(/replacing its image/);
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

  it("rejects an old-memory clone after replacement registration", () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1 });
    const newMemory = new WebAssembly.Memory({ initial: 1 });
    const worker = createWorker({
      processes: new Map([[7, { channels: [], memory: newMemory }]]),
    });

    expect(() => worker.addChannel(7, 512, 11, 1, 2, oldMemory))
      .toThrow(/changed memory generation/);
    expect(worker.processes.get(7).channels).toEqual([]);
  });

  it("keeps concurrent sleeps independent across one process's threads", async () => {
    vi.useFakeTimers();
    try {
      const memory = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
      const mainChannel = createChannel(7, memory, 0);
      const threadChannel = createChannel(7, memory, 0x10000);
      const completeSleep = vi.fn();
      const worker = createWorker({
        processes: new Map([[7, {
          channels: [mainChannel, threadChannel],
          memory,
        }]]),
        completeSleepWithSignalCheck: completeSleep,
      });

      expect(worker.handleSleepDelay(
        mainChannel, ABI_SYSCALLS.Usleep, [50_000], 0, 0,
      )).toBe(true);
      expect(worker.handleSleepDelay(
        threadChannel, ABI_SYSCALLS.Usleep, [10_000], 0, 0,
      )).toBe(true);
      expect(worker.pendingSleeps.size).toBe(2);

      await vi.advanceTimersByTimeAsync(10);
      expect(completeSleep).toHaveBeenCalledTimes(1);
      expect(completeSleep).toHaveBeenLastCalledWith(
        threadChannel, ABI_SYSCALLS.Usleep, [10_000], 0, 0,
      );
      expect(worker.pendingSleeps.has(mainChannel)).toBe(true);

      await vi.advanceTimersByTimeAsync(40);
      expect(completeSleep).toHaveBeenCalledTimes(2);
      expect(completeSleep).toHaveBeenLastCalledWith(
        mainChannel, ABI_SYSCALLS.Usleep, [50_000], 0, 0,
      );
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

  it("does not wake a signal-dead image after async exec failure", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const channel = createChannel(7, memory, 0);
    const handleProcessTerminated = vi.fn();
    const completeChannel = vi.fn();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      getProcessExitSignal: vi.fn(() => 11),
      handleProcessTerminated,
      completeChannel,
    });

    worker.finishFailedExec(channel, 211, [0, 0, 0], 3);

    expect(handleProcessTerminated).toHaveBeenCalledWith(channel);
    expect(completeChannel).not.toHaveBeenCalled();
  });

  it("does not wake a normally reaped image after async exec failure", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const channel = createChannel(7, memory, 0);
    const getProcessExitSignal = vi.fn(() => 0);
    const completeChannel = vi.fn();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      hostReaped: new Set([7]),
      getProcessExitSignal,
      completeChannel,
    });

    worker.finishFailedExec(channel, 211, [0, 0, 0], 3);

    expect(getProcessExitSignal).not.toHaveBeenCalled();
    expect(completeChannel).not.toHaveBeenCalled();
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
    const completeChannel = vi.fn();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onResolveSpawn: vi.fn(() => program),
        onSpawn,
      },
      completeChannel,
      kernelInstance: {
        exports: { kernel_spawn_process: kernelSpawn },
      },
    });

    worker.handleSpawn(channel, [pathPtr, path.length, blobPtr, 40, 0, 0]);
    worker.processes.get(7).channels = [];
    resolveProgram(resolvedProgram());
    await Promise.resolve();
    await Promise.resolve();

    expect(kernelSpawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(completeChannel).not.toHaveBeenCalled();
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
    const completeChannel = vi.fn();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: {
        onResolveSpawn: vi.fn(async () => ({ errno: 8 })),
        onSpawn,
      },
      completeChannel,
      kernelInstance: {
        exports: { kernel_spawn_process: kernelSpawn },
      },
    });

    worker.handleSpawn(channel, [pathPtr, path.length, blobPtr, 40, 0, 0]);
    await Promise.resolve();
    await Promise.resolve();

    expect(kernelSpawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      [pathPtr, path.length, blobPtr, 40, 0, 0],
      undefined,
      -1,
      8,
    );
  });

  it("keeps a created spawn child but suppresses stale parent completion", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = createChannel(7, memory, 0);
    let finishSpawn!: (result: number) => void;
    const spawned = new Promise<number>((resolve) => {
      finishSpawn = resolve;
    });
    const kernelSpawn = vi.fn(() => 100);
    const removeProcess = vi.fn();
    const completeChannel = vi.fn();
    const onSpawn = vi.fn(() => spawned);
    const program = resolvedProgram();
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      callbacks: { onSpawn },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 1 }),
      scratchOffset: 0,
      toKernelPtr: (value: number) => value,
      kernelInstance: {
        exports: {
          kernel_spawn_process: kernelSpawn,
          kernel_remove_process: removeProcess,
        },
      },
    });

    worker.handleSpawnAfterResolve(
      channel,
      [0, 0, 0, 40, 0, 0],
      7,
      0,
      new Uint8Array(40),
      40,
      program,
      [],
    );
    expect(onSpawn).toHaveBeenCalledWith(100, program, []);
    worker.processes.get(7).channels = [];
    finishSpawn(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(kernelSpawn).toHaveBeenCalled();
    expect(removeProcess).not.toHaveBeenCalled();
    expect(completeChannel).not.toHaveBeenCalled();
  });

  it("installs spawn-child listener mirrors before async worker launch", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = createChannel(7, memory, 0);
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
      callbacks: { onSpawn: vi.fn(() => spawned) },
      completeChannel: vi.fn(),
      kernelMemory: new WebAssembly.Memory({ initial: 1 }),
      scratchOffset: 0,
      toKernelPtr: (value: number) => value,
      kernelInstance: {
        exports: {
          kernel_spawn_process: () => 100,
          kernel_remove_process: vi.fn(),
          kernel_get_fd_accept_wake_idx: (_pid: number, fd: number) =>
            fd === 4 ? 41 : -1,
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

    worker.handleSpawnAfterResolve(
      channel,
      [0, 0, 0, 40, 0, 0],
      7,
      0,
      new Uint8Array(40),
      40,
      resolvedProgram(),
      [],
    );

    expect(worker.tcpListenerTargets.get(8080)).toContainEqual({
      pid: 100,
      fd: 4,
      acceptWakeIdx: 41,
    });
    worker.cleanupTcpListeners(7);
    expect(close).not.toHaveBeenCalled();
    finishSpawn(0);
    await Promise.resolve();
  });

  it("drops a stale channel listener after the pid is re-registered", async () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const newMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const oldChannel = createChannel(7, oldMemory, 0);
    const newChannel = createChannel(7, newMemory, 0);
    const worker = createWorker({
      processes: new Map([[7, { channels: [oldChannel], memory: oldMemory }]]),
      activeChannels: [oldChannel],
      usePolling: false,
      relistenBatchSize: 64,
    });
    const handleSyscall = vi.fn();
    worker.handleSyscall = handleSyscall;

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
      expect(handleSyscall).not.toHaveBeenCalled();

      // Even if the discarded mailbox becomes pending later, entering the
      // listener directly cannot dispatch it into the replacement process.
      Atomics.store(oldChannel.i32View, 0, 1);
      worker.listenOnChannel(oldChannel);
      expect(handleSyscall).not.toHaveBeenCalled();
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
      const worker = createWorker({
        processes: new Map([[7, { channels: [oldChannel], memory: oldMemory }]]),
        kernelInstance: { exports: {} },
        profileData: null,
      });
      worker.retrySyscall = vi.fn();

      worker.handleBlockingRetry(oldChannel, 999, [0, 0, 0, 0, 0, 0]);
      vi.advanceTimersByTime(5);

      worker.processes.set(7, { channels: [newChannel], memory: newMemory });
      worker.handleBlockingRetry(newChannel, 999, [0, 0, 0, 0, 0, 0]);
      expect(worker.pendingPollRetries.has(oldChannel)).toBe(true);
      expect(worker.pendingPollRetries.has(newChannel)).toBe(true);

      vi.advanceTimersByTime(5);
      expect(worker.pendingPollRetries.has(oldChannel)).toBe(false);
      expect(worker.pendingPollRetries.has(newChannel)).toBe(true);
      expect(worker.retrySyscall).not.toHaveBeenCalled();
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
    const scratchOffset = 1024;
    const clears: Array<[number, number]> = [];
    const pushes: Array<{ pid: number; kind: number; bytes: Uint8Array }> = [];
    const worker = createWorker({
      kernelMemory,
      scratchOffset,
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

  it("feature-detects metadata replacement and retains legacy small argv", () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 1 });
    const setArgv = vi.fn((_pid: number, _ptr: number, len: number) => {
      expect(new TextDecoder().decode(
        new Uint8Array(kernelMemory.buffer, 0, len),
      )).toBe("program\0arg");
      return 0;
    });
    const worker = createWorker({
      kernelMemory,
      scratchOffset: 0,
      toKernelPtr: (value: number) => value,
      kernelInstance: {
        exports: { kernel_set_process_argv: setArgv },
      },
    });

    expect(worker.supportsExecMetadataReplacement()).toBe(false);
    worker.replaceProcessMetadata(7, 0, ["program", "arg"]);
    expect(setArgv).toHaveBeenCalled();
    expect(() => worker.replaceProcessMetadata(7, 1, []))
      .toThrow(/missing bounded process metadata exports/);
  });

  it("flushes file-backed mappings before commit and forgets them afterward", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const channel = { pid: 7, memory };
    const flush = vi.fn(() => true);
    const worker = createWorker({
      processes: new Map([[7, { channels: [channel], memory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, { fd: 4, fileOffset: 0x2000, len: 0x3000, writable: true }],
      ])]]),
      pwriteFromProcessMemory: flush,
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);

    expect(flush).toHaveBeenCalledWith(channel, 4, 0x1000, 0x3000, 0x2000);
    expect(worker.sharedMappings.has(7)).toBe(true);
    expect(worker.finalizeAddressSpaceForExec(7)).toBe(0);
    expect(worker.sharedMappings.has(7)).toBe(false);
  });

  it("retains mapping trackers when a pre-commit flush fails", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const worker = createWorker({
      processes: new Map([[7, { channels: [{ pid: 7, memory }], memory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, { fd: 4, fileOffset: 0, len: 0x1000, writable: true }],
      ])]]),
      pwriteFromProcessMemory: vi.fn(() => false),
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(-5);
    expect(worker.sharedMappings.has(7)).toBe(true);
  });

  it("does not flush read-only shared mappings during exec", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const flush = vi.fn(() => false);
    const worker = createWorker({
      processes: new Map([[7, { channels: [{ pid: 7, memory }], memory }]]),
      sharedMappings: new Map([[7, new Map([
        [0x1000, { fd: 4, fileOffset: 0, len: 0x1000, writable: false }],
      ])]]),
      pwriteFromProcessMemory: flush,
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);
    expect(flush).not.toHaveBeenCalled();
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
    const channel = { pid: 7, memory: processMemory };
    let calls = 0;
    const worker = createWorker({
      currentHandlePid: 0,
      kernelMemory,
      scratchOffset: 0,
      toKernelPtr: (value: number) => value,
      bindKernelTidForChannel: vi.fn(),
      kernelInstance: {
        exports: {
          kernel_handle_channel: () => {
            const args = new DataView(kernelMemory.buffer);
            const requested = Number(args.getBigInt64(
              CH_ARGS + 2 * CH_ARG_SIZE,
              true,
            ));
            kernelMemory.grow(1);
            new DataView(kernelMemory.buffer).setBigInt64(
              CH_RETURN,
              BigInt(requested),
              true,
            );
            calls++;
          },
        },
      },
    });

    expect(worker.pwriteFromProcessMemory(
      channel,
      4,
      0x1000,
      CH_DATA_SIZE + 4,
      0,
    )).toBe(true);
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
      scratchOffset: 0,
      getKernelMem: () => new Uint8Array(kernelMemory.buffer),
      toKernelPtr: (value: number) => value,
      kernelInstance: {
        exports: {
          kernel_set_current_pid: vi.fn(),
          kernel_ipc_shm_read_chunk: readChunk,
          kernel_ipc_shm_write_chunk: writeChunk,
          kernel_ipc_shmdt: detach,
        },
      },
    });

    expect(worker.prepareAddressSpaceForExec(7)).toBe(0);
    expect(writeChunk).toHaveBeenCalledWith(3, 0, 72, 4);
    expect(detach).not.toHaveBeenCalled();
    expect(worker.shmMappings.has(7)).toBe(true);

    expect(worker.finalizeAddressSpaceForExec(7)).toBe(0);
    expect(detach).toHaveBeenCalledWith(3);
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
          kernel_exec_setup: () => 0,
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
          kernel_exec_setup: () => 0,
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
          kernel_exec_setup: () => 0,
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

  it("keeps pending child listener targets during async worker launch", () => {
    const targets = [
      { pid: 7, fd: 4 },
      { pid: 8, fd: 4 },
    ];
    const worker = createWorker({
      processes: new Map([[7, { channels: [], memory: new WebAssembly.Memory({ initial: 1 }) }]]),
      tcpListenerTargets: new Map([[8080, targets]]),
      tcpListenerRRIndex: new Map([[8080, 0]]),
    });

    expect(worker.pickListenerTarget(8080)).toEqual({ pid: 7, fd: 4 });
    expect(worker.tcpListenerTargets.get(8080)).toEqual(targets);
  });

  it("reconciles a reused listener fd without losing its surviving alias", () => {
    const listener = {
      server: { close: vi.fn() },
      pid: 7,
      port: 8080,
      connections: new Set(),
    };
    const worker = createWorker({
      kernelInstance: {
        exports: {
          kernel_get_fd_accept_wake_idx: (_pid: number, fd: number) =>
            fd === 4 ? 99 : fd === 6 ? 41 : -1,
          kernel_find_listener_fd_by_accept_wake: (_pid: number, wakeIdx: number) =>
            wakeIdx === 41 ? 6 : wakeIdx === 99 ? 4 : -1,
        },
      },
      tcpListenerTargets: new Map([[8080, [{
        pid: 7,
        fd: 4,
        acceptWakeIdx: 41,
      }]]]),
      tcpListenerRRIndex: new Map([[8080, 0]]),
      tcpListeners: new Map([["7:4", listener]]),
      netModule: null,
    });

    worker.startTcpListener(7, 4, 9090);

    expect(worker.tcpListenerTargets.get(8080)).toEqual([{
      pid: 7,
      fd: 6,
      acceptWakeIdx: 41,
    }]);
    expect(worker.tcpListenerTargets.get(9090)).toEqual([{
      pid: 7,
      fd: 4,
      acceptWakeIdx: 99,
    }]);
    expect(worker.tcpListeners.get("7:6")).toEqual(listener);
    expect(listener.server.close).not.toHaveBeenCalled();
  });

  it("finalizes signal death during the exec handoff exactly once", () => {
    const notifyParent = vi.fn();
    const onExit = vi.fn();
    const worker = createWorker({
      hostReaped: new Set(),
      callbacks: { onExit },
      notifyParentOfExitedProcess: notifyParent,
      kernelInstance: {
        exports: {
          kernel_get_process_exit_signal: () => 15,
        },
      },
      sharedMappings: new Map([[7, new Map([[0x1000, { fd: 4 }]])]]),
    });

    expect(worker.finalizeExecHandoffTermination(7)).toBe(15);
    expect(worker.finalizeExecHandoffTermination(7)).toBe(15);
    expect(notifyParent).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(7, 143);
    expect(worker.sharedMappings.has(7)).toBe(false);
  });

  it("does not launch a signal-dead pending child or roll back its zombie", () => {
    const notifyParent = vi.fn();
    const onExit = vi.fn();
    const cleanupTcpListeners = vi.fn();
    const removeProcess = vi.fn();
    const worker = createWorker({
      hostReaped: new Set(),
      callbacks: { onExit },
      notifyParentOfExitedProcess: notifyParent,
      cleanupTcpListeners,
      kernelInstance: {
        exports: {
          kernel_get_process_exit_signal: (pid: number) => {
            if (pid === 8) return 9;
            if (pid === 9) return -1;
            if (pid === 10) return 0;
            return -3;
          },
          kernel_remove_process: removeProcess,
        },
      },
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
    expect(notifyParent).toHaveBeenCalledWith(8);
    expect(onExit).toHaveBeenCalledWith(8, 137);
    expect(cleanupTcpListeners.mock.calls).toEqual([[8], [10], [11]]);
    expect(worker.epollInterests.has("8:4")).toBe(false);
    expect(worker.epollInterests.has("9:4")).toBe(true);
    expect(worker.epollInterests.has("10:4")).toBe(false);
    expect(worker.epollInterests.has("11:4")).toBe(false);
    expect(removeProcess).not.toHaveBeenCalled();
  });
});

function createWorker(overrides: Record<string, unknown>): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    processes: new Map(),
    activeChannels: [],
    execHandoffPids: new Set(),
    waitingForChild: [],
    pendingSleeps: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    pendingFutexWaits: new Map(),
    pendingCancels: new Set(),
    socketTimeoutTimers: new Map(),
    posixTimers: new Map(),
    channelTids: new Map(),
    threadForkContexts: new Map(),
    threadCtidPtrs: new Map(),
    sharedMappings: new Map(),
    shmMappings: new Map(),
    epollInterests: new Map(),
    tcpListenerTargets: new Map(),
    tcpListenerRRIndex: new Map(),
    tcpVirtualListenerKeys: new Map(),
    tcpListeners: new Map(),
    tcpConnections: new Map(),
    hostReaped: new Set(),
    callbacks: {},
    io: { network: undefined },
    ...overrides,
  });
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

function createChannel(pid: number, memory: WebAssembly.Memory, channelOffset: number): any {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}
