'use strict';
// Exact pinned native internal binding reference; not a guest backend.
const assert = require('node:assert/strict');
const { internalBinding } = require('internal/test/binding');
const binding = internalBinding('module_wrap');
const { ModuleWrap } = binding;
const observations = [];
let failures = 0;
async function check(name, callback) {
  try { await callback(); observations.push({ name, status: 'pass' }); }
  catch (error) { failures++; observations.push({ name, status: 'fail', error: {
    name: error.name, message: error.message, stack: error.stack,
  } }); }
}
(async () => {
  await check('native-synthetic-callback-receiver-and-success-promise', async () => {
    let calls = 0;
    const module = new ModuleWrap('reference:success', undefined, ['value'], function() {
      calls++; assert.equal(this, module); this.setExport('value', 42);
    });
    assert.equal(module.synthetic, true); assert.equal(module.getStatus(), 0);
    assert.equal(Object.hasOwn(module, 'hasAsyncGraph'), true);
    assert.throws(() => module.hasAsyncGraph, { code: 'ERR_MODULE_NOT_INSTANTIATED' });
    module.instantiate(); const first = module.evaluate(-1, false); await first;
    assert.equal(module.evaluate(-1, false), first); assert.equal(calls, 1);
    assert.equal(module.getStatus(), 4); assert.equal(module.getNamespace().value, 42);
    assert.equal(module.hasAsyncGraph, false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(module, 'hasAsyncGraph'),
      { value: false, writable: true, enumerable: false, configurable: true });
  });
  await check('native-first-synthetic-failure-throws-then-rejects', async () => {
    let calls = 0;
    const sentinel = { identity: 'original exception' };
    const module = new ModuleWrap('reference:failure', undefined, [], () => { calls++; throw sentinel; });
    module.instantiate(); assert.throws(() => module.evaluate(-1, false), error => error === sentinel);
    assert.equal(module.getStatus(), 5); assert.equal(module.getError(), sentinel);
    await assert.rejects(module.evaluate(-1, false), error => error === sentinel);
    assert.equal(calls, 1);
  });
  await check('native-request-attributes-are-complete-and-frozen', () => {
    const module = new ModuleWrap('reference:requests', undefined,
      'import "first"; import value from "second" with {type:"json"}; import "third" with {custom:"retained"};', 0, 0);
    const requests = module.getModuleRequests(); assert.equal(requests.length, 3);
    assert.equal(requests[1].attributes.type, 'json'); assert.equal(requests[2].attributes.custom, 'retained');
    for (const request of requests) {
      assert.equal(Object.getPrototypeOf(request), null); assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.getPrototypeOf(request.attributes), null); assert.equal(Object.isFrozen(request.attributes), true);
      assert.equal(request.phase, binding.kEvaluationPhase);
    }
  });
  await check('native-source-synthetic-graph-and-live-bindings', async () => {
    const dependency = new ModuleWrap('reference:dep', undefined, ['value'], function() { this.setExport('value', 7); });
    const module = new ModuleWrap('reference:importer', undefined,
      'import {value} from "dep"; export {value}; export function read(){return value}', 0, 0);
    module.link([dependency]); module.instantiate(); await module.evaluate(-1, false);
    assert.equal(module.getNamespace().read(), 7); dependency.setExport('value', 8);
    assert.equal(module.getNamespace().value, 8); assert.equal(module.getNamespace().read(), 8);
    assert.throws(() => dependency.setExport('missing', 0), ReferenceError);
  });
  await check('native-custom-metadata-callback-identity', async () => {
    const identity = Symbol('source identity'); let calls = 0; let seen;
    binding.setInitializeImportMetaObjectCallback((id, meta, wrap) => {
      assert.equal(id, identity); calls++; seen = wrap; meta.answer = 18;
    });
    const module = new ModuleWrap('reference:meta', undefined,
      'export const value=import.meta.answer;', 0, 0, identity);
    module.link([]); module.instantiate(); await module.evaluate(-1, false);
    assert.equal(module.getNamespace().value, 18); assert.equal(calls, 1); assert.equal(seen, module);
  });
  await check('native-source-object-missing-error-and-retained-value', () => {
    const module = new ModuleWrap('reference:source-object', undefined, [], () => {});
    assert.throws(() => module.getModuleSourceObject(), { code: 'ERR_SOURCE_PHASE_NOT_DEFINED' });
    const object = { identity: 'native source object' }; module.setModuleSourceObject(object);
    assert.equal(module.getModuleSourceObject(), object);
  });
  console.log(JSON.stringify({kind:'native-module-wrap-reference-only',version:process.version,
    platform:process.platform,arch:process.arch,v8:process.versions.v8,execArgv:process.execArgv,
    cases:observations.length,failures,observations,
    limits:['Bounded native internal binding reference only','No guest startup or browser conformance',
      'No complete method/error/lifecycle/security/OOM differential']}));
  if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
