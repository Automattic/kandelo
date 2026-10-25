import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createRootJournal from './root_record_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const provider = load('./provider.wasm');
const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
const wide = process.argv.includes('wide');
const journal = createRootJournal(wide);
const store = createGcStore(provider, transit, wide, {
  bind: journal.bind,
  memory() {
    return new WebAssembly.Memory({ initial: wide ? 2n : 2, maximum: wide ? 2n : 2,
      address: wide ? 'i64' : 'i32', shared: true });
  },
});
const parent = store.instantiate();
parent.instance.exports.wpk_fork_module_bootstrap();
parent.instance.exports.make();
assert.equal(parent.instance.exports.verify(), 1);
parent.instance.exports.save_roots(7);
assert.equal(journal.records.size, 4);
parent.assertReleased();
for (let index = 0; index < transit.length; index++) transit.set(index, null);
const child = store.instantiate();
for (const id of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_allocate(id);
for (const id of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_fill(id);
child.instance.exports.restore_roots(7);
assert.equal(child.instance.exports.verify(), 1);
child.instance.exports.finish_roots(7);
assert.throws(() => child.instance.exports.probe_dropped(), WebAssembly.RuntimeError);
child.assertReleased();
