const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const load = name => new WebAssembly.Module(fs.readFileSync(path.join(__dirname, name)));
const moduleUnderTest = load('provider.wasm');
const transit = new WebAssembly.Instance(load('transit.wasm')).exports.transit;
const descriptor = new DataView(WebAssembly.Module.customSections(moduleUnderTest, 'kandelo.wpk_fork.gc_codec')[0]);
const layouts = new Map();
for (let i = 0; i < descriptor.getUint32(8, true); i++) {
  const start = 16 + i * 44;
  layouts.set(descriptor.getUint32(start, true), {
    base: descriptor.getUint32(start + 28, true),
    scalarLength: descriptor.getUint32(start + 36, true),
    referenceCount: descriptor.getUint32(start + 40, true),
  });
}
const records = new WeakMap();
let pending;
let nextToken = 1;
let published = 0;
let instance;
const imports = {
  env: {
    __wpk_fork_module_activation: new WebAssembly.Global({ value: 'i32', mutable: false }, 7),
    __wpk_fork_ref_gc_transit: transit,
    __wpk_fork_ref_gc_provenance_begin(slot, activation, base, layoutId, low, high, referenceCount) {
      assert.equal(pending, undefined);
      assert.equal(activation, 7);
      const layout = layouts.get(layoutId);
      assert(layout);
      assert.equal(base, layout.base);
      assert.equal(referenceCount, layout.referenceCount);
      const bytes = new Uint8Array(16);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, BigInt.asUintN(64, low), true);
      view.setBigUint64(8, BigInt.asUintN(64, high), true);
      const token = nextToken++;
      pending = { token, object: transit.get(slot), referenceCount,
        scalars: bytes.slice(0, layout.scalarLength), references: [], effects: instance.exports.effects.value };
      assert.notEqual(pending.object, null);
      return token;
    },
    __wpk_fork_ref_gc_provenance_ref(token, ordinal, slot) {
      assert.equal(pending.token, token);
      assert.equal(ordinal, pending.references.length);
      pending.references.push(transit.get(slot));
    },
    __wpk_fork_ref_gc_provenance_end(token) {
      assert.equal(pending.token, token);
      assert.equal(pending.references.length, pending.referenceCount);
      records.set(pending.object, pending);
      published++;
      pending = undefined;
    },
  },
};
for (const entry of WebAssembly.Module.imports(moduleUnderTest)) {
  const namespace = imports[entry.module] ??= {};
  if (entry.name in namespace) continue;
  if (entry.kind === 'function') namespace[entry.name] = () => { throw new Error(`Unexpected import call ${entry.name}`); };
  else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
  else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
  else throw new Error(`Unexpected import ${entry.name}`);
}
instance = new WebAssembly.Instance(moduleUnderTest, imports);
assert.equal(instance.exports.construct(), 1);
const objects = instance.exports.objects;
const record = index => { const value = records.get(objects.get(index)); assert(value); return value; };
assert.deepEqual(record(2).references, [objects.get(0), objects.get(0)],
  'holder retains both seeds around the packed and vector operands');
assert.deepEqual(record(3).references, [objects.get(0)], 'array.new keeps its initializer');
assert.deepEqual(record(4).references, [objects.get(0), objects.get(1)]);
assert.deepEqual([...record(5).scalars], [0x34]);
assert.equal(record(5).effects, 12, 'operand effects occur once and in source order');
assert.equal(record(6).scalars.length, 0);
assert.equal(record(7).references.length, 0);
assert.deepEqual([...record(8).scalars], [2, 0, 0, 0, 2, 0, 0, 0]);
assert.deepEqual([...record(9).scalars], [1, 0, 0, 0, 2, 0, 0, 0]);
assert.equal(new DataView(record(10).scalars.buffer).getUint32(0, true), 0x7fc12345);
assert.equal(new DataView(record(11).scalars.buffer).getBigUint64(0, true), 0x7ff8123456789abcn);
const vector = new DataView(record(12).scalars.buffer);
assert.equal(vector.getBigUint64(0, true), 0x102030405060708n);
assert.equal(vector.getBigUint64(8, true), 0x8899aabbccddeeffn);
assert.equal(record(13).referenceCount, 0, 'empty non-null arrays need no seed');
assert.equal(transit.get(0), null);
const count = published;
assert.throws(() => instance.exports.bad_data(), WebAssembly.RuntimeError);
assert.equal(published, count, 'a trapping constructor publishes nothing');
assert.throws(() => instance.exports.bad_elem(), WebAssembly.RuntimeError);
assert.equal(published, count);
instance.exports.drop_segments();
assert.throws(() => instance.exports.dropped_data(), WebAssembly.RuntimeError);
assert.throws(() => instance.exports.dropped_elem(), WebAssembly.RuntimeError);
assert.equal(published, count, 'dropped-segment constructors publish nothing');
assert.equal(instance.exports.effects.value, 123456);
assert.equal(pending, undefined);
assert.equal(transit.get(0), null);
