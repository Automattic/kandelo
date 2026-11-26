import * as G from '../src/generated/program-extensions';
import { describe, expect, it, vi } from 'vitest';
import { GroupProcessAddressSpace, LinearProcessAddressSpace, ProcessAddressFault } from '../src/process-address-space';
import { publishMemoryGroupNotification } from '../src/memory-group-notification';
import { ProcessAtomicI32, ProcessAtomicU64 } from '../src/process-atomic-word';
const PAGE = 65536;
function fixture() {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32, shared: true });
  const root = PAGE, words = new Uint32Array(memory.buffer), pte = root / 4 + 16;
  words[root / 4] = 3;
  words[pte] = 4 * PAGE | 3;
  words[pte + 1] = 6 * PAGE | 3;
  words[pte + 2] = 4 * PAGE | 7;
  let live = true;
  const access = new GroupProcessAddressSpace({ memory, root, maximumPages: 32,
    assertLive: () => { if (!live) throw new ProcessAddressFault('retired'); } });
  return { memory, root, words, pte, access, retire: () => { live = false; } };
}
describe('explicit process address spaces', () => {
  it('revokes native adapters without letting an identity token retain storage', () => {
    const access = new LinearProcessAddressSpace(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }));
    const identity = access.identity;
    expect(identity).not.toBe(access); expect(Object.keys(identity)).toEqual([]);
    access.detachHostAccess();
    for (const operation of [() => access.byteLength, () => access.readBytes(0, 0),
      () => access.writeBytes(0, new Uint8Array()), () => access.fillBytes(0, 0, 0)]) {
      expect(operation).toThrow(ProcessAddressFault);
    }
  });
  it('uses canonical bytes in both native and scattered backends', () => {
    const group = fixture();
    const ordinary = new LinearProcessAddressSpace(new WebAssembly.Memory({ initial: 3, maximum: 4, shared: true }));
    for (const access of [ordinary, group.access]) {
      access.writeBytes(PAGE - 2, new Uint8Array([1, 2, 3, 4, 5]));
      expect([...access.readBytes(PAGE - 2, 5)]).toEqual([1, 2, 3, 4, 5]);
      access.fillBytes(PAGE - 1, 3, 0xab);
      expect([...access.readBytes(PAGE - 2, 5)]).toEqual([1, 0xab, 0xab, 0xab, 5]);
    }
  });
  it('owns copied reads and preserves direct shared aliases', () => {
    const { access } = fixture();
    access.writeBytes(20, new Uint8Array([1, 2]));
    const read = access.readBytes(20, 2); read[0] = 99;
    expect([...access.readBytes(2 * PAGE + 20, 2)]).toEqual([1, 2]);
    access.writeBytes(2 * PAGE + 20, new Uint8Array([8]));
    expect(access.readBytes(20, 1)[0]).toBe(8);
  });
  it('preflights every destination before modifying a partial range', () => {
    const { access, words, pte } = fixture();
    access.fillBytes(PAGE - 2, 4, 7); words[pte + 1] = 6 * PAGE | 1;
    expect(() => access.writeBytes(PAGE - 2, new Uint8Array(4))).toThrow(ProcessAddressFault);
    expect(() => access.fillBytes(PAGE - 2, 4, 0)).toThrow(ProcessAddressFault);
    expect([...access.readBytes(PAGE - 2, 4)]).toEqual([7, 7, 7, 7]);
  });
  it('stages physical aliases before scatter writes', () => {
    const { memory, access } = fixture();
    const physical = new Uint8Array(memory.buffer, 4 * PAGE, PAGE);
    physical.set([1, 2, 3, 4], PAGE - 4);
    access.writeBytes(PAGE - 2, physical.subarray(PAGE - 4));
    expect([...access.readBytes(PAGE - 2, 4)]).toEqual([1, 2, 3, 4]);
  });
  it('accepts empty end ranges and rejects invalid bounds or metadata', () => {
    const { access, words, pte } = fixture();
    expect(access.readBytes(3 * PAGE, 0).length).toBe(0);
    for (const [at, length] of [[-1, 1], [0, -1], [NaN, 0], [0.5, 1], [3 * PAGE, 1]]) {
      expect(() => access.readBytes(at, length)).toThrow(ProcessAddressFault);
    }
    words[pte] = 0; expect(() => access.readBytes(0, 1)).toThrow(ProcessAddressFault);
    words[pte] = 31 * PAGE | 3; expect(() => access.readBytes(0, 1)).toThrow(ProcessAddressFault);
  });
  it('refreshes physical views after C-style logical growth publication', () => {
    const { access, memory, words, root, pte } = fixture();
    memory.grow(1); const grown = new Uint8Array(memory.buffer); grown[16 * PAGE] = 42;
    words[pte + 3] = 16 * PAGE | 3; Atomics.store(words, root / 4, 4);
    expect(access.readBytes(3 * PAGE, 1)[0]).toBe(42);
  });
  it('keeps image identity distinct and revokes retained host access', () => {
    const a = fixture(), b = new GroupProcessAddressSpace({ memory: a.memory,
      root: a.root, maximumPages: 32, assertLive: () => {} });
    expect(a.access.identity).not.toBe(b.identity);
    expect(a.access.identity).not.toBe(a.access);
    expect(Object.keys(a.access.identity)).toEqual([]);
    a.retire(); expect(() => a.access.readBytes(0, 1)).toThrow(ProcessAddressFault);
    b.detachHostAccess(); expect(() => b.byteLength).toThrow(ProcessAddressFault);
  });
});

describe('explicit process atomic publication', () => {
  it('preserves unsigned 64-bit atomic values through mapped aliases and revokes handles', () => {
    const { access, words, pte } = fixture();
    const original = new ProcessAtomicU64(access, 24), alias = new ProcessAtomicU64(access, 2 * PAGE + 24);
    const value = 0xfedcba9876543210n;
    expect(original.store(value)).toBe(value); expect(alias.load()).toBe(value);
    words[pte] = 4 * PAGE | 1;
    expect(() => original.store(2n)).toThrow(ProcessAddressFault);
    expect(alias.load()).toBe(value);
    expect(() => access.atomicLoadU64(25)).toThrow(ProcessAddressFault);
    access.detachHostAccess();
    expect(() => alias.load()).toThrow(ProcessAddressFault);
  });
  it('retains ordinary unsigned atomic behavior on shared and unshared memories', () => {
    for (const shared of [true, false]) {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared });
      const word = new ProcessAtomicU64(memory, 8);
      word.store(-1n); expect(word.load()).toBe(0xffffffffffffffffn);
      expect(() => new ProcessAtomicU64(memory, 9).load()).toThrow(RangeError);
    }
  });
  it('requires a replica wait and checks source revocation before invoking it', () => {
    const { access } = fixture();
    expect(() => new ProcessAtomicI32(access, 20)).toThrow('replica-bound translated wait');
    let calls = 0;
    const word = new ProcessAtomicI32(access, 20, () => { calls++; return 1; });
    expect(word.wait(0)).toBe('not-equal');
    access.detachHostAccess();
    expect(() => word.wait(0)).toThrow(ProcessAddressFault);
    expect(calls).toBe(1);
  });
  it('uses virtual words for atomics on native and grouped adapters', () => {
    const native = new LinearProcessAddressSpace(new WebAssembly.Memory({ initial: 3, maximum: 4, shared: true }));
    for (const access of [native, fixture().access]) {
      expect(access.atomicStoreI32(20, 7)).toBe(7);
      expect(access.atomicCompareExchangeI32(20, 7, 9)).toBe(7);
      expect(access.atomicLoadI32(20)).toBe(9);
      expect(access.notifyI32(20, 1)).toBe(0);
      expect(() => access.atomicLoadI32(21)).toThrow(ProcessAddressFault);
      expect(() => access.notifyI32(20, -1)).toThrow(ProcessAddressFault);
      expect(() => access.notifyI32(20, NaN)).toThrow(ProcessAddressFault);
    }
  });
  it('preflights signal permission and alignment before writing payload', () => {
    const { access, words, pte } = fixture();
    access.fillBytes(30, 4, 0xa5); words[pte + 1] = 6 * PAGE | 1;
    expect(() => access.publishBytes(30, new Uint8Array(4), PAGE, 2, 1)).toThrow(ProcessAddressFault);
    expect(() => access.publishBytes(30, new Uint8Array(4), 1, 2, 1)).toThrow(ProcessAddressFault);
    expect([...access.readBytes(30, 4)]).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
  });
  it('wakes only the native kernel observer while guest Q is busy', async () => {
    const { access, words, memory, retire } = fixture(), q = G.MEMORY_GROUP_WAIT_HEADER / 4, node = G.MEMORY_GROUP_WAIT_NODES;
    words[q + 1] = node; words[q + 2] = node; words[q + 4] = 1;
    words[node / 4] = 1; words[node / 4 + 2] = 4 * PAGE + 20;
    const observer = Atomics.waitAsync(new Int32Array(memory.buffer, 4 * PAGE + 20, 1), 0, 0, 1000);
    expect(observer.async).toBe(true);
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw Error('IPC request must not take guest Q'); });
    Atomics.store(words, q, 1);
    try { expect(access.notifyKernelObserverI32(20, 1)).toBe(1); expect(wait).not.toHaveBeenCalled(); }
    finally { Atomics.store(words, q, 0); wait.mockRestore(); }
    expect(await observer.value).toBe('ok'); expect(words[node / 4]).toBe(1); expect(words[q + 1]).toBe(node);
    expect(() => access.notifyKernelObserverI32(20, -1)).toThrow(ProcessAddressFault);
    retire(); expect(() => access.notifyKernelObserverI32(20, 1)).toThrow(ProcessAddressFault);
  });
  it('publishes the return body before waking the exact ordered node, retaining waiter custody', async () => {
    const { memory, access, words } = fixture(), q = G.MEMORY_GROUP_WAIT_HEADER / 4, first = G.MEMORY_GROUP_WAIT_NODES;
    const stride = G.MEMORY_GROUP_WAIT_NODE_BYTES;
    const addresses = [4 * PAGE + 20, 6 * PAGE + 24, 4 * PAGE + 20];
    for (let i = 0; i < 3; i++) {
      const at = (first + i * stride) / 4;
      words[at] = 1; words[at + 1] = i === 2 ? 0 : first + (i + 1) * stride; words[at + 2] = addresses[i];
    }
    words[q + 1] = first; words[q + 2] = first + 2 * stride; words[q + 4] = 3;
    const firstState = new Int32Array(memory.buffer, first, 1), lastState = new Int32Array(memory.buffer, first + 2 * stride, 1);
    const pending = Atomics.waitAsync(firstState, 0, 1, 1000);
    const observer = Atomics.waitAsync(new Int32Array(memory.buffer, addresses[0], 1), 0, 0, 1000);
    expect(pending.async).toBe(true);
    expect(observer.async).toBe(true);
    expect(access.publishBytes(PAGE - 2, new Uint8Array([1, 2, 3, 4]), 20, 2, 1)).toBe(1);
    expect(await pending.value).toBe('ok');
    expect(await observer.value).toBe('ok');
    expect([...access.readBytes(PAGE - 2, 4)]).toEqual([1, 2, 3, 4]);
    expect(access.atomicLoadI32(20)).toBe(2);
    expect(words[q + 1]).toBe(first + stride); expect(words[q + 2]).toBe(first + 2 * stride);
    expect(Atomics.load(firstState, 0)).toBe(2); expect(Atomics.load(lastState, 0)).toBe(1);
    expect(access.notifyI32(2 * PAGE + 20, 1)).toBe(1);
    expect(Atomics.load(lastState, 0)).toBe(2);
    expect(words[q + 1]).toBe(first + stride); expect(words[q + 2]).toBe(first + stride);
    expect(words[q + 4]).toBe(3); // Only returning waiters can free their nodes.
    expect(access.notifyI32(PAGE + 24, 1)).toBe(1);
    expect(words[q + 1]).toBe(0); expect(words[q + 2]).toBe(0);
  });
  it('wakes native channel observers without reporting them as guest waiters', async () => {
    const { memory, access } = fixture();
    const observer = Atomics.waitAsync(new Int32Array(memory.buffer, 4 * PAGE + 20, 1), 0, 0, 1000);
    expect(observer.async).toBe(true);
    expect(access.publishBytes(30, new Uint8Array([9]), 20, 2, 1)).toBe(0);
    expect(await observer.value).toBe('ok');
    expect(access.atomicLoadI32(20)).toBe(2);
    expect([...access.readBytes(30, 1)]).toEqual([9]);
  });
  it('leaves fragmented payload and status untouched if allocating a source slice fails', () => {
    const { access, words } = fixture(), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    access.fillBytes(PAGE - 2, 4, 0xa5);
    const failure = new RangeError('source slice allocation refused');
    const original = Uint8Array.prototype.subarray;
    let slices = 0;
    const spy = vi.spyOn(Uint8Array.prototype, 'subarray').mockImplementation(function(this: Uint8Array, ...args) {
      if (++slices === 2) throw failure;
      return Reflect.apply(original, this, args);
    });
    try { expect(() => access.publishBytes(PAGE - 2, Uint8Array.of(1, 2, 3, 4), 20, 2, 1)).toThrow(failure); }
    finally { spy.mockRestore(); }
    expect(slices).toBe(2);
    expect([...access.readBytes(PAGE - 2, 4)]).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
    expect(access.atomicLoadI32(20)).toBe(0);
    expect(words[q]).toBe(0);
  });
  it('refuses a corrupt queue before writing data or status', () => {
    const { access, words } = fixture(), q = 4112 / 4, node = 8192;
    access.fillBytes(30, 4, 0xa5);
    words[q + 1] = node; words[q + 2] = node; words[q + 4] = 1;
    words[node / 4] = 1; words[node / 4 + 1] = node;
    expect(() => access.publishBytes(30, new Uint8Array(4), 20, 2, 1)).toThrow('Corrupt memory-group wait queue');
    expect([...access.readBytes(30, 4)]).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
    expect(access.atomicLoadI32(20)).toBe(0); expect(words[q]).toBe(0);
  });
});

it('keeps the unsigned four-GiB virtual end through the compiled SDK access ABI', () => {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32, shared: true }), root = PAGE;
  const words = new Uint32Array(memory.buffer), table = root / 4 + 16;
  words[root / 4] = 65536;
  words[table + 65535] = 12 * PAGE | 3;
  new Uint8Array(memory.buffer)[13 * PAGE - 1] = 0xab;
  const source = new GroupProcessAddressSpace({ memory, root, maximumPages: 65536, assertLive: () => {} });
  expect(source.byteLength).toBe(4294967296);
  expect(source.readBytes(4294967296, 0)).toEqual(new Uint8Array());
  expect(source.readBytes(4294967295, 1)).toEqual(Uint8Array.of(0xab));
  expect(() => source.readBytes(4294967296, 1)).toThrow(ProcessAddressFault);
});
it('releases its own queue on an abrupt bounded publication without waking an unwritten result', () => {
  const { memory, words } = fixture(), q = G.MEMORY_GROUP_WAIT_HEADER / 4, node = G.MEMORY_GROUP_WAIT_NODES;
  words[q + 1] = node; words[q + 2] = node; words[q + 4] = 1;
  words[node / 4] = G.MEMORY_GROUP_WAIT_WAITING; words[node / 4 + 2] = 4 * PAGE + 20;
  const failure = new Error('bounded publication refused');
  expect(() => publishMemoryGroupNotification(memory, 4 * PAGE + 20, 1, () => { throw failure; })).toThrow(failure);
  expect(words[q]).toBe(0);
  expect(words[node / 4]).toBe(G.MEMORY_GROUP_WAIT_WAITING);
  expect(words[q + 1]).toBe(node); expect(words[q + 4]).toBe(1);
});
it('validates a later corrupt waiter before publishing to an earlier matching waiter', () => {
  const { access, words } = fixture(), q = G.MEMORY_GROUP_WAIT_HEADER / 4, first = G.MEMORY_GROUP_WAIT_NODES;
  const last = first + G.MEMORY_GROUP_WAIT_NODE_BYTES;
  words[q + 1] = first; words[q + 2] = last; words[q + 4] = 2;
  words[first / 4] = G.MEMORY_GROUP_WAIT_WAITING; words[first / 4 + 1] = last; words[first / 4 + 2] = 4 * PAGE + 20;
  words[last / 4] = G.MEMORY_GROUP_WAIT_FREE;
  access.fillBytes(30, 4, 0xa5);
  expect(() => access.publishBytes(30, new Uint8Array(4), 20, 2, 1)).toThrow('Corrupt memory-group wait queue');
  expect(access.readBytes(30, 4)).toEqual(new Uint8Array(4).fill(0xa5));
  expect(access.atomicLoadI32(20)).toBe(0); expect(words[first / 4]).toBe(G.MEMORY_GROUP_WAIT_WAITING);
  expect(words[q]).toBe(0);
});
