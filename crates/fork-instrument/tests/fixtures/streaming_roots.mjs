import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createRootJournal from './root_record_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const provider = load('./provider.wasm');
const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
const wide = process.argv.includes('wide');
const GLOBALS = 3;
const ELEMENTS = 6;
const DATA = 7;
let instances = 0;
const journal = createRootJournal(wide, () => ({
  h: { alias: 4294967297.25, mutable: new WebAssembly.Global({ value: 'i64', mutable: true }, 0n) },
  env: {
    __channel_base: new WebAssembly.Global({ value: 'i32', mutable: true }, instances++ === 0 ? 777 : 999),
    __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global({ value: 'i64', mutable: false }, 0n),
  },
}));
const { records, pending } = journal;
const store = createGcStore(provider, transit, wide, { bind: journal.bind });
const parent = store.instantiate();
parent.instance.exports.wpk_fork_module_bootstrap();
const token = Object.freeze({ owner: 'parent' });
parent.instance.exports.make(token);
assert.equal(parent.instance.exports.verify(), 1);
assert.equal(parent.instance.exports.verify_exception(), 1);
parent.instance.exports.save_roots(7);
assert.equal(pending.size, 0);
parent.assertReleased();
const globalRecords = [...records.values()].filter(record => record.kind === GLOBALS);
assert(globalRecords.length > 10);
assert(!globalRecords.some(record => record.owner === 4 || record.owner === 5),
  'child channel binding and immutable local are not captured roots');
for (const record of globalRecords) {
  const view = new DataView(record.bytes.buffer);
  assert.equal(view.getUint16(2, true), 0);
  assert.equal(view.getUint32(4, true), 0);
}
const rootRecipes = globalRecords.filter(record => [6, 7, 8, 9].includes(record.bytes[0]))
  .map(record => new DataView(record.bytes.buffer).getUint32(8, true));
assert(rootRecipes.every(id => id > 0), 'all fixture reference roots are non-null');
const anyRoots = globalRecords.filter(record => record.bytes[0] === 9)
  .map(record => new DataView(record.bytes.buffer).getUint32(8, true));
assert.equal(anyRoots[0], anyRoots[1], 'typed and abstract global aliases share one recipe');
const parentObject = transit.get(anyRoots[0] + 1);
const dataRecord = [...records.values()].find(record => record.kind === DATA);
assert(dataRecord);
assert.deepEqual([...dataRecord.bytes.slice(8)], [3, 0, 0, 128, 17]);

for (let index = 0; index < transit.length; index++) transit.set(index, null);
const child = store.instantiate();
assert.throws(() => child.instance.exports.finish_roots(7), WebAssembly.RuntimeError);
const childToken = Object.freeze({ owner: 'child' });
for (const id of store.brokerValues.keys()) {
  child.instance.exports.__wpk_fork_ref_gc_publish_externref(id, childToken);
}
for (const id of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_allocate(id);
for (const [id, recipe] of store.recipes) {
  if (recipe.kind !== 0) child.instance.exports.__wpk_fork_ref_gc_fill(id);
}
assert.notEqual(transit.get(anyRoots[0] + 1), parentObject, 'child roots use freshly allocated GC identities');
child.instance.exports.restore_roots(7);
assert.equal(child.instance.exports.verify(), 1);
assert.equal(child.instance.exports.verify_exception(), 1);
assert.equal(child.instance.exports.external(), childToken);
assert.equal(child.instance.exports.channel(), 999, 'channel binding belongs to the fresh child');
assert.equal(child.instance.exports.starts.value, 1, 'restore cannot run start again');
child.instance.exports.finish_roots(7);
assert.throws(() => child.instance.exports.probe_dropped_data(), WebAssembly.RuntimeError);
assert.throws(() => child.instance.exports.probe_dropped_elements(), WebAssembly.RuntimeError);
child.instance.exports.probe_untouched_data();
assert.equal(new Uint8Array(child.memory.buffer)[96], 68);
child.instance.exports.wpk_fork_module_bootstrap();
assert.equal(child.instance.exports.starts.value, 1);
child.assertReleased();
