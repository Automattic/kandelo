'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
// That native testing helper installs two globals. Restore only its exact
// component setup effects so unchanged upstream leak assertions remain intact.
const saved = new Map(['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
const { internalBinding } = require('internal/test/binding');
for (const [name, descriptor] of saved) {
  if (descriptor === undefined) delete globalThis[name];
  else Object.defineProperty(globalThis,name,descriptor);
}
module.exports = function createCandidate(root) {
  const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
  const factories = Function(bundle + ';return {_createNodeTestingPlatform,_createNodeTestOptionReader,_createNodeGlobPlatform,_createNodeESMGraphPlatform};')();
  const values = { errors: require('internal/errors'), validators: require('internal/validators'),
    util: require('internal/util'), require };
  const glob = factories._createNodeGlobPlatform({ fs, path, process, values,
    dirents: require('internal/fs/utils'), toPathIfFileURL: require('internal/url').toPathIfFileURL });
  const graph = factories._createNodeESMGraphPlatform({
    records: { Module }, values, native: { importModule: identifier => import(identifier) },
    url: require('node:url'), types: require('node:util').types,
  });
  const candidate = factories._createNodeTestingPlatform({
    process, values, assert: require('node:assert'), comparisons: require('internal/util/comparisons'),
    types: require('node:util').types, inspection: require('internal/util/inspect'),
    eventTarget: require('internal/event_target'), assertUtils: require('internal/assert/utils'),
    getCallerLocation: internalBinding('util').getCallerLocation,
    getStructuredStack: internalBinding('util').getStructuredStack,
    getModuleResolver: require('internal/modules/esm/loader').getOrInitializeCascadedLoader,
    importModule: (specifier, parentURL, attributes) => graph.importURL(specifier, attributes),
    glob: glob.require('internal/fs/glob'), console,
    events: require('node:events'), abort: require('internal/abort_controller'), async: require('node:async_hooks'),
    timers: require('node:timers'), timerPromises: require('node:timers/promises'),
    path, fs, fsUtils: require('internal/fs/utils'), os: require('node:os'),
    url: require('internal/url'), Module, vm: require('node:vm'),
    diagnostics: require('node:diagnostics_channel'), queueMicrotask,
    stream: require('node:stream'), streamRequire: require,
    getOptionValue: factories._createNodeTestOptionReader({ cliOptions: {} }),
  });
  // This is an explicit native component import dependency, not guest code or
  // a native-host production fallback. Actual fixture modules register tests
  // with candidate API, then its actual tree emits every observed outcome.
  const key = Symbol.for('kandelo.testing.runner.component.api');
  globalThis[key] = candidate.api;
  Module.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'node:test' || specifier === 'test')
        return { url: 'kandelo-component:test', shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === 'kandelo-component:test') return { format: 'module', shortCircuit: true,
        source: `const api=globalThis[Symbol.for('kandelo.testing.runner.component.api')];export default api;${['test','suite','describe','it','run','before','after','beforeEach','afterEach','getTestContext'].map(k=>`export const ${k}=api.${k};`).join('')}` };
      return next(url, context);
    },
  });
  return { ...candidate, graph, glob };
};
