import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createTableJournal from './table_record_host.cjs';
import createFrameJournal from './activation_frame_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const provider = load('./provider.wasm');
const imported = load('./imported.wasm');
const wide = process.argv[2] === '1';
const index = value => wide ? BigInt(value) : value;
const originalCount = Number(process.argv[3]);
const exports = readFileSync(new URL('./exports.tsv', import.meta.url), 'utf8').trim().split('\n')
  .map(line => line.split('\t'));
const directories = new WeakMap();
const unwindTags = new WeakMap();
const tables = createTableJournal(wide, wide);
const frames = createFrameJournal(wide, provider, { requireIndirectGuard: false });
const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
let mode = 'normal';
const store = createGcStore(provider, transit, wide, {
  memory: () => new WebAssembly.Memory({ initial: index(4), address: wide ? 'i64' : 'i32' }),
  lookupStatic(value, instance) { return directories.get(instance)?.ordinals.get(value); },
  bind(getInstance, memory) {
    const imports = tables.bind(getInstance, memory);
    const activation = frames.bind(getInstance, memory, tables.bindings.at(-1), mode);
    Object.assign(imports.env, activation.env);
    Object.assign(imports.h, activation.h, {
      callback: value => value + 10,
      root: new WebAssembly.Instance(imported).exports.root,
    });
    imports.env.__wpk_fork_unwind = new WebAssembly.Tag({ parameters: [] });
    unwindTags.set(memory, imports.env.__wpk_fork_unwind);
    return imports;
  },
});
function instantiate() {
  const run = store.instantiate();
  frames.bindings.at(-1).link(run.instance);
  const entries = run.instance.exports;
  assert.equal(entries.starts.value, 0, 'native start is deferred');
  const functions = entries.__wpk_fork_function_catalog;
  assert.equal(functions.length, originalCount + 1, 'private helpers have no source function ordinal');
  for (const [ordinal, name] of exports) assert.equal(functions.get(Number(ordinal)), entries[name], name);
  assert.equal(functions.get(originalCount), entries.wpk_fork_module_bootstrap);
  assert.throws(() => functions.grow(1), RangeError);
  const table = entries.__wpk_fork_static_root_catalog;
  assert.equal(table.length, 7);
  for (let ordinal = 0; ordinal < table.length; ordinal++) assert.equal(table.get(ordinal), null);
  entries.__wpk_fork_static_root_harvest();
  const first = Array.from({ length: table.length }, (_, ordinal) => table.get(ordinal));
  entries.__wpk_fork_static_root_harvest();
  for (let ordinal = 0; ordinal < table.length; ordinal++) assert.equal(table.get(ordinal), first[ordinal]);
  assert.equal(first[1], entries.root.value);
  assert.equal(first[2], 7);
  assert.equal(first[3], entries.array.value);
  assert.equal(first[4], entries.default.get(index(0)));
  assert.equal(first[4], entries.default.get(index(1)), 'table initializer evaluates once');
  const ordinals = new WeakMap();
  const weak = first.map((value, ordinal) => {
    if (typeof value !== 'object' || value === null) return { deref: () => value };
    ordinals.set(value, ordinal);
    return new WeakRef(value);
  });
  for (let ordinal = 0; ordinal < table.length; ordinal++) table.set(ordinal, null);
  directories.set(run.instance, { ordinals, weak });
  return run;
}
const parent = instantiate();
const functionCatalog = parent.instance.exports.__wpk_fork_function_catalog;
functionCatalog.get(originalCount)();
parent.instance.exports.wpk_fork_module_bootstrap();
assert.equal(parent.instance.exports.starts.value, 1);
parent.instance.exports.initialize_values();
assert.equal(parent.instance.exports.values.get(index(2)), directories.get(parent.instance).weak[5].deref());
assert.equal(parent.instance.exports.active.get(index(0)), directories.get(parent.instance).weak[6].deref());
assert.equal(parent.instance.exports.checkpoint(), 1);
mode = 'capture';
frames.bindings[0].mode = mode;
assert.throws(() => parent.instance.exports.checkpoint(), error => error instanceof WebAssembly.Exception && error.is(unwindTags.get(parent.memory)));
parent.instance.exports.drop_roots();
assert.equal(frames.committed.length, 1);
parent.instance.exports.wpk_fork_module_state_save(7);
assert.equal(store.staticRecipes.size, 6);
assert.equal(store.recipes.size, 1, 'only i31 needs a value recipe; static aggregates are not cloned');
assert([...store.recipes.values()].every(recipe => recipe.kind === 0));
parent.instance.exports.wpk_fork_unwind_end();
parent.assertReleased();
for (let slot = 0; slot < transit.length; slot++) transit.set(slot, null);
mode = 'rewind';
const child = instantiate();
new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
for (const [recipe, ordinal] of store.staticRecipes) {
  const value = directories.get(child.instance).weak[ordinal].deref();
  assert.notEqual(value, undefined);
  assert.notEqual(value, directories.get(parent.instance).weak[ordinal].deref());
  transit.set(recipe + 1, value);
}
for (const recipe of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_allocate(recipe);
child.instance.exports.wpk_fork_module_state_restore(7);
child.instance.exports.wpk_fork_module_state_finish_restore(7);
child.instance.exports.wpk_fork_rewind_begin(index(512));
assert.equal(child.instance.exports.__wpk_fork_resume_catalog.get(0)(), 1);
assert.equal(child.instance.exports.starts.value, 1);
assert.equal(child.instance.exports.wpk_fork_state(), 0);
assert.equal(frames.bindings[1].consumed, 1);
assert.throws(() => child.instance.exports.initialize_values(), WebAssembly.RuntimeError);
assert.equal(child.instance.exports.__wpk_fork_static_root_catalog.get(0), null);
child.assertReleased();
