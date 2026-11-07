'use strict';
// The production adapter object is evaluated verbatim. A recording native
// boundary checks only registration/argument/result wiring, not JSAPI behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const source = fs.readFileSync(path.join(root,
  'packages/registry/spidermonkey/node-compat/adapter.js'), 'utf8');
const start = source.indexOf('    const _nodeNative = {');
const end = source.indexOf('\n\n    const entryPath =', start);
const helperStart = source.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;');
const helperEnd = source.indexOf('    // The deadline heap owns', helperStart);
assert(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart);
const names = ['socketOwnerAdopt', 'socketOwnerConnect', 'socketOwnerCancelConnect',
  'socketOwnerRefConnect', 'socketOwnerOfConnect', 'socketOwnerAbortAdoption',
  'socketOwnerCommitAdoption'];
const native = {}, calls = [];
for (const name of names) native[name] = function(...args) {
  const result = { name, args };
  calls.push(result);
  return result;
};
const actual = Function('native', 'workerEnvironment',
  source.slice(helperStart, helperEnd) + source.slice(start, end) + '\nreturn _nodeNative;')(native, null);
const owner = {}, callback = () => {};
const args = {
  socketOwnerAdopt: [17], socketOwnerConnect: ['127.0.0.1', 80, 4, undefined, 0, callback],
  socketOwnerCancelConnect: [owner], socketOwnerRefConnect: [owner, false],
  socketOwnerOfConnect: [owner], socketOwnerAbortAdoption: [owner],
  socketOwnerCommitAdoption: [owner],
};
for (const name of names) {
  assert.equal(typeof actual[name], 'function', 'Production adapter must forward ' + name);
  const result = Reflect.apply(actual[name], actual, args[name]);
  assert.equal(result, calls.at(-1));
  assert.deepEqual(result, { name, args: args[name] });
}
console.log(JSON.stringify({passed:true, methods:names,
  boundary:'verbatim production adapter forwarding over explicit recording native boundary; no JSAPI execution'}));
