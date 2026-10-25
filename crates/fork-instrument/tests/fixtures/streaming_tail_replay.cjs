const fs = require('node:fs');
const assert = require('node:assert/strict');
const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const memory64 = process.argv[2] === '1';
const pointer = value => memory64 ? BigInt(value) : value;
const descriptor = pointer(512);

function createRun(mode) {
  let instance;
  let captured = false;
  let replaying = false;
  let cursor = [];
  const journal = [];
  const trace = [];
  const consumed = [];
  const foreignError = new Error('foreign failure');
  const read = (address, offset) => new DataView(instance.exports.memory.buffer)
    .getUint32(Number(address) + offset, true);
  const callbacks = {
    __wpk_fork_frame_reserve: size => pointer(8192 + journal.length * 1024),
    __wpk_fork_frame_commit: address => {
      assert.equal(read(address, 8), 0);
      assert.equal(read(address, 12), 0);
      journal.push({ address: Number(address), ordinal: read(address, 0) });
    },
    __wpk_fork_frame_next: size => {
      const frame = cursor.shift();
      assert(frame, 'tail callers must not consume nonexistent frames');
      consumed.push(frame.ordinal);
      return pointer(frame.address);
    },
    __wpk_fork_frame_peek: size => {
      assert(cursor.length);
      return pointer(cursor[0].address);
    },
    __wpk_fork_resume_peek: () => cursor.length ? cursor[0].ordinal + 1 : 0,
  };
  const imports = {
    h: {
      fork: ordinal => {
        trace.push(ordinal);
        // scratch_tail executes fork(1) normally while it owns scratch,
        // then fork(3) after eliminating that activation with a tail call.
        if (ordinal === 1) return 11;
        assert.equal(Number(instance.exports.sp.value), 65536);
        if (mode === 'foreign') throw foreignError;
        if (replaying) {
          instance.exports.wpk_fork_rewind_end();
          replaying = false;
          return 0;
        }
        if (mode === 'capture' && !captured) {
          captured = true;
          instance.exports.wpk_fork_unwind_begin(descriptor);
        }
        return ordinal + 10;
      },
    },
  };
  for (const entry of WebAssembly.Module.imports(wasmModule)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.name in namespace) continue;
    if (entry.name in callbacks) namespace[entry.name] = callbacks[entry.name];
    else if (entry.kind === 'function') namespace[entry.name] = () => 0;
    else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
    else if (entry.kind === 'table') {
      namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 8 });
    } else throw new Error(`Unexpected import ${entry.module}.${entry.name}`);
  }
  instance = new WebAssembly.Instance(wasmModule, imports);
  const exports = instance.exports;
  for (const namespace of Object.values(imports)) {
    for (const value of Object.values(namespace)) {
      if (value instanceof WebAssembly.Table) {
        value.set(1, exports.resume_child);
        value.set(2, exports.resume_root);
      }
    }
  }
  return {
    exports, journal, trace, consumed, foreignError,
    rewind() {
      cursor = journal.slice().reverse();
      replaying = true;
      exports.wpk_fork_unwind_end();
      exports.wpk_fork_rewind_begin(descriptor);
    },
  };
}

for (const route of [0, 1, 2]) {
  const normal = createRun('normal');
  assert.equal(normal.exports.root(route, 100000), route === 0 ? 30 : 23);
  assert.equal(normal.exports.visits.value, route === 0 ? 100001 : 0);
  assert.equal(normal.journal.length, 0);

  const run = createRun('capture');
  assert.throws(
    () => run.exports.root(route, 100000),
    error => error instanceof WebAssembly.Exception && error.is(run.exports.unwind_tag),
  );
  const ordinals = run.journal.map(frame => frame.ordinal);
  assert.deepEqual(ordinals, route === 0 ? [0, 1] : [1]);
  run.rewind();
  assert.equal(run.exports.resume_root(), route === 0 ? 17 : 10);
  assert.deepEqual(run.consumed, ordinals.slice().reverse());
  assert.equal(run.exports.root_visits.value, 1);
  assert.equal(run.exports.child_visits.value, route === 0 ? 1 : 0);
  assert.equal(run.exports.visits.value, route === 0 ? 100001 : 0, 'tail prelude must not replay');
  assert.deepEqual(run.trace, [3, 3]);
  assert.equal(run.exports.wpk_fork_state(), 0);
  assert.equal(Number(run.exports.sp.value), 65536);
}

for (const mode of ['normal', 'capture', 'foreign']) {
  const run = createRun(mode);
  if (mode === 'normal') assert.equal(run.exports.scratch_tail(), 13);
  else assert.throws(() => run.exports.scratch_tail(), error => mode === 'foreign'
    ? error === run.foreignError
    : error instanceof WebAssembly.Exception && error.is(run.exports.unwind_tag));
  assert.deepEqual(run.trace, [1, 3]);
  assert.equal(run.journal.length, 0, 'eliminated scratch activation must not commit a frame');
  assert.equal(Number(run.exports.sp.value), 65536);
}
