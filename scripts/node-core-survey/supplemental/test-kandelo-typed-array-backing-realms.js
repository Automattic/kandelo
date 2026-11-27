// Flags: --expose-internals
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { isMainThread, parentPort, Worker } = require('node:worker_threads');
const { internalBinding } = require('internal/test/binding');
const { arrayBufferViewHasBuffer } = internalBinding('util');

function verify(hasBuffer, check) {
  for (const size of [0, 63, 64, 65, 96, 97, 1024]) {
    for (const view of [
      new Uint8Array(size),
      Uint8Array.from({ length: size }),
      new Uint8Array(new Uint8Array(size)),
    ]) {
      check.equal(hasBuffer(view), size > 64, 'implicit backing at ' + size);
      if (size) view[0] = 31;
      const backing = view.buffer;
      check.equal(hasBuffer(view), true);
      check.equal(view.buffer, backing);
      if (size) check.equal(new Uint8Array(backing)[0], 31);
    }
    const supplied = new ArrayBuffer(size);
    const explicit = new Uint8Array(supplied);
    check.equal(hasBuffer(explicit), true);
    check.equal(explicit.buffer, supplied);
  }
}

verify(arrayBufferViewHasBuffer, assert);
if (isMainThread) {
  vm.runInNewContext('(' + verify.toString() + ')(hasBuffer, check)',
                     { hasBuffer: arrayBufferViewHasBuffer, check: assert });
  const worker = new Worker(__filename);
  let received = false;
  worker.on('message', (value) => { assert.equal(value, 'verified'); received = true; });
  worker.on('exit', (code) => { assert.equal(code, 0); assert.ok(received); });
} else {
  parentPort.postMessage('verified');
}
