// Exercise the linked-frame ABI without the kernel. The journal records
// reserve/commit/consume ordering; resume-table entries deliberately allow
// replay to reach a different child from the lexical call target.
const fs = require('node:fs');
const assert = require('node:assert/strict');

const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const memory64 = process.argv[2] === '1';
const frameSizes = process.argv[3].split(',').map(Number);
const pointer = value => memory64 ? BigInt(value) : value;
const descriptor = pointer(512);

function createRun(failAt = 0) {
  let instance;
  let mode = 'normal';
  let capture = true;
  let reservations = 0;
  let pendingReplay = [];
  const committed = [];
  const pendingCommits = new Map();
  const events = [];
  const trace = [];

  const readHeader = (address, offset = 0) => {
    const memory = new DataView(instance.exports.memory.buffer);
    return memory.getUint32(Number(address) + offset, true);
  };
  const callbacks = {
    __wpk_fork_frame_reserve: size => {
      reservations++;
      events.push(['reserve', Number(size)]);
      if (reservations === failAt) {
        mode = 'abort';
        pendingReplay = committed.slice().reverse();
        instance.exports.wpk_fork_abort_begin(descriptor);
        return pointer(0);
      }
      const address = 8192 + reservations * 1024;
      pendingCommits.set(address, Number(size));
      return pointer(address);
    },
    __wpk_fork_frame_commit: address => {
      address = Number(address);
      assert(pendingCommits.has(address));
      const functionOrdinal = readHeader(address);
      const size = pendingCommits.get(address);
      assert.equal(size, frameSizes[functionOrdinal - 1]);
      assert.equal(readHeader(address, 8), 0, 'no catch payload');
      assert.equal(readHeader(address, 12), 0, 'no reference vector');
      committed.push({ address, size, functionOrdinal });
      pendingCommits.delete(address);
      events.push(['commit', functionOrdinal, readHeader(address, 4)]);
    },
    __wpk_fork_frame_next: size => {
      const frame = pendingReplay.shift();
      assert(frame, 'no frame to consume');
      assert.equal(Number(size), frame.size);
      events.push(['next', frame.functionOrdinal]);
      return pointer(frame.address);
    },
    __wpk_fork_frame_peek: size => {
      assert(pendingReplay.length);
      assert.equal(Number(size), pendingReplay[0].size);
      return pointer(pendingReplay[0].address);
    },
    __wpk_fork_resume_peek: () => pendingReplay.length ? pendingReplay[0].functionOrdinal : 0,
  };
  const imports = {
    h: {
      fork: ordinal => {
        trace.push(ordinal);
        if (mode === 'rewind') {
          instance.exports.wpk_fork_rewind_end();
          mode = 'normal';
          return 0;
        }
        if (mode === 'abort') {
          instance.exports.wpk_fork_abort_end();
          mode = 'normal';
          return -1;
        }
        if (capture) {
          capture = false;
          mode = 'capture';
          instance.exports.wpk_fork_unwind_begin(descriptor);
          return -999;
        }
        return ordinal + 10;
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
      namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 8 });
    } else {
      throw new Error(`Unexpected test import: ${entry.module}.${entry.name}`);
    }
  }
  for (const name of Object.keys(callbacks)) {
    assert(WebAssembly.Module.imports(wasmModule).some(entry => entry.name === name), name);
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
    exports, events, trace, committed,
    disableCapture() { capture = false; },
    rewind() {
      mode = 'rewind';
      pendingReplay = committed.slice().reverse();
      exports.wpk_fork_unwind_end();
      exports.wpk_fork_rewind_begin(descriptor);
    },
    routeThroughSecondRootCall() {
      const root = committed.find(frame => frame.functionOrdinal === 2);
      const memory = new DataView(exports.memory.buffer);
      memory.setUint32(root.address + 4, 1, true);
      memory.setUint32(root.address + 20, 7, true); // carryover for the second call
    },
  };
}

function consumedOrdinals(run) {
  return run.events.filter(event => event[0] === 'next').map(event => event[1]);
}

function checkNormalExecution() {
  const run = createRun();
  run.disableCapture();
  assert.equal(run.exports.root(3), 28);
  assert.deepEqual(run.trace, [3, 2]);
  assert.equal(run.exports.counter.value, 2);
  assert.equal(Number(run.exports.sp.value), 65536);
}

function checkCaptureAndRewind(input) {
  const run = createRun();
  const exports = run.exports;
  assert.throws(
    () => exports.root(input),
    error => error instanceof WebAssembly.Exception && error.is(exports.unwind_tag),
  );
  assert.equal(exports.wpk_fork_state(), 1);
  assert.deepEqual(run.committed.map(frame => frame.functionOrdinal), [1, 2]);
  assert.deepEqual(
    run.events.filter(event => event[0] === 'commit').map(event => event.slice(1)),
    [[1, input ? 0 : 1], [2, 0]],
  );
  assert.equal(Number(exports.sp.value), 65536);
  run.rewind();
  assert.equal(exports.resume_root(), input + 12);
  assert.equal(exports.wpk_fork_state(), 0);
  assert.equal(exports.counter.value, 2);
  assert.deepEqual(consumedOrdinals(run), [2, 1]);
  assert.deepEqual(run.trace, [input ? 3 : 4, input ? 3 : 4, 2]);
}

function checkAllocationFailure(failAt) {
  const run = createRun(failAt);
  assert.equal(run.exports.root(3), 14);
  assert.equal(run.exports.wpk_fork_state(), 0);
  assert.equal(Number(run.exports.sp.value), 65536);
  assert.equal(run.exports.counter.value, 2);
  assert.equal(run.committed.length, failAt - 1);
  assert.deepEqual(consumedOrdinals(run), failAt === 1 ? [] : [1]);
}

function checkNonlexicalResume() {
  const run = createRun();
  assert.throws(() => run.exports.root(3), error => error instanceof WebAssembly.Exception);
  run.routeThroughSecondRootCall();
  run.rewind();
  assert.equal(run.exports.resume_root(), 10);
  assert.deepEqual(run.trace, [3, 3]);
  assert.deepEqual(consumedOrdinals(run), [2, 1]);
  assert.equal(run.exports.counter.value, 1);
}

checkNormalExecution();
for (const input of [0, 3]) checkCaptureAndRewind(input);
for (const failAt of [1, 2]) checkAllocationFailure(failAt);
checkNonlexicalResume();
