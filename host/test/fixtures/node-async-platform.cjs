'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const nativeAsync = require('node:async_hooks');
const util = require('node:util');
const os = require('node:os');
const root = resolve(__dirname, '../../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('third_party/node-core/sources.json'));
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing actual async source boundary');
  return source.slice(a, b);
}
function pinned(path, sha256) {
  const source = read('third_party/node-core/' + path);
  if (createHash('sha256').update(source).digest('hex') !== sha256)
    throw Error('Async source identity mismatch: ' + path);
  return source;
}
const publicSource = pinned('upstream/async/lib/async_hooks.js',
  '19669397a9b2ece553eacde7a9be2a50df82e0528b6b1fe8cb01bc83e9d9b550');
pinned('upstream/async/lib/internal/async_hooks.js',
  'cd790a1bd161d5979d15c7a250fc540931e6170ffb06948b76acb77a8ea28533');
function hookSource() {
  let source = section(publicSource, 'class AsyncHook {', '// Embedder API //');
  // Node's count array is aliased native memory. This adapter has an explicit
  // destroy-tracking setter, so publish both completed registry mutations.
  for (const anchor of ['      updatePromiseHookMode();\n    }', '      disableHooks();\n    }']) {
    if (source.split(anchor).length !== 2) throw Error('Review AsyncHook native count boundary');
    source = source.replace(anchor, anchor + '\n\n    syncDestroyTracking();');
  }
  return source;
}
const core = read('third_party/node-core/node-core.js');
const { makeValues, make } = Function(core +
  ';return { makeValues: _createNodeValuesPlatform, make: _createNodeAsyncPlatform };')();
const values = makeValues({ process, Buffer, util, inspection: util, os,
  signals: os.constants.signals, getDOMException: () => DOMException });
let source = read('third_party/node-core/async-platform-adapter.js');
const factories = Object.entries(manifest.asyncPlatform).map(([name, entry]) =>
  JSON.stringify(name) + ': function(module, exports, require, primordials, internalBinding) {\n' +
  pinned(entry.path, entry.sha256) + '\n}').join(',\n');
const providerExpression = section(core, 'asyncWrapProviders:', '    };')
  .slice('asyncWrapProviders:'.length).trim().replace(/,$/, '');
const providerBody = section(providerExpression, 'ObjectCreate(null), {', '        }')
  .slice('ObjectCreate(null), {'.length).trim();
source = source.replace('/* NODE_ASYNC_MODULES */', factories)
  .replace('/* NODE_ASYNC_HOOK */', hookSource())
  .replace('/* NODE_ASYNC_RESOURCE */', pinned(manifest.asyncResource.path, manifest.asyncResource.sha256))
  .replace('/* NODE_ASYNC_PROVIDER_MAP */', providerBody);
const tick = manifest.tickObject;
if (!tick) throw Error('Missing pinned TickObject identity');
source = source.replace('/* NODE_TICK_OBJECT */', pinned(tick.path, tick.sha256));
if (!core.includes(source.slice(0, source.indexOf('// Keep the pinned'))))
  throw Error('Generated async adapter differs from its exact pinned source assembly');

// Actual Node ALS and AsyncResources are the native dependency boundary here.
// The subject's own hook registry, public classes, symbols and dispatch run
// unmodified except for the explicit native-count publication above. This is
// neither a guest JSAPI/GC control nor a Promise activation-mode control.
function createAsyncPlatformControl({ defaultTrigger } = {}) {
  const state = new nativeAsync.AsyncLocalStorage();
  const allocated = new Map(), records = new WeakMap(), driverResources = new Map();
  let lifecycle, nativeHook, priorDriverState;
  const destroyTrackingChanges = [];
  // Explicit test-only execution bridge for registry/public class controls.
  // This array is NOT the production native owner. The independently compiled
  // callback-recovery owner controls validate that portable C++ implementation.
  const execution = [];

  const native = {
    pushAsyncExecution(id, triggerId, resource) {
      execution.push({ id, triggerId, resource, prior: state.getStore() });
    },
    popAsyncExecution(id) {
      if (!execution.length) return undefined;
      const entry = execution[execution.length - 1];
      if (entry.id !== id) throw Error('Fixture async execution ID mismatch');
      execution.pop(); return entry.prior;
    },
    clearAsyncExecution() { execution.length = 0; state.enterWith(undefined); },
    executionAsyncId: () => execution[execution.length - 1]?.id ?? 0,
    triggerAsyncId: () => execution[execution.length - 1]?.triggerId ?? 0,
    executionAsyncResource: () => execution[execution.length - 1]?.resource,
    hasAsyncExecution: () => execution.length > 0,
    getAsyncContext: () => state.getStore(),
    // Ordinary registry controls only need the current execution default.
    // Override controls inject the compiled native owner, never a JS duplicate.
    getDefaultTriggerAsyncId: () => defaultTrigger ?
      defaultTrigger.resolve(execution[execution.length - 1]?.id ?? 0) : execution[execution.length - 1]?.id ?? 0,
    swapDefaultTriggerAsyncId(value) {
      if (!defaultTrigger) throw Error('Native default-trigger owner was not supplied');
      return defaultTrigger.swap(value);
    },
    setAsyncContext: value => state.enterWith(value),
    allocateAsyncId() {
      const owner = new nativeAsync.AsyncResource('CandidateIdAllocator', { requireManualDestroy: true });
      allocated.set(owner.asyncId(), owner);
      return owner.asyncId();
    },
    getAsyncResourceInfo(resource) {
      const record = records.get(resource);
      if (!record) throw Error('No real native async resource information');
      return record;
    },
    isPromise: util.types.isPromise,
    setAsyncLifecycle(callback) {
      lifecycle = callback;
      nativeHook = nativeAsync.createHook({
        init(id, type, triggerId, resource) {
          if (type !== 'AsyncHookControl') return;
          records.set(resource, [id, triggerId, undefined, type]);
          driverResources.set(id, resource);
          lifecycle('native:init', resource);
        },
        before(id) {
          const resource = driverResources.get(id);
          if (!resource) return;
          priorDriverState = state.getStore();
          lifecycle('before', resource, priorDriverState?.frame);
        },
        after(id) {
          const resource = driverResources.get(id);
          if (!resource) return;
          lifecycle('after', resource);
          state.enterWith(priorDriverState);
        },
        destroy(id) { driverResources.delete(id); },
      }).enable();
    },
    setAsyncDestroyTracking(enabled) {
      destroyTrackingChanges.push(enabled);
      // Node owns its real native destroy queue; this fixture does not assert
      // the guest's construction-time GC tracking or destroy delivery.
    },
    enqueueAsyncDestroyId(id) {
      const owner = allocated.get(id);
      if (!owner) throw Error('No actual native lifetime for candidate ID');
      owner.emitDestroy();
    },
    drainNativeAsyncDestroyIds() { throw Error('Guest numeric destroy queue is outside this control'); },
    asyncHookFatal(error) { throw error; },
  };
  const platform = make({ native, values, process });
  return {
    ...platform,
    destroyTrackingChanges,
    runNative(callback) {
      const resource = new nativeAsync.AsyncResource('AsyncHookControl', { requireManualDestroy: true });
      try { return resource.runInAsyncScope(callback); }
      finally { resource.emitDestroy(); }
    },
    close() {
      nativeHook.disable();
      for (const owner of allocated.values()) owner.emitDestroy();
      allocated.clear();
      state.disable();
    },
  };
}
module.exports = { createAsyncPlatformControl, hookSource, section };
