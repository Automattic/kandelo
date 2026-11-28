'use strict';

const common = require('../common');
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread) {
  const state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(__filename, { workerData: state });

  assert.strictEqual(Atomics.wait(state, 0, 0, 10000), 'ok');

  worker.once('message', common.mustCall((message) => {
    assert.strictEqual(message, 'waiting');
    const wakeWorker = setInterval(() => {
      if (Atomics.notify(state, 1, 1) === 1) clearInterval(wakeWorker);
    }, 1);
    worker.once('exit', () => clearInterval(wakeWorker));
  }));

  worker.once('exit', common.mustCall((code) => {
    assert.strictEqual(code, 0);
  }));
} else {
  const wakeMain = setInterval(() => {
    if (Atomics.notify(workerData, 0, 1) !== 1) return;
    clearInterval(wakeMain);
    parentPort.postMessage('waiting');
    assert.strictEqual(Atomics.wait(workerData, 1, 0, 10000), 'ok');
  }, 1);
}
