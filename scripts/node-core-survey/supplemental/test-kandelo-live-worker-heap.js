'use strict';

const common = require('../common');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { isMainThread, parentPort, Worker } = require('node:worker_threads');

if (isMainThread) {
  async function observe() {
    const worker = new Worker(__filename);
    try {
      const [ready] = await once(worker, 'message');
      assert.equal(ready, 'ready');
      const before = await worker.getHeapStatistics();
      const allocated = once(worker, 'message');
      worker.postMessage('allocate');
      assert.deepEqual(await allocated, [100000]);
      const after = await worker.getHeapStatistics();
      assert.ok(before.used_heap_size > 0);
      assert.ok(after.used_heap_size > before.used_heap_size);
      const completed = once(worker, 'exit');
      worker.postMessage('release');
      const [code] = await completed;
      assert.equal(code, 0);
      await assert.rejects(worker.getHeapStatistics(), { code: 'ERR_WORKER_NOT_RUNNING' });
      console.log(JSON.stringify({ before: before.used_heap_size, after: after.used_heap_size, code }));
    } finally {
      await worker.terminate();
    }
  }
  observe().then(common.mustCall());
} else {
  parentPort.once('message', common.mustCall((command) => {
    assert.equal(command, 'allocate');
    const retained = Array.from({ length: 100000 }, (_, index) => ({ index, next: index + 1 }));
    parentPort.once('message', common.mustCall((message) => {
      assert.equal(message, 'release');
      assert.equal(retained[retained.length - 1].next, retained.length);
      parentPort.close();
    }));
    parentPort.postMessage(retained.length);
  }));
  parentPort.postMessage('ready');
}
