import { ProgramGroup, PAGE, READ } from './runtime.mjs';
const assert = {
  equal(a, b, message = 'equality') { if (!Object.is(a,b)) throw Error(`${message}: ${a} != ${b}`); },
  deepEqual(a, b, message = 'bytes') { if (JSON.stringify([...a]) !== JSON.stringify([...b])) throw Error(message); },
  throws(fn, Type) {
    try { fn(); } catch (error) { if (error instanceof Type) return; throw error; }
    throw Error('expected operation to trap');
  },
};
export function runCanary(module) {
const group = new ProgramGroup(), a = group.create(module);
assert.equal(a.exports.initial_data(), 40);
assert.equal(a.exports.stack(7), 64 * 7 + 63 * 64 / 2);
assert.equal(a.exports.size(), 2);
assert.equal(a.exports.grow(2), 2);
assert.equal(a.exports.size(), 4);
assert.equal(a.exports.load32(2 * PAGE), 0);
assert.equal(a.exports.grow(0xffffffff) >>> 0, 0xffffffff);
a.exports.store32(PAGE - 2, 0xaabbccdd);
assert.equal(a.exports.load32(PAGE - 2) >>> 0, 0xaabbccdd);
const scatter = group.alloc(1);
group.map(a, PAGE, scatter);
a.exports.store32(PAGE - 2, 0x12345678);
assert.equal(a.exports.load32(PAGE - 2) >>> 0, 0x12345678);
assert.deepEqual([...group.read(a, PAGE - 2, 4)], [0x78,0x56,0x34,0x12]);
const before = group.read(a, PAGE - 2, 2);
group.map(a, PAGE, scatter, { rights: READ });
assert.throws(() => a.exports.store32(PAGE - 2, 0xffffffff), WebAssembly.RuntimeError);
assert.deepEqual(group.read(a, PAGE - 2, 2), before);
group.map(a, PAGE, scatter);
a.exports.fill(PAGE - 8, 0x5a, 16);
assert.deepEqual([...group.read(a, PAGE - 8, 16)], Array(16).fill(0x5a));
a.exports.copy(2 * PAGE, PAGE - 8, 16);
assert.deepEqual([...group.read(a, 2 * PAGE, 16)], Array(16).fill(0x5a));
const shared = group.alloc(1);
group.map(a, 3 * PAGE, shared, { shared: true });
a.exports.store32(3 * PAGE, 41);
a.exports.mutate_data(101);
const b = group.create(module, a);
assert.equal(b.exports.initial_data(), 138, 'fork initialization overwrote copied private data');
b.exports.mutate_data(200);
assert.equal(a.exports.initial_data(), 138);
assert.equal(b.exports.initial_data(), 237);
assert.equal(b.exports.atomic_add(3 * PAGE, 1), 41);
assert.equal(a.exports.load32(3 * PAGE), 42);
assert.throws(() => b.exports.__vm_initialize(1), WebAssembly.RuntimeError);
const result = { passed: true, checks: ['compiled C initialization and shadow stack', 'virtual memory size/growth', 'split/scattered scalar access and denied-store atomicity', 'bulk scatter', 'private clone and shared atomic backing'], phpFpm: false, realForkContinuation: false };
return result;
}
