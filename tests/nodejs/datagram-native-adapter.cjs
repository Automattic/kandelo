'use strict';
// Actual production _nodeNative object with an explicit native call dependency.
// This checks forwarding only; it does not instantiate the guest engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2] || path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root,
  'packages/registry/spidermonkey/node-compat/adapter.js'), 'utf8');
const start = source.indexOf('    const _nodeNative = {');
const end = source.indexOf('\n\n    const entryPath =', start);
const helperStart = source.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;');
const helperEnd = source.indexOf('    // The deadline heap owns', helperStart);
assert(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart);
const expected = {};
const args = ['send', {}, {}, [], null, 0, 2, true, 4];
let calls = 0;
const native = { udp(...values) {
  assert.equal(this, native); assert.deepEqual(values, args); ++calls; return expected;
} };
const actual = Function('native', 'workerEnvironment',
  source.slice(helperStart, helperEnd) + source.slice(start, end) + '\nreturn _nodeNative;')(native, null);
assert.equal(typeof actual.udp, 'function', 'Actual shared adapter must forward the native UDP owner');
assert.equal(actual.udp(...args), expected); assert.equal(calls, 1);
const error = new Error('native failure'); native.udp = () => { throw error; };
assert.throws(() => actual.udp(...args), value => value === error);
console.log('PASS actual production _nodeNative.udp arguments, receiver, return and exception forwarding; no guest JSAPI proof');
