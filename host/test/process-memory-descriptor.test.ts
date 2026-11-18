import { describe, it, expect } from 'vitest';
import * as G from '../src/generated/program-extensions';
import { MemoryGroupPagePool } from '../src/memory-group-pool';
import { MemoryGroupProtocolFault, type MemoryGroupTaskReceipt } from '../src/memory-group-protocol';
import { GroupProcessAddressSpace, ProcessAddressFault } from '../src/process-address-space';
import { encodeProcessMemoryDescriptor, decodeProcessMemoryDescriptor,
  type GroupReplicaMemoryDescriptor, type GroupReplicaMemoryLaunchBinding } from '../src/process-memory-descriptor';
const P = 65536;
function fixture() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32, shared: true });
  MemoryGroupPagePool.initialize(memory, 32).allocateContiguous(13);
  const words = new Uint32Array(memory.buffer);
  for (const [root, second] of [[P, 10 * P], [2 * P, 12 * P]]) {
    words[root / 4] = 2; words[root / 4 + 1] = 8; words[root / 4 + 2] = P;
    words[root / 4 + 3] = 1; words[root / 4 + 14] = 1;
    words[root / 4 + 16] = 8 * P | 3; words[root / 4 + 17] = second | 3;
  }
  const task: MemoryGroupTaskReceipt = { group: 7, pid: 10, tid: 10,
    serial: (1n << 50n) + 3n, generation: (1n << 40n) + 1n };
  let live = true;
  const owner: GroupReplicaMemoryLaunchBinding = { memory, receipt: task, root: P, replica: 3 * P, scratch: 3 * P + G.MEMORY_GROUP_REPLICA_BYTES,
    maximumPhysicalPages: 32, maximumVirtualPages: 8, scratchBytes: P,
    assertLive: () => { if (!live) throw new ProcessAddressFault('retired'); } };
  const initialize = (where: number, task: MemoryGroupTaskReceipt, root: number) => {
    const control = new DataView(memory.buffer, where, G.MEMORY_GROUP_REPLICA_BYTES);
    control.setUint32(G.MEMORY_GROUP_REPLICA_RUN, 1, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_ROOT, root, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET, G.MEMORY_GROUP_REPLICA_MAGIC, true);
    control.setBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, task.serial, true);
    control.setBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, task.generation, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_PID, task.pid, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_TID, task.tid, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_GROUP, task.group, true);
  };
  initialize(3 * P, task, P);
  initialize(5 * P, { ...task, pid: 11, tid: 11, serial: task.serial + 1n }, 2 * P);
  const value: GroupReplicaMemoryDescriptor = { kind: G.MEMORY_GROUP_MODULE, receipt: task,
    root: P, replica: 3 * P, scratch: 3 * P + G.MEMORY_GROUP_REPLICA_BYTES, maximumVirtualPages: 8, scratchBytes: P };
  return { memory, words, task, owner, value, retire: () => { live = false; } };
}
describe('Worker process memory descriptors', () => {
  it('round trips genuine native Memory through structured clone', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const wire = structuredClone(encodeProcessMemoryDescriptor(memory, { kind: 'linear' }));
    const decoded = decodeProcessMemoryDescriptor(wire);
    expect(decoded.source).toBe(wire.memory); expect(decoded.source).toBeInstanceOf(WebAssembly.Memory);
    new Uint8Array(wire.memory.buffer)[3] = 42;
    expect(new Uint8Array(memory.buffer)[3]).toBe(42);
  });
  it('reconstructs local methods from one cloned admitted launch envelope', () => {
    const { value, owner, memory } = fixture();
    const wire = structuredClone(encodeProcessMemoryDescriptor(memory, value, owner));
    expect(Object.getPrototypeOf(wire.descriptor)).toBe(Object.prototype);
    const decoded = decodeProcessMemoryDescriptor(wire, owner);
    expect(decoded.source).toBeInstanceOf(GroupProcessAddressSpace);
    expect('buffer' in decoded.source).toBe(false);
    const source = decoded.source as GroupProcessAddressSpace;
    source.writeBytes(P - 2, new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(memory.buffer, 9 * P - 2, 2)).toEqual(new Uint8Array([1, 2]));
    expect(new Uint8Array(memory.buffer, 10 * P, 2)).toEqual(new Uint8Array([3, 4]));
    expect(Object.isFrozen(decoded.descriptor)).toBe(true);
    expect(Object.isFrozen((decoded.descriptor as GroupReplicaMemoryDescriptor).receipt)).toBe(true);
  });
  it('keeps image identities distinct while intentional shared pages alias', () => {
    const { value, owner } = fixture();
    const peer = { ...value, receipt: { ...value.receipt, pid: 11, tid: 11, serial: value.receipt.serial + 1n }, root: 2 * P, replica: 5 * P, scratch: 5 * P + G.MEMORY_GROUP_REPLICA_BYTES };
    const first = decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: value }, owner).source as GroupProcessAddressSpace;
    const second = decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: peer }, { ...owner, receipt: peer.receipt, root: peer.root, replica: peer.replica, scratch: peer.scratch }).source as GroupProcessAddressSpace;
    expect(first.identity).not.toBe(second.identity);
    first.writeBytes(32, new Uint8Array([42])); expect(second.readBytes(32, 1)[0]).toBe(42);
    first.writeBytes(P, new Uint8Array([15])); expect(second.readBytes(P, 1)[0]).toBe(0);
  });
  it.each(['group', 'pid', 'tid', 'serial', 'generation'] as const)('refuses a mismatched %s without truncating high bits', field => {
    const { value, owner } = fixture();
    const changed = { ...value.receipt };
    if (field === 'serial' || field === 'generation') changed[field] += 1n << 32n;
    else changed[field] += 1;
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { ...value, receipt: changed } }, owner)).toThrow(MemoryGroupProtocolFault);
  });
  it('refuses a different backing, image root or replica scratch', () => {
    const { value, owner } = fixture(), other = fixture();
    expect(() => encodeProcessMemoryDescriptor(other.memory, value, owner)).toThrow(MemoryGroupProtocolFault);
    for (const invalid of [{ ...value, root: 2 * P }, { ...value, replica: 5 * P, scratch: 5 * P + G.MEMORY_GROUP_REPLICA_BYTES }, { ...value, memory: other.memory }]) {
      expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: invalid }, owner)).toThrow(MemoryGroupProtocolFault);
    }
    // There is one backing reference in the wire format. Its authenticated
    // sender selects it; no duplicate-wrapper identity check is required.
    const wire = structuredClone(encodeProcessMemoryDescriptor(owner.memory, value, owner));
    expect(decodeProcessMemoryDescriptor(wire, owner).source).toBeInstanceOf(GroupProcessAddressSpace);
  });
  it('requires an admitted expectation and keeps memory-model tags separate', () => {
    const { value, owner } = fixture();
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: value })).toThrow(MemoryGroupProtocolFault);
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { kind: 'linear' } }, owner)).toThrow(MemoryGroupProtocolFault);
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { ...value, kind: 'kandelo.memory-group.v1' } }, owner)).toThrow(MemoryGroupProtocolFault);
  });
  it('rejects fabricated Memory, getters and extra transport fields without invoking them', () => {
    const { value, owner } = fixture(); let reads = 0;
    expect(() => decodeProcessMemoryDescriptor({ memory: { buffer: new SharedArrayBuffer(P) }, descriptor: { kind: 'linear' } })).toThrow(MemoryGroupProtocolFault);
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { ...value, get root() { reads++; return P; } } }, owner)).toThrow(MemoryGroupProtocolFault);
    expect(reads).toBe(0);
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { ...value, ignored: true } }, owner)).toThrow(MemoryGroupProtocolFault);
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { ...value, receipt: { ...value.receipt, generation: Number(value.receipt.generation) } } }, owner)).toThrow(MemoryGroupProtocolFault);
  });
  it('refuses corrupted limits and overlapping controls before changing storage', () => {
    const { value, owner, words } = fixture(), before = words.slice();
    for (const patch of [{ maximumVirtualPages: 9 }, { scratchBytes: 2 * P }, { root: -1 }, { scratch: P }]) {
      expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: { ...value, ...patch } }, { ...owner, ...patch })).toThrow(MemoryGroupProtocolFault);
    }
    expect(words).toEqual(before);
    words[P / 4 + 2] = 2 * P;
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: value }, owner)).toThrow(MemoryGroupProtocolFault);
  });
  it('revokes existing scalar/byte access when its exact image owner retires', () => {
    const { value, owner, retire } = fixture();
    const source = decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: value }, owner).source as GroupProcessAddressSpace;
    retire();
    expect(() => source.readBytes(0, 1)).toThrow(ProcessAddressFault);
    expect(() => decodeProcessMemoryDescriptor({ memory: owner.memory, descriptor: value }, owner)).toThrow(ProcessAddressFault);
    source.detachHostAccess();
  });
});
