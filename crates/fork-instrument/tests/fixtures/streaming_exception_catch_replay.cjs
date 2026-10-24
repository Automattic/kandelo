const fs = require('node:fs');
const assert = require('node:assert/strict');
const createExceptionStore = require('./exception_recipe_host.cjs');
const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[2]));
const wide = process.argv[3] === '1';
const kind = process.argv[4];
const scratch = process.argv[5] === '1';
const oracle = process.argv[6] === 'Walrus';
const pointer = value => wide ? BigInt(value) : value;
const descriptor = pointer(512);
const frameAddress = 8192;
const store = createExceptionStore();
const vectors = new Map();
const builders = new Map();
const object = { value: 21 };
const rawException = { message: 'broker-owned raw exception' };
let nextVector = 1;

function run(mode, input, savedFrames = []) {
  let instance;
  let forks = 0;
  let commits = 0;
  let consumed = 0;
  let valueCalls = 0;
  let vectorReads = 0;
  let forkStackPointer;
  const journal = [];
  const pending = savedFrames.slice();
  const host = store.bind(() => instance, () => instance.exports.memory);
  const callbacks = {
    // There is no saved child activation below this root; the fork import
    // resumes lexically through the sentinel route.
    __wpk_fork_resume_peek() { return 0; },
    __wpk_fork_frame_reserve(size) {
      if (mode === 'abort') {
        instance.exports.wpk_fork_abort_begin(descriptor);
        return pointer(0);
      }
      return pointer(frameAddress);
    },
    __wpk_fork_frame_commit(address) {
      const memory = new DataView(instance.exports.memory.buffer);
      assert.equal(Number(address), frameAddress);
      assert.equal(memory.getUint32(frameAddress, true), 0);
      assert.equal(memory.getUint32(frameAddress + 4, true), input === 0 ? 0 : 1);
      const selector = input === 1 || input === 3 ? 1 : 0;
      assert.equal(memory.getUint32(frameAddress + 8, true), selector);
      const vector = vectors.get(memory.getUint32(frameAddress + 12, true));
      assert(vector, 'commit must publish a finished durable vector');
      if (selector === 0) {
        assert(vector.every(id => id === 0), 'private unwind cannot own a user recipe');
      } else {
        const exceptions = vector.filter(id => store.recipes.has(id));
        assert(exceptions.length >= 1);
        if (kind.endsWith('_ref')) {
          assert.equal(exceptions.length, 2, 'user and synthetic exception slots stay live');
          assert.equal(exceptions[0], exceptions[1], 'aliased exceptions share one recipe');
        }
        const recipe = store.recipes.get(exceptions[0]);
        if (input === 3) {
          assert.equal(recipe.broker, true);
          assert.equal(recipe.value, rawException);
        } else {
          assert.equal(recipe.tag, 0);
          assert.equal(recipe.layout, 0);
          assert.deepEqual([...new Int32Array(recipe.scalars.buffer)], [21, 22, 23, 24]);
          assert.equal(recipe.refs.length, 1);
          assert(recipe.refs[0] > 0);
        }
      }
      host.assertIdle();
      commits++;
      journal.push(frameAddress);
    },
    __wpk_fork_frame_next(size) {
      const address = pending.shift();
      assert(address, 'consume exactly one committed activation');
      consumed++;
      return pointer(address);
    },
    __wpk_fork_frame_peek(size) {
      assert(pending.length);
      return pointer(pending[0]);
    },
    __wpk_fork_ref_vector_begin(count) {
      const id = nextVector++;
      builders.set(id, { count, values: [] });
      return id;
    },
    __wpk_fork_ref_vector_append(id, recipe) {
      const builder = builders.get(id);
      assert(builder && builder.values.length < builder.count);
      builder.values.push(recipe);
    },
    __wpk_fork_ref_vector_finish(id) {
      const builder = builders.get(id);
      assert.equal(builder.values.length, builder.count);
      vectors.set(id, builder.values);
      builders.delete(id);
      return id;
    },
    __wpk_fork_ref_vector_get(id, index) {
      vectorReads++;
      const vector = vectors.get(id);
      assert(vector && index < vector.length, 'unknown frame reference vector');
      return vector[index];
    },
  };
  const imports = {
    env: { ...host.imports },
    h: {
      value() { valueCalls++; return object; },
      raise() { throw rawException; },
      check(value) { assert.equal(value, object); return value.value; },
      fork(ordinal) {
        assert.equal(ordinal, 3);
        forks++;
        forkStackPointer = Number(instance.exports.sp.value);
        if (mode === 'rewind') {
          instance.exports.wpk_fork_rewind_end();
          return 0;
        }
        if (mode === 'abort' && forks === 2) {
          instance.exports.wpk_fork_abort_end();
          return -1;
        }
        if (mode === 'capture' || mode === 'abort') {
          instance.exports.wpk_fork_unwind_begin(descriptor);
        }
        return 13;
      },
    },
  };
  for (const entry of WebAssembly.Module.imports(wasmModule)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.name in namespace) continue;
    if (entry.name in callbacks) namespace[entry.name] = callbacks[entry.name];
    else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
    else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 4 });
    else if (entry.kind === 'function') {
      namespace[entry.name] = () => { throw new Error(`Unexpected import call ${entry.name}`); };
    } else throw new Error(`Unexpected import ${entry.name}`);
  }
  instance = new WebAssembly.Instance(wasmModule, imports);
  return { exports: instance.exports, journal, host,
    forks: () => forks, commits: () => commits, consumed: () => consumed,
    valueCalls: () => valueCalls, vectorReads: () => vectorReads,
    forkStackPointer: () => forkStackPointer };
}

function invoke(instance, input, expected) {
  const call = () => instance.exports.root(input);
  if (input === 3 && kind === 'all_ref') assert.throws(call, value => value === rawException);
  else assert.equal(call(), expected);
}

function assertReleased(instance, input, baseline, reservation) {
  // Existing Walrus omits release when catch_all_ref rethrows a
  // raw broker value. Record that oracle defect explicitly; native emission
  // must release the complete activation reservation on this path.
  const knownOracleLeak = oracle && scratch && kind === 'all_ref' && input === 3;
  assert.equal(Number(instance.exports.sp.value), baseline - (knownOracleLeak ? reservation : 0));
}

const inputs = kind.startsWith('all') ? [0, 1, 2, 3] : [0, 1, 2];
for (const input of inputs) {
  const expected = 42 + input * 100 + (scratch ? 820 : 0);
  const normal = run('normal', input);
  invoke(normal, input, expected + 13);
  assertReleased(normal, input, 65536, 65536 - normal.forkStackPointer());
  normal.host.assertIdle();
  const before = store.recipes.size;
  const captured = run('capture', input);
  assert.throws(() => captured.exports.root(input), error =>
    error instanceof WebAssembly.Exception && error.is(captured.exports.unwind_tag));
  assert.equal(captured.commits(), 1);
  assert.equal(captured.exports.handlers.value, input === 1 || input === 3 ? 1 : 0);
  assert.equal(Number(captured.exports.sp.value), 65536);
  assert.equal(captured.valueCalls(), input === 1 ? 1 : 0);
  if (input === 0 || input === 2) assert.equal(store.recipes.size, before);
  captured.exports.wpk_fork_unwind_end();

  const fresh = run('rewind', input, captured.journal);
  new Uint8Array(fresh.exports.memory.buffer).set(new Uint8Array(captured.exports.memory.buffer));
  fresh.exports.wpk_fork_rewind_begin(descriptor);
  const replayStackPointer = Number(fresh.exports.sp.value);
  assert.equal(replayStackPointer, captured.forkStackPointer());
  if (input === 3 && kind === 'all_ref') {
    assert.throws(() => fresh.exports.resume_root(), value => value === rawException);
  } else assert.equal(fresh.exports.resume_root(), expected);
  assert.equal(fresh.exports.entries.value, 1, 'rewind skips the source prelude');
  assert.equal(fresh.exports.handlers.value, input === 2 ? 0 : 1);
  assert.equal(fresh.valueCalls(), input === 0 ? 1 : 0);
  assert.equal(fresh.forks(), 1);
  assert.equal(fresh.consumed(), 1);
  assert.equal(fresh.exports.wpk_fork_state(), 0);
  // Replayed prologues reserve below the restored fork-time SP, as the
  // existing snapshot ABI specifies. Release this replay activation's range.
  assertReleased(fresh, input, replayStackPointer, 65536 - captured.forkStackPointer());
  fresh.host.assertIdle();

  const vectorsBeforeAbort = vectors.size;
  const aborted = run('abort', input);
  invoke(aborted, input, expected - 1);
  assert.equal(aborted.commits(), 0);
  assert.equal(aborted.consumed(), 0);
  assert.equal(aborted.forks(), 2);
  assert.equal(aborted.exports.entries.value, 1);
  assert.equal(aborted.exports.handlers.value, input === 2 ? 0 : 1);
  assert.equal(aborted.exports.wpk_fork_state(), 0);
  assertReleased(aborted, input, 65536, 65536 - aborted.forkStackPointer());
  assert.equal(vectors.size, vectorsBeforeAbort, 'live restart does not serialize reference recipes');
  aborted.host.assertIdle();

  const corrupt = run('rewind', input, captured.journal);
  new Uint8Array(corrupt.exports.memory.buffer).set(new Uint8Array(captured.exports.memory.buffer));
  new DataView(corrupt.exports.memory.buffer).setUint32(frameAddress + 8, 999, true);
  corrupt.exports.wpk_fork_rewind_begin(descriptor);
  assert.throws(() => corrupt.exports.resume_root(), WebAssembly.RuntimeError);
  assert.equal(corrupt.vectorReads(), 0, 'reject invalid selectors before decoding references');
  assert.equal(corrupt.forks(), 0);
}
assert.equal(builders.size, 0, 'no unfinished vector survives a commit');
