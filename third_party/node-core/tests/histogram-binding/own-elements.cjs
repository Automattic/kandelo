'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
let api = require('node:perf_hooks');
if (process.argv[2] === 'candidate') {
  const root = path.resolve(__dirname, '../..');
  const { primordials } = require('internal/test/binding');
  const adapter = fs.readFileSync(path.join(root, 'histogram-platform-adapter.js'), 'utf8')
    .replace('/* NODE_HISTOGRAM_PUBLIC_WRAPPER */', fs.readFileSync(path.join(root,
      'upstream/histogram-reference/lib/internal/histogram.js'), 'utf8'));
  const factory = Function('_createNodePrimordials', adapter + ';return _createNodeHistogramPlatform;')(() => primordials);
  api = factory({ native: require(process.env.HISTOGRAM_BINDING_ADDON),
    values: { errors: require('internal/errors'), validators: require('internal/validators'), util: require('internal/util') },
    types: require('internal/util/types'), util: require('node:util'), cloneProtocol: require('internal/worker/js_transferable') });
}
const a = api.createHistogram(), b = api.createHistogram();
for (const n of [2,4,6]) a.record(n);
for (const n of [3,5,7]) b.record(n);
const methods = [() => a.meanCI(), () => a.percentileCI(50), () => a.welchTest(b), () => a.mannWhitneyTest(b)];
let controls = 0;
for (const method of methods) {
  const expected = method();
  for (const mode of ['setter', 'throw', 'readonly', 'reenter']) {
    let calls = 0, actual;
    const property = mode === 'readonly' ? { value: 31337, writable: false } : {
      get() { return 31337; },
      set() { ++calls; if (mode === 'throw') throw Error('inherited setter'); if (mode === 'reenter') a.reset(); },
    };
    try {
      Object.defineProperty(Array.prototype, '0', { configurable: true, ...property });
      actual = method();
    } finally { delete Array.prototype[0]; }
    assert.equal(calls, 0); assert.deepEqual(actual, expected); assert.equal(a.count, 3);
    ++controls;
  }
}
console.log(JSON.stringify({ mode: process.argv[2] || 'native', ownElementControls: controls }));
