import { describe, expect, it } from 'vitest';
import { MemoryGroupImageStore } from '../src/memory-group-image-store';
import { decodeProcessMemoryDescriptor } from '../src/process-memory-descriptor';
import { GroupProcessAddressSpace, ProcessAddressFault } from '../src/process-address-space';
import type { MemoryGroupTaskReceipt } from '../src/memory-group-protocol';
import * as G from '../src/generated/program-extensions';
import { publishMemoryGroupNotification } from '../src/memory-group-notification';

const P = 65536;
const layout = { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: P };
function task(patch: Partial<MemoryGroupTaskReceipt> = {}): MemoryGroupTaskReceipt {
  return { group: 7, pid: 100, tid: 100, serial: (1n << 55n) + 1n, generation: (1n << 54n) + 3n, ...patch };
}
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
