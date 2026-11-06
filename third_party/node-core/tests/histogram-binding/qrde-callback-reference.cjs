'use strict';
// Exact Node reference for InternalCallbackScope{0,0}; the N-API fixture is
// deliberately not used as proof of SpiderMonkey embedding callback semantics.
const assert = require('node:assert/strict');
const { createHook, AsyncLocalStorage, executionAsyncId, triggerAsyncId, executionAsyncResource } = require('node:async_hooks');
const { createHistogram } = require('node:perf_hooks');
const als = new AsyncLocalStorage(), promises = new Map(), trace = [];
let target;
const hook = createHook({
  init(id, type, trigger, resource) { if (type === 'PROMISE') promises.set(id, resource); },
  promiseResolve(id) {
    if (promises.get(id) !== target) return;
    trace.push({ event: 'resolve', execution: executionAsyncId(), trigger: triggerAsyncId(),
      store: als.getStore() ?? null, resource: executionAsyncResource().constructor.name });
    process.nextTick(() => trace.push({ event: 'tick', store: als.getStore() ?? null }));
    queueMicrotask(() => trace.push({ event: 'microtask', store: als.getStore() ?? null }));
  },
}).enable();
const h = createHistogram(); h.record(2); h.record(4); h.record(6);
als.run('submitter', () => { target = h.qrde({ bins: 2, cache: true }); });
target.then(() => { trace.push({ event: 'reaction', store: als.getStore() ?? null }); queueMicrotask(finish); });
function finish() {
  hook.disable();
  assert.deepEqual(trace[0], { event: 'resolve', execution: 0, trigger: 0, store: null, resource: 'Object' });
  assert.deepEqual(trace.slice(1).map(x => x.event), ['tick', 'microtask', 'reaction']);
  assert(trace.every(x => x.store === null));
  console.log(JSON.stringify({ node: process.version, trace }));
}
