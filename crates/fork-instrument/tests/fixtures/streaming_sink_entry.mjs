import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const module = load('./provider.wasm');
const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
const thunks = new WebAssembly.Instance(load('./thunks.wasm')).exports;
const resume = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
let peeks = 0;
const store = createGcStore(module, transit, false, {
  bind() { return { env: {
    __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global({ value: 'i64' }, 1024n),
    __wpk_fork_resume_table: resume,
    __wpk_fork_resume_peek() { peeks++; return 1; },
  } }; },
});
const run = store.instantiate();
const descriptor = new DataView(WebAssembly.Module.customSections(module, 'kandelo.wpk_fork.boundaries')[0]);
assert.equal(descriptor.getUint32(8, true), 4);
const groups = [];
for (let entry = 0; entry < 4; entry++) {
  assert.equal(descriptor.getUint32(12 + entry * 8, true), entry);
  groups.push(descriptor.getUint32(16 + entry * 8, true));
}
assert.deepEqual(groups, [0, 1, 2, 0], 'equal result shapes share their selector');
for (const [selector, thunk] of [[0, thunks.scalar], [1, thunks.tuple], [2, thunks.reference], [99, thunks.reference]]) {
  resume.set(1, thunk);
  assert.equal(run.instance.exports.wpk_fork_resume_sink(selector), undefined,
    'unexpected sink return reaches the host invariant check without a fabricated trap');
}
assert.equal(peeks, 4);
resume.set(1, thunks.trap);
assert.throws(() => run.instance.exports.wpk_fork_resume_sink(0), WebAssembly.RuntimeError,
  'a genuine guest trap still escapes unchanged');
resume.set(1, thunks.scalar);
assert.throws(() => run.instance.exports.wpk_fork_resume_sink(1), WebAssembly.RuntimeError,
  'the engine enforces the selected thunk signature');
run.assertReleased();
