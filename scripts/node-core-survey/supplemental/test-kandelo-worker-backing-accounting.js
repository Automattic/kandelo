// Flags: --expose-gc
'use strict';

const common = require('../common');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { getHeapStatistics } = require('node:v8');
const { isMainThread, parentPort, Worker } = require('node:worker_threads');

const size = 8 * 1024 * 1024;

function externalBytes() {
  global.gc();
  return getHeapStatistics().external_memory;
}

if (isMainThread) {
  async function observe() {
    const worker = new Worker(__filename);
    try {
      const [workerBefore] = await once(worker, 'message');
      const before = externalBytes();
      const buffer = new ArrayBuffer(size);
      const bytes = new Uint8Array(buffer);
      bytes[0] = 17;
      bytes[size - 1] = 91;
      const allocated = externalBytes();

      const received = once(worker, 'message');
      worker.postMessage(buffer, [buffer]);
      assert.equal(buffer.byteLength, 0);
      const [workerOwned] = await received;
      const transferred = externalBytes();

      const returned = once(worker, 'message');
      const ended = once(worker, 'exit');
      worker.postMessage('return');
      const [back] = await returned;
      const reacquired = externalBytes();
      assert.equal(back.byteLength, size);
      assert.equal(new Uint8Array(back)[0], 17);
      assert.equal(new Uint8Array(back)[size - 1], 92);
      assert.deepEqual(await ended, [0]);
      console.log(JSON.stringify({ size, before, allocated, transferred, reacquired,
                                   workerBefore, workerOwned }));
      // Other external allocations can vary independently in each isolate.
      for (const held of [allocated, workerOwned, reacquired]) assert.ok(held >= size);
      assert.ok(allocated > before);
      assert.ok(workerOwned > workerBefore);
      assert.ok(transferred < allocated);
      assert.ok(reacquired > transferred);
    } finally {
      await worker.terminate();
    }
  }
  observe().then(common.mustCall());
} else {
  parentPort.once('message', common.mustCall((buffer) => {
    const bytes = new Uint8Array(buffer);
    assert.equal(bytes.length, size);
    assert.equal(bytes[0], 17);
    assert.equal(bytes[size - 1], 91);
    bytes[size - 1]++;
    parentPort.once('message', common.mustCall((command) => {
      assert.equal(command, 'return');
      parentPort.postMessage(buffer, [buffer]);
      assert.equal(buffer.byteLength, 0);
      parentPort.close();
    }));
    parentPort.postMessage(externalBytes());
  }));
  parentPort.postMessage(externalBytes());
}
