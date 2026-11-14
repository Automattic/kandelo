import { Group, PAGE, LIMIT, READ, WRITE } from './runtime.mjs';
import { oracle } from './oracle.mjs';

function assert(ok, text) { if (!ok) throw Error(text); }
function equal(a, b, text) { assert(a === b, `${text}: ${a} != ${b}`); }
function trap(f, text) {
  let error;
  try { f(); } catch (e) { error = e; }
  assert(error instanceof WebAssembly.RuntimeError, `${text}: expected Wasm trap`);
}

export async function checks(modules, remote, mutation = '') {
  const passed = [], group = new Group(modules), parent = group.context();
  const p = group.alloc(2), shared = group.alloc(2);
  group.map(parent, PAGE, p, 2);
  group.map(parent, 8 * PAGE, p); // Private alias must remain an alias after fork.
  group.map(parent, 16 * PAGE, shared, 2, 3, true);
  group.map(parent, 24 * PAGE, shared, 2, 3, true);
  equal(parent.inline.memory, group.memory, 'same actual memory import');
  parent.inline.store(PAGE, PAGE + 16);
  parent.inline.store(PAGE + 16, 41);
  parent.inline.store(16 * PAGE, 100);
  const child = group.fork(parent, mutation);
  const pointer = child.inline.load(PAGE);
  equal(pointer, PAGE + 16, 'stored virtual pointer and integer bits survive clone');
  child.inline.store(pointer, 42);
  equal(child.inline.load(8 * PAGE + 16), 42, 'private alias preserved in child');
  equal(parent.inline.load(pointer), 41, 'parent private bytes independent');
  const grandchild = group.fork(child);
  grandchild.inline.store(pointer, 43);
  equal(child.inline.load(pointer), 42, 'nested clone private bytes independent');
  passed.push('private graph, unchanged pointer bits, private aliases, nested page clone');
  child.inline.store(24 * PAGE, 101);
  equal(parent.inline.load(16 * PAGE), 101, 'shared writes visible without syscall');
  parent.inline.store(16 * PAGE + 4, 16 * PAGE);
  equal(child.inline.load(child.inline.load(24 * PAGE + 4)), 101, 'pointer graph in shared backing');
  group.map(child, 32 * PAGE, shared, 1, 3, true);
  child.inline.store(32 * PAGE + 8, 102);
  equal(parent.inline.load(24 * PAGE + 8), 102, 'different VA shared alias');
  passed.push('shared graph, immediate peer visibility, different-address aliases');

  // Adjacent virtual pages deliberately have nonadjacent physical backing.
  const scatter1 = group.alloc(), gap = group.alloc(), scatter2 = group.alloc();
  group.map(parent, 40 * PAGE, scatter1);
  group.map(parent, 41 * PAGE, scatter2);
  const split = 41 * PAGE - 2;
  for (const mode of ['inline', 'helper']) {
    parent[mode].store(split, 0x12345678);
    equal(parent[mode].load(split), 0x12345678, `${mode} split scalar`);
    equal(new DataView(group.memory.buffer).getUint16(scatter1 + PAGE - 2, true), 0x5678, 'first physical half');
    equal(new DataView(group.memory.buffer).getUint16(scatter2, true), 0x1234, 'second physical half');
    group.map(parent, 41 * PAGE, scatter2, 1, READ);
    trap(() => parent[mode].store(split, 0x33445566), 'split store permission');
    equal(parent[mode].load(split), 0x12345678, 'failed split store has no partial effect');
    group.map(parent, 41 * PAGE, scatter2);
    trap(() => parent[mode].store(LIMIT - 1, 1), 'out of virtual bounds');
    trap(() => parent[mode].load(-1), 'wrapped virtual address');
    trap(() => parent[mode].load(63 * PAGE), 'unmapped address');
    group.map(parent, 41 * PAGE, scatter2, 1, WRITE);
    trap(() => parent[mode].load(41 * PAGE), 'write-only mapping');
    group.map(parent, 41 * PAGE, scatter2);
    trap(() => parent[mode].add(40 * PAGE + 1, 1), 'misaligned atomic');
    equal(parent[mode].cas(40 * PAGE, 77), 0, 'successful compare exchange returns old value');
    equal(parent[mode].cas(40 * PAGE, 99), 77, 'failed compare exchange returns old value');
    equal(parent[mode].load(40 * PAGE), 77, 'failed compare exchange does not write');
    parent[mode].store(40 * PAGE, 0);
  }
  equal(new Uint8Array(group.memory.buffer, gap, PAGE).some(x => x), false, 'physical gap untouched');
  passed.push('split-page scalars, bounds, permissions, atomic alignment and CAS');

  const source = group.bytes(parent, PAGE, 256);
  for (const mode of ['inline', 'helper']) {
    for (let i = 0; i < source.length; i++) source[i] = i;
    parent[mode].copy(40 * PAGE + PAGE - 128, PAGE, 256);
    for (let i = 0; i < 256; i++) {
      const where = i < 128 ? scatter1 + PAGE - 128 + i : scatter2 + i - 128;
      equal(new Uint8Array(group.memory.buffer)[where], i, 'scattered bulk copy');
    }
    const before = source.slice();
    parent[mode].copy(PAGE + 7, PAGE, 100);
    assert(source.subarray(7, 107).every((x, i) => x === before[i]), 'overlapping memmove');
    parent[mode].store(16 * PAGE, 0x12345678);
    parent[mode].copy(PAGE, 24 * PAGE, 4);
    equal(parent[mode].load(PAGE), 0x12345678, 'shared to private bulk');
    parent[mode].store(PAGE, 0x456789);
    parent[mode].copy(16 * PAGE, PAGE, 4);
    equal(child.inline.load(24 * PAGE), 0x456789, 'private to shared bulk');
    const snapshot = group.bytes(parent, PAGE, 32).slice();
    trap(() => parent[mode].copy(PAGE, 63 * PAGE, 32), 'unmapped bulk source');
    assert(group.bytes(parent, PAGE, 32).every((x, i) => x === snapshot[i]), 'failed bulk unchanged');
    parent[mode].copy(LIMIT, LIMIT, 0);
  }
  parent.table[40] = 0;
  trap(() => parent.inline.load(40 * PAGE), 'quiescent unmap');
  const replacement = group.alloc();
  group.map(parent, 40 * PAGE, replacement);
  equal(parent.inline.load(40 * PAGE), 0, 'remap uses current page entry');
  passed.push('bulk copies, overlap, scatter, permissions, zero-length and quiescent remap');

  // These really execute in separate Workers, using the same backing object.
  parent.inline.store(16 * PAGE, 0);
  const peers = await Promise.all([remote(), remote()]);
  try {
    await Promise.all(peers.map((peer, i) => peer.call('init', {
      modules, memory: group.memory, root: [parent, child][i].root, scratch: [parent, child][i].scratch,
    })));
    await Promise.all(peers.map((peer, i) => peer.call('call', { name: 'atomic', args: [200000, [16, 24][i] * PAGE, 0] })));
    equal(parent.inline.load(16 * PAGE), 400000, 'concurrent shared atomic total');
    await peers[0].call('call', { name: 'store', args: [PAGE + 16, 199] });
    equal(await peers[1].call('call', { name: 'load', args: [PAGE + 16] }), 42, 'remote private child independent');
    await peers[0].call('call', { name: 'store', args: [16 * PAGE, 0] });
    const waiting = peers[0].call('call', { name: 'wait', args: [16 * PAGE] });
    let notified = 0;
    const deadline = performance.now() + 4500;
    // Observe notify's actual waiter count, not an assumed scheduling delay.
    while (!notified && performance.now() < deadline) {
      notified = await peers[1].call('call', { name: 'notify', args: [24 * PAGE] });
    }
    equal(notified, 1, 'alias notify finds the parked peer');
    equal(await waiting, 0, 'Wasm wait wakes through different-address alias');
  } finally { await Promise.all(peers.map(x => x.close())); }
  passed.push('two Workers: shared atomics, private independence, wait/notify through aliases');
  const randomized = oracle(group);
  passed.push('6000 scalar operations against independent randomized byte/permission model');
  return { passed, randomized, memoryObjectsPerGroup: 1, privateCloneIsKandeloFork: false };
}
