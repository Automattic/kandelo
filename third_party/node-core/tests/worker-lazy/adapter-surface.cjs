'use strict';
// Exercise the actual shared adapter forwarding, with a genuine native lazy
// reference and portable manager supplied explicitly by the component control.
// Other adapter methods are not executed; this is not guest JSAPI validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = function nativeSurface(native) {
  const root = path.resolve(__dirname, '../../../..');
  const source = fs.readFileSync(path.join(root,
    'packages/registry/spidermonkey/node-compat/adapter.js'), 'utf8');
  const start = source.indexOf('    const _nodeNative = {');
  const end = source.indexOf('\n\n    const entryPath =', start);
  const helperStart = source.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;');
  const helperEnd = source.indexOf('    // The deadline heap owns', helperStart);
  assert(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart);
  const actual = Function('native', 'workerEnvironment',
    source.slice(helperStart, helperEnd) + source.slice(start, end) + '\nreturn _nodeNative;')(native, null);
  assert.equal(typeof actual.defineNativeLazyDataProperty, 'function',
    'Actual shared adapter must forward the native lazy data owner');
  return actual;
};
