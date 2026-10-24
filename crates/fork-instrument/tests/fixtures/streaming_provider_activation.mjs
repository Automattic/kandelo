import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createTableJournal from './table_record_host.cjs';
import createFrameJournal from './activation_frame_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const provider = load('./provider.wasm');
const wide = process.argv[2] === '1';
const scratch = process.argv[3] === '1';
const pointer = value => wide ? BigInt(value) : value;
function scenario(mode, failAt = 0) {
  const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
  const tables = createTableJournal(wide, wide);
  const frames = createFrameJournal(wide);
  let nextMode = mode;
  const store = createGcStore(provider, transit, wide, {
    functions: ['source_function', 'child', 'handler'],
    memory: () => new WebAssembly.Memory({ initial: wide ? 4n : 4, address: wide ? 'i64' : 'i32' }),
    bind(getInstance, memory) {
      const imports = tables.bind(getInstance, memory);
      const publication = tables.bindings.at(-1);
      const activation = frames.bind(getInstance, memory, publication, nextMode, failAt);
      Object.assign(imports.env, activation.env);
      Object.assign(imports.h, activation.h);
      return imports;
    },
  });
  function instantiate() {
    const run = store.instantiate();
    frames.bindings.at(-1).link(run.instance);
    return run;
  }
  const parent = instantiate();
  parent.instance.exports.wpk_fork_module_bootstrap();
  const parentToken = Object.freeze({ owner: 'parent' });
  parent.instance.exports.prepare(parentToken);
  if (mode === 'normal' || mode === 'fail') {
    assert.equal(parent.instance.exports.root(parentToken), mode === 'normal' ? 138 : 124);
    assert.equal(parent.instance.exports.verify_roots(), 1);
    assert.equal(parent.instance.exports.root_visits.value, 2);
    assert.equal(parent.instance.exports.child_visits.value, 1);
    assert.equal(parent.instance.exports.wpk_fork_state(), 0);
    assert.equal(frames.bindings[0].calls, mode === 'normal' ? 1 : 2);
    assert.equal(frames.committed.length, mode === 'normal' ? 0 : failAt - 1);
    assert.equal(frames.bindings[0].consumed, mode === 'normal' ? 0 : failAt - 1);
    if (scratch) assert(frames.bindings[0].forkStackPointer < 196608, 'wide arguments use virtual scratch');
    // Replayed prologues reserve below the restored fork-time SP under the
    // existing ABI. A live abort that reenters the child has the same floor.
    assert.equal(Number(parent.instance.exports.sp.value), mode === 'fail' && failAt === 2
      ? frames.bindings[0].forkStackPointer : 196608);
    parent.assertReleased();
    return;
  }
  assert.throws(() => parent.instance.exports.root(parentToken),
    error => error instanceof WebAssembly.Exception && error.is(parent.instance.exports.unwind_tag));
  assert.deepEqual(frames.committed.map(frame => frame.ordinal), [0, 1]);
  for (const frame of frames.committed) {
    const vector = store.vectors[frame.vector];
    assert.equal(vector.values.length, vector.expected);
    assert(vector.expected >= 2);
  }
  parent.instance.exports.wpk_fork_module_state_save(7);
  parent.instance.exports.wpk_fork_unwind_end();
  parent.assertReleased();
  for (let index = 0; index < transit.length; index++) transit.set(index, null);
  nextMode = 'rewind';
  const child = instantiate();
  new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
  const childToken = Object.freeze({ owner: 'child' });
  for (const id of store.brokerValues.keys()) child.instance.exports.__wpk_fork_ref_gc_publish_externref(id, childToken);
  for (const id of store.recipes.keys()) child.instance.exports.__wpk_fork_ref_gc_allocate(id);
  for (const [id, recipe] of store.recipes) if (recipe.kind !== 0) child.instance.exports.__wpk_fork_ref_gc_fill(id);
  child.instance.exports.wpk_fork_module_state_restore(7);
  child.instance.exports.wpk_fork_module_state_finish_restore(7);
  child.instance.exports.wpk_fork_rewind_begin(pointer(512));
  const replayStackPointer = Number(child.instance.exports.sp.value);
  assert.equal(replayStackPointer, frames.bindings[0].forkStackPointer);
  if (scratch) assert(replayStackPointer < 196608);
  // These mutable globals are not safe argument-rematerialization sources.
  // Replayed wide calls must consume captured operand bits, not fresh reads.
  if (scratch) child.instance.exports.operand.value = 999n;
  assert.equal(child.instance.exports.resume_root(), 125);
  assert.equal(child.instance.exports.verify_roots(), 1);
  assert.equal(child.instance.exports.root_visits.value, 2, 'resume skips source pre-call effects');
  assert.equal(child.instance.exports.child_visits.value, 1);
  assert.equal(child.instance.exports.wpk_fork_state(), 0);
  assert.equal(frames.bindings[1].consumed, 2);
  assert.equal(frames.bindings[1].calls, 1);
  assert.notEqual(child.instance.exports.source_function, parent.instance.exports.source_function);
  assert.throws(() => child.instance.exports.probe_dropped(), WebAssembly.RuntimeError);
  assert.equal(Number(child.instance.exports.sp.value), replayStackPointer);
  child.assertReleased();
}
scenario('normal');
scenario('capture');
scenario('fail', 1);
scenario('fail', 2);
