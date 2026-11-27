// Flags: --expose-gc
'use strict';
const common = require('../common');
const assert = require('node:assert/strict');

function absentFunction() {}
async function capture() {
  await Promise.resolve();
  const error = new Error('captured');
  const skipped = {};
  Error.captureStackTrace(skipped, absentFunction);
  return { error, skipped };
}
async function caller() { return await capture(); }

async function main() {
  for (const limit of [0, 1, 2, 8]) {
    Error.stackTraceLimit = limit;
    const { error, skipped } = await caller();
    // Defer formatting until the promise jobs which produced the error retired.
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
    Error.prepareStackTrace = (_, frames) => frames;
    const frames = error.stack;
    assert.ok(frames.length <= limit);
    assert.deepEqual(skipped.stack, []);
    if (limit >= 1) {
      assert.equal(frames[0].getFunctionName(), 'capture');
      assert.equal(frames[0].isAsync(), false);
    }
    if (limit >= 2) {
      const frame = frames[1];
      assert.equal(frame.isAsync(), true);
      assert.equal(frame.getFunctionName(), 'caller');
      assert.equal(frame.getFileName(), __filename);
      assert.equal(frame.getLineNumber(), 14);
      assert.match(frame.toString(), /^async caller \(/);
    }
  }

  // Two independent waiters on one promise do not establish a unique caller.
  async function raise(gate) {
    await gate;
    throw new Error('multiple reactions');
  }
  async function left(value) { return await value; }
  async function right(value) { return await value; }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = raise(gate);
  const outcomes = Promise.allSettled([left(pending), right(pending)]);
  release();
  const [a, b] = await outcomes;
  assert.equal(a.reason, b.reason);
  assert.equal(a.status, 'rejected');
  assert.deepEqual(a.reason.stack.map((frame) => frame.getFunctionName()), ['raise']);
}
main().then(common.mustCall());
