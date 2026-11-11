const fs = require('node:fs');
const assert = require('node:assert/strict');
const moduleBytes = fs.readFileSync(process.argv[1]);
const wasmModule = new WebAssembly.Module(moduleBytes);
const wide = process.argv[2] === '1';
const pointer = value => wide ? BigInt(value) : value;
const descriptor = pointer(512);
const frameAddress = 8192;

function createRun(mode) {
  let instance;
  let calls = 0;
  let commits = 0;
  let consumed = 0;
  const callbacks = {
    __wpk_fork_frame_reserve: () => {
      if (mode === 'abort') {
        instance.exports.wpk_fork_abort_begin(descriptor);
        return pointer(0);
      }
      return pointer(frameAddress);
    },
    __wpk_fork_frame_commit: () => {
      // The previous iteration's catch is no longer the current try entry.
      // Check before replay so a regression fails without an infinite loop.
      assert.equal(new DataView(instance.exports.memory.buffer).getUint32(frameAddress + 8, true), 0);
      commits++;
    },
    __wpk_fork_frame_next: () => { consumed++; return pointer(frameAddress); },
    __wpk_fork_frame_peek: () => pointer(frameAddress),
    __wpk_fork_ref_vector_begin: () => 1,
    __wpk_fork_ref_vector_append: (_id, recipe) => {
      assert.equal(recipe, 0, 'a retired catch must not retain an exception recipe');
    },
    __wpk_fork_ref_vector_finish: () => 1,
    __wpk_fork_ref_vector_get: () => 0,
  };
  const imports = {h: {fork: ordinal => {
    assert.equal(ordinal, 3);
    calls++;
    if (mode === 'rewind') {
      instance.exports.wpk_fork_rewind_end();
      return 0;
    }
    if (mode === 'abort' && calls === 2) {
      instance.exports.wpk_fork_abort_end();
      return -1;
    }
    if (mode !== 'normal') instance.exports.wpk_fork_unwind_begin(descriptor);
    return 13;
  }}};
  for (const entry of WebAssembly.Module.imports(wasmModule)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.name in namespace) continue;
    if (entry.name in callbacks) namespace[entry.name] = callbacks[entry.name];
    else if (entry.kind === 'function') namespace[entry.name] = () => 0;
    else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({parameters: []});
    else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({element: 'anyfunc', initial: 4});
    else if (entry.name === '__wpk_fork_module_activation') namespace[entry.name] = new WebAssembly.Global({value: 'i32', mutable: false}, 0);
    else throw new Error(`Unexpected import ${entry.module}.${entry.name}`);
  }
  instance = new WebAssembly.Instance(wasmModule, imports);
  return {exports: instance.exports, calls: () => calls, commits: () => commits, consumed: () => consumed};
}

const normal = createRun('normal');
assert.equal(normal.exports.root(0), 112);
const captured = createRun('capture');
assert.throws(() => captured.exports.root(0), error => error instanceof WebAssembly.Exception && error.is(captured.exports.unwind_tag));
assert.equal(captured.commits(), 1);
captured.exports.wpk_fork_unwind_end();
const fresh = createRun('rewind');
new Uint8Array(fresh.exports.memory.buffer).set(new Uint8Array(captured.exports.memory.buffer));
fresh.exports.wpk_fork_rewind_begin(descriptor);
assert.equal(fresh.exports.resume_root(), 99);
assert.equal(fresh.calls(), 1);
assert.equal(fresh.consumed(), 1);
assert.equal(Number(fresh.exports.sp.value), 65536);
const aborted = createRun('abort');
assert.equal(aborted.exports.root(0), 98);
assert.equal(aborted.calls(), 2);
assert.equal(aborted.commits(), 0);
assert.equal(aborted.consumed(), 0);
