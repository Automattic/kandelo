// Flags: --expose-gc
'use strict';
const common = require('../common');
const assert = require('node:assert/strict');

function capture() {
  return new Error('receiver');
}
function make() {
  const receiver = { capture };
  return { weak: new WeakRef(receiver), error: receiver.capture() };
}
async function main() {
  const pending = make();
  const formatted = make();
  const overwritten = make();
  const retained = make();
  assert.equal(typeof formatted.error.stack, 'string');
  overwritten.error.stack = 'custom text';
  Error.prepareStackTrace = (_, sites) => sites;
  const site = retained.error.stack[0];
  retained.error.stack = 'keep only the call site';

  for (let i = 0; i < 12; i++) {
    await new Promise(setImmediate);
    global.gc();
    if (!formatted.weak.deref() && !overwritten.weak.deref()) break;
  }
  assert.equal(formatted.weak.deref(), undefined);
  assert.equal(overwritten.weak.deref(), undefined);
  assert.ok(pending.weak.deref());
  assert.ok(retained.weak.deref());
  assert.equal(site.getMethodName(), 'capture');
  assert.equal(pending.error.message, 'receiver');
  assert.equal(typeof formatted.error.stack, 'string');
  assert.equal(overwritten.error.stack, 'custom text');
  assert.equal(retained.error.stack, 'keep only the call site');
}
main().then(common.mustCall());
