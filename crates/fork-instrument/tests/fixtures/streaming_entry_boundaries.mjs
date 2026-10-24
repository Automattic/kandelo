import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createTableJournal from './table_record_host.cjs';
import createFrameJournal from './activation_frame_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const module = load('./provider.wasm');
const wide = process.argv[2] === '1';
const table64 = process.argv[3] === '1';
const requireGuards = process.argv[4] === '1';
const pointer = value => wide ? BigInt(value) : value;
for (const thread of [false, true]) {
  for (const mode of ['normal', 'capture', 'fail']) {
    const tables = createTableJournal(wide, table64);
    const frames = createFrameJournal(wide, module, {
      requireIndirectGuard: false, requireReferenceVector: false,
    });
    const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
    let nextMode = mode;
    const store = createGcStore(module, transit, wide, {
      memory: () => new WebAssembly.Memory({ initial: pointer(4), address: wide ? 'i64' : 'i32' }),
      bind(getInstance, memory) {
        const imports = tables.bind(getInstance, memory);
        const frame = frames.bind(getInstance, memory, tables.bindings.at(-1), nextMode, mode === 'fail' ? 1 : 0);
        Object.assign(imports.env, frame.env);
        Object.assign(imports.h, frame.h);
        return imports;
      },
    });
    function instantiate() {
      const run = store.instantiate();
      frames.bindings.at(-1).link(run.instance);
      return run;
    }
    function enter(run, replay = false) {
      const publication = tables.bindings.at(-1);
      const prior = publication.reconciles;
      try {
        return thread
          ? run.instance.exports.wpk_fork_resume_thread(replay ? 0 : 1, pointer(replay ? 999 : 10))
          : run.instance.exports.wpk_fork_resume_start();
      } finally {
        if (thread && requireGuards) assert(publication.reconciles > prior,
          'thread boundary guards before normal dispatch and private replay');
      }
    }
    function check(run, consumed) {
      assert.equal(run.instance.exports.visits.value, 1, 'entry effects execute once');
      assert.equal(run.instance.exports.wpk_fork_state(), 0);
      assert.equal(frames.bindings.at(-1).consumed, consumed);
      run.assertReleased();
    }
    const parent = instantiate();
    parent.instance.exports.wpk_fork_module_bootstrap();
    tables.bindings.at(-1).advance();
    if (mode !== 'capture') {
      assert.equal(enter(parent), thread ? pointer(mode === 'normal' ? 23 : 9) : undefined);
      check(parent, 0);
      continue;
    }
    assert.throws(() => enter(parent), error => error instanceof WebAssembly.Exception && error.is(parent.instance.exports.unwind_tag));
    assert.equal(frames.committed.length, 1, 'host entry boundaries add no captured frame');
    parent.instance.exports.wpk_fork_module_state_save(7);
    parent.instance.exports.wpk_fork_unwind_end();
    parent.assertReleased();
    nextMode = 'rewind';
    const child = instantiate();
    new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
    child.instance.exports.wpk_fork_module_state_restore(7);
    child.instance.exports.wpk_fork_module_state_finish_restore(7);
    child.instance.exports.wpk_fork_rewind_begin(pointer(512));
    tables.bindings.at(-1).advance();
    assert.equal(enter(child, true), thread ? pointer(10) : undefined, 'replay ignores stale index and argument');
    check(child, 1);
  }
}
