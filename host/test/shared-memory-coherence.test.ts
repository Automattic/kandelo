import { describe, expect, it, vi } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";

function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
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
  const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    anonymousSharedBackings: new Map([[key, backing]]),
    sharedMappings: new Map([
      [parentPid, new Map([[mapAddr, mapping()]])],
      [peerPid, new Map([[mapAddr, mapping()]])],
    ]),
    shmMappings: new Map(),
    processes: new Map([
      [parentPid, { pid: parentPid, memory: parentMemory, channels: [parentChannel] }],
      [peerPid, { pid: peerPid, memory: peerMemory, channels: [peerChannel] }],
      [childPid, { pid: childPid, memory: childMemory, channels: [childChannel] }],
    ]),
  }) as CentralizedKernelWorker;
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
});

function sysvHarness() {
  const pids = [61, 62, 63];
  const mapAddr = 0x3000;
  const size = 256;
  const segId = 9;
  const memories = new Map(pids.map((pid) => [pid, sharedMemory()]));
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const segment = new Uint8Array(size);
  const setCurrentPid = vi.fn();
  const shmat = vi.fn(() => size);
  const shmdt = vi.fn(() => 0);
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
  const mapping = (readOnly = false) => ({
    segId,
    size,
    readOnly,
    snapshot: new Uint8Array(size),
    seenVersion: 0,
  });
  const processes = new Map(pids.map((pid) => {
    const memory = memories.get(pid)!;
    return [pid, { pid, memory, channels: [{ pid, memory, channelOffset: 0 }] }];
  }));
  const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    currentHandlePid: 0,
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    kernelMemory,
    kernelInstance: {
      exports: {
        kernel_set_current_pid: setCurrentPid,
        kernel_ipc_shmat: shmat,
        kernel_ipc_shmdt: shmdt,
        kernel_ipc_shm_read_chunk: readChunk,
        kernel_ipc_shm_write_chunk: writeChunk,
      },
    },
    scratchOffset: 0,
    processes,
    sharedMappings: new Map(),
    anonymousSharedBackings: new Map(),
    shmMappings: new Map([
      [pids[0], new Map([[mapAddr, mapping()]])],
      [pids[1], new Map([[mapAddr, mapping()]])],
    ]),
    shmSegmentVersions: new Map([[segId, 0]]),
  }) as CentralizedKernelWorker;
  return { kw, mapAddr, memories, pids, segment, segId, shmat, shmdt, size };
}

describe("SysV SHM coherence and lifecycle", () => {
  it("merges stale same-page publishers and refreshes the later publisher", () => {
    const h = sysvHarness();
    const first = new Uint8Array(h.memories.get(h.pids[0])!.buffer);
    const second = new Uint8Array(h.memories.get(h.pids[1])!.buffer);
    first[h.mapAddr + 5] = 0x15;
    (h.kw as any).syncSysvShmMappingsFromProcess(
      (h.kw as any).processes.get(h.pids[0]),
    );
    second[h.mapAddr + 19] = 0x29;
    (h.kw as any).syncSysvShmMappingsFromProcess(
      (h.kw as any).processes.get(h.pids[1]),
    );

    expect(h.segment[5]).toBe(0x15);
    expect(h.segment[19]).toBe(0x29);
    expect(second[h.mapAddr + 5]).toBe(0x15);
    expect(second[h.mapAddr + 19]).toBe(0x29);
  });

  it("never publishes a SHM_RDONLY attachment but still refreshes it", () => {
    const h = sysvHarness();
    const readonlyMap = (h.kw as any).shmMappings.get(h.pids[1]).get(h.mapAddr);
    readonlyMap.readOnly = true;
    const first = new Uint8Array(h.memories.get(h.pids[0])!.buffer);
    const second = new Uint8Array(h.memories.get(h.pids[1])!.buffer);
    second[h.mapAddr + 8] = 0xee;
    first[h.mapAddr + 14] = 0x44;

    (h.kw as any).syncSysvShmMappingsFromProcess(
      (h.kw as any).processes.get(h.pids[0]),
    );
    (h.kw as any).syncSysvShmMappingsFromProcess(
      (h.kw as any).processes.get(h.pids[1]),
    );

    expect(h.segment[8]).toBe(0);
    expect(h.segment[14]).toBe(0x44);
    expect(second[h.mapAddr + 8]).toBe(0);
    expect(second[h.mapAddr + 14]).toBe(0x44);
  });

  it("increments inherited nattch and detaches the child exactly once", () => {
    const h = sysvHarness();
    h.kw.inheritProcessSharedMappings(h.pids[0], h.pids[2]);
    expect(h.shmat).toHaveBeenCalledWith(h.segId, h.mapAddr, 0);
    expect((h.kw as any).shmMappings.get(h.pids[2]).size).toBe(1);

    (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[2]);
    expect(h.shmdt).toHaveBeenCalledTimes(1);
    (h.kw as any).releaseAllSharedMemoryForProcess(h.pids[2]);
    expect(h.shmdt).toHaveBeenCalledTimes(1);
  });

  it("rolls back attachments when inherited SysV setup fails", () => {
    const h = sysvHarness();
    const secondAddr = h.mapAddr + 0x1000;
    (h.kw as any).shmMappings.get(h.pids[0]).set(secondAddr, {
      segId: h.segId,
      size: h.size,
      readOnly: false,
      snapshot: new Uint8Array(h.size),
      seenVersion: 0,
    });
    h.shmat.mockImplementationOnce(() => h.size).mockImplementationOnce(() => -12);

    expect(() => h.kw.inheritProcessSharedMappings(h.pids[0], h.pids[2])).toThrow();
    expect(h.shmdt).toHaveBeenCalledTimes(1);
    expect((h.kw as any).shmMappings.has(h.pids[2])).toBe(false);
  });

  it("rolls back kernel nattch when host mmap allocation fails", () => {
    const h = sysvHarness();
    const complete = vi.fn();
    const relisten = vi.fn();
    Object.assign(h.kw as any, {
      shmMappings: new Map(),
      runSyntheticMemorySyscall: vi.fn(() => ({ retVal: -1, errVal: 12 })),
      completeChannelRaw: complete,
      relistenChannel: relisten,
    });
    const memory = h.memories.get(h.pids[2])!;
    const channel = { pid: h.pids[2], memory, channelOffset: 0 };

    (h.kw as any).handleIpcShmat(channel, [h.segId, 0, 0]);
    expect(h.shmdt).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(channel, -12, 12);
    expect(relisten).toHaveBeenCalledWith(channel);
  });
});
