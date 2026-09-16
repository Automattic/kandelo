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
} from "../src/generated/abi";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  createSysvMirrorStub,
  SYSV_MIRROR_EXPORT_NAMES,
  type SysvMirrorStub,
  type SysvMirrorStubOptions,
} from "./support/sysv-mirror-stub";

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
    const sysv = createSysvMirrorStub();
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
      const sysv = createSysvMirrorStub();
      const kw = Object.assign(createCentralizedKernelWorkerTestDouble(), {
        processes: new Map([[pid, process]]),
        sharedMappings,
      });
      installSysvMirrorScratch(kw, sysv);
      if (mappingKind === "SysV") {
        sysv.seed(pid, 0x3000, { segId: 9, size: 256, readOnly: false });
        // The host's cached boundary predicate, as a shmat/fork/exec site
        // would have refreshed it from the kernel.
        (kw as any).sysvActivePidCount = 1;
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
      expect(sysv.callsTo("kernel_shared_mapping_sysv_sync_process")).toEqual(
        mappingKind === "SysV"
          ? [{
            name: "kernel_shared_mapping_sysv_sync_process",
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
  const sysv = createSysvMirrorStub(options);
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
    // The byte mirror is Rust-owned; the host caches only the population
    // count that gates its syscall-boundary early-out.
    sysvActivePidCount: 2,
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
    expect(h.sysv.callsTo("kernel_shared_mapping_sysv_inherit")).toEqual([
      {
        name: "kernel_shared_mapping_sysv_inherit",
        args: [h.pids[0], h.pids[2], BigInt(childBytes)],
      },
    ]);
    expect(h.shmat).not.toHaveBeenCalled();
    expect(h.recordForProcess).not.toHaveBeenCalled();
    expect(h.sysv.count(h.pids[2])).toBe(1);

    (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[2]);
    expect(h.sysv.callsTo("kernel_shared_mapping_sysv_release_process"))
      .toEqual([
        {
          name: "kernel_shared_mapping_sysv_release_process",
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
      fail: { kernel_shared_mapping_sysv_release_process: -5 },
    });

    expect(() => {
      (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[0]);
    }).toThrow(/Cannot release SysV attachments for pid=61: errno 5/);

    // The kernel keeps the mirror when a detach cannot be proven, so the
    // attachment is still on record rather than silently forgotten.
    expect(h.sysv.count(h.pids[0])).toBe(1);
  });

  it("leaves the child with no attachments when inheritance is refused", () => {
    const h = sysvHarness({
      fail: { kernel_shared_mapping_sysv_inherit: -12 },
    });

    expect(() => h.kw.inheritProcessSharedMappings(h.pids[0], h.pids[2]))
      .toThrow(/SysV shared-memory inheritance failed for pid=63: errno 12/);
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
