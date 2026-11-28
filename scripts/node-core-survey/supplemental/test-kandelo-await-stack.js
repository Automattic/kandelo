'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

async function leaf() {
  await Promise.resolve();
  throw new Error('await stack');
}
async function awaitingCaller() {
  return await leaf();
}
async function detachedCaller() {
  return leaf();
}
async function filesystemCaller() {
  return await fs.access(__filename + '.missing');
}
function synchronousCaller() {
  throw new Error('sync stack');
}

async function inspect(action, structured) {
  const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  try {
    if (structured) {
      Error.prepareStackTrace = (_, frames) => frames.map((frame) => {
        let asyncFrame;
        try {
          asyncFrame = frame.isAsync();
        } catch (error) {
          asyncFrame = { error: error.message };
        }
        return { name: frame.getFunctionName(), asyncFrame, text: frame.toString() };
      });
    }
    try {
      await action();
    } catch (error) {
      if (action === filesystemCaller) {
        assert.equal(error.code, 'ENOENT');
        assert.equal(error.path, __filename + '.missing');
      }
      return error.stack;
    }
    assert.fail('expected rejection or throw');
  } finally {
    if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous);
    else delete Error.prepareStackTrace;
  }
}

(async function main() {
  const rows = [];
  for (const action of [synchronousCaller, awaitingCaller, detachedCaller, filesystemCaller]) {
    const stack = await inspect(action, false);
    const frames = await inspect(action, true);
    console.log(JSON.stringify({ action: action.name, stack, frames }));
    rows.push({ action, stack, frames });
  }
  // Check the observable difference between awaiting and merely returning a promise.
  for (const { action, stack, frames } of rows) {
    assert.ok(Array.isArray(frames));
    if (action === synchronousCaller) {
      assert.match(stack, /at synchronousCaller\b/);
      assert.equal(frames[0].asyncFrame, false);
    } else if (action === detachedCaller) {
      assert.doesNotMatch(stack, /at async detachedCaller\b/);
      assert.ok(!frames.some((frame) => frame.name === 'detachedCaller'));
    } else {
      assert.match(stack, new RegExp('at async ' + action.name + '\\b'));
      assert.ok(frames.some((frame) => frame.name === action.name && frame.asyncFrame === true));
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
