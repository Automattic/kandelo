'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

function verify(expected) {
  const proto = ArrayBuffer.prototype;
  for (const name of ['immutable', 'sliceToImmutable', 'transferToImmutable']) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    assert.equal(Boolean(descriptor), expected, name);
    if (!expected) continue;
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.configurable, true);
    if (name === 'immutable') {
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
    } else {
      assert.equal(typeof descriptor.value, 'function');
      assert.equal(descriptor.writable, true);
    }
  }
  if (!expected) return;
  const source = new Uint8Array([1, 2, 3]);
  const slice = source.buffer.sliceToImmutable(1);
  source[1] = 9;
  assert.equal(slice.immutable, true);
  assert.equal(new Uint8Array(slice).join(), "2,3");
  assert.equal(source.buffer.immutable, false);
  const immutable = source.buffer.transferToImmutable();
  assert.equal(source.buffer.detached, true);
  assert.equal(new Uint8Array(immutable).join(), "1,9,3");
  assert.throws(() => new DataView(immutable).setUint8(0, 7), TypeError);
  assert.throws(() => new Uint8Array(immutable).set([7]), TypeError);
}

if (!isMainThread) {
  verify(workerData);
  parentPort.postMessage('verified');
} else {
  const expected = false;
  verify(expected);
  // Supply the host assert library but compare exceptions with the tested realm's TypeError.
  vm.runInNewContext('(' + verify.toString() + ')(' + expected + ')', { assert });
  const worker = new Worker(__filename, { workerData: expected });
  let received = false;
  worker.on('message', (message) => { assert.equal(message, 'verified'); received = true; });
  worker.on('exit', (code) => { assert.equal(code, 0); assert.ok(received); console.log('verified'); });
}
