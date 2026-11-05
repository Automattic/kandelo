// A test journal for the native activation wrapper. Reference recipes must
// survive instantiation: a function recipe resolves to the new instance's
// function, while repeated externref recipes preserve their shared identity.
const fs = require('node:fs');
const assert = require('node:assert/strict');

const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const memory64 = process.argv[2] === '1';
const pointer = value => memory64 ? BigInt(value) : value;
const externalValue = { identity: 'extern' };
const EXTERNAL_RECIPE = 1;
const FUNCTION_RECIPE = 2;
const FRAME_CALL_OFFSET = 4;
const FRAME_REFERENCE_OFFSET = 12;

function exerciseReplay(captureAt) {
  const vectors = new Map();
  const builders = new Map();
  const journal = [];
  const vectorReads = [];
  const decodedClasses = [];
  let nextVector = 1;
  let nextBuilder = 1000;

  function createInstance(replaying) {
    let instance;
    let captured = false;
    const pendingFrames = journal.slice();
    const readHeader = (address, offset = 0) => {
      const memory = new DataView(instance.exports.memory.buffer);
      return memory.getUint32(Number(address) + offset, true);
    };

    const callbacks = {
      __wpk_fork_frame_reserve: size => pointer(8192),
      __wpk_fork_frame_commit: address => {
        assert.equal(readHeader(address), 2);
        assert.equal(readHeader(address, FRAME_CALL_OFFSET), captureAt === 1 ? 0 : 2);
        const vector = readHeader(address, FRAME_REFERENCE_OFFSET);
        assert(vectors.has(vector), 'commit requires a finished, durable vector');
        journal.push({ address: Number(address), vector });
      },
      __wpk_fork_frame_next: size => {
        const frame = pendingFrames.shift();
        assert(frame, 'resume must consume a saved frame');
        return pointer(frame.address);
      },
      __wpk_fork_frame_peek: size => {
        assert(pendingFrames.length, 'resume must peek before consuming the frame');
        return pointer(pendingFrames[0].address);
      },
      __wpk_fork_ref_vector_begin: count => {
        const handle = nextBuilder++;
        builders.set(handle, { count, values: [] });
        return handle;
      },
      __wpk_fork_ref_vector_append: (handle, recipe) => {
        assert(builders.has(handle));
        builders.get(handle).values.push(recipe);
      },
      __wpk_fork_ref_vector_finish: handle => {
        const builder = builders.get(handle);
        assert(builder, 'finish requires a live builder');
        assert.equal(builder.values.length, builder.count);
        builders.delete(handle);
        const ordinal = nextVector++;
        vectors.set(ordinal, builder.values);
        return ordinal;
      },
      __wpk_fork_ref_vector_get: (ordinal, position) => {
        assert(vectors.has(ordinal));
        vectorReads.push(position);
        return vectors.get(ordinal)[position];
      },
      __wpk_fork_ref_encode_externref: value => {
        assert.equal(value, externalValue);
        return EXTERNAL_RECIPE;
      },
      __wpk_fork_ref_decode_externref: recipe => {
        assert.equal(recipe, EXTERNAL_RECIPE);
        decodedClasses.push('extern');
        return externalValue;
      },
      __wpk_fork_ref_encode_funcref: value => {
        assert.equal(value, instance.exports.callee);
        return FUNCTION_RECIPE;
      },
      __wpk_fork_ref_decode_funcref: recipe => {
        assert.equal(recipe, FUNCTION_RECIPE);
        decodedClasses.push('func');
        return instance.exports.callee;
      },
    };

    const imports = {
      h: {
        same: (left, right) => Number(left === right),
        fork: ordinal => {
          if (replaying) {
            assert.equal(ordinal, captureAt);
            instance.exports.wpk_fork_rewind_end();
            replaying = false;
            return 0;
          }
          if (!captured && ordinal === captureAt) {
            captured = true;
            instance.exports.wpk_fork_unwind_begin(pointer(512));
          }
          return 0;
        },
      },
    };
    for (const entry of WebAssembly.Module.imports(wasmModule)) {
      const namespace = imports[entry.module] ??= {};
      if (entry.name in namespace) continue;
      if (entry.name in callbacks) {
        namespace[entry.name] = callbacks[entry.name];
      } else if (entry.kind === 'function') {
        namespace[entry.name] = () => 0;
      } else if (entry.kind === 'tag') {
        namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
      } else if (entry.kind === 'table') {
        namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
      } else {
        throw new Error(`Unexpected test import: ${entry.module}.${entry.name}`);
      }
    }
    // Do not silently turn a misspelled journal/codec import into a no-op.
    for (const name of Object.keys(callbacks)) {
      assert(WebAssembly.Module.imports(wasmModule).some(entry => entry.name === name), name);
    }
    instance = new WebAssembly.Instance(wasmModule, imports);
    return instance.exports;
  }

  const original = createInstance(false);
  assert.throws(
    () => original.root(externalValue, original.callee),
    error => error instanceof WebAssembly.Exception && error.is(original.unwind_tag),
  );
  assert.equal(journal.length, 1);
  assert.deepEqual(
    vectors.get(journal[0].vector),
    captureAt === 1
      ? [EXTERNAL_RECIPE, FUNCTION_RECIPE, EXTERNAL_RECIPE]
      : [EXTERNAL_RECIPE, FUNCTION_RECIPE],
  );
  assert.equal(builders.size, 0, 'commit must retire transient builders');
  original.wpk_fork_unwind_end();

  const fresh = createInstance(true);
  assert.notEqual(fresh.callee, original.callee);
  new Uint8Array(fresh.memory.buffer).set(new Uint8Array(original.memory.buffer));
  fresh.wpk_fork_rewind_begin(pointer(512));
  assert.equal(fresh.resume_root(), 1);
  assert.equal(fresh.wpk_fork_state(), 0);
  assert.equal(Number(fresh.sp.value), 65536);
  assert.deepEqual(vectorReads.slice(0, 2), [0, 1], 'resume parameters use the universal prefix');
  assert(decodedClasses.includes('func'));
  assert(decodedClasses.includes('extern'));
}

for (const captureAt of [1, 2]) exerciseReplay(captureAt);
