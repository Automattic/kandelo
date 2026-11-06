import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createTableJournal from './table_record_host.cjs';
import createFrameJournal from './activation_frame_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const module = load('./provider.wasm');
const wide = process.argv[2] === '1';
const pointer = value => wide ? BigInt(value) : value;
for (const branch of [0, 1]) {
  const rawValue = Object.freeze({ raw: true });
  const source = new WebAssembly.Instance(load('./original.wasm'), {
    h: { fork: () => 13, same: (left, right) => Number(left === right), raise: () => { throw rawValue; } },
    env: { memory: new WebAssembly.Memory({ initial: pointer(4), address: wide ? 'i64' : 'i32' }) },
  });
  assert.equal(source.exports.root(branch, rawValue), 19, 'the raw input defines the normal result');
  for (const mode of ['normal', 'capture', 'fail']) {
    const tables = createTableJournal(wide, wide);
    const frames = createFrameJournal(wide, module, { requireIndirectGuard: false });
    const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
    let nextMode = mode;
    const store = createGcStore(module, transit, wide, {
      memory: () => new WebAssembly.Memory({ initial: pointer(4), address: wide ? 'i64' : 'i32' }),
      bind(getInstance, memory) {
        const imports = tables.bind(getInstance, memory);
        const frame = frames.bind(getInstance, memory, tables.bindings.at(-1), nextMode, mode === 'fail' ? 1 : 0);
        Object.assign(imports.env, frame.env);
        Object.assign(imports.h, frame.h);
        imports.h.raise = () => { throw rawValue; };
        return imports;
      },
    });
    function instantiate() {
      const run = store.instantiate();
      frames.bindings.at(-1).link(run.instance);
      return run;
    }
    const parent = instantiate();
    const parentToken = Object.freeze({ parent: true });
    parent.instance.exports.wpk_fork_module_bootstrap();
    if (mode !== 'capture') {
      assert.equal(parent.instance.exports.root(branch, parentToken), mode === 'normal' ? 19 : 5);
      assert.equal(parent.instance.exports.visits.value, 1);
      assert.equal(parent.instance.exports.wpk_fork_state(), 0);
      assert.equal(frames.bindings[0].calls, mode === 'normal' ? 1 : 2);
      parent.assertReleased();
      continue;
    }
    assert.throws(() => parent.instance.exports.root(branch, parentToken), error =>
      error instanceof WebAssembly.Exception && error.is(parent.instance.exports.unwind_tag));
    assert.equal(frames.committed.length, 1, 'delegate must not skip activation capture');
    parent.instance.exports.wpk_fork_module_state_save(7);
    parent.instance.exports.wpk_fork_unwind_end();
    parent.assertReleased();
    for (let slot = 0; slot < transit.length; slot++) transit.set(slot, null);
    nextMode = 'rewind';
    const child = instantiate();
    new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
    const childToken = Object.freeze({ child: true });
    for (const id of store.brokerValues.keys()) child.instance.exports.__wpk_fork_ref_gc_publish_externref(id, childToken);
    for (const id of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_allocate(id);
    for (const [id, recipe] of store.recipes) if (recipe.kind !== 0) child.instance.exports.__wpk_fork_ref_gc_fill(id);
    child.instance.exports.wpk_fork_module_state_restore(7);
    child.instance.exports.wpk_fork_module_state_finish_restore(7);
    child.instance.exports.wpk_fork_rewind_begin(pointer(512));
    assert.equal(child.instance.exports.resume_root(), 6);
    assert.equal(child.instance.exports.visits.value, 1, 'replay skips the source entry effect');
    assert.equal(child.instance.exports.wpk_fork_state(), 0);
    assert.equal(frames.bindings[1].consumed, 1);
    assert.equal(frames.bindings[1].calls, 1);
    child.assertReleased();
  }
}
