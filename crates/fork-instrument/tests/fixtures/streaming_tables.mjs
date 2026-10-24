import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createTableJournal from './table_record_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const provider = load('./provider.wasm');
const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
const [wide, tableWide, shared] = process.argv.slice(2).map(value => value === '1');
const journal = createTableJournal(wide, tableWide);
const store = createGcStore(provider, transit, wide, {
  bind: journal.bind,
  memory: () => new WebAssembly.Memory({ address: wide ? 'i64' : 'i32',
    initial: wide ? 2n : 2, maximum: wide ? 2n : 2, shared }),
});
const parent = store.instantiate();
parent.instance.exports.wpk_fork_module_bootstrap();
const parentToken = Object.freeze({ owner: 'parent' });
parent.instance.exports.prepare(parentToken);
assert.equal(parent.instance.exports.verify(), 1);
assert.equal(parent.instance.exports.verify_exception(), 1);
const publication = journal.bindings[0];
const aborts = publication.aborts;
parent.instance.exports.empty_and_failed_grows();
assert.equal(publication.aborts, aborts + 3, 'empty ranges and failed grows end their writer transaction');
assert.equal(publication.depth, 0);
assert.equal(publication.begins, publication.commits + publication.aborts);
publication.advance();
let reconciles = publication.reconciles;
assert.equal(parent.instance.exports.read_only(), 42);
assert.equal(publication.reconciles, reconciles, 'a read-only table has no generation guard');
publication.race = true;
assert.equal(parent.instance.exports.verify(), 1);
assert.equal(publication.reconciles, reconciles + 2, 'cache the applied generation, not a newer publication');

parent.instance.exports.wpk_fork_module_state_save(7);
parent.assertReleased();
assert.equal(journal.pending.size, 0);
const descriptorOwners = [...journal.records.keys()].filter(key => key.startsWith('4:7:'))
  .map(key => Number(key.split(':')[2]));
assert.deepEqual(descriptorOwners, [1, 3, 4, 6, 7], 'one owner for each physical mutable table, no read-only snapshot');
for (const owner of descriptorOwners) {
  const descriptor = journal.records.get(journal.key(4, 7, owner))[0];
  const view = new DataView(descriptor.buffer);
  assert.equal(descriptor.length, 56);
  assert.equal(view.getUint8(0), tableWide ? 8 : 4);
  assert.equal(view.getUint8(1), 10);
  assert.equal(view.getUint16(2, true), 1);
  const pages = journal.records.get(journal.key(5, 7, owner));
  assert.equal(view.getUint32(4, true), pages.length);
  assert.equal(view.getBigUint64(8, true), owner === 1 ? 7n : owner <= 4 ? 2052n : 1n);
  for (const bytes of pages) {
    const page = new DataView(bytes.buffer);
    assert.equal(page.getUint32(8, true), 1);
    assert.equal(page.getUint32(16, true), 0);
    assert.equal(page.getUint32(12, true), page.getUint32(20, true));
    assert.equal(bytes.length, 24 + page.getUint32(12, true) * 4);
  }
}
for (let index = 0; index < transit.length; index++) transit.set(index, null);
const child = store.instantiate();
assert.throws(() => child.instance.exports.wpk_fork_module_state_finish_restore(7), WebAssembly.RuntimeError);
assert.equal(Number(child.instance.exports.__wpk_fork_table_1.length), 2, 'finish rejects before mutating an uninitialized baseline');
const childToken = Object.freeze({ owner: 'child' });
for (const id of store.brokerValues.keys()) child.instance.exports.__wpk_fork_ref_gc_publish_externref(id, childToken);
for (const id of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_allocate(id);
for (const [id, recipe] of store.recipes) if (recipe.kind !== 0) child.instance.exports.__wpk_fork_ref_gc_fill(id);
child.instance.exports.wpk_fork_module_state_restore(7);
child.instance.exports.wpk_fork_module_state_finish_restore(7);
assert.equal(child.instance.exports.verify(), 1);
assert.equal(child.instance.exports.verify_exception(), 1);
assert.equal(child.instance.exports.external(), childToken);
assert.throws(() => journal.bindings[1].invoke(() => child.instance.exports.probe_dropped()), WebAssembly.RuntimeError);
child.assertReleased();

// Durable metadata is validated by the owner; the guest also checks its own
// baseline binding and each single-run page before narrowing or writing.
const baseline = journal.records.get(journal.key(4, 7, 3))[0];
baseline[24] ^= 1;
assert.throws(() => child.instance.exports.restore_tables(7), WebAssembly.RuntimeError);
baseline[24] ^= 1;
const firstPage = journal.records.get(journal.key(5, 7, 3))[0];
firstPage[8] = 2;
assert.throws(() => child.instance.exports.restore_tables(7), WebAssembly.RuntimeError);
firstPage[8] = 1;
child.instance.exports.restore_tables(7);
assert.equal(child.instance.exports.verify(), 1);
assert.equal(journal.bindings[1].depth, 0);
