import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import createGcStore from './gc_recipe_host.mjs';
import createTableJournal from './table_record_host.cjs';
import createFrameJournal from './activation_frame_host.cjs';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const provider = load('./provider.wasm');
const wide = process.argv[2] === '1';
const wideTable = process.argv[3] === '1';
const shape = Number(process.argv[4]);
const pointer = value => wide ? BigInt(value) : value;
for (const checkpoint of [0, 1, 2, 5]) {
  for (const [mode, failAt] of [['normal', 0], ['capture', 0], ['fail', 1], ['fail', 2], ['fail', 3]]) {
    const tables = createTableJournal(wide, wideTable);
    const frames = createFrameJournal(wide, provider, { requireIndirectGuard: false, requireReferenceVector: false });
    const transit = new WebAssembly.Instance(load('./transit.wasm')).exports.transit;
    const transactions = [];
    let nextMode = mode;
    const store = createGcStore(provider, transit, wide, {
      functions: ['initializer'],
      memory: () => new WebAssembly.Memory({ initial: pointer(4), address: wide ? 'i64' : 'i32' }),
      bind(getInstance, memory) {
        const imports = tables.bind(getInstance, memory);
        const publication = tables.bindings.at(-1);
        const frame = frames.bind(getInstance, memory, publication, nextMode, failAt);
        const transaction = { cursor: nextMode === 'rewind' ? transactions[0].cursor : 0, prepare: 0, next: 0, commit: 0 };
        transactions.push(transaction);
        Object.assign(imports.env, frame.env, {
          __wasm_dlopen_main() { assert.fail('nonempty loader ranges do not select main'); },
          __wasm_dlopen_prepare(...args) {
            transaction.prepare++;
            publication.advance();
            assert.deepEqual(args, [pointer(64), pointer(32), pointer(shape === 2 ? 0 : 128), pointer(shape === 2 ? 0 : 16), shape === 5 ? 7 : 0x100]);
            return 17;
          },
          __wasm_dlopen_next(token) { transaction.next++; assert.equal(token, 17); return transaction.cursor++ === 0 ? 1 : 0; },
          __wasm_dlopen_commit(token) { transaction.commit++; assert.equal(token, 17); return 77; },
        });
        Object.assign(imports.h, frame.h, {
          check(count) { return Number(count === checkpoint); },
          fork(...args) {
            const signal = getInstance().exports.in_checkpoint.value !== 0;
            if (!signal) assert(publication.reconciles > 0, 'generated initializer transport reconciles its source table');
            if (checkpoint && !signal) return 13;
            return frame.h.fork(...args);
          },
        });
        return imports;
      },
    });
    function instantiate() {
      const run = store.instantiate();
      frames.bindings.at(-1).link(run.instance);
      return run;
    }
    function check(run, expected, consumed) {
      const x = run.instance.exports;
      assert.equal(expected, 77 + x.fork_value.value + 1);
      assert.equal(x.root_visits.value, 1); assert.equal(x.init_visits.value, 1);
      assert.equal(x.checkpoints.value, 5); assert.equal(x.wpk_fork_state(), 0);
      assert.equal(x.in_checkpoint.value, 0);
      assert.equal(frames.bindings.at(-1).consumed, consumed);
      run.assertReleased();
    }
    const parent = instantiate();
    parent.instance.exports.wpk_fork_module_bootstrap();
    const parentToken = Object.freeze({ parent: true });
    if (mode !== 'capture') {
      const expected = mode === 'normal' || checkpoint ? 91 : 77;
      assert.equal(parent.instance.exports.root(parentToken), expected);
      check(parent, expected, mode === 'normal' ? 0 : failAt - 1);
      assert.equal(transactions[0].prepare, 1, 'replay never calls prepare again');
      assert.equal(transactions[0].next, 2); assert.equal(transactions[0].commit, 1);
      continue;
    }
    assert.throws(() => parent.instance.exports.root(parentToken), error => error instanceof WebAssembly.Exception && error.is(parent.instance.exports.unwind_tag));
    assert.deepEqual(frames.committed.map(frame => frame.ordinal), [checkpoint ? 1 : 0, 3, 2], 'selected callback, generated driver, original caller');
    const driver = frames.committed[1];
    assert.equal(driver.size, 24, 'only the scalar token and entry survive in the generated driver');
    assert.equal(driver.vector, 0, 'dead adapter pointers do not become driver reference roots');
    assert(frames.committed[2].vector > 0, 'original caller still captures its live token');
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
    tables.bindings.at(-1).advance();
    child.instance.exports.wpk_fork_rewind_begin(pointer(512));
    const expected = checkpoint ? 91 : 78;
    assert.equal(child.instance.exports.resume_root(), expected);
    check(child, expected, 3);
    assert.equal(transactions[1].prepare, 0);
    assert.equal(transactions[1].next, checkpoint === 5 ? 0 : checkpoint === 1 ? 2 : 1);
    assert.equal(transactions[1].commit, checkpoint === 5 ? 0 : 1);
  }
}
