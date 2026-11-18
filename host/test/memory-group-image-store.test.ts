import { describe, expect, it } from 'vitest';
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
function imageWithThread(maximumPhysicalPages = 32) {
  const store = new MemoryGroupImageStore(7, maximumPhysicalPages), main = task(), thread = task({ tid: 101, serial: 2n });
  const a = store.prepareImage(main, layout), b = store.prepareThread(thread);
  const leader = store.publish(a, main), peer = store.publish(b, thread);
  const control = (launch: typeof leader) => new Int32Array(launch.envelope.memory.buffer,
    launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
  const left = control(leader), right = control(peer);
  const request = (words: Int32Array) => Atomics.load(words, G.MEMORY_GROUP_REPLICA_REQUEST / 4);
  const acknowledge = (words: Int32Array) => Atomics.store(words, G.MEMORY_GROUP_REPLICA_ACK / 4, request(words));
  return { store, a, b, main, thread, leader, peer, control, left, right, request, acknowledge };
}
function pausedMappingImage(maximumPhysicalPages = 32) {
  const h = imageWithThread(maximumPhysicalPages), barrier = h.store.beginImageExecutionPause(h.a);
  h.acknowledge(h.left); h.acknowledge(h.right);
  const describe = (patch: Partial<GroupMemoryChangeDescription> = {}): GroupMemoryChangeDescription => ({
    receipt: h.main, token: (1n << 63n) + 7n, kind: 'map', address: 8 * P, length: P,
    oldAddress: 0, oldLength: 0, result: 8 * P, flags: 0x22, prot: 3, ...patch,
  });
  const prepare = (patch: Partial<GroupMemoryChangeDescription> = {}) => {
    const result = h.store.prepareImageMapping(barrier, describe(patch));
    if (typeof result === 'string') throw Error(`Unexpected mapping preparation ${result}`);
    return result;
  };
  return { ...h, barrier, describe, prepare };
}
describe('owned physical mapping transactions', () => {
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
  it('refuses unowned tokens, unsupported brk and oversized allocation without pretending support', () => {
    const h = pausedMappingImage();
    expect(() => h.store.cancelImageMapping({} as PreparedGroupMapping)).toThrow();
    expect(() => h.prepare({ kind: 'break' })).toThrow(/initial-image/);
    expect(() => h.prepare({ length: 17 * P })).toThrow(); h.store.close();
  });
  it('leaves the old mapping and barrier usable after physical exhaustion', () => {
    const h = pausedMappingImage(8), before = h.store.snapshot();
    expect(h.store.prepareImageMapping(h.barrier, h.describe())).toBe('exhausted');
    expect(h.store.prepareImageMapping(h.barrier, h.describe({ address: 0, length: 8 * P }))).toBe('exhausted');
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
