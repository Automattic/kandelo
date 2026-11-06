const fs = require('node:fs');
const assert = require('node:assert/strict');
const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const memory64 = process.argv[2] === '1';
const catchOffset = Number(process.argv[3]);
const forkInsideTry = process.argv[4] === '1';
const pointer = value => memory64 ? BigInt(value) : value;
const descriptor = pointer(512);
const frameAddress = 8192;

function createRun(mode, input, savedFrames = []) {
  let instance;
  let forkCalls = 0;
  let commits = 0;
  let consumed = 0;
  const journal = [];
  const pending = savedFrames.slice();
  const callbacks = {
    __wpk_fork_frame_reserve: size => {
      if (mode === 'abort') {
        instance.exports.wpk_fork_abort_begin(descriptor);
        return pointer(0);
      }
      return pointer(frameAddress);
    },
    __wpk_fork_frame_commit: address => {
      const memory = new DataView(instance.exports.memory.buffer);
      assert.equal(Number(address), frameAddress);
      assert.equal(memory.getUint32(frameAddress, true), 0);
      assert.equal(memory.getUint32(frameAddress + 4, true), 0);
      const selector = forkInsideTry || input === 2 ? 0 : input === 1 ? 1 : 2;
      assert.equal(memory.getUint32(frameAddress + 8, true), selector);
      assert.equal(memory.getUint32(frameAddress + 12, true), 0);
      if (selector === 1) {
        assert.equal(memory.getUint32(frameAddress + catchOffset, true), 21);
      } else if (selector === 2) {
        assert.equal(memory.getBigUint64(frameAddress + catchOffset, true), 30n);
        assert.equal(memory.getUint32(frameAddress + catchOffset + 8, true), 12);
      }
      commits++;
      journal.push(frameAddress);
    },
    __wpk_fork_frame_next: size => {
      const address = pending.shift();
      assert(address, 'replay must consume exactly one saved activation');
      consumed++;
      return pointer(address);
    },
    __wpk_fork_frame_peek: size => {
      assert(pending.length);
      return pointer(pending[0]);
    },
  };
  const imports = {
    h: {
      fork: ordinal => {
        forkCalls++;
        assert.equal(ordinal, 3);
        if (mode === 'rewind') {
          instance.exports.wpk_fork_rewind_end();
          return 0;
        }
        if (mode === 'abort' && forkCalls === 2) {
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
    else if (entry.kind === 'function') namespace[entry.name] = () => 0;
    else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
    else if (entry.kind === 'table') {
      namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 4 });
    } else throw new Error(`Unexpected import ${entry.module}.${entry.name}`);
  }
  instance = new WebAssembly.Instance(wasmModule, imports);
  return {
    exports: instance.exports, journal,
    forkCalls: () => forkCalls,
    commits: () => commits,
    consumed: () => consumed,
  };
}

for (const input of [0, 1, 2]) {
  const payload = (input === 1 ? 21 : 42) + input * 100;
  const normal = createRun('normal', input);
  assert.equal(normal.exports.root(input), payload + 13);
  assert.equal(normal.exports.entries.value, 1);

  const captured = createRun('capture', input);
  assert.throws(
    () => captured.exports.root(input),
    error => error instanceof WebAssembly.Exception && error.is(captured.exports.unwind_tag),
  );
  assert.equal(captured.commits(), 1);
  captured.exports.wpk_fork_unwind_end();
  const fresh = createRun('rewind', input, captured.journal);
  new Uint8Array(fresh.exports.memory.buffer).set(new Uint8Array(captured.exports.memory.buffer));
  fresh.exports.wpk_fork_rewind_begin(descriptor);
  assert.equal(fresh.exports.resume_root(), payload);
  assert.equal(fresh.exports.entries.value, 1, 'rewind skips pre-catch side effects');
  assert.equal(fresh.forkCalls(), 1);
  assert.equal(fresh.consumed(), 1);
  assert.equal(fresh.exports.wpk_fork_state(), 0);
  assert.equal(Number(fresh.exports.sp.value), 65536);

  const aborted = createRun('abort', input);
  assert.equal(aborted.exports.root(input), payload - 1);
  assert.equal(aborted.exports.entries.value, 1);
  assert.equal(aborted.commits(), 0);
  assert.equal(aborted.consumed(), 0, 'live restart keeps the existing catch state');
  assert.equal(aborted.forkCalls(), 2);
  assert.equal(aborted.exports.wpk_fork_state(), 0);

  const corrupt = createRun('rewind', input, captured.journal);
  new Uint8Array(corrupt.exports.memory.buffer).set(new Uint8Array(captured.exports.memory.buffer));
  new DataView(corrupt.exports.memory.buffer).setUint32(frameAddress + 8, 999, true);
  corrupt.exports.wpk_fork_rewind_begin(descriptor);
  assert.throws(() => corrupt.exports.resume_root(), WebAssembly.RuntimeError);
  assert.equal(corrupt.forkCalls(), 0, 'invalid selectors trap before user continuation');
}
