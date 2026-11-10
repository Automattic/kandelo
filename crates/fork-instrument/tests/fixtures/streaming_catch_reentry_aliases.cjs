const fs = require('node:fs');
const assert = require('node:assert/strict');
const createExceptionStore = require('./exception_recipe_host.cjs');
const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[2]));
const pointer = value => process.argv[3] === '1' ? BigInt(value) : value;
const descriptor = pointer(512);
const frameAddress = 8192;
const store = createExceptionStore();
const vectors = new Map();
const builders = new Map();
const object = { value: 21 };
let nextVector = 1;

function run(mode, target, recapture) {
  const captureTarget = recapture ?? target;
  let instance;
  let commits = 0;
  let consumed = 0;
  let values = 0;
  let checks = 0;
  let targetCalls = 0;
  const phases = [];
  const host = store.bind(() => instance, () => instance.exports.memory);
  const callbacks = {
    __wpk_fork_resume_peek: () => 0,
    __wpk_fork_frame_reserve() {
      if (mode === 'abort') {
        instance.exports.wpk_fork_abort_begin(descriptor);
        return pointer(0);
      }
      assert(mode === 'capture' || (mode === 'rewind' && recapture !== undefined));
      return pointer(frameAddress);
    },
    __wpk_fork_frame_commit(address) {
      assert.equal(Number(address), frameAddress);
      const memory = new DataView(instance.exports.memory.buffer);
      assert.equal(memory.getUint32(frameAddress + 8, true), captureTarget === 0 ? 2 : 0, `capture phase ${captureTarget}`);
      const vector = vectors.get(memory.getUint32(frameAddress + 12, true));
      assert.equal(vector.length, 5, 'four guest aliases plus synthetic catch state');
      assert.equal(vector.filter(id => id === 0).length, captureTarget === 0 ? 0 : 1);
      // Reference positions follow the frame plan; verify alias groups by the
      // real codec's durable recipes rather than assuming guest-local order.
      const counts = new Map();
      for (const id of vector.filter(id => id !== 0)) {
        const recipe = store.recipes.get(id);
        assert(recipe && !recipe.broker);
        const lanes = [...new Int32Array(recipe.scalars.buffer)];
        assert.deepEqual(lanes.slice(1), [1, 2, 3]);
        assert([41, 42].includes(lanes[0]));
        assert.equal(recipe.refs.length, 1);
        const previous = counts.get(lanes[0]);
        if (previous) {
          assert.equal(previous.id, id, 'guest aliases must share exception identity');
          previous.count++;
        } else counts.set(lanes[0], { id, count: 1 });
      }
      assert.equal(counts.get(41).count, 2);
      assert.equal(counts.get(42).count, captureTarget === 0 ? 3 : 2);
      assert.notEqual(counts.get(41).id, counts.get(42).id);
      if (captureTarget !== 0) assert.equal(vector.at(-1), 0, 'only the synthetic root is retired');
      host.assertIdle();
      commits++;
    },
    __wpk_fork_frame_next() {
      assert.equal(mode, 'rewind');
      assert.equal(consumed++, 0);
      return pointer(frameAddress);
    },
    __wpk_fork_frame_peek: () => pointer(frameAddress),
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
      const vector = vectors.get(id);
      assert(vector && index < vector.length);
      return vector[index];
    },
  };
  const imports = {
    env: { ...host.imports },
    h: {
      value() { values++; return object; },
      check(value) { checks++; assert.equal(value, object); return value.value; },
      fork(phase) {
        phases.push(phase);
        if (mode === 'rewind' && phase === recapture) {
          assert.equal(instance.exports.wpk_fork_state(), 0);
          instance.exports.wpk_fork_unwind_begin(descriptor);
          return 13;
        }
        if (phase !== target) return 13;
        targetCalls++;
        if (mode === 'rewind') {
          assert.equal(instance.exports.wpk_fork_state(), 2);
          instance.exports.wpk_fork_rewind_end();
          return 0;
        }
        if (mode === 'abort' && targetCalls === 2) {
          assert.equal(instance.exports.wpk_fork_state(), 3);
          instance.exports.wpk_fork_abort_end();
          return -1;
        }
        assert.equal(instance.exports.wpk_fork_state(), 0);
        if (mode !== 'normal') instance.exports.wpk_fork_unwind_begin(descriptor);
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
    else if (entry.kind === 'function') namespace[entry.name] = () => { throw new Error(`Unexpected import call ${entry.name}`); };
    else throw new Error(`Unexpected import ${entry.module}.${entry.name}`);
  }
  instance = new WebAssembly.Instance(wasmModule, imports);
  return { exports: instance.exports, phases, host,
    commits: () => commits, consumed: () => consumed,
    values: () => values, checks: () => checks };
}

for (const target of [0, 1, 2]) {
  const normal = run('normal', target);
  assert.equal(normal.exports.root(0), 489);
  assert.deepEqual(normal.phases, [0, 1, 2]);
  assert.equal(normal.values(), 2);
  assert.equal(normal.checks(), 4);
  normal.host.assertIdle();

  const captured = run('capture', target);
  assert.throws(() => captured.exports.root(0), error =>
    error instanceof WebAssembly.Exception && error.is(captured.exports.unwind_tag));
  assert.deepEqual(captured.phases, [0, 1, 2].slice(0, target + 1));
  assert.equal(captured.commits(), 1);
  captured.exports.wpk_fork_unwind_end();

  const fresh = run('rewind', target);
  new Uint8Array(fresh.exports.memory.buffer).set(new Uint8Array(captured.exports.memory.buffer));
  fresh.exports.wpk_fork_rewind_begin(descriptor);
  assert.equal(fresh.exports.resume_root(), 476);
  assert.deepEqual(fresh.phases, [0, 1, 2].slice(target));
  assert.equal(fresh.values(), 0, 'replay must not repeat source throws or payload producers');
  assert.equal(fresh.checks(), 4);
  assert.equal(fresh.consumed(), 1);
  assert.equal(fresh.exports.wpk_fork_state(), 0);
  assert.equal(Number(fresh.exports.sp.value), 65536);
  fresh.host.assertIdle();

  const vectorsBeforeAbort = vectors.size;
  const aborted = run('abort', target);
  assert.equal(aborted.exports.root(0), 475);
  assert.deepEqual(aborted.phases, [...[0, 1, 2].slice(0, target + 1), ...[0, 1, 2].slice(target)]);
  assert.equal(aborted.values(), 2, 'live recovery must not repeat payload producers');
  assert.equal(aborted.checks(), 4);
  assert.equal(aborted.commits(), 0);
  assert.equal(aborted.consumed(), 0);
  assert.equal(aborted.exports.wpk_fork_state(), 0);
  assert.equal(Number(aborted.exports.sp.value), 65536);
  assert.equal(vectors.size, vectorsBeforeAbort, 'live recovery does not serialize references');
  aborted.host.assertIdle();
  assert.equal(builders.size, 0);
}

// Recapture restored references in successive fresh generations. This also
// verifies decoded aliases retain identity when encoded again by the real
// Wasm codec, rather than merely carrying equal payloads after one rewind.
let previous = run('capture', 0);
assert.throws(() => previous.exports.root(0), error =>
  error instanceof WebAssembly.Exception && error.is(previous.exports.unwind_tag));
previous.exports.wpk_fork_unwind_end();
for (const target of [0, 1]) {
  const generation = run('rewind', target, target + 1);
  new Uint8Array(generation.exports.memory.buffer).set(new Uint8Array(previous.exports.memory.buffer));
  generation.exports.wpk_fork_rewind_begin(descriptor);
  assert.throws(() => generation.exports.resume_root(), error =>
    error instanceof WebAssembly.Exception && error.is(generation.exports.unwind_tag));
  assert.deepEqual(generation.phases, [target, target + 1]);
  assert.equal(generation.commits(), 1);
  assert.equal(generation.consumed(), 1);
  assert.equal(generation.values(), 0);
  generation.host.assertIdle();
  generation.exports.wpk_fork_unwind_end();
  previous = generation;
}
const last = run('rewind', 2);
new Uint8Array(last.exports.memory.buffer).set(new Uint8Array(previous.exports.memory.buffer));
last.exports.wpk_fork_rewind_begin(descriptor);
assert.equal(last.exports.resume_root(), 450);
assert.deepEqual(last.phases, [2]);
assert.equal(last.values(), 0);
assert.equal(last.checks(), 4);
assert.equal(last.consumed(), 1);
assert.equal(last.exports.wpk_fork_state(), 0);
assert.equal(Number(last.exports.sp.value), 65536);
last.host.assertIdle();
assert.equal(builders.size, 0);
