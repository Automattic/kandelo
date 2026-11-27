// Flags: --experimental-stream-iter --expose-gc
'use strict';
const common = require('../common');
const assert = require('node:assert/strict');
const { broadcast } = require('node:stream/iter');
const { getHeapStatistics } = require('node:v8');

function collectedHeap() {
  global.gc();
  return getHeapStatistics().used_heap_size;
}

// The measurement must respond to live JS objects and to releasing them.
function checkHeapCounter() {
  const baseline = collectedHeap();
  let held = Array.from({ length: 65536 }, (_, index) => ({ index }));
  const live = collectedHeap();
  assert.equal(held.at(-1).index, 65535);
  assert.ok(live - baseline > 512 * 1024, JSON.stringify({ baseline, live }));
  held = undefined;
  const released = collectedHeap();
  assert.ok(live - released > 512 * 1024, JSON.stringify({ live, released }));
}

async function detachConsumers(shared, count) {
  for (let index = 0; index < count; index++) {
    const iterator = shared.push()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return();
    await pending;
  }
}

async function main() {
  checkHeapCounter();
  const { broadcast: shared } = broadcast();
  await detachConsumers(shared, 100);
  const before = collectedHeap();
  await detachConsumers(shared, 50000);
  const after = collectedHeap();
  assert.ok(after - before < 8 * 1024 * 1024, JSON.stringify({ before, after }));
  assert.equal(shared.consumerCount, 0);
  shared.cancel();
}
main().then(common.mustCall());
