import { describe, expect, it, vi } from 'vitest';
import { MemoryGroupImageStore, type PreparedGroupMapping } from '../src/memory-group-image-store';
import { decodeProcessMemoryDescriptor } from '../src/process-memory-descriptor';
import { GroupProcessAddressSpace, ProcessAddressFault } from '../src/process-address-space';
import type { MemoryGroupTaskReceipt, GroupMemoryChangeDescription } from '../src/memory-group-protocol';
import * as G from '../src/generated/program-extensions';
import { publishMemoryGroupNotification } from '../src/memory-group-notification';

const P = 65536;
const layout = { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: P };
function task(patch: Partial<MemoryGroupTaskReceipt> = {}): MemoryGroupTaskReceipt {
  return { group: 7, pid: 100, tid: 100, serial: (1n << 55n) + 1n, generation: (1n << 54n) + 3n, ...patch };
}
describe('full virtual-capacity custody validation', () => {
  const large = { ...layout, maximumVirtualPages: 65536 };
  it.each(['physical-bounds', 'virtual-tail'] as const)('retains all custody on invalid %s PTEs', kind => {
    const store = new MemoryGroupImageStore(7, 64), receipt = task();
    const handle = store.prepareImage(receipt, large), launch = store.publish(handle, receipt);
    const memory = launch.envelope.memory;
    const table = new Uint32Array(memory.buffer, launch.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, large.maximumVirtualPages);
    const at = kind === 'physical-bounds' ? 1 : large.maximumVirtualPages - 1;
    const saved = Atomics.load(table, at), charged = store.snapshot().allocatedPages;
    try {
      const physical = kind === 'physical-bounds' ? memory.buffer.byteLength / P : Atomics.load(table, 0) >>> 16;
      Atomics.store(table, at, physical * P + 3);
      store.noteReplicaQuiescent(handle); store.revokeImageAccess(handle);
      expect(() => store.tryReleaseStoppedImage(handle)).toThrow(/invalid page custody/);
      expect(store.snapshot().allocatedPages).toBe(charged);
    } finally { Atomics.store(table, at, saved); store.close(); }
  });
  it('revalidates physical bounds when a live peer grows during a retirement scan', () => {
    const store = new MemoryGroupImageStore(7, 64), victimReceipt = task();
    const peerReceipt = task({ pid: 200, tid: 200, serial: 2n });
    const victim = store.prepareImage(victimReceipt, large), victimLaunch = store.publish(victim, victimReceipt);
    const peer = store.prepareImage(peerReceipt, large), peerLaunch = store.publish(peer, peerReceipt);
    const memory = victimLaunch.envelope.memory, originalBytes = memory.buffer.byteLength;
    const peerTableOffset = peerLaunch.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES;
    const originalLoad = Atomics.load;
    let grew = false;
    store.noteReplicaQuiescent(victim); store.revokeImageAccess(victim);
    const load = vi.spyOn(Atomics, 'load').mockImplementation((array: any, index: number): any => {
      if (!grew && array instanceof Uint32Array && array.byteOffset === peerTableOffset && index === 0) {
        grew = true;
        // Model native peer growth after the scanner captured its initial
        // buffer bound, while the retiring image still owns all its pages.
        const allocation = (store as any).pool.allocateContiguous(1);
        expect(allocation).toBeDefined(); expect(memory.buffer.byteLength).toBeGreaterThan(originalBytes);
        const table = new Uint32Array(memory.buffer, peerTableOffset, large.maximumVirtualPages);
        Atomics.store(table, 2, allocation.first * P + 3);
        Atomics.store(new Uint32Array(memory.buffer, peerLaunch.expectation.root, 1), 0, 3);
      }
      return originalLoad(array, index);
    });
    try {
      const result = store.tryReleaseStoppedImage(victim);
      expect(result).not.toBe('busy'); expect(grew).toBe(true);
      expect(store.snapshot().images).toBe(1);
      expect(peerLaunch.source.readBytes(2 * P, 1)).toEqual(Uint8Array.of(0));
    } finally { load.mockRestore(); store.close(); }
  });
});
function imageWithThread(maximumPhysicalPages = 32, requested = layout) {
  const store = new MemoryGroupImageStore(7, maximumPhysicalPages), main = task(), thread = task({ tid: 101, serial: 2n });
  const a = store.prepareImage(main, requested), b = store.prepareThread(thread);
  const leader = store.publish(a, main), peer = store.publish(b, thread);
  const control = (launch: typeof leader) => new Int32Array(launch.envelope.memory.buffer,
    launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
  const left = control(leader), right = control(peer);
  const request = (words: Int32Array) => Atomics.load(words, G.MEMORY_GROUP_REPLICA_REQUEST / 4);
  const acknowledge = (words: Int32Array) => Atomics.store(words, G.MEMORY_GROUP_REPLICA_ACK / 4, request(words));
  return { store, a, b, main, thread, leader, peer, control, left, right, request, acknowledge };
}
function pausedMappingImage(maximumPhysicalPages = 32, requested = layout) {
  const h = imageWithThread(maximumPhysicalPages, requested), barrier = h.store.beginImageExecutionPause(h.a);
  h.acknowledge(h.left); h.acknowledge(h.right);
  const describe = (patch: Partial<GroupMemoryChangeDescription> = {}): GroupMemoryChangeDescription => ({
    receipt: h.main, token: (1n << 63n) + 7n, kind: 'map', address: 8 * P, length: P,
    oldAddress: 0, oldLength: 0, result: 8 * P, flags: 0x22, prot: 3, populationAddress: 0, populationLength: 0, sharedObject: 0n, sharedLength: 0, sharedOffset: 0, ...patch,
  });
  const prepare = (patch: Partial<GroupMemoryChangeDescription> = {}) => {
    const result = h.store.prepareImageMapping(barrier, describe(patch));
    if (typeof result === 'string') throw Error(`Unexpected mapping preparation ${result}`);
    return result;
  };
  return { ...h, barrier, describe, prepare };
}
describe('exact image cooperative stop', () => {
  it('stops only the exact image peers, retaining a natural actor until its real fence', async () => {
    const h = imageWithThread(), otherReceipt = task({ pid: 200, tid: 200, serial: 3n });
    const other = h.store.prepareImage(otherReceipt, layout), launch = h.store.publish(other, otherReceipt), control = h.control(launch);
    const charged = h.store.snapshot().allocatedPages;
    expect(h.store.requestImageStop(h.a, h.main.tid)).toBe(true);
    expect(Atomics.load(h.left, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(1);
    expect(Atomics.load(h.right, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(0);
    expect(Atomics.load(control, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(1);
    expect(() => h.store.prepareThread(task({ tid: 102, serial: 4n }))).toThrow(/stop/);
    expect(() => h.store.beginImageExecutionPause(h.a)).toThrow(/barrier/);
    let settled = false; const stopped = h.store.waitForImageQuiescence(h.a).then(() => { settled = true; });
    h.store.noteReplicaQuiescent(h.b); await Promise.resolve(); expect(settled).toBe(false);
    h.store.noteReplicaQuiescent(h.a); await stopped;
    expect(h.store.snapshot().allocatedPages).toBe(charged); expect(launch.source.readBytes(0, 1)).toEqual(Uint8Array.of(0)); h.store.close();
  });
  it('keeps a busy queue charged and re-drains only this image after actual lock release', () => {
    const h = imageWithThread(), lock = new Int32Array(h.leader.envelope.memory.buffer, G.MEMORY_GROUP_WAIT_HEADER, 1);
    const charged = h.store.snapshot().allocatedPages; Atomics.store(lock, 0, 1);
    expect(h.store.requestImageStop(h.a)).toBe(false);
    expect(Atomics.load(h.left, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(0);
    expect(Atomics.load(h.right, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(0);
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged, pendingWaitDrains: 2, exposedReplicas: 2 });
    Atomics.store(lock, 0, 0); Atomics.notify(lock, 0);
    expect(h.store.requestImageStop(h.a)).toBe(true);
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged, pendingWaitDrains: 0, exposedReplicas: 2 }); h.store.close();
  });
});

describe('stop proof after contended wait drain', () => {
  it('retries a pending drain even after every exact stop receipt arrives', () => {
    const h = imageWithThread(), lock = new Int32Array(h.leader.envelope.memory.buffer, G.MEMORY_GROUP_WAIT_HEADER, 1);
    const charged = h.store.snapshot().allocatedPages; Atomics.store(lock, 0, 1);
    expect(h.store.requestImageStop(h.a)).toBe(false);
    h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b);
    expect(h.store.snapshot().pendingWaitDrains).toBe(2);
    expect(h.store.requestImageStop(h.a)).toBe(false);
    Atomics.store(lock, 0, 0);
    expect(h.store.requestImageStop(h.a)).toBe(true);
    expect(h.store.snapshot()).toMatchObject({ pendingWaitDrains: 0, allocatedPages: charged }); h.store.close();
  });
  it('retries the stopped thread drain before freeing scratch while a peer remains active', () => {
    const h = imageWithThread(), lock = new Int32Array(h.leader.envelope.memory.buffer, G.MEMORY_GROUP_WAIT_HEADER, 1);
    const release = vi.fn(() => true); Atomics.store(lock, 0, 1);
    expect(h.store.requestReplicaStop(h.b)).toBe(false); h.store.noteReplicaQuiescent(h.b);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, release)).toBe('busy'); expect(release).not.toHaveBeenCalled();
    Atomics.store(lock, 0, 0);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, release)).toBe('released'); expect(release).toHaveBeenCalledOnce();
    expect(h.store.snapshot()).toMatchObject({ replicas: 1, pendingWaitDrains: 0 });
    expect(Atomics.load(h.left, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(1); h.store.close();
  });
});

describe('bounded exact replica wait observation', () => {
  it('distinguishes actual queue membership from a returning stopped node without draining a peer', () => {
    const h = imageWithThread(), words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const node = G.MEMORY_GROUP_WAIT_NODES, at = node / 4;
    expect(h.store.inspectReplicaWait(h.b)).toBe('none');
    words[at] = G.MEMORY_GROUP_WAIT_WAITING; words[at + 3] = h.peer.expectation.root;
    words[at + 4] = h.peer.expectation.replica; words[q + 1] = words[q + 2] = node; words[q + 4] = 1;
    Atomics.store(h.right, G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4, node);
    expect(h.store.inspectReplicaWait(h.a)).toBe('none'); expect(h.store.inspectReplicaWait(h.b)).toBe('waiting');
    expect(words[at]).toBe(G.MEMORY_GROUP_WAIT_WAITING); expect(words[q + 4]).toBe(1);
    h.store.requestReplicaStop(h.b);
    expect(h.store.inspectReplicaWait(h.b)).toBe('returning'); expect(words[q + 4]).toBe(1);
    expect(h.store.replicaExecutionStopped(h.b)).toBe(false); h.store.close();
  });
  it('refuses stale ownership and reports queue contention without granting a fence', () => {
    const h = imageWithThread(), words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    Atomics.store(words, q, 1); expect(h.store.inspectReplicaWait(h.b)).toBe('busy'); Atomics.store(words, q, 0);
    const node = G.MEMORY_GROUP_WAIT_NODES, at = node / 4;
    words[at] = G.MEMORY_GROUP_WAIT_WAITING; words[at + 3] = h.peer.expectation.root;
    words[at + 4] = h.leader.expectation.replica; words[q + 1] = words[q + 2] = node; words[q + 4] = 1;
    Atomics.store(h.right, G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4, node);
    expect(() => h.store.inspectReplicaWait(h.b)).toThrow(/another replica/);
    expect(Atomics.load(words, q)).toBe(0); expect(h.store.replicaExecutionStopped(h.b)).toBe(false); h.store.close();
  });
});

describe('exact whole-image page retirement', () => {
  const stop = (h: ReturnType<typeof imageWithThread>) => {
    h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b); h.store.revokeImageAccess(h.a);
  };
  it('refuses live replicas and revokes stale access before returning deduplicated mapped and retired storage', () => {
    const h = pausedMappingImage(), mapping = h.prepare({ kind: 'unmap', address: P, length: P, result: 0 });
    expect(h.store.commitImageMapping(mapping, () => true, () => 0)).toBe('committed');
    h.store.resumeImageExecutionPause(h.barrier);
    const ptes = new Uint32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 16);
    ptes[1] = ptes[0]; // A within-image alias owns no second bitmap allocation.
    const before = h.store.snapshot();
    expect(h.store.tryReleaseStoppedImage(h.a)).toBe('busy');
    stop(h);
    expect(h.store.tryReleaseStoppedImage(h.a)).toMatchObject({ pages: before.allocatedPages - 1 });
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0, retainedMappingReferences: 0 });
    expect(() => h.leader.source.readBytes(0, 1)).toThrow();
    expect(() => h.store.receipt(h.a)).toThrow();
    const receipt = task({ pid: 102, tid: 102, serial: 3n });
    const next = h.store.prepareImage(receipt, layout), launch = h.store.publish(next, receipt);
    expect(launch.source.readBytes(0, 32)).toEqual(new Uint8Array(32));
    expect(h.store.snapshot().physicalExtentPages).toBe(before.physicalExtentPages);
    h.store.close();
  });
  it('keeps storage charged until its actual native observer settles', async () => {
    const h = imageWithThread(), source = h.store.imageSource(h.a), charged = h.store.snapshot().allocatedPages;
    source.atomicStoreI32(0, 17);
    const observation = source.prepareNativeObservationI32(0), wait = observation.arm(17, 1000);
    expect(wait.async).toBe(true); stop(h);
    expect(h.store.tryReleaseStoppedImage(h.a)).toBe('busy');
    expect(h.store.snapshot().allocatedPages).toBe(charged);
    observation.wake(); if (wait.async) await wait.value;
    expect(h.store.snapshot().nativeObservers).toBe(0);
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy'); h.store.close();
  });
  it.each([G.MEMORY_GROUP_WAIT_WAITING, G.MEMORY_GROUP_WAIT_NOTIFIED, G.MEMORY_GROUP_WAIT_STOPPED])('retains an owned queued or unlinked native node (state=%s)', state => {
    const h = imageWithThread(), words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4, at = G.MEMORY_GROUP_WAIT_NODES / 4;
    stop(h); const charged = h.store.snapshot().allocatedPages;
    words[at] = state; words[at + 3] = h.leader.expectation.root; words[at + 4] = h.leader.expectation.replica;
    words[q + 4] = 1;
    if (state === G.MEMORY_GROUP_WAIT_WAITING) words[q + 1] = words[q + 2] = G.MEMORY_GROUP_WAIT_NODES;
    expect(h.store.tryReleaseStoppedImage(h.a)).toBe('busy'); expect(h.store.snapshot().allocatedPages).toBe(charged);
    words[at] = 0; words[q + 1] = words[q + 2] = words[q + 4] = 0;
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy'); h.store.close();
  });
  it('does not drain a live peer image wait or release its data', () => {
    const h = imageWithThread(), receipt = task({ pid: 102, tid: 102, serial: 3n });
    const peer = h.store.prepareImage(receipt, layout), launch = h.store.publish(peer, receipt);
    launch.source.fillBytes(0, P, 0x97); stop(h);
    const words = new Int32Array(launch.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4, at = G.MEMORY_GROUP_WAIT_NODES / 4;
    words[at] = G.MEMORY_GROUP_WAIT_WAITING; words[at + 3] = launch.expectation.root; words[at + 4] = launch.expectation.replica;
    words[q + 1] = words[q + 2] = G.MEMORY_GROUP_WAIT_NODES; words[q + 4] = 1;
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy');
    expect(words[at]).toBe(G.MEMORY_GROUP_WAIT_WAITING); expect(words[q + 4]).toBe(1);
    expect(launch.source.readBytes(0, 32)).toEqual(new Uint8Array(32).fill(0x97));
    words[at] = 0; words[q + 1] = words[q + 2] = words[q + 4] = 0; h.store.close();
  });
  it.each(['queue', 'root', 'pool'])('refuses a busy %s lock without partially releasing pages', target => {
    const h = imageWithThread(); stop(h); const before = h.store.snapshot();
    const address = target === 'queue' ? G.MEMORY_GROUP_WAIT_HEADER : target === 'root' ? h.leader.expectation.root + G.MEMORY_GROUP_ROOT_GROW_LOCK : G.MEMORY_GROUP_CONTROL;
    const lock = new Int32Array(h.leader.envelope.memory.buffer, address, 1); Atomics.store(lock, 0, 1);
    try { expect(h.store.tryReleaseStoppedImage(h.a)).toBe('busy'); } finally { Atomics.store(lock, 0, 0); }
    expect(h.store.snapshot()).toEqual(before);
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy'); h.store.close();
  });
  it('never writes an old root lock after a peer has reused its physical page', () => {
    const h = imageWithThread(); stop(h);
    const pool = (h.store as any).pool, release = pool.tryReleaseRetiredPages.bind(pool);
    let reused!: Int32Array;
    pool.tryReleaseRetiredPages = (pages: Uint32Array) => {
      const status = release(pages);
      if (status === 'released') {
        const receipt = task({ pid: 102, tid: 102, serial: 3n });
        const peer = h.store.prepareImage(receipt, layout), launch = h.store.publish(peer, receipt);
        expect(launch.expectation.root).toBe(h.leader.expectation.root);
        reused = new Int32Array(launch.envelope.memory.buffer, launch.expectation.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
        Atomics.store(reused, 0, 1);
      }
      return status;
    };
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy'); expect(Atomics.load(reused, 0)).toBe(1);
    Atomics.store(reused, 0, 0); h.store.close();
  });
});
it('removes a proven stopped member from an active barrier and settles its exact ACK observer', async () => {
  const h = imageWithThread(), charged = h.store.snapshot().allocatedPages;
  const barrier = h.store.beginImageExecutionPause(h.a);
  h.acknowledge(h.left);
  const observation = h.store.waitForMappingProgress(barrier, 'barrier');
  expect(h.store.snapshot().nativeObservers).toBe(1);
  expect(h.store.imageExecutionPauseAcknowledged(barrier)).toBe(false);
  h.store.noteReplicaQuiescent(h.b);
  expect(Atomics.load(h.right, G.MEMORY_GROUP_REPLICA_ACK / 4)).toBe(0);
  expect(h.store.imageExecutionPauseAcknowledged(barrier)).toBe(true);
  expect(h.store.snapshot().allocatedPages).toBe(charged);
  await observation;
  expect(h.store.snapshot().nativeObservers).toBe(0);
  const prepared = h.store.waitForImageExecutionPause(h.a);
  expect(h.store.resumeImageExecutionPause(barrier)).toBe(true);
  await prepared;
  const next = h.store.beginImageExecutionPause(h.a); h.acknowledge(h.left);
  expect(h.store.imageExecutionPauseAcknowledged(next)).toBe(true);
  expect(h.store.resumeImageExecutionPause(next)).toBe(true);
  h.store.close();
});
describe('paused full virtual-capacity validation', () => {
  it.each(['fork', 'mapping'] as const)('preserves every charge when %s sees a corrupt bounds or tail PTE', kind => {
    for (const corruption of ['physical', 'tail', 'rights'] as const) {
      const h = pausedMappingImage(64, { ...layout, maximumVirtualPages: 65536 });
      const memory = h.leader.envelope.memory;
      const table = new Uint32Array(memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 65536);
      const at = corruption === 'tail' ? 65535 : 1;
      const saved = table[at], charged = h.store.snapshot().allocatedPages;
      const physical = corruption === 'physical' ? memory.buffer.byteLength / P : table[0] >>> 16;
      table[at] = physical * P + (corruption === 'rights' ? 7 : 3);
      try {
        expect(() => kind === 'fork'
          ? h.store.preparePrivateFork(h.barrier, task({ pid: 200, tid: 200, serial: 3n }))
          : h.store.prepareImageMapping(h.barrier, h.describe())).toThrow(/Invalid private fork PTE|Invalid physical mapping baseline/);
        expect(h.store.snapshot().allocatedPages).toBe(charged);
        expect(h.leader.source.readBytes(0, 1)).toEqual(Uint8Array.of(0));
      } finally { table[at] = saved; h.store.resumeImageExecutionPause(h.barrier); h.store.close(); }
    }
  });
});
describe('owned physical mapping transactions', () => {
  it('populates fresh readonly pages before publication and rolls back rejected file replacement', () => {
    const h = pausedMappingImage(), { store } = h;
    h.leader.source.fillBytes(0, 2 * P, 0xa5);
    const charged = store.snapshot().allocatedPages;
    const patch = { address: 0, result: 0, length: 2 * P, prot: 1, flags: 2, populationAddress: 0, populationLength: 2 * P };
    const token = h.prepare(patch), bytes = Uint8Array.of(1, 2, 3, 4);
    store.populateImageMapping(token, P - 2, bytes);
    expect(h.leader.source.readBytes(P - 2, 4)).toEqual(Uint8Array.of(0xa5, 0xa5, 0xa5, 0xa5));
    expect(() => store.populateImageMapping(token, 2 * P - 1, bytes)).toThrow(/interval/);
    expect(store.commitImageMapping(token, () => true, () => -5)).toBe(-5);
    expect(h.peer.source.readBytes(P - 2, 4)).toEqual(Uint8Array.of(0xa5, 0xa5, 0xa5, 0xa5));
    store.cancelImageMapping(token);
    expect(store.snapshot().allocatedPages).toBe(charged);
    expect(() => store.populateImageMapping(token, 0, bytes)).toThrow(/unpublished/);
    const accepted = h.prepare(patch); store.populateImageMapping(accepted, P - 2, bytes);
    expect(store.commitImageMapping(accepted, () => true, () => 0)).toBe('committed');
    expect(h.peer.source.readBytes(P - 2, 4)).toEqual(bytes);
    expect(h.peer.source.readBytes(0, 8)).toEqual(new Uint8Array(8));
    expect(() => h.peer.source.writeBytes(0, bytes)).toThrow(); store.close();
  });
  it('refuses population directed at an existing physical page', () => {
    const h = pausedMappingImage(); h.leader.source.fillBytes(0, P, 0x6a);
    const token = h.prepare({ populationAddress: 0, populationLength: P });
    expect(() => h.store.populateImageMapping(token, 0, Uint8Array.of(9))).toThrow(/published storage/);
    expect(h.peer.source.readBytes(0, 1)[0]).toBe(0x6a);
    h.store.cancelImageMapping(token); h.store.close();
  });
  it('grows, shrinks and regrows heap pages without changing partial-page rights or reusing detached storage', () => {
    const h = pausedMappingImage(), charged = h.store.snapshot().allocatedPages;
    h.leader.source.fillBytes(P, P, 0x55);
    const protect = h.prepare({ kind: 'protect', address: P, result: 0, length: P, flags: 0, prot: 1 });
    h.store.commitImageMapping(protect, () => true, () => 0);
    const change = (oldAddress: number, address: number) => h.prepare({ kind: 'break', oldAddress, address, result: address, length: 0, oldLength: 0, flags: 0, prot: 3 });
    const grow = change(P + 7, 3 * P + 9); expect(h.store.commitImageMapping(grow, () => true, () => 0)).toBe('committed');
    expect(h.peer.source.readBytes(P, P).every(byte => byte === 0x55)).toBe(true);
    expect(() => h.peer.source.writeBytes(P, Uint8Array.of(1))).toThrow();
    expect(h.peer.source.readBytes(2 * P, 2 * P).every(byte => byte === 0)).toBe(true);
    const shrink = change(3 * P + 9, P + 9); h.store.commitImageMapping(shrink, () => true, () => 0);
    expect(h.peer.source.byteLength).toBe(4 * P); expect(() => h.peer.source.readBytes(2 * P, 1)).toThrow();
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged + 2, retainedMappingReferences: 2 });
    const regrow = change(P + 9, 3 * P + 9); h.store.commitImageMapping(regrow, () => true, () => 0);
    expect(h.peer.source.readBytes(2 * P, 2 * P).every(byte => byte === 0)).toBe(true);
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged + 4, mappingStagingBytes: 0 }); h.store.close();
  });
  it('stages fresh MAP_FIXED bytes and restores old PTEs when Rust refuses commit', () => {
    const h = pausedMappingImage(), { store } = h; h.leader.source.fillBytes(0, P, 0xa5);
    const charged = store.snapshot().allocatedPages, token = h.prepare({ address: 0, result: 0 });
    expect(h.leader.source.readBytes(0, 1)[0]).toBe(0xa5);
    expect(store.snapshot().allocatedPages).toBe(charged + 1);
    expect(store.snapshot().mappingStagingBytes).toBeGreaterThan(0);
    expect(store.commitImageMapping(token, () => true, description => {
      expect(description.token).toBe((1n << 63n) + 7n);
      expect(h.leader.source.readBytes(0, P).every(byte => byte === 0)).toBe(true);
      return -12;
    })).toBe(-12);
    expect(h.leader.source.readBytes(0, 1)[0]).toBe(0xa5);
    expect(store.cancelImageMapping(token)).toBe('cancelled');
    expect(store.snapshot().allocatedPages).toBe(charged);
    expect(store.snapshot().mappingStagingBytes).toBe(0);
    expect(() => store.commitImageMapping(token, () => true, () => 0)).toThrow(); store.close();
  });
  it('publishes sparse zeroed mappings to every replica and preserves removed pages', () => {
    const h = pausedMappingImage(), { store } = h, charged = store.snapshot().allocatedPages;
    const token = h.prepare();
    expect(h.peer.source.byteLength).toBe(2 * P);
    expect(store.commitImageMapping(token, () => true, () => 0)).toBe('committed');
    expect(h.peer.source.byteLength).toBe(9 * P); expect(h.peer.source.readBytes(8 * P, P).every(v => v === 0)).toBe(true);
    expect(() => h.peer.source.readBytes(3 * P, 1)).toThrow(ProcessAddressFault);
    expect(() => store.cancelImageMapping(token)).toThrow();
    const unmap = h.prepare({ kind: 'unmap', result: 0, flags: 0, prot: 0 });
    expect(store.commitImageMapping(unmap, () => true, () => 0)).toBe('committed');
    expect(() => h.peer.source.readBytes(8 * P, 1)).toThrow(ProcessAddressFault);
    expect(store.snapshot().allocatedPages).toBe(charged + 1); store.close();
  });
  it('changes protection without copying storage and cannot protect a hole into existence', () => {
    const h = pausedMappingImage(); h.leader.source.writeBytes(0, new Uint8Array([71]));
    const charged = h.store.snapshot().allocatedPages;
    const token = h.prepare({ kind: 'protect', address: 0, result: 0, flags: 0, prot: 1 });
    expect(h.store.commitImageMapping(token, () => true, () => 0)).toBe('committed');
    expect(h.peer.source.readBytes(0, 1)[0]).toBe(71); expect(() => h.peer.source.writeBytes(0, new Uint8Array([3]))).toThrow();
    expect(() => h.prepare({ kind: 'protect', result: 0, flags: 0 })).toThrow(/hole/);
    expect(h.store.snapshot().allocatedPages).toBe(charged); h.store.close();
  });
  it('moves a remap prefix directly, zeroes its growth tail and removes the old address', () => {
    const h = pausedMappingImage(); h.leader.source.fillBytes(0, P, 0x37);
    const charged = h.store.snapshot().allocatedPages;
    const token = h.prepare({ kind: 'remap', flags: 0, oldAddress: 0, oldLength: P, length: 2 * P });
    expect(h.store.commitImageMapping(token, () => true, () => 0)).toBe('committed');
    expect(h.peer.source.readBytes(8 * P, P).every(v => v === 0x37)).toBe(true);
    expect(h.peer.source.readBytes(9 * P, P).every(v => v === 0)).toBe(true);
    expect(() => h.peer.source.readBytes(0, 1)).toThrow(); expect(h.store.snapshot().allocatedPages).toBe(charged + 1); h.store.close();
  });
  it('refuses partial barriers, other receipts and busy root/group locks without ownership changes', () => {
    const h = pausedMappingImage(), memory = h.leader.envelope.memory;
    const charged = h.store.snapshot().allocatedPages;
    Atomics.store(h.right, G.MEMORY_GROUP_REPLICA_ACK / 4, 0);
    expect(h.store.prepareImageMapping(h.barrier, h.describe())).toBe('waiting'); h.acknowledge(h.right);
    expect(() => h.store.prepareImageMapping(h.barrier, h.describe({ receipt: task({ serial: 99n }) }))).toThrow(/receipt/);
    for (const address of [h.leader.expectation.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, G.MEMORY_GROUP_CONTROL]) {
      const lock = new Int32Array(memory.buffer, address, 1); Atomics.store(lock, 0, 1);
      try { expect(h.store.prepareImageMapping(h.barrier, h.describe())).toBe('busy'); }
      finally { Atomics.store(lock, 0, 0); }
      expect(h.store.snapshot().allocatedPages).toBe(charged);
    }
    h.store.cancelImageMapping(h.prepare()); h.store.close();
  });
  it('revalidates root extent/PTEs and a cancelled or stopped operation before calling commit', () => {
    for (const change of ['extent', 'pte', 'cancel', 'stop'] as const) {
      const h = pausedMappingImage(), token = h.prepare(); let called = false;
      const words = new Uint32Array(h.leader.envelope.memory.buffer), root = h.leader.expectation.root / 4;
      const result = h.store.commitImageMapping(token, () => {
        if (change === 'extent') words[root]++;
        else if (change === 'pte') words[root + G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4] ^= 1;
        else if (change === 'cancel') h.store.cancelImageMapping(token);
        else h.store.requestReplicaStop(h.b);
        return true;
      }, () => { called = true; return 0; });
      expect(result).toBe('stale'); expect(called).toBe(false);
      if (change !== 'cancel') expect(h.store.cancelImageMapping(token)).toBe('cancelled'); h.store.close();
    }
  });
  it('keeps unpublished rollback custody on a busy pool and forbids reentrant release during publication', () => {
    const h = pausedMappingImage(), token = h.prepare(), memory = h.leader.envelope.memory;
    const lock = new Int32Array(memory.buffer, G.MEMORY_GROUP_CONTROL, 1); Atomics.store(lock, 0, 1);
    try { expect(h.store.cancelImageMapping(token)).toBe('busy'); } finally { Atomics.store(lock, 0, 0); }
    expect(h.store.commitImageMapping(token, () => true, () => {
      expect(() => h.store.cancelImageMapping(token)).toThrow(/unpublished/); return 0;
    })).toBe('committed'); h.store.close();
  });
  it('contains uncertain Rust publication and retains both old and replacement storage', () => {
    const h = pausedMappingImage(), charged = h.store.snapshot().allocatedPages, token = h.prepare();
    expect(() => h.store.commitImageMapping(token, () => true, () => { throw Error('commit trap'); })).toThrow('commit trap');
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged + 1, quarantinedReplicas: 2 });
    expect(() => h.store.cancelImageMapping(token)).toThrow(); expect(() => h.store.imageSource(h.a)).toThrow(); h.store.close();
  });
  it('refuses unowned tokens, malformed brk and oversized allocation', () => {
    const h = pausedMappingImage();
    expect(() => h.store.cancelImageMapping({} as PreparedGroupMapping)).toThrow();
    expect(() => h.prepare({ kind: 'break' })).toThrow(/Invalid/);
    expect(() => h.prepare({ length: 17 * P })).toThrow(); h.store.close();
  });
  it('leaves the old mapping and barrier usable after physical exhaustion', () => {
    const h = pausedMappingImage(8), before = h.store.snapshot();
    expect(h.store.prepareImageMapping(h.barrier, h.describe())).toBe('exhausted');
    expect(h.store.prepareImageMapping(h.barrier, h.describe({ address: 0, length: 8 * P }))).toBe('exhausted');
    expect(h.store.prepareImageMapping(h.barrier, h.describe({ kind: 'break', oldAddress: P, address: 3 * P + 7,
      result: 3 * P + 7, length: 0, oldLength: 0, flags: 0 }))).toBe('exhausted');
    expect(h.store.snapshot()).toEqual(before);
    const protect = h.prepare({ kind: 'protect', address: 0, result: 0, flags: 0, prot: 1 });
    expect(h.store.commitImageMapping(protect, () => true, () => 0)).toBe('committed'); h.store.close();
  });
  it('preserves PROT_NONE storage and remap-shrink bytes while charging detached references', () => {
    const h = pausedMappingImage(); h.leader.source.fillBytes(0, 2 * P, 0x42);
    const charged = h.store.snapshot().allocatedPages;
    for (const prot of [0, 3]) {
      const token = h.prepare({ kind: 'protect', address: 0, result: 0, length: 2 * P, prot, flags: 0 });
      expect(h.store.commitImageMapping(token, () => true, () => 0)).toBe('committed');
      if (!prot) expect(() => h.peer.source.readBytes(0, 1)).toThrow();
    }
    const shrink = h.prepare({ kind: 'remap', address: 0, result: 0, oldAddress: 0, oldLength: 2 * P, flags: 0 });
    expect(h.store.commitImageMapping(shrink, () => true, () => 0)).toBe('committed');
    expect(h.peer.source.readBytes(0, P).every(v => v === 0x42)).toBe(true); expect(() => h.peer.source.readBytes(P, 1)).toThrow();
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged, mappingStagingBytes: 0, retainedMappingReferences: 1 }); h.store.close();
  });
  it('takes an independent receipt/effect copy and refuses a busy commit before kernel callbacks', () => {
    const h = pausedMappingImage(), input = h.describe(), token = h.store.prepareImageMapping(h.barrier, input);
    if (typeof token === 'string') throw Error(token);
    (input as any).address = 0; (input.receipt as any).serial = 0n;
    const lock = new Int32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    Atomics.store(lock, 0, 1); let called = false;
    try { expect(h.store.commitImageMapping(token, () => { called = true; return true; }, () => 0)).toBe('busy'); }
    finally { Atomics.store(lock, 0, 0); }
    expect(called).toBe(false);
    expect(h.store.commitImageMapping(token, description => {
      expect(description.address).toBe(8 * P); expect(description.receipt.serial).not.toBe(0n);
      expect(Object.isFrozen(description)).toBe(true); expect(Object.isFrozen(description.receipt)).toBe(true); return true;
    }, () => 0)).toBe('committed'); h.store.close();
  });
});
describe('image execution barriers for mapping publication', () => {
  it('pins an exact native progress observation through source revocation until actual settlement', async () => {
    const h = imageWithThread(), barrier = h.store.beginImageExecutionPause(h.a);
    const progress = h.store.waitForMappingProgress(barrier, 'barrier');
    expect(h.store.snapshot().nativeObservers).toBe(1);
    h.store.revokeImageAccess(h.a); expect(h.store.snapshot().nativeObservers).toBe(1);
    h.acknowledge(h.left); Atomics.notify(h.left, G.MEMORY_GROUP_REPLICA_ACK / 4);
    await progress;
    expect(h.store.snapshot().nativeObservers).toBe(0);
    expect(h.store.imageExecutionPauseAcknowledged(barrier)).toBe(false);
    h.store.resumeImageExecutionPause(barrier); h.store.close();
  });
  it('uses bounded native contention observation without treating timeout as an execution ACK', async () => {
    const h = imageWithThread(), barrier = h.store.beginImageExecutionPause(h.a);
    const lock = new Int32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    Atomics.store(lock, 0, 1);
    try {
      await h.store.waitForMappingProgress(barrier, 'locks');
      expect(Atomics.load(lock, 0)).toBe(1); expect(h.store.snapshot().nativeObservers).toBe(0);
      expect(h.store.imageExecutionPauseAcknowledged(barrier)).toBe(false);
    } finally { Atomics.store(lock, 0, 0); h.store.resumeImageExecutionPause(barrier); h.store.close(); }
  });
  it('requires every exact replica and leaves a successor image alone', () => {
    const h = imageWithThread(), { store } = h;
    const next = task({ serial: 3n, generation: h.main.generation + 1n });
    const successor = store.publish(store.prepareImage(next, layout), next), other = h.control(successor);
    const charged = store.snapshot().allocatedPages, pause = store.beginImageExecutionPause(h.a);
    expect(Object.getPrototypeOf(pause)).toBeNull(); expect(Object.keys(pause)).toEqual([]);
    expect(h.request(h.left)).toBeGreaterThan(0); expect(h.request(h.right)).toBeGreaterThan(0);
    expect(h.request(h.left)).not.toBe(h.request(h.right)); expect(h.request(other)).toBe(0);
    // Synthetic acknowledgments test owner state, not real C quiescence.
    h.acknowledge(h.left); expect(store.imageExecutionPauseAcknowledged(pause)).toBe(false);
    h.acknowledge(h.right); expect(store.imageExecutionPauseAcknowledged(pause)).toBe(true);
    expect(store.resumeImageExecutionPause(pause)).toBe(true);
    expect(h.request(h.left)).toBe(0); expect(h.request(h.right)).toBe(0);
    expect(store.imageExecutionPauseAcknowledged(pause)).toBe(false);
    expect(store.resumeImageExecutionPause(pause)).toBe(false);
    expect(store.snapshot().allocatedPages).toBe(charged);
    expect(successor.source.byteLength).toBe(2 * P);
    expect(() => store.imageExecutionPauseAcknowledged({} as any)).toThrow();
    expect(() => new MemoryGroupImageStore(7, 32).resumeImageExecutionPause(pause)).toThrow();
    store.close();
  });
  it('freezes membership and refuses a prepared member before any request changes', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), thread = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(thread), launch = store.publish(a, main);
    const control = new Int32Array(launch.envelope.memory.buffer, launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
    expect(() => store.beginImageExecutionPause(a)).toThrow(/live unpaused/);
    expect(Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4)).toBe(0);
    store.publish(b, thread);
    const pause = store.beginImageExecutionPause(b);
    expect(() => store.prepareThread(task({ tid: 102, serial: 3n }))).toThrow(/forbids new replica/);
    expect(() => store.beginImageExecutionPause(a)).toThrow();
    expect(() => store.beginExecutionPause(a)).toThrow(/already owns/);
    expect(store.resumeImageExecutionPause(pause)).toBe(true);
    const fresh = store.prepareThread(task({ tid: 102, serial: 3n }));
    store.cancelUnexposed(fresh); store.close();
  });
  it('cannot absorb an independently paused member or wrap the epoch sequence', () => {
    const h = imageWithThread(), single = h.store.beginExecutionPause(h.b);
    const before = h.request(h.right);
    expect(() => h.store.beginImageExecutionPause(h.a)).toThrow(/live unpaused/);
    expect(h.request(h.left)).toBe(0); expect(h.request(h.right)).toBe(before);
    h.store.resumeExecutionPause(single);
    (h.store as any).nextPauseEpoch = 0xffffffff;
    expect(() => h.store.beginImageExecutionPause(h.a)).toThrow(/fresh replica epochs/);
    expect(h.request(h.left)).toBe(0); expect(h.request(h.right)).toBe(0);
    h.store.close();
  });
  it('invalidates an all-replica acknowledgment when a member stops without freeing pages', () => {
    const h = imageWithThread(), charged = h.store.snapshot().allocatedPages;
    const pause = h.store.beginImageExecutionPause(h.a);
    h.acknowledge(h.left); h.acknowledge(h.right);
    expect(h.store.imageExecutionPauseAcknowledged(pause)).toBe(true);
    h.store.requestReplicaStop(h.b);
    expect(h.store.imageExecutionPauseAcknowledged(pause)).toBe(false);
    expect(h.store.resumeImageExecutionPause(pause)).toBe(false);
    expect(h.request(h.left)).toBe(0);
    expect(Atomics.load(h.right, G.MEMORY_GROUP_REPLICA_RUN / 4)).toBe(0);
    expect(h.store.snapshot().allocatedPages).toBe(charged);
    expect(() => h.store.beginImageExecutionPause(h.a)).toThrow(/live unpaused/);
    h.store.close();
  });
  it('revokes mapping authority with image custody while still permitting barrier cleanup', () => {
    const h = imageWithThread(), pause = h.store.beginImageExecutionPause(h.a);
    h.acknowledge(h.left); h.acknowledge(h.right); h.store.revokeImageAccess(h.a);
    expect(h.store.imageExecutionPauseAcknowledged(pause)).toBe(false);
    expect(h.store.resumeImageExecutionPause(pause)).toBe(true);
    expect(h.request(h.left)).toBe(0); expect(h.request(h.right)).toBe(0);
    h.store.close();
  });
  it('contains partial barrier faults and retains every uncertain wait drain and allocation', () => {
    const h = imageWithThread(), charged = h.store.snapshot().allocatedPages;
    const words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const node = G.MEMORY_GROUP_WAIT_NODES;
    words[q + 1] = node; words[q + 2] = node; words[q + 4] = 1;
    words[node / 4] = G.MEMORY_GROUP_WAIT_WAITING; words[node / 4 + 1] = node;
    expect(() => h.store.beginImageExecutionPause(h.a)).toThrow(/Corrupt memory-group wait queue/);
    expect(h.store.snapshot()).toMatchObject({ quarantinedReplicas: 2, pendingWaitDrains: 2, allocatedPages: charged });
    expect(() => h.leader.source.readBytes(0, 1)).toThrow();
    expect(() => h.peer.source.readBytes(0, 1)).toThrow();
    expect(() => h.store.beginImageExecutionPause(h.a)).toThrow(/live unpaused/);
    h.store.close();
  });
});
describe('kernel-realm group image custody', () => {
  it('provides registration custody only for a live published main replica', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), peer = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(peer);
    expect(() => store.processRegistration(a)).toThrow(/published main/);
    const leader = store.publish(a, main); store.publish(b, peer);
    expect(() => store.processRegistration(b)).toThrow(/published main/);
    expect(() => store.processRegistration({} as any)).toThrow();
    const registration = store.processRegistration(a);
    expect(registration).toMatchObject({ receipt: main, maximumVirtualPages: 16, memory: leader.envelope.memory });
    expect(registration.source).toBe(store.imageSource(b));
    store.quarantine(a);
    expect(() => store.processRegistration(a)).toThrow(/published main/);
    // Kernel image custody survives, but a retired execution owner cannot
    // install it again. This does not infer quiescence or free its pages.
    expect(store.imageSource(b)).toBe(registration.source);
    store.close();
  });
  it('keeps one image source alive when its leader execution access ends', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), peer = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(peer);
    const leader = store.publish(a, main), thread = store.publish(b, peer);
    const image = store.imageSource(a), charged = store.snapshot().allocatedPages;
    expect(store.imageSource(b)).toBe(image);
    expect(image).not.toBe(leader.source); expect(image).not.toBe(thread.source);
    leader.source.writeBytes(P - 1, new Uint8Array([17, 42]));
    store.quarantine(a);
    expect(() => leader.source.readBytes(0, 1)).toThrow(ProcessAddressFault);
    expect(image.readBytes(P - 1, 2)).toEqual(new Uint8Array([17, 42]));
    thread.source.writeBytes(P, new Uint8Array([91]));
    expect(image.readBytes(P, 1)[0]).toBe(91);
    image.writeBytes(P - 1, new Uint8Array([63]));
    expect(thread.source.readBytes(P - 1, 1)[0]).toBe(63);
    expect(store.imageSource(a)).toBe(image);
    expect(store.snapshot().allocatedPages).toBe(charged);
  });
  it('revokes every kernel image handle irreversibly without stopping peers or claiming reuse', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), peer = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(peer);
    const leader = store.publish(a, main), thread = store.publish(b, peer), image = store.imageSource(a);
    const charged = store.snapshot().allocatedPages;
    store.revokeImageAccess(b); store.revokeImageAccess(a);
    expect(() => image.writeBytes(0, new Uint8Array([9]))).toThrow(ProcessAddressFault);
    expect(() => store.imageSource(a)).toThrow(ProcessAddressFault);
    expect(() => store.imageSource(b)).toThrow(ProcessAddressFault);
    expect(() => store.prepareThread(task({ tid: 102, serial: 3n }))).toThrow();
    thread.source.writeBytes(0, new Uint8Array([23]));
    expect(leader.source.readBytes(0, 1)[0]).toBe(23);
    expect(store.snapshot()).toMatchObject({ allocatedPages: charged, exposedReplicas: 2 });
    store.close();
  });
  it('separates old and new image access within one PID and physical backing', () => {
    const store = new MemoryGroupImageStore(7, 32), old = task(), next = task({ serial: 2n, generation: task().generation + (1n << 32n) });
    const a = store.prepareImage(old, layout), b = store.prepareImage(next, layout);
    store.publish(a, old); store.publish(b, next);
    const left = store.imageSource(a), right = store.imageSource(b);
    expect(left).not.toBe(right); expect(left.identity).not.toBe(right.identity);
    left.fillBytes(0, P, 7); right.fillBytes(0, P, 11);
    store.revokeImageAccess(a);
    expect(() => left.readBytes(0, 1)).toThrow(ProcessAddressFault);
    expect(right.readBytes(0, P).every(value => value === 11)).toBe(true);
    store.close(); expect(() => right.readBytes(0, 1)).toThrow(ProcessAddressFault);
  });
  it('refuses unpublished/foreign image access and cannot recreate a never-borrowed revoked source', () => {
    const store = new MemoryGroupImageStore(7, 32), other = new MemoryGroupImageStore(7, 32), main = task();
    const a = store.prepareImage(main, layout);
    expect(() => store.imageSource(a)).toThrow(ProcessAddressFault);
    expect(() => other.imageSource(a)).toThrow();
    store.publish(a, main); store.revokeImageAccess(a);
    expect(() => store.imageSource(a)).toThrow(ProcessAddressFault);
    const next = task({ pid: 101, tid: 101, serial: 2n }), b = store.prepareImage(next, layout);
    store.revokeImageAccess(b);
    expect(() => store.publish(b, next)).toThrow();
    store.cancelUnexposed(b); store.releaseUnexposedImage(next);
    expect(() => store.imageSource(b)).toThrow();
    store.close(); other.close();
  });
  it('binds reversible barriers to exact non-reused epochs and consumes resume authority', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task();
    const handle = store.prepareImage(main, layout), launch = store.publish(handle, main);
    const control = new Int32Array(launch.envelope.memory.buffer, launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
    const a = store.beginExecutionPause(handle);
    const first = Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4);
    expect(Object.keys(a)).toEqual([]); expect(store.executionPauseAcknowledged(a)).toBe(false);
    // Synthetic acknowledgment exercises owner state only; real compiled-C
    // source checkpoints are checked separately in disposable Workers.
    Atomics.store(control, G.MEMORY_GROUP_REPLICA_ACK / 4, first);
    expect(store.executionPauseAcknowledged(a)).toBe(true);
    expect(store.resumeExecutionPause(a)).toBe(true); expect(store.resumeExecutionPause(a)).toBe(false);
    const b = store.beginExecutionPause(handle), second = Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4);
    expect(second).toBeGreaterThan(first); expect(store.executionPauseAcknowledged(b)).toBe(false);
    expect(store.resumeExecutionPause(a)).toBe(false);
    expect(Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4)).toBe(second);
    expect(() => store.resumeExecutionPause({} as any)).toThrow();
    expect(store.resumeExecutionPause(b)).toBe(true);
  });
  it('targets one queued replica without notifying its same-word same-root peer', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), peer = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(peer);
    const left = store.publish(a, main), right = store.publish(b, peer), memory = left.envelope.memory;
    const words = new Int32Array(memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const first = G.MEMORY_GROUP_WAIT_NODES, second = first + G.MEMORY_GROUP_WAIT_NODE_BYTES;
    const physical = (words[(left.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES) / 4] >>> 0) & -P;
    for (const [node, next, replica] of [[first, second, left.expectation.replica], [second, 0, right.expectation.replica]]) {
      words[node / 4] = G.MEMORY_GROUP_WAIT_WAITING; words[node / 4 + 1] = next;
      words[node / 4 + 2] = physical; words[node / 4 + 3] = left.expectation.root; words[node / 4 + 4] = replica;
      words[(replica + G.MEMORY_GROUP_REPLICA_WAIT_NODE) / 4] = node;
    }
    words[q + 1] = first; words[q + 2] = second; words[q + 4] = 2;
    const pause = store.beginExecutionPause(b);
    expect(store.executionPauseAcknowledged(pause)).toBe(true);
    expect(words[q + 1]).toBe(first); expect(words[second / 4]).toBe(G.MEMORY_GROUP_WAIT_WAITING);
    expect(store.requestReplicaStop(a)).toBe(true);
    expect(words[first / 4]).toBe(G.MEMORY_GROUP_WAIT_STOPPED);
    expect(words[q + 1]).toBe(second); expect(words[q + 2]).toBe(second);
    expect(words[second / 4]).toBe(G.MEMORY_GROUP_WAIT_WAITING);
    expect(words[(right.expectation.replica + G.MEMORY_GROUP_REPLICA_RUN) / 4]).toBe(1);
    expect(publishMemoryGroupNotification(memory, physical, 1, () => {})).toBe(1);
    expect(words[second / 4]).toBe(G.MEMORY_GROUP_WAIT_NOTIFIED);
    expect(store.resumeExecutionPause(pause)).toBe(true);
    expect(words[q + 4]).toBe(2); // Returning waiters still own recycling.
    expect(store.snapshot().allocatedPages).toBe(8); // No stop-fence inference.
  });
  it('contains a busy wait queue without blocking teardown or freeing its owners', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), handle = store.prepareImage(main, layout);
    const launch = store.publish(handle, main), words = new Int32Array(launch.envelope.memory.buffer);
    const q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    Atomics.store(words, q, 1); store.close();
    expect(store.snapshot()).toMatchObject({ pendingWaitDrains: 1, allocatedPages: 6, quarantinedReplicas: 1 });
    expect(words[(launch.expectation.replica + G.MEMORY_GROUP_REPLICA_RUN) / 4]).toBe(0);
    expect(() => launch.source.readBytes(0, 1)).toThrow();
    Atomics.store(words, q, 0);
    expect(store.requestReplicaStop(handle)).toBe(true);
    expect(store.snapshot()).toMatchObject({ pendingWaitDrains: 0, allocatedPages: 6 });
  });
  it('returns an opaque preparation and metadata-only accounting before publication', () => {
    const store = new MemoryGroupImageStore(7, 32), receipt = { ...task() };
    const handle = store.prepareImage(receipt, layout);
    expect(Object.keys(handle)).toEqual([]); expect(Object.getPrototypeOf(handle)).toBeNull();
    expect(Object.isFrozen(handle)).toBe(true);
    expect(store.snapshot()).toMatchObject({ images: 1, replicas: 1, allocatedPages: 6, exposedReplicas: 0 });
    expect(Object.values(store.snapshot()).every(v => typeof v === 'number')).toBe(true);
    receipt.serial += 1n; expect(store.receipt(handle).serial).not.toBe(receipt.serial);
  });
  it('gives an image one root and each thread separate zeroed translation scratch', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), peer = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(peer);
    const left = store.publish(a, main), right = store.publish(b, peer);
    expect(left.expectation.root).toBe(right.expectation.root);
    expect(left.expectation.scratch).not.toBe(right.expectation.scratch);
    expect(left.envelope.memory).toBe(right.envelope.memory);
    const bytes = new Uint8Array(left.envelope.memory.buffer);
    expect(bytes.slice(left.expectation.scratch, left.expectation.scratch + P).every(v => v === 0)).toBe(true);
    bytes[left.expectation.scratch] = 255; expect(bytes[right.expectation.scratch]).toBe(0);
    left.source.writeBytes(P - 1, new Uint8Array([17, 42]));
    expect(right.source.readBytes(P - 1, 2)).toEqual(new Uint8Array([17, 42]));
    const wire = structuredClone(left.envelope);
    const decoded = decodeProcessMemoryDescriptor(wire, left.expectation).source as GroupProcessAddressSpace;
    expect(decoded.readBytes(P, 1)[0]).toBe(42);
  });
  it('keeps high generation bits and image roots separate within one physical group', () => {
    const store = new MemoryGroupImageStore(7, 32), old = task(), next = task({ serial: 2n, generation: task().generation + (1n << 32n) });
    const a = store.prepareImage(old, layout), b = store.prepareImage(next, layout);
    const left = store.publish(a, old), right = store.publish(b, next);
    expect(left.expectation.root).not.toBe(right.expectation.root);
    left.source.fillBytes(0, 2 * P, 0xea);
    expect(right.source.readBytes(0, 2 * P).every(v => v === 0)).toBe(true);
    expect(store.snapshot()).toMatchObject({ images: 2, replicas: 2, allocatedPages: 11 });
  });
  it('rolls back partial allocation on real capacity failure without consuming payload pages', () => {
    const store = new MemoryGroupImageStore(7, 5, 5);
    expect(() => store.prepareImage(task(), layout)).toThrow(RangeError);
    expect(store.snapshot()).toMatchObject({ images: 0, replicas: 0, allocatedPages: 1, physicalExtentPages: 5 });
    const small = { ...layout, initialVirtualPages: 1 };
    const handle = store.prepareImage(task(), small), launch = store.publish(handle, task());
    expect(launch.source.readBytes(0, P).every(v => v === 0)).toBe(true);
    expect(store.snapshot().allocatedPages).toBe(5);
  });
  it('returns unpublished scratch independently and releases a root only after its last owner', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), peer = task({ tid: 101, serial: 2n });
    const a = store.prepareImage(main, layout), b = store.prepareThread(peer);
    expect(() => store.releaseUnexposedImage(main)).toThrow();
    store.cancelUnexposed(a); expect(store.canReleaseUnexposedImage(main)).toBe(false);
    expect(() => store.cancelUnexposed(a)).toThrow();
    expect(store.snapshot().allocatedPages).toBe(6);
    store.cancelUnexposed(b); expect(store.canReleaseUnexposedImage(main)).toBe(true);
    store.releaseUnexposedImage(main);
    expect(store.snapshot()).toMatchObject({ allocatedPages: 1, replicas: 0, images: 0 });
    expect(() => store.releaseUnexposedImage(main)).toThrow();
    const next = task({ serial: 3n, generation: main.generation + 1n });
    const launch = store.publish(store.prepareImage(next, layout), next);
    expect(launch.source.readBytes(0, 2 * P).every(v => v === 0)).toBe(true);
  });
  it('refuses invented, foreign, duplicate and stale publication capabilities', () => {
    const a = new MemoryGroupImageStore(7, 32), b = new MemoryGroupImageStore(7, 32), main = task();
    const handle = a.prepareImage(main, layout);
    expect(() => b.publish(handle, main)).toThrow();
    expect(() => a.publish(Object.freeze({}) as any, main)).toThrow();
    expect(() => a.publish(handle, { ...main, serial: main.serial + (1n << 32n) })).toThrow();
    expect(() => a.prepareImage(main, layout)).toThrow();
    expect(() => a.prepareThread({ ...main, tid: 101, serial: 3n, generation: main.generation + 1n })).toThrow();
    const launch = a.publish(handle, main);
    expect(() => a.publish(handle, main)).toThrow();
    expect(() => a.cancelUnexposed(handle)).toThrow();
    expect(() => a.releaseUnexposedImage(main)).toThrow();
    expect(launch.source.byteLength).toBe(2 * P);
  });
  it('retains charged pages after publication and revokes host access without claiming quiescence', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), handle = store.prepareImage(main, layout);
    const launch = store.publish(handle, main), before = store.snapshot().allocatedPages;
    store.quarantine(handle);
    expect(() => launch.source.readBytes(0, 1)).toThrow(ProcessAddressFault);
    expect(() => launch.expectation.assertLive()).toThrow(ProcessAddressFault);
    expect(() => store.cancelUnexposed(handle)).toThrow();
    expect(store.snapshot()).toMatchObject({ allocatedPages: before, quarantinedReplicas: 1 });
    // Even an escaped wire backing remains charged. No local token can prove
    // that an external Worker stopped using these bytes.
    expect(launch.envelope.memory.buffer.byteLength).toBeGreaterThanOrEqual(before * P);
  });
  it('closes all accessors while retaining allocation and refusing new admissions', () => {
    const store = new MemoryGroupImageStore(7, 32), main = task(), handle = store.prepareImage(main, layout);
    const launch = store.publish(handle, main); store.close();
    expect(() => launch.source.fillBytes(0, 1, 42)).toThrow(ProcessAddressFault);
    expect(() => store.prepareImage(task({ serial: 2n, pid: 101, tid: 101 }), layout)).toThrow();
    expect(store.snapshot()).toMatchObject({ images: 1, replicas: 1, allocatedPages: 6, quarantinedReplicas: 1 });
  });
  it('allocates the complete multi-page root at the largest virtual limit', () => {
    const store = new MemoryGroupImageStore(7, 16), main = task();
    const handle = store.prepareImage(main, { ...layout, initialVirtualPages: 0, maximumVirtualPages: 65536 });
    const launch = store.publish(handle, main);
    expect(launch.source.byteLength).toBe(0);
    expect(launch.expectation.replica - launch.expectation.root).toBe(5 * P);
    expect(store.snapshot().allocatedPages).toBe(8);
  });
});


describe('unconstructed thread control rollback', () => {
  it('retains mapped pages and refuses rebinding until exact native observations settle', async () => {
    const h = imageWithThread(), source = h.store.imageSource(h.a), charged = h.store.snapshot().allocatedPages;
    const pin = source.prepareNativeObservationI32(P), wait = pin.arm(0, 1000);
    const release = vi.fn(() => true);
    expect(h.store.tryReleaseUnconstructedThreadControl(h.a, P, P, release)).toBe('busy');
    expect(release).not.toHaveBeenCalled();
    pin.wake(); if (wait.async) await wait.value;
    expect(h.store.tryReleaseUnconstructedThreadControl(h.a, P, P, () => false)).toBe('busy');
    expect(h.store.snapshot().allocatedPages).toBe(charged);
    h.store.revokeImageAccess(h.a);
    expect(h.store.tryReleaseUnconstructedThreadControl(h.a, P, P, release)).toBe('released');
    expect(release).toHaveBeenCalledOnce();
    expect(h.store.snapshot().allocatedPages).toBe(charged); h.store.close();
  });
  it.each([G.MEMORY_GROUP_WAIT_WAITING, G.MEMORY_GROUP_WAIT_NOTIFIED, G.MEMORY_GROUP_WAIT_STOPPED])('retains a peer target even in queue state %s', state => {
    const h = imageWithThread(), words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const at = G.MEMORY_GROUP_WAIT_NODES / 4;
    const ptes = new Uint32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 16);
    words[at] = state; words[at + 2] = (ptes[1] >>> 16) * P;
    words[at + 3] = h.leader.expectation.root; words[at + 4] = h.peer.expectation.replica;
    words[q + 4] = 1;
    if (state === G.MEMORY_GROUP_WAIT_WAITING) words[q + 1] = words[q + 2] = at * 4;
    const release = vi.fn(() => true);
    expect(h.store.tryReleaseUnconstructedThreadControl(h.a, P, P, release)).toBe('busy');
    expect(release).not.toHaveBeenCalled();
    words[at] = 0; words[q + 1] = words[q + 2] = words[q + 4] = 0;
    expect(h.store.tryReleaseUnconstructedThreadControl(h.a, P, P, release)).toBe('released'); h.store.close();
  });
});

describe('live-image exact thread scratch and control retirement', () => {
  it('releases only the stopped thread scratch after Rust validation, preserving mapped controls and live peers', () => {
    const h = imageWithThread(), charged = h.store.snapshot().allocatedPages;
    h.leader.source.writeBytes(P, Uint8Array.of(0x97));
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('busy');
    h.store.noteReplicaQuiescent(h.b);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => false)).toBe('busy');
    expect(h.store.snapshot().allocatedPages).toBe(charged);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('released');
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: charged - 2, images: 1, replicas: 1, exposedReplicas: 1 });
    expect(h.leader.source.readBytes(P, 1)).toEqual(Uint8Array.of(0x97));
    const receipt = task({ tid: 102, serial: 3n }), next = h.store.prepareThread(receipt);
    const launch = h.store.publish(next, receipt);
    expect(launch.expectation.replica).toBe(h.peer.expectation.replica);
    expect(h.store.snapshot().allocatedPages).toBe(charged);
    expect(() => h.store.receipt(h.b)).toThrow(); h.store.close();
  });
  it('waits for a real observer of control bytes but permits unrelated live-peer observers', async () => {
    const h = imageWithThread(), source = h.store.imageSource(h.a);
    const own = source.prepareNativeObservationI32(P), ownWait = own.arm(0, 1000);
    const peer = source.prepareNativeObservationI32(0), peerWait = peer.arm(0, 1000);
    h.store.noteReplicaQuiescent(h.b);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('busy');
    own.wake(); if (ownWait.async) await ownWait.value;
    expect(h.store.snapshot().nativeObservers).toBe(1);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('released');
    peer.wake(); if (peerWait.async) await peerWait.value; h.store.close();
  });
  it('keeps old scratch through its actual ACK observer even after removing the stopped barrier member', async () => {
    const h = imageWithThread(), barrier = h.store.beginImageExecutionPause(h.a);
    h.acknowledge(h.left);
    const observed = h.store.waitForMappingProgress(barrier, 'barrier');
    h.store.noteReplicaQuiescent(h.b);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('busy');
    await observed;
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('released');
    expect(h.store.imageExecutionPauseAcknowledged(barrier)).toBe(true);
    h.store.resumeImageExecutionPause(barrier); h.store.close();
  });
  it.each([G.MEMORY_GROUP_WAIT_WAITING, G.MEMORY_GROUP_WAIT_NOTIFIED, G.MEMORY_GROUP_WAIT_STOPPED])('preserves a peer parked on old controls, including unlinked node state %s', state => {
    const h = imageWithThread(), words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const at = G.MEMORY_GROUP_WAIT_NODES / 4;
    const ptes = new Uint32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 16);
    words[at] = state; words[at + 2] = (ptes[1] >>> 16) * P;
    words[at + 3] = h.leader.expectation.root; words[at + 4] = h.leader.expectation.replica;
    words[q + 4] = 1;
    if (state === G.MEMORY_GROUP_WAIT_WAITING) words[q + 1] = words[q + 2] = at * 4;
    h.store.noteReplicaQuiescent(h.b);
    const before = words.slice(at, at + 8);
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('busy');
    expect(words.slice(at, at + 8)).toEqual(before);
    words[at] = 0; words[q + 1] = words[q + 2] = words[q + 4] = 0;
    expect(h.store.tryReleaseStoppedThread(h.b, P, P, () => true)).toBe('released'); h.store.close();
  });
});


describe('retired mapping physical custody', () => {
  const unmap = (h: ReturnType<typeof pausedMappingImage>, address = P) => {
    const mapping = h.prepare({ kind: 'unmap', address, length: P, result: 0 });
    expect(h.store.commitImageMapping(mapping, () => true, () => 0)).toBe('committed');
  };
  it('joins the actual stop transition and rejects teardown without treating it as proof', async () => {
    const h = imageWithThread(), stopped = h.store.waitForReplicaQuiescence(h.b);
    h.store.noteReplicaQuiescent(h.b); await stopped;
    await h.store.waitForReplicaQuiescence(h.b);
    const unknown = h.store.waitForReplicaQuiescence(h.a);
    h.store.close(); await expect(unknown).rejects.toThrow();
  });
  it('returns an original unmapped page once, zeroes reuse, and never claims a peer allocation through its old payload tuple', () => {
    const h = pausedMappingImage(); unmap(h);
    const before = h.store.snapshot();
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 1, retainedPages: 0 });
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: before.allocatedPages - 1, retainedMappingReferences: 0 });
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 0, retainedPages: 0 });
    h.store.resumeImageExecutionPause(h.barrier);
    const other = task({ pid: 200, tid: 200, serial: 300n }), image = h.store.prepareImage(other, { ...layout, initialVirtualPages: 1 });
    const peer = h.store.publish(image, other); peer.source.writeBytes(0, Uint8Array.of(0x97));
    h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b); h.store.revokeImageAccess(h.a);
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy');
    expect(peer.source.readBytes(0, 1)).toEqual(Uint8Array.of(0x97));
    h.store.noteReplicaQuiescent(image); h.store.revokeImageAccess(image);
    expect(h.store.tryReleaseStoppedImage(image)).not.toBe('busy');
    expect(h.store.snapshot().allocatedPages).toBe(1);
  });
  it('preserves an unmapped page through actual native observer settlement', async () => {
    const h = pausedMappingImage(), source = h.store.imageSource(h.a);
    const observation = source.prepareNativeObservationI32(P), wait = observation.arm(0, 1000);
    unmap(h);
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 0, retainedPages: 1 });
    observation.wake(); if (wait.async) await wait.value;
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 1, retainedPages: 0 });
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
  it('drops historical alias references while keeping their current physical mapping', () => {
    const h = pausedMappingImage();
    const ptes = new Uint32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 16);
    ptes[1] = ptes[0]; unmap(h);
    const before = h.store.snapshot().allocatedPages;
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 0, retainedPages: 0 });
    expect(h.store.snapshot().allocatedPages).toBe(before);
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
  it.each([G.MEMORY_GROUP_WAIT_WAITING, G.MEMORY_GROUP_WAIT_NOTIFIED, G.MEMORY_GROUP_WAIT_STOPPED])('keeps physical wait target pins in state %s without retaining unrelated pages', state => {
    const h = pausedMappingImage(), words = new Int32Array(h.leader.envelope.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const at = G.MEMORY_GROUP_WAIT_NODES / 4;
    const ptes = new Uint32Array(h.leader.envelope.memory.buffer, h.leader.expectation.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 16);
    words[at] = state; words[at + 2] = (ptes[1] >>> 16) * P;
    words[at + 3] = h.leader.expectation.root; words[at + 4] = h.peer.expectation.replica; words[q + 4] = 1;
    if (state === G.MEMORY_GROUP_WAIT_WAITING) {
      words[q + 1] = words[q + 2] = at * 4;
      Atomics.store(h.right, G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4, at * 4);
    }
    unmap(h);
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 0, retainedPages: 1 });
    words[at] = 0; words[q + 1] = words[q + 2] = words[q + 4] = 0;
    Atomics.store(h.right, G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4, 0);
    expect(h.store.tryReclaimRemovedPages(h.a)).toEqual({ releasedPages: 1, retainedPages: 0 });
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
});

it('does not keep a reclaimed private-fork page in its original payload ownership', () => {
  const h = pausedMappingImage(), receipt = task({ pid: 200, tid: 200, serial: 300n });
  const child = h.store.preparePrivateFork(h.barrier, receipt);
  if (typeof child === 'string') throw Error(child);
  const launch = h.store.publish(child, receipt); h.store.resumeImageExecutionPause(h.barrier);
  const barrier = h.store.beginImageExecutionPause(child), words = h.control(launch); h.acknowledge(words);
  const mapping = h.store.prepareImageMapping(barrier, h.describe({ receipt, kind: 'unmap', address: P, length: P, result: 0 }));
  if (typeof mapping === 'string') throw Error(mapping);
  expect(h.store.commitImageMapping(mapping, () => true, () => 0)).toBe('committed');
  expect(h.store.tryReclaimRemovedPages(child)).toEqual({ releasedPages: 1, retainedPages: 0 });
  h.store.resumeImageExecutionPause(barrier);
  const other = task({ pid: 300, tid: 300, serial: 400n }), peer = h.store.prepareImage(other, layout);
  const exposed = h.store.publish(peer, other); exposed.source.writeBytes(0, Uint8Array.of(0x73));
  h.store.noteReplicaQuiescent(child); h.store.revokeImageAccess(child);
  expect(h.store.tryReleaseStoppedImage(child)).not.toBe('busy');
  expect(exposed.source.readBytes(0, 1)).toEqual(Uint8Array.of(0x73));
  h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b); h.store.revokeImageAccess(h.a);
  expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy');
  h.store.noteReplicaQuiescent(peer); h.store.revokeImageAccess(peer);
  expect(h.store.tryReleaseStoppedImage(peer)).not.toBe('busy');
  expect(h.store.snapshot().allocatedPages).toBe(1);
});

describe('descriptor-backed group storage', () => {
  it('aliases attachments without copying and retains file pages after exact image retirement', () => {
    const h = pausedMappingImage(64), id = h.describe().token;
    const first = h.prepare({ flags: 1, length: 2 * P, sharedObject: id, sharedLength: 2 * P,
      populationAddress: 0, populationLength: 2 * P });
    h.store.populateImageMapping(first, P + 9, Uint8Array.of(0x71));
    expect(h.store.commitImageMapping(first, () => true, () => 0)).toBe('committed');
    const charged = h.store.snapshot().allocatedPages;
    const alias = h.prepare({ token: id + 1n, flags: 1, address: 10 * P, result: 10 * P,
      length: 2 * P, sharedObject: id, sharedLength: 2 * P });
    expect(h.store.commitImageMapping(alias, () => true, () => 0)).toBe('committed');
    expect(h.store.snapshot().allocatedPages).toBe(charged);
    expect(h.leader.source.readBytes(11 * P + 9, 1)).toEqual(Uint8Array.of(0x71));
    h.leader.source.writeBytes(11 * P + 9, Uint8Array.of(0x72));
    const read = new Uint8Array(1); expect(h.store.readFileObject(id, BigInt(P + 9), read)).toBe(1);
    expect(read).toEqual(Uint8Array.of(0x72));
    h.store.resumeImageExecutionPause(h.barrier);
    h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b); h.store.revokeImageAccess(h.a);
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy');
    expect(h.store.snapshot()).toMatchObject({ images: 0, sharedObjects: 1, sharedPages: 2, allocatedPages: 3 });
    h.store.sweepFileObjects(() => true); expect(h.store.snapshot().allocatedPages).toBe(3);
    h.store.sweepFileObjects(() => false);
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 0, sharedPages: 0, allocatedPages: 1 });
  });
});

describe('anonymous shared backing custody', () => {
  function shared(pages = 3) {
    const h = pausedMappingImage(64), id = h.describe().token;
    const mapping = h.prepare({ length: pages * P, flags: 0x21, sharedObject: id, sharedLength: pages * P });
    expect(h.store.commitImageMapping(mapping, () => true, () => 0)).toBe('committed');
    return { ...h, id };
  }
  it('aliases shared fork pages, copies private pages and counts physical storage once', () => {
    const h = shared(2), before = h.store.snapshot();
    h.leader.source.writeBytes(8 * P, Uint8Array.of(0x71));
    const receipt = task({ pid: 102, tid: 102, serial: 3n });
    const child = h.store.preparePrivateFork(h.barrier, receipt);
    if (typeof child === 'string') throw Error(child);
    const launch = h.store.publish(child, receipt);
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 1, sharedPages: 2, sharedImageReferences: 2,
      allocatedPages: before.allocatedPages + 5 });
    launch.source.writeBytes(8 * P, Uint8Array.of(0x82));
    expect(h.leader.source.readBytes(8 * P, 1)).toEqual(Uint8Array.of(0x82));
    h.leader.source.writeBytes(9 * P, Uint8Array.of(0x93));
    expect(launch.source.readBytes(9 * P, 1)).toEqual(Uint8Array.of(0x93));
    launch.source.writeBytes(0, Uint8Array.of(0xa4));
    expect(h.leader.source.readBytes(0, 1)).toEqual(Uint8Array.of(0));
    h.store.resumeImageExecutionPause(h.barrier);
    h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b); h.store.revokeImageAccess(h.a);
    expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy');
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 1, sharedPages: 2, sharedImageReferences: 1 });
    expect(launch.source.readBytes(8 * P, 1)).toEqual(Uint8Array.of(0x82));
    h.store.noteReplicaQuiescent(child); h.store.revokeImageAccess(child);
    expect(h.store.tryReleaseStoppedImage(child)).not.toBe('busy');
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 0, sharedPages: 0, sharedImageReferences: 0, allocatedPages: 1 });
  });
  it('returns only unpublished private child pages and its backing hold on fork rollback', () => {
    const h = shared(), before = h.store.snapshot();
    const receipt = task({ pid: 102, tid: 102, serial: 3n }), child = h.store.preparePrivateFork(h.barrier, receipt);
    if (typeof child === 'string') throw Error(child);
    h.store.cancelUnexposed(child); h.store.releaseUnexposedImage(receipt);
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: before.allocatedPages, sharedObjects: 1, sharedPages: 3, sharedImageReferences: 1 });
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
  it('keeps object data across shrink and regrowth and preserves remapped offsets', () => {
    const h = shared(); h.leader.source.writeBytes(10 * P, Uint8Array.of(0xb5));
    const commit = (patch: Partial<GroupMemoryChangeDescription>) => {
      const mapping = h.prepare({ kind: 'remap', flags: 0, sharedObject: h.id, sharedLength: 3 * P,
        oldAddress: 8 * P, oldLength: 3 * P, ...patch });
      expect(h.store.commitImageMapping(mapping, () => true, () => 0)).toBe('committed');
    };
    commit({ length: P });
    expect(h.store.tryReclaimRemovedPages(h.a)).toMatchObject({ releasedPages: 0 });
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 1, sharedPages: 3 });
    commit({ oldLength: P, length: 3 * P });
    expect(h.leader.source.readBytes(10 * P, 1)).toEqual(Uint8Array.of(0xb5));
    commit({ address: 12 * P, result: 12 * P, length: P, oldAddress: 10 * P, oldLength: P, sharedOffset: 2 * P });
    expect(h.leader.source.readBytes(12 * P, 1)).toEqual(Uint8Array.of(0xb5));
    expect(() => h.leader.source.readBytes(10 * P, 1)).toThrow();
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
  it('preserves peer storage after unmap and releases only the last detached owner', () => {
    const h = shared(2), receipt = task({ pid: 102, tid: 102, serial: 3n });
    const child = h.store.preparePrivateFork(h.barrier, receipt); if (typeof child === 'string') throw Error(child);
    const launch = h.store.publish(child, receipt);
    const unmap = h.prepare({ kind: 'unmap', flags: 0, prot: 0, result: 0, length: 2 * P });
    expect(h.store.commitImageMapping(unmap, () => true, () => 0)).toBe('committed');
    expect(h.store.tryReclaimRemovedPages(h.a)).toMatchObject({ releasedPages: 0 });
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 1, sharedPages: 2, sharedImageReferences: 1 });
    launch.source.writeBytes(8 * P, Uint8Array.of(0xc6));
    expect(() => h.leader.source.readBytes(8 * P, 1)).toThrow();
    h.store.noteReplicaQuiescent(child); h.store.revokeImageAccess(child);
    expect(h.store.tryReleaseStoppedImage(child)).not.toBe('busy');
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 0, sharedPages: 0, sharedImageReferences: 0 });
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
  it('pins a detached object until its actual native observation settles', async () => {
    const h = shared(1), observation = h.store.imageSource(h.a).prepareNativeObservationI32(8 * P), wait = observation.arm(0, 1000);
    const unmap = h.prepare({ kind: 'unmap', flags: 0, prot: 0, result: 0 });
    expect(h.store.commitImageMapping(unmap, () => true, () => 0)).toBe('committed');
    expect(h.store.tryReclaimRemovedPages(h.a)).toMatchObject({ releasedPages: 0 });
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 1, sharedPages: 1, nativeObservers: 1 });
    observation.wake(); if (wait.async) await wait.value;
    expect(h.store.tryReclaimRemovedPages(h.a)).toMatchObject({ releasedPages: 1 });
    expect(h.store.snapshot()).toMatchObject({ sharedObjects: 0, sharedPages: 0, nativeObservers: 0 });
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
  it('rolls back a rejected native map commit without exposing or retaining the new backing', () => {
    const h = pausedMappingImage(), before = h.store.snapshot(), id = h.describe().token;
    const mapping = h.prepare({ flags: 0x21, sharedObject: id, sharedLength: P });
    expect(h.store.commitImageMapping(mapping, () => true, () => -12)).toBe(-12);
    expect(() => h.leader.source.readBytes(8 * P, 1)).toThrow();
    expect(h.store.cancelImageMapping(mapping)).toBe('cancelled');
    expect(h.store.snapshot()).toMatchObject({ allocatedPages: before.allocatedPages, sharedObjects: 0, sharedPages: 0, sharedImageReferences: 0 });
    h.store.resumeImageExecutionPause(h.barrier); h.store.close();
  });
});


it('admits full descriptor storage for a prefix map and directly publishes bounded device writes', () => {
  const h = pausedMappingImage(64), id = h.describe().token;
  const first = h.prepare({flags: 1, length: P, sharedObject: id, sharedLength: 3 * P});
  expect(h.store.commitImageMapping(first, () => true, () => 0)).toBe('committed');
  const charged = h.store.snapshot().allocatedPages;
  expect(h.store.snapshot()).toMatchObject({sharedObjects: 1, sharedPages: 3});
  expect(h.store.writeFileObject(id, BigInt(P - 1), Uint8Array.of(41, 43))).toBe(2);
  expect(h.leader.source.readBytes(9 * P - 1, 1)).toEqual(Uint8Array.of(41));
  const alias = h.prepare({token: id + 1n, flags: 1, address: 10 * P, result: 10 * P,
    length: 3 * P, sharedObject: id, sharedLength: 3 * P});
  expect(h.store.commitImageMapping(alias, () => true, () => 0)).toBe('committed');
  expect(h.store.snapshot().allocatedPages).toBe(charged);
  expect(h.leader.source.readBytes(11 * P - 1, 2)).toEqual(Uint8Array.of(41, 43));
  h.leader.source.writeBytes(11 * P + 3, Uint8Array.of(59));
  const copied = new Uint8Array(1); expect(h.store.readFileObject(id, BigInt(P + 3), copied)).toBe(1);
  expect(copied).toEqual(Uint8Array.of(59));
  expect(h.store.writeFileObject(id, BigInt(3 * P), Uint8Array.of(99))).toBe(-5);
  expect(h.store.writeFileObject(id, -1n, Uint8Array.of(99))).toBe(-5);
  expect(h.store.writeFileObject(id + 999n, 0n, Uint8Array.of(99))).toBe(-5);
  h.store.resumeImageExecutionPause(h.barrier);
  h.store.noteReplicaQuiescent(h.a); h.store.noteReplicaQuiescent(h.b); h.store.revokeImageAccess(h.a);
  expect(h.store.tryReleaseStoppedImage(h.a)).not.toBe('busy');
  h.store.sweepFileObjects(() => true); expect(h.store.snapshot().sharedPages).toBe(3);
  h.store.sweepFileObjects(() => false); expect(h.store.snapshot().sharedPages).toBe(0);
});


it('refuses an oversized descriptor object as physical admission exhaustion without mutation', () => {
  const h = pausedMappingImage(64), before = h.store.snapshot(), id = h.describe().token;
  expect(h.store.prepareImageMapping(h.barrier, h.describe({flags: 1, length: P,
    sharedObject: id, sharedLength: 65 * P}))).toBe('exhausted');
  expect(h.store.snapshot()).toEqual(before);
  const mapping = h.prepare({flags: 1, sharedObject: id, sharedLength: P});
  expect(h.store.commitImageMapping(mapping, () => true, () => 0)).toBe('committed');
});

it('initializes the complete descriptor object when its first map is a nonzero-offset slice', () => {
  const h = pausedMappingImage(64), id = h.describe().token;
  const first = h.prepare({ flags: 1, length: P, sharedObject: id, sharedLength: 3 * P,
    sharedOffset: P, populationAddress: 0, populationLength: 3 * P });
  h.store.populateImageMapping(first, 3, Uint8Array.of(17));
  h.store.populateImageMapping(first, P + 3, Uint8Array.of(29));
  h.store.populateImageMapping(first, 2 * P + 3, Uint8Array.of(43));
  expect(h.store.commitImageMapping(first, () => true, () => 0)).toBe('committed');
  expect(h.leader.source.readBytes(8 * P + 3, 1)).toEqual(Uint8Array.of(29));
  const charged = h.store.snapshot().allocatedPages;
  const alias = h.prepare({ token: id + 1n, flags: 1, address: 10 * P, result: 10 * P,
    length: 2 * P, sharedObject: id, sharedLength: 3 * P, sharedOffset: P });
  expect(h.store.commitImageMapping(alias, () => true, () => 0)).toBe('committed');
  expect(h.store.snapshot().allocatedPages).toBe(charged);
  expect(h.leader.source.readBytes(11 * P + 3, 1)).toEqual(Uint8Array.of(43));
  h.leader.source.writeBytes(10 * P + 3, Uint8Array.of(59));
  expect(h.leader.source.readBytes(8 * P + 3, 1)).toEqual(Uint8Array.of(59));
  const unmapped = new Uint8Array(1);
  expect(h.store.readFileObject(id, 3n, unmapped)).toBe(1);
  expect(unmapped).toEqual(Uint8Array.of(17));
  expect(h.store.writeFileObject(id, BigInt(P + 3), Uint8Array.of(71))).toBe(1);
  expect(h.leader.source.readBytes(8 * P + 3, 1)).toEqual(Uint8Array.of(71));
  h.store.resumeImageExecutionPause(h.barrier); h.store.close();
});
