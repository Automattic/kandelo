'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { primordials } = require('internal/test/binding');
const root = path.resolve(__dirname, '../..');
const native = require(process.env.HISTOGRAM_BINDING_ADDON);
const reference = fs.readFileSync(path.join(root, 'upstream/histogram-reference/lib/internal/histogram.js'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'histogram-platform-adapter.js'), 'utf8');
assert.equal(adapter.split('/* NODE_HISTOGRAM_PUBLIC_WRAPPER */').length, 2);
const factory = vm.runInThisContext(`(function(_createNodePrimordials) {
  ${adapter.replace('/* NODE_HISTOGRAM_PUBLIC_WRAPPER */', reference)}
  return _createNodeHistogramPlatform;
})`)(() => primordials);
const candidate = factory({ native,
  values: { errors: require('internal/errors'), validators: require('internal/validators'), util: require('internal/util') },
  types: require('internal/util/types'), util: require('node:util'),
  cloneProtocol: require('internal/worker/js_transferable'),
});
async function controls() {
  // The same native differential fixture observes the complete public wrapper
  // over the real portable owner. Only transport is substituted: N-API does
  // not implement the proposed SpiderMonkey clone callbacks.
  let fixture = fs.readFileSync(path.join(root, 'tests/histogram/native-control.js'), 'utf8');
  fixture = fixture.replace("import { createHistogram, createSlidingWindowHistogram, importHistogram } from 'node:perf_hooks';",
    'const { createHistogram, createSlidingWindowHistogram, importHistogram } = candidate;');
  fixture = fixture.replace('sharedClone = structuredClone(shared)',
    'sharedClone = new candidate.ClonedRecordableHistogram(native.histogramOperation("share", shared[candidate.kHandle]).value)');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  // Await the same main function so QRDE jobs and all output have completed.
  fixture = fixture.replace('main().catch(e => { console.error(e); process.exitCode = 1; });', 'await main();');
  await new AsyncFunction('candidate', 'native', 'Buffer', 'process', fixture)(candidate, native, Buffer, process);
  const edges = await require('./edge-controls.cjs')(candidate);
  fs.writeFileSync(path.join(process.env.HISTOGRAM_BINDING_OUT, 'edges.json'), JSON.stringify(edges, null, 2) + '\n');
}
controls().catch(error => { console.error(error); process.exitCode = 1; });
