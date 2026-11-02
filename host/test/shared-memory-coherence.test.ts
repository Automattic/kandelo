import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
} from "../src/generated/abi";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  createKernelSharedMappingStub,
  SYSV_MIRROR_EXPORT_NAMES,
  type SysvMirrorStub,
  type SysvMirrorStubOptions,
} from "./support/kernel-shared-mapping-stub";

function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

/**
 * Give a bare worker test double just enough kernel to resolve the SysV
 * mirror entry points, for the boundary early-out tests that have no other
 * kernel needs.
 */
function installSysvMirrorScratch(kw: unknown, sysv: SysvMirrorStub): void {
  installKernelWorkerTestScratch(
    kw as Record<string, unknown>,
    new WebAssembly.Memory({ initial: 2, maximum: 2 }),
    128,
    4,
    {
      kernelExports: { ...sysv.exports },
      kernelExportNames: [...SYSV_MIRROR_EXPORT_NAMES],
    },
  );
}

function writeChannelSyscall(
  channel: { memory: WebAssembly.Memory; channelOffset: number },
  syscallNr: number,
  args: readonly bigint[],
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_SYSCALL, syscallNr, true);
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      args[index] ?? 0n,
      true,
    );
  }
}

function anonymousHarness() {
  const parentPid = 41;
  const peerPid = 42;
  const childPid = 43;
  const mapAddr = 0x2000;
  const len = 256;
  const key = "anon:test";
  const parentMemory = sharedMemory();
  const peerMemory = sharedMemory();
  const childMemory = sharedMemory();
  const backing = {
    key,
    bytes: new Uint8Array(len),
    refCount: 2,
    version: 0,
  };
  const mapping = () => ({
    fd: -1,
    fileOffset: 0,
    len,
    writable: true,
    backingKey: key,
    snapshot: new Uint8Array(len),
    seenVersion: 0,
  });
  const channel = (pid: number, memory: WebAssembly.Memory) => ({
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer, 0, 1),
    consecutiveSyscalls: 0,
  });
  const parentChannel = channel(parentPid, parentMemory);
  const peerChannel = channel(peerPid, peerMemory);
  const childChannel = channel(childPid, childMemory);
  const kw = Object.assign(createCentralizedKernelWorkerTestDouble(), {
    anonymousSharedBackings: new Map([[key, backing]]),
    sharedMappings: new Map([
      [parentPid, new Map([[mapAddr, mapping()]])],
      [peerPid, new Map([[mapAddr, mapping()]])],
    ]),
    processes: new Map([
      [parentPid, { pid: parentPid, memory: parentMemory, channels: [parentChannel] }],
      [peerPid, { pid: peerPid, memory: peerMemory, channels: [peerChannel] }],
      [childPid, { pid: childPid, memory: childMemory, channels: [childChannel] }],
    ]),
  });
  installKernelWorkerTestScratch(
    kw as unknown as Record<string, unknown>,
    new WebAssembly.Memory({ initial: 2, maximum: 2 }),
    128,
    4,
    { kernelExportNames: [] },
  );
  return {
    backing,
    childMemory,
    childPid,
    key,
    kw,
    len,
    mapAddr,
    parentMemory,
    parentPid,
    peerMemory,
    peerPid,
  };
}

describe("anonymous MAP_SHARED coherence", () => {
  it("merges stale same-page publishers without losing disjoint peer writes", () => {
    const h = anonymousHarness();
    const parent = new Uint8Array(h.parentMemory.buffer);
    const peer = new Uint8Array(h.peerMemory.buffer);

    parent[h.mapAddr + 11] = 0xa1;
    (h.kw as any).syncAnonymousSharedMappingsFromProcess(
      (h.kw as any).processes.get(h.parentPid),
    );

    peer[h.mapAddr + 29] = 0xb2;
    (h.kw as any).syncAnonymousSharedMappingsFromProcess(
      (h.kw as any).processes.get(h.peerPid),
    );

    expect(h.backing.bytes[11]).toBe(0xa1);
    expect(h.backing.bytes[29]).toBe(0xb2);
    expect(peer[h.mapAddr + 11]).toBe(0xa1);
    expect(peer[h.mapAddr + 29]).toBe(0xb2);

    (h.kw as any).syncAnonymousSharedMappingsFromProcess(
      (h.kw as any).processes.get(h.parentPid),
    );
    expect(parent[h.mapAddr + 29]).toBe(0xb2);
  });

  it("force-publishes a sole observer before fork and inherits one backing", () => {
    const h = anonymousHarness();
    (h.kw as any).sharedMappings.delete(h.peerPid);
    h.backing.refCount = 1;
    new Uint8Array(h.parentMemory.buffer)[h.mapAddr + 7] = 0x7c;

    (h.kw as any).syncAnonymousSharedMappingsFromProcess(
      (h.kw as any).processes.get(h.parentPid),
      { force: true },
    );
    h.kw.inheritProcessSharedMappings(h.parentPid, h.childPid);

    expect(h.backing.bytes[7]).toBe(0x7c);
    expect(new Uint8Array(h.childMemory.buffer)[h.mapAddr + 7]).toBe(0x7c);
    expect(h.backing.refCount).toBe(2);
    expect((h.kw as any).sharedMappings.get(h.childPid).size).toBe(1);
  });

  it("refreshes a sole parent after its child publishes and detaches", () => {
    const h = anonymousHarness();
    (h.kw as any).sharedMappings.delete(h.peerPid);
    h.backing.refCount = 1;
    h.kw.inheritProcessSharedMappings(h.parentPid, h.childPid);

    const child = new Uint8Array(h.childMemory.buffer);
    child[h.mapAddr + 17] = 0x6d;
    (h.kw as any).syncAnonymousSharedMappingsFromProcess(
      (h.kw as any).processes.get(h.childPid),
    );
    expect(h.backing.bytes[17]).toBe(0x6d);
    expect(h.backing.refCount).toBe(2);

    (h.kw as any).releaseAllSharedMemoryForProcess(h.childPid);
    expect(h.backing.refCount).toBe(1);

    const parent = new Uint8Array(h.parentMemory.buffer);
    expect(parent[h.mapAddr + 17]).toBe(0);
    (h.kw as any).syncAnonymousSharedMappingsFromProcess(
      (h.kw as any).processes.get(h.parentPid),
    );
    expect(parent[h.mapAddr + 17]).toBe(0x6d);
  });

  it("publishes and releases backing references exactly once at teardown", () => {
    const h = anonymousHarness();
    new Uint8Array(h.parentMemory.buffer)[h.mapAddr + 3] = 0x55;

    (h.kw as any).releaseAllSharedMemoryForProcess(h.parentPid);
    expect(h.backing.bytes[3]).toBe(0x55);
    expect(h.backing.refCount).toBe(1);

    (h.kw as any).releaseAllSharedMemoryForProcess(h.parentPid);
    expect(h.backing.refCount).toBe(1);

    (h.kw as any).releaseAllSharedMemoryForProcess(h.peerPid);
    expect((h.kw as any).anonymousSharedBackings.has(h.key)).toBe(false);
  });

  it("rejects a stale pre-exec memory generation at a coherence boundary", () => {
    const h = anonymousHarness();
    const replacement = sharedMemory();
    (h.kw as any).processes.set(h.parentPid, {
      pid: h.parentPid,
      memory: replacement,
      channels: [],
    });
    new Uint8Array(h.parentMemory.buffer)[h.mapAddr + 1] = 0xff;

    (h.kw as any).synchronizeSharedMemoryForBoundary({
      pid: h.parentPid,
      memory: h.parentMemory,
    });

    expect(h.backing.bytes[1]).toBe(0);
  });

  it("skips coherence scans when no process has shared mappings", () => {
    const pid = 51;
    const process = { pid, memory: sharedMemory() };
    const processes = new Map([[pid, process]]);
    const getProcess = vi.spyOn(processes, "get");
    const sharedMappings = new Map<number, Map<number, unknown>>();
    const getPosixMappings = vi.spyOn(sharedMappings, "get");
    const sysv = createKernelSharedMappingStub();
    const kw = Object.assign(createCentralizedKernelWorkerTestDouble(), {
      processes,
      sharedMappings,
    });
    installSysvMirrorScratch(kw, sysv);

    (kw as any).synchronizeSharedMemoryForBoundary(process);

    expect(getProcess).toHaveBeenCalledWith(pid);
    expect(getPosixMappings).not.toHaveBeenCalled();
    // The SysV half is Rust-owned, so "no scan" means the kernel was never
    // entered at all -- not that a host container was left unread.
    expect(sysv.calls).toEqual([]);
  });

  it.each(["POSIX", "SysV"])(
    "runs coherence scans while %s shared mappings exist",
    (mappingKind) => {
      const pid = 52;
      const process = { pid, memory: sharedMemory() };
      const sharedMappings = mappingKind === "POSIX"
        ? new Map([[pid, new Map()]])
        : new Map<number, Map<number, unknown>>();
      const getPosixMappings = vi.spyOn(sharedMappings, "get");
      const sysv = createKernelSharedMappingStub();
      const kw = Object.assign(createCentralizedKernelWorkerTestDouble(), {
        processes: new Map([[pid, process]]),
        sharedMappings,
      });
      installSysvMirrorScratch(kw, sysv);
      if (mappingKind === "SysV") {
        sysv.seed(pid, 0x3000, { segId: 9, size: 256, readOnly: false });
        // The host's cached boundary predicate, as a shmat/fork/exec site
        // would have refreshed it from the kernel.
        (kw as any).kernelSharedMappingPids = new Set([pid]);
      }

      (kw as any).synchronizeSharedMemoryForBoundary(process);

      // Anonymous and file-backed POSIX scans share the same per-pid map, so
      // two real map reads prove both production scans ran without replacing
      // authority-bearing methods.
      expect(getPosixMappings).toHaveBeenCalledTimes(2);
      expect(getPosixMappings).toHaveBeenNthCalledWith(1, pid);
      expect(getPosixMappings).toHaveBeenNthCalledWith(2, pid);

      // The SysV sync is now narrower than the POSIX one: the kernel is
      // entered only when SysV shared memory exists somewhere on this
      // machine, so a POSIX-only machine pays nothing for it.
      expect(sysv.callsTo("kernel_shared_mapping_sync_process")).toEqual(
        mappingKind === "SysV"
          ? [{
            name: "kernel_shared_mapping_sync_process",
            args: [pid, 0],
          }]
          : [],
      );
    },
  );
});

function sysvHarness(options: SysvMirrorStubOptions = {}) {
  const pids = [61, 62, 63];
  const mapAddr = 0x3000;
  const size = 256;
  const segId = 9;
  const memories = new Map(pids.map((pid) => [pid, sharedMemory()]));
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const segment = new Uint8Array(size);
  const syntheticMemorySyscalls: Array<{
    syscallNr: number;
    args: bigint[];
  }> = [];
  const shmat = vi.fn(() => size);
  const shmdt = vi.fn(() => 0);
  const shmatForTask = vi.fn(() => size);
  const recordForProcess = vi.fn(() => 0);
  const recordForTask = vi.fn(() => 0);
  const lookupForTask = vi.fn((
    _pid: number,
    _tid: number,
    addr: number,
  ) => addr === mapAddr
    ? (BigInt(size) << 32n) | BigInt(segId)
    : -22n);
  const shmdtAddrForProcess = vi.fn(() => 0);
  const shmdtAddrForTask = vi.fn(() => 0);
  const validateTask = vi.fn(() => 0);
  const handleChannel = vi.fn((channelPtr: number | bigint) => {
    const view = new DataView(
      kernelMemory.buffer,
      Number(channelPtr),
      CH_TOTAL_SIZE,
    );
    syntheticMemorySyscalls.push({
      syscallNr: view.getUint32(CH_SYSCALL, true),
      args: Array.from(
        { length: 6 },
        (_, index) =>
          view.getBigInt64(CH_ARGS + index * CH_ARG_SIZE, true),
      ),
    });
    const syscallNr = view.getUint32(CH_SYSCALL, true);
    view.setBigInt64(
      CH_RETURN,
      syscallNr === ABI_SYSCALLS.Mmap ? -1n : 0n,
      true,
    );
    view.setUint32(
      CH_ERRNO,
      syscallNr === ABI_SYSCALLS.Mmap ? 12 : 0,
      true,
    );
    return 0;
  });
  const readChunk = vi.fn((id: number, offset: number, outPtr: number, maxLen: number) => {
    expect(id).toBe(segId);
    const len = Math.min(maxLen, segment.length - offset);
    new Uint8Array(kernelMemory.buffer).set(segment.subarray(offset, offset + len), outPtr);
    return len;
  });
  const writeChunk = vi.fn((id: number, offset: number, dataPtr: number, len: number) => {
    expect(id).toBe(segId);
    segment.set(new Uint8Array(kernelMemory.buffer, dataPtr, len), offset);
    return len;
  });
  const sysv = createKernelSharedMappingStub(options);
  const processes = new Map(pids.map((pid) => {
    const memory = memories.get(pid)!;
    return [pid, { pid, memory, channels: [{ pid, memory, channelOffset: 0 }] }];
  }));
  const kw = Object.assign(createCentralizedKernelWorkerTestDouble(), {
    currentHandlePid: 0,
    channelTids: new Map(),
    processes,
    sharedMappings: new Map(),
    anonymousSharedBackings: new Map(),
    // The byte mirror is Rust-owned; the host caches only the per-pid
    // predicate that gates its syscall-boundary early-out.
    kernelSharedMappingPids: new Set(pids.slice(0, 2)),
  });
  sysv.seed(pids[0], mapAddr, { segId, size, readOnly: false });
  sysv.seed(pids[1], mapAddr, { segId, size, readOnly: false });
  installKernelWorkerTestScratch(
    kw as unknown as Record<string, unknown>,
    kernelMemory,
    128,
    4,
    {
      kernelExports: {
        kernel_get_process_exit_signal: () => 0,
        kernel_handle_channel: handleChannel,
        kernel_ipc_shm_lookup_mapping_for_task: lookupForTask,
        kernel_ipc_shm_record_mapping_for_process: recordForProcess,
        kernel_ipc_shm_record_mapping_for_task: recordForTask,
        kernel_ipc_shmat_for_process: shmat,
        kernel_ipc_shmat_for_task: shmatForTask,
        kernel_ipc_shmdt_addr_for_process: shmdtAddrForProcess,
        kernel_ipc_shmdt_addr_for_task: shmdtAddrForTask,
        kernel_ipc_shmdt_for_process: shmdt,
        kernel_ipc_shm_read_chunk: readChunk,
        kernel_ipc_shm_write_chunk: writeChunk,
        kernel_set_current_tid: () => 0,
        kernel_validate_task: validateTask,
        ...sysv.exports,
      },
      kernelExportNames: [
        ...SYSV_MIRROR_EXPORT_NAMES,
        "kernel_get_process_exit_signal",
        "kernel_handle_channel",
        "kernel_ipc_shm_lookup_mapping_for_task",
        "kernel_ipc_shm_record_mapping_for_process",
        "kernel_ipc_shm_record_mapping_for_task",
        "kernel_ipc_shmat_for_process",
        "kernel_ipc_shmat_for_task",
        "kernel_ipc_shmdt_addr_for_process",
        "kernel_ipc_shmdt_addr_for_task",
        "kernel_ipc_shmdt_for_process",
        "kernel_ipc_shm_read_chunk",
        "kernel_ipc_shm_write_chunk",
        "kernel_set_current_tid",
        "kernel_validate_task",
      ],
    },
  );
  return {
    kw,
    handleChannel,
    lookupForTask,
    mapAddr,
    memories,
    pids,
    readChunk,
    recordForProcess,
    recordForTask,
    segment,
    segId,
    shmat,
    shmatForTask,
    shmdt,
    shmdtAddrForProcess,
    shmdtAddrForTask,
    size,
    syntheticMemorySyscalls,
    sysv,
    validateTask,
    writeChunk,
  };
}

describe("kernel-owned shared-mapping boundary failures", () => {
  function pendingChannel(h: ReturnType<typeof sysvHarness>) {
    const channel = (h.kw as any).processes.get(h.pids[0]).channels[0];
    channel.i32View = new Int32Array(channel.memory.buffer, 0, 1);
    channel.consecutiveSyscalls = 0;
    Object.assign(h.kw as any, {
      config: {},
      syscallRing: new Map(),
      syscallTraceEnabled: false,
      pendingCancels: new Set(),
    });
    writeChannelSyscall(channel, ABI_SYSCALLS.Getpid, []);
    Atomics.store(channel.i32View, CH_STATUS / 4, CHANNEL_STATUS_PENDING);
    return channel;
  }

  it.each([-5, 1])("rejects boundary export result %i before dispatch and completes EIO once", (result) => {
    const h = sysvHarness({
      fail: { kernel_shared_mapping_sync_process: result },
    });
    const channel = pendingChannel(h);
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: relisten });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      (h.kw as any).handleSyscall(channel);
      const view = new DataView(channel.memory.buffer);
      expect(h.handleChannel).not.toHaveBeenCalled();
      // Raw error completion contains one further synchronization attempt;
      // it catches that failure rather than replaying the syscall.
      expect(h.sysv.callsTo("kernel_shared_mapping_sync_process")).toEqual([
        { name: "kernel_shared_mapping_sync_process", args: [channel.pid, 3] },
        { name: "kernel_shared_mapping_sync_process", args: [channel.pid, 0] },
      ]);
      expect(view.getBigInt64(CH_RETURN, true)).toBe(-5n);
      expect(view.getUint32(CH_ERRNO, true)).toBe(5);
      expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(relisten).toHaveBeenCalledExactlyOnceWith(channel);
    } finally { error.mockRestore(); }
  });

  it("dispatches and completes normally when the real sync export succeeds", () => {
    const h = sysvHarness();
    const channel = pendingChannel(h);
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: relisten });
    (h.kw as any).handleSyscall(channel);
    const view = new DataView(channel.memory.buffer);
    expect(h.handleChannel).toHaveBeenCalledTimes(1);
    expect(h.sysv.callsTo("kernel_shared_mapping_sync_process")).toHaveLength(2);
    expect(view.getBigInt64(CH_RETURN, true)).toBe(0n);
    expect(view.getUint32(CH_ERRNO, true)).toBe(0);
    expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(relisten).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it("tells the kernel which boundary each sync is", () => {
    const h = sysvHarness();
    const channel = pendingChannel(h);
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: vi.fn() });
    (h.kw as any).handleSyscall(channel);
    writeChannelSyscall(channel, ABI_SYSCALLS.Getpid, []);
    Atomics.store(channel.i32View, CH_STATUS / 4, CHANNEL_STATUS_PENDING);
    (h.kw as any).handleSyscall(channel);
    // Entry (3): no kernel-file work. Completion (0): pull peers, refresh.
    expect(h.sysv.callsTo("kernel_shared_mapping_sync_process").map((c) => c.args))
      .toEqual([[channel.pid, 3], [channel.pid, 0], [channel.pid, 3], [channel.pid, 0]]);
  });

  it("treats a completion without a recorded entry, or with output bytes, as a completion", () => {
    const h = sysvHarness();
    const channel = pendingChannel(h);
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: vi.fn() });
    (h.kw as any).completeChannel(channel, ABI_SYSCALLS.Getpid, [], undefined, 0, 0, []);
    (h.kw as any).completeChannel(
      channel, ABI_SYSCALLS.Read, [0, 0x5000, 1], undefined, 1, 0,
      [{ ptr: 0x5000, bytes: new Uint8Array([0x6d]) }],
    );
    expect(h.sysv.callsTo("kernel_shared_mapping_sync_process")).toEqual([
      { name: "kernel_shared_mapping_sync_process", args: [channel.pid, 0] },
      { name: "kernel_shared_mapping_sync_process", args: [channel.pid, 0] },
    ]);
  });

  // `host_proc_quiescent_epoch` (`CleanStamp` in runtime-core memory.rs):
  // an epoch only while no guest code of the process can run, and a new one
  // after anything that can change its memory.
  describe("quiescent epoch", () => {
    function addSibling(h: ReturnType<typeof sysvHarness>, status: number) {
      const channel = (h.kw as any).processes.get(h.pids[0]).channels[0];
      const registration = (h.kw as any).processes.get(h.pids[0]);
      const siblingOffset = 0x8000;
      const sibling = {
        pid: channel.pid,
        memory: channel.memory,
        channelOffset: siblingOffset,
        i32View: new Int32Array(channel.memory.buffer, siblingOffset, 1),
      };
      Atomics.store(sibling.i32View, CH_STATUS / 4, status);
      registration.channels.push(sibling);
      return sibling;
    }

    it("is reported only while every thread channel is pending", () => {
      const h = sysvHarness();
      const channel = pendingChannel(h);
      const epoch = () => h.kw.testAuthority.processQuiescentEpochForTest(channel.pid);
      expect(epoch()).toBeGreaterThanOrEqual(0n);
      const sibling = addSibling(h, CHANNEL_STATUS_COMPLETE);
      expect(epoch()).toBe(-1n);
      Atomics.store(sibling.i32View, CH_STATUS / 4, CHANNEL_STATUS_PENDING);
      expect(epoch()).toBeGreaterThanOrEqual(0n);
      // A thread whose channel was attached but has made no syscall yet.
      Atomics.store(sibling.i32View, CH_STATUS / 4, 0);
      expect(epoch()).toBe(-1n);
      Atomics.store(channel.i32View, CH_STATUS / 4, CHANNEL_STATUS_COMPLETE);
      Atomics.store(sibling.i32View, CH_STATUS / 4, CHANNEL_STATUS_PENDING);
      expect(epoch()).toBe(-1n);
    });

    it("is never reported for an unknown process or one whose memory is borrowed", () => {
      const h = sysvHarness();
      const channel = pendingChannel(h);
      expect(h.kw.testAuthority.processQuiescentEpochForTest(9999)).toBe(-1n);
      const processes = (h.kw as any).processes as Map<number, any>;
      const borrower = { ...processes.get(channel.pid), pid: 4242, channels: [] };
      processes.set(4242, borrower);
      try {
        expect(h.kw.testAuthority.processQuiescentEpochForTest(channel.pid)).toBe(-1n);
      } finally { processes.delete(4242); }
    });

    it("changes when a completion is materialized and when it is published", () => {
      const h = sysvHarness();
      const channel = pendingChannel(h);
      const epoch = () => h.kw.testAuthority.processQuiescentEpochForTest(channel.pid);
      const before = epoch();
      const prepared = {
        kind: "marshalled", outputWrites: [], retVal: 0, errVal: 0,
        materialized: false, relistenRequested: false,
      };
      (h.kw as any).materializePreparedChannelCompletion(channel, prepared);
      const materialized = epoch();
      expect(materialized).toBeGreaterThan(before);
      (h.kw as any).publishPreparedChannelCompletion(channel, prepared);
      expect(epoch()).toBe(-1n);
      Atomics.store(channel.i32View, CH_STATUS / 4, CHANNEL_STATUS_PENDING);
      expect(epoch()).toBeGreaterThan(materialized);
    });
  });

  it.each([-5, 0])("completes a detached output with sync result %i without hiding its effects", (result) => {
    let channel: ReturnType<typeof pendingChannel>;
    const ptr = 0x5000;
    const observed: number[] = [];
    const h = sysvHarness({ fail: {
      get kernel_shared_mapping_sync_process() {
        observed.push(new Uint8Array(channel.memory.buffer)[ptr]);
        return result;
      },
    } });
    channel = pendingChannel(h);
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: relisten });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      (h.kw as any).completeChannel(
        channel, ABI_SYSCALLS.Read, [0, ptr, 1], undefined, 1, 0,
        [{ ptr, bytes: new Uint8Array([0x6d]) }],
      );
      expect(observed).toEqual([0x6d]);
      expect(new Uint8Array(channel.memory.buffer)[ptr]).toBe(0x6d);
      const view = new DataView(channel.memory.buffer);
      expect(view.getBigInt64(CH_RETURN, true)).toBe(BigInt(result < 0 ? -5 : 1));
      expect(view.getUint32(CH_ERRNO, true)).toBe(result < 0 ? 5 : 0);
      expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(relisten).toHaveBeenCalledExactlyOnceWith(channel);
      expect(h.handleChannel).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it.each([-5, 0])("materializes outputs before sync result %i without replaying effects", (result) => {
    let channel: ReturnType<typeof pendingChannel>;
    const ptr = 0x5000;
    const observed: number[] = [];
    const h = sysvHarness({ fail: {
      get kernel_shared_mapping_sync_process() {
        observed.push(new Uint8Array(channel.memory.buffer)[ptr]);
        return result;
      },
    } });
    channel = pendingChannel(h);
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: relisten });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepared = {
      kind: "marshalled", outputWrites: [{ ptr, bytes: new Uint8Array([0x6d]) }],
      retVal: 1, errVal: 0, materialized: false, relistenRequested: true,
    };
    try {
      // Exercise the actual completion materializer with an independently
      // owned output. No boundary hook replaces the real export call.
      (h.kw as any).materializePreparedChannelCompletion(channel, prepared);
      expect(observed).toEqual([0x6d]);
      expect(prepared.outputWrites).toEqual([]);
      expect(prepared.retVal).toBe(result < 0 ? -5 : 1);
      expect(prepared.errVal).toBe(result < 0 ? 5 : 0);
      expect(prepared.materialized).toBe(true);
      new Uint8Array(channel.memory.buffer)[ptr] = 0x7e;
      (h.kw as any).materializePreparedChannelCompletion(channel, prepared);
      expect(observed).toEqual([0x6d]);
      expect(new Uint8Array(channel.memory.buffer)[ptr]).toBe(0x7e);
      (h.kw as any).publishOrParkChannelCompletion(channel, prepared);
      const view = new DataView(channel.memory.buffer);
      expect(view.getBigInt64(CH_RETURN, true)).toBe(BigInt(result < 0 ? -5 : 1));
      expect(view.getUint32(CH_ERRNO, true)).toBe(result < 0 ? 5 : 0);
      expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(relisten).toHaveBeenCalledExactlyOnceWith(channel);
    } finally { error.mockRestore(); }
  });
});

describe("SysV SHM coherence and lifecycle", () => {
  // The publish/refresh byte protocol itself -- disjoint-run merging, version
  // arithmetic, SHM_RDONLY refusal, the sole-observer deferral and the
  // stale-observer refresh -- is Rust-owned and covered by the
  // `SharedMappingTable` unit tests in `crates/runtime-core/src/memory.rs`.
  // What remains here is the host<->kernel contract: which entry point runs,
  // with which arguments, in what order relative to mmap/munmap and the
  // exact-entry gate, and what the host does when one of them refuses.

  it("inherits and releases a child's attachments as single kernel transactions", () => {
    const h = sysvHarness();
    const childBytes = h.memories.get(h.pids[2])!.buffer.byteLength;

    h.kw.inheritProcessSharedMappings(h.pids[0], h.pids[2]);

    // Attachment records and the byte mirror commit together inside the
    // kernel, so the host issues one call rather than interleaving shmat,
    // record_mapping and a segment read per attachment.
    expect(h.sysv.callsTo("kernel_shared_mapping_inherit")).toEqual([
      {
        name: "kernel_shared_mapping_inherit",
        args: [h.pids[0], h.pids[2], BigInt(childBytes)],
      },
    ]);
    expect(h.shmat).not.toHaveBeenCalled();
    expect(h.recordForProcess).not.toHaveBeenCalled();
    expect(h.sysv.count(h.pids[2])).toBe(1);

    (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[2]);
    expect(h.sysv.callsTo("kernel_shared_mapping_release_process"))
      .toEqual([
        {
          name: "kernel_shared_mapping_release_process",
          args: [h.pids[2], 0, 1],
        },
      ]);
    expect(h.sysv.count(h.pids[2])).toBe(0);

    // A second teardown of the same pid must not manufacture a second detach.
    (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[2]);
    expect(h.sysv.count(h.pids[2])).toBe(0);
    expect(h.shmdtAddrForProcess).not.toHaveBeenCalled();
    expect(h.shmdt).not.toHaveBeenCalled();
  });

  it("fails teardown loudly when the kernel cannot settle the attachments", () => {
    const h = sysvHarness({
      fail: { kernel_shared_mapping_release_process: -5 },
    });

    expect(() => {
      (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[0]);
    }).toThrow(/Cannot release kernel shared mappings for pid=61: errno 5/);

    // The kernel keeps the mirror when a detach cannot be proven, so the
    // attachment is still on record rather than silently forgotten.
    expect(h.sysv.count(h.pids[0])).toBe(1);
  });

  it("leaves the child with no attachments when inheritance is refused", () => {
    const h = sysvHarness({
      fail: { kernel_shared_mapping_inherit: -12 },
    });

    expect(() => h.kw.inheritProcessSharedMappings(h.pids[0], h.pids[2]))
      .toThrow(/Kernel shared-mapping inheritance failed for pid=63: errno 12/);
    expect(h.sysv.count(h.pids[2])).toBe(0);
    expect(h.shmdtAddrForProcess).not.toHaveBeenCalled();
    expect(h.shmdt).not.toHaveBeenCalled();
  });

  it("rolls back kernel nattch when host mmap allocation fails", () => {
    const h = sysvHarness();
    const relisten = vi.fn();
    h.sysv.attachments.clear();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel: relisten,
    });
    const channel = (h.kw as any).processes.get(h.pids[2]).channels[0];

    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmat,
      [BigInt(h.segId), 0n, 0n],
    );
    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(h.validateTask).toHaveBeenCalledWith(h.pids[2], h.pids[2]);
    expect(h.shmatForTask).toHaveBeenCalledWith(
      h.pids[2],
      h.pids[2],
      h.segId,
      0,
      0,
    );
    expect(h.shmdt).toHaveBeenCalledTimes(1);
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-12);
    expect(view.getUint32(CH_ERRNO, true)).toBe(12);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(relisten).toHaveBeenCalledWith(channel);
  });

  it("rejects a stale task before changing kernel or host attachment state", () => {
    const h = sysvHarness();
    h.validateTask.mockReturnValue(-3);
    const channel = (h.kw as any).processes.get(h.pids[2]).channels[0];
    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmat,
      [BigInt(h.segId), 0n, 0n],
    );

    let failure: unknown;
    try {
      h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /void kernel ingress scratch-boundary test syscall failed/,
    );
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(
      ((failure as Error & { cause: Error }).cause).message,
    ).toMatch(/rejected tid/);
    expect(h.validateTask).toHaveBeenCalledWith(h.pids[2], h.pids[2]);
    expect(h.readChunk).not.toHaveBeenCalled();
    expect(h.writeChunk).not.toHaveBeenCalled();
    expect(h.shmatForTask).not.toHaveBeenCalled();
    expect(h.sysv.callsTo("kernel_shared_mapping_sysv_track")).toEqual([]);
    expect(h.sysv.count(h.pids[2])).toBe(0);
  });

  it("preserves a wasm64 shmat hint above 4 GiB until mmap rejects it", () => {
    const h = sysvHarness();
    const process = (h.kw as any).processes.get(h.pids[2]);
    process.ptrWidth = 8;
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel: relisten,
    });
    const channel = process.channels[0];
    const highHint = 0x1_0000_0000n;

    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmat,
      [BigInt(h.segId), highHint, 0n],
    );
    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    // The legacy kernel attachment helper does not own the process mapping
    // address, but the host mmap path must retain every wasm64 pointer bit.
    expect(h.shmatForTask).toHaveBeenCalledWith(
      h.pids[2],
      h.pids[2],
      h.segId,
      0,
      0,
    );
    expect(h.syntheticMemorySyscalls).toHaveLength(1);
    expect(h.syntheticMemorySyscalls[0]?.syscallNr).toBe(ABI_SYSCALLS.Mmap);
    expect(h.syntheticMemorySyscalls[0]?.args[0]).toBe(highHint);
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-12);
    expect(view.getUint32(CH_ERRNO, true)).toBe(12);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(relisten).toHaveBeenCalledWith(channel);
  });

  it("rejects a non-lossless wasm64 shmat hint before attachment state changes", () => {
    const h = sysvHarness();
    const process = (h.kw as any).processes.get(h.pids[2]);
    process.ptrWidth = 8;
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel: relisten,
    });
    const channel = process.channels[0];
    const unsafeHint = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmat,
      [BigInt(h.segId), unsafeHint, 0n],
    );
    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(h.shmatForTask).not.toHaveBeenCalled();
    expect(h.handleChannel).not.toHaveBeenCalled();
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-1);
    expect(view.getUint32(CH_ERRNO, true)).toBe(14);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(relisten).toHaveBeenCalledWith(channel);
  });

  it("resolves shmdt identity in Rust before publishing and detaching", () => {
    const h = sysvHarness();
    const pid = h.pids[0];
    const process = (h.kw as any).processes.get(pid);
    const channel = process.channels[0];
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel: relisten,
    });
    new Uint8Array(process.memory.buffer)[h.mapAddr + 7] = 0x7d;

    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmdt,
      [BigInt(h.mapAddr)],
    );
    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(h.lookupForTask).toHaveBeenCalledWith(
      pid,
      pid,
      h.mapAddr,
    );
    // Publish, detach, and only then forget: a failed detach must leave a
    // mirrored attachment rather than one nobody reconciles.
    expect(
      h.sysv.calls
        .map((call) => call.name)
        .filter((name) =>
          name === "kernel_shared_mapping_sysv_publish_mapping"
          || name === "kernel_shared_mapping_sysv_drop_mapping"
        ),
    ).toEqual([
      "kernel_shared_mapping_sysv_publish_mapping",
      "kernel_shared_mapping_sysv_drop_mapping",
    ]);
    expect(h.sysv.callsTo("kernel_shared_mapping_sysv_publish_mapping"))
      .toEqual([
        {
          name: "kernel_shared_mapping_sysv_publish_mapping",
          args: [pid, h.mapAddr, h.segId, h.size],
        },
      ]);
    expect(h.shmdtAddrForTask).toHaveBeenCalledExactlyOnceWith(
      pid,
      pid,
      h.mapAddr,
    );
    expect(h.sysv.count(pid)).toBe(0);
    expect(h.syntheticMemorySyscalls.at(-1)).toMatchObject({
      syscallNr: ABI_SYSCALLS.Munmap,
    });
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(0);
    expect(view.getUint32(CH_ERRNO, true)).toBe(0);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(relisten).toHaveBeenCalledWith(channel);
  });

  it("keeps the host mirror when address-owned shmdt fails", () => {
    const h = sysvHarness();
    const pid = h.pids[0];
    const process = (h.kw as any).processes.get(pid);
    const channel = process.channels[0];
    h.shmdtAddrForTask.mockReturnValue(-5);
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel: vi.fn(),
    });

    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmdt,
      [BigInt(h.mapAddr)],
    );
    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(h.sysv.count(pid)).toBe(1);
    expect(h.sysv.callsTo("kernel_shared_mapping_sysv_drop_mapping")).toEqual([]);
    expect(h.syntheticMemorySyscalls).toHaveLength(0);
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-5);
    expect(view.getUint32(CH_ERRNO, true)).toBe(5);
  });

  it("does not alias a wasm64 shmdt address to an existing low mapping", () => {
    const h = sysvHarness();
    const process = (h.kw as any).processes.get(h.pids[0]);
    process.ptrWidth = 8;
    const relisten = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel: relisten,
    });
    const channel = process.channels[0];
    const highAddress = BigInt(h.mapAddr) + 0x1_0000_0000n;

    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Shmdt,
      [highAddress],
    );
    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(h.sysv.count(h.pids[0])).toBe(1);
    expect(h.sysv.callsTo("kernel_shared_mapping_sysv_publish_mapping")).toEqual([]);
    expect(h.lookupForTask).not.toHaveBeenCalled();
    expect(h.shmdtAddrForTask).not.toHaveBeenCalled();
    expect(h.handleChannel).not.toHaveBeenCalled();
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-22);
    expect(view.getUint32(CH_ERRNO, true)).toBe(22);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(relisten).toHaveBeenCalledWith(channel);
  });
});
