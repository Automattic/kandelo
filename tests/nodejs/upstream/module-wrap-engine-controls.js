'use strict';
// Native binding integration controls, not upstream Node realm/bootstrap startup.
const api = globalThis.__kandeloUpstreamTest;
const observations = [];
let failures = 0;
function check(name, callback) {
  try { callback(); observations.push({ name, status: 'pass' }); }
  catch (error) { failures++; observations.push({ name, status: 'fail', error: {
    name: error.name, message: error.message, stack: error.stack,
  } }); }
}
function caught(callback) {
  try { callback(); } catch (error) { return error; }
  throw new Error('expected an exception');
}
function code(callback, expected) { const error = caught(callback); assertEq(error.code, expected); return error; }
function result(promise) {
  const state = { status: 'pending' };
  promise.then(value => { state.status = 'fulfilled'; state.value = value; },
    error => { state.status = 'rejected'; state.error = error; });
  drainJobQueue();
  return state;
}
function done(promise) { assertEq(result(promise).status, 'fulfilled'); }
api.initializeContext();
const binding = api.getModuleWrapBinding();
const { ModuleWrap } = binding;
check('canonical-realm-binding-and-original-prototype-operation', () => {
  assertEq(api.getModuleWrapBinding(), binding);
  Object.setPrototypeOf(ModuleWrap.prototype, null);
  assertEq(Object.getPrototypeOf(ModuleWrap.prototype), null);
  assertEq(binding.kUninstantiated, 0); assertEq(binding.kInstantiating, 1);
  assertEq(binding.kInstantiated, 2); assertEq(binding.kEvaluating, 3);
  assertEq(binding.kEvaluated, 4); assertEq(binding.kErrored, 5);
});
check('synthetic-constructor-real-namespace-and-wrapper-receiver', () => {
  let calls = 0;
  const module = new ModuleWrap('node:fixture', undefined, ['default', 'answer'], function() {
    assertEq(this, module); calls++; this.setExport('default', 'fixture'); this.setExport('answer', 42);
  });
  assertEq(module.synthetic, true); assertEq(module.url, 'node:fixture');
  assertEq(module.getStatus(), binding.kUninstantiated);
  code(() => module.getNamespace(), 'ERR_MODULE_NOT_INSTANTIATED');
  module.instantiate();
  assertEq(module.getStatus(), binding.kInstantiated);
  const promise = module.evaluate(-1, false);
  assertEq(module.getNamespace().answer, 42); assertEq(calls, 1);
  done(promise); assertEq(module.evaluate(-1, false), promise);
  assertEq(module.getStatus(), binding.kEvaluated); assertEq(calls, 1);
});
check('has-async-graph-is-own-lazy-writable-data', () => {
  const module = new ModuleWrap('fixture:lazy', undefined, [], () => {});
  assertEq(Object.hasOwn(module, 'hasAsyncGraph'), true);
  code(() => module.hasAsyncGraph, 'ERR_MODULE_NOT_INSTANTIATED');
  module.instantiate(); assertEq(module.hasAsyncGraph, false);
  const descriptor = Object.getOwnPropertyDescriptor(module, 'hasAsyncGraph');
  assertEq(descriptor.value, false); assertEq(descriptor.writable, true);
  assertEq(descriptor.enumerable, false); assertEq(descriptor.configurable, true);
});
check('live-synthetic-exports-and-reference-error', () => {
  const module = new ModuleWrap('fixture:live', undefined, ['value', '*namespace*', '0', ''], function() {
    this.setExport('value', 10); this.setExport('*namespace*', 20); this.setExport('0', 30); this.setExport('', 40);
  });
  module.instantiate(); done(module.evaluate(-1, false));
  const namespace = module.getNamespace();
  module.setExport('value', 11); assertEq(namespace.value, 11);
  assertEq(namespace['*namespace*'], 20); assertEq(namespace['0'], 30); assertEq(namespace[''], 40);
  assertEq(Object.getPrototypeOf(namespace), null); assertEq(Object.isExtensible(namespace), false);
  assertEq(caught(() => module.setExport('unknown', 0)) instanceof ReferenceError, true);
});
check('synthetic-first-failure-throws-later-evaluation-rejects', () => {
  const sentinel = { identity: 'original synthetic failure' };
  let calls = 0;
  const module = new ModuleWrap('fixture:failed', undefined, [], () => { calls++; throw sentinel; });
  module.instantiate(); assertEq(caught(() => module.evaluate(-1, false)), sentinel);
  assertEq(module.getStatus(), binding.kErrored); assertEq(module.getError(), sentinel);
  assertEq(result(module.evaluate(-1, false)).error, sentinel); assertEq(calls, 1);
});
check('source-requests-have-real-frozen-attributes', () => {
  const module = new ModuleWrap('fixture:requests', undefined,
    'import "first"; import data from "second" with {type:"json"}; import "third" with {custom:"retained"};', 0, 0);
  const requests = module.getModuleRequests(); assertEq(requests.length, 3);
  assertEq(requests[0].specifier, 'first'); assertEq(requests[1].specifier, 'second');
  assertEq(requests[1].attributes.type, 'json'); assertEq(requests[2].attributes.custom, 'retained');
  for (const request of requests) {
    assertEq(Object.getPrototypeOf(request), null); assertEq(Object.isFrozen(request), true);
    assertEq(Object.getPrototypeOf(request.attributes), null); assertEq(Object.isFrozen(request.attributes), true);
    assertEq(request.phase, binding.kEvaluationPhase);
  }
  assertEq(module.synthetic, false);
  const dependency = new ModuleWrap('fixture:attribute-target', undefined, ['default'], function() { this.setExport('default', 1); });
  module.link([dependency, dependency, dependency]);
  assertEq(caught(() => module.instantiate()).message.includes('custom'), true);
});
check('native-source-links-synthetic-dependency-and-live-reexport', () => {
  const dependency = new ModuleWrap('fixture:dependency', undefined, ['value'], function() { this.setExport('value', 7); });
  const module = new ModuleWrap('fixture:importer', undefined,
    'import {value} from "dependency"; export {value}; export function read(){ return value; }', 0, 0);
  code(() => module.instantiate(), 'ERR_VM_MODULE_LINK_FAILURE');
  module.link([dependency]); module.instantiate(); done(module.evaluate(-1, false));
  assertEq(dependency.getStatus(), binding.kEvaluated);
  const namespace = module.getNamespace(); assertEq(namespace.read(), 7);
  dependency.setExport('value', 8); assertEq(namespace.value, 8); assertEq(namespace.read(), 8);
});
check('source-module-cycles-use-actual-engine-graph', () => {
  const left = new ModuleWrap('fixture:left', undefined,
    'import {right} from "right"; export function left(){return 1}; export function run(){return right()}', 0, 0);
  const right = new ModuleWrap('fixture:right', undefined,
    'import {left} from "left"; export function right(){return left()+1}', 0, 0);
  left.link([right]); right.link([left]); left.instantiate(); done(left.evaluate(-1, false));
  assertEq(left.getNamespace().run(), 2); assertEq(right.getNamespace().right(), 2);
});
check('linked-dependencies-cannot-be-mutated-through-caller-array', () => {
  const one = new ModuleWrap('fixture:one', undefined, ['value'], function(){this.setExport('value', 1)});
  const two = new ModuleWrap('fixture:two', undefined, ['value'], function(){this.setExport('value', 2)});
  const module = new ModuleWrap('fixture:stable-links', undefined, 'export {value} from "dep";', 0, 0);
  const dependencies = [one]; module.link(dependencies); dependencies[0] = two;
  module.instantiate(); done(module.evaluate(-1, false)); assertEq(module.getNamespace().value, 1);
});
check('top-level-await-and-synchronous-refusal', () => {
  let release; globalThis.moduleWrapGate = new Promise(resolve => {release=resolve});
  const async = new ModuleWrap('fixture:async', undefined, 'await globalThis.moduleWrapGate; export const value=9;', 0, 0);
  const importer = new ModuleWrap('fixture:async-importer', undefined, 'export {value} from "async";', 0, 0);
  async.link([]); importer.link([async]); importer.instantiate();
  assertEq(async.hasTopLevelAwait, true); assertEq(importer.hasAsyncGraph, true);
  code(() => importer.evaluateSync(), 'ERR_REQUIRE_ASYNC_MODULE');
  const promise = importer.evaluate(-1, false); assertEq(result(promise).status, 'pending');
  release(); done(promise); assertEq(importer.getNamespace().value, 9);
});
check('synchronous-evaluation-and-rejection-identity', () => {
  const module = new ModuleWrap('fixture:sync', undefined, 'export const value=12;', 0, 0);
  module.link([]); module.instantiate(); assertEq(module.evaluateSync().value, 12);
  const sentinel = { identity: 'original source failure' }; globalThis.moduleWrapSentinel=sentinel;
  const bad = new ModuleWrap('fixture:source-failure', undefined, 'throw globalThis.moduleWrapSentinel;', 0, 0);
  bad.link([]); bad.instantiate(); assertEq(caught(() => bad.evaluateSync()), sentinel);
  assertEq(bad.getStatus(), binding.kErrored); assertEq(bad.getError(), sentinel);
});
check('dependency-failure-stops-source-body', () => {
  const sentinel={ identity:'dependency error' }; globalThis.moduleWrapImporterRan=false;
  const dependency=new ModuleWrap('fixture:throwing',undefined,[],()=>{throw sentinel});
  const importer=new ModuleWrap('fixture:stopped',undefined,'import "bad"; globalThis.moduleWrapImporterRan=true;',0,0);
  importer.link([dependency]); importer.instantiate();
  assertEq(result(importer.evaluate(-1,false)).error,sentinel);
  assertEq(globalThis.moduleWrapImporterRan,false); assertEq(importer.getError(),sentinel);
});
check('custom-import-meta-callback-uses-original-id-and-wrapper', () => {
  const identity=Symbol('source identity'); let calls=0; let seen;
  binding.setInitializeImportMetaObjectCallback((id, meta, wrap)=>{calls++;seen=wrap;assertEq(id,identity);meta.answer=18});
  const module=new ModuleWrap('fixture:meta',undefined,'export const value=import.meta.answer;',0,0,identity);
  module.link([]); module.instantiate(); done(module.evaluate(-1,false));
  assertEq(seen,module); assertEq(calls,1); assertEq(module.getNamespace().value,18);
});
check('source-bytes-unicode-surrogates-offsets-and-pragmas', () => {
  const module=new ModuleWrap('fixture:π',undefined,'export const value="'+String.fromCharCode(0xd800)+'";\n//# sourceURL=original-source.js\n//# sourceMappingURL=original.map',0,0);
  assertEq(module.sourceURL,'original-source.js'); assertEq(module.sourceMapURL,'original.map');
  module.link([]);module.instantiate();assertEq(module.evaluateSync().value.charCodeAt(0),0xd800);
  const bad=new ModuleWrap('fixture:offset',undefined,'throw new Error("offset");',3,2);
  bad.link([]);bad.instantiate();caught(()=>bad.evaluateSync());assertEq(bad.getError().lineNumber,4);
});
check('native-source-object-storage-is-real-and-missing-source-errors', () => {
  const module=new ModuleWrap('fixture:source-object',undefined,[],()=>{});
  code(()=>module.getModuleSourceObject(),'ERR_SOURCE_PHASE_NOT_DEFINED');
  const object={ identity:'native source object' };module.setModuleSourceObject(object);gc();
  assertEq(module.getModuleSourceObject(),object);
});
check('wrong-receiver-and-unimplemented-backends-fail-honestly', () => {
  code(()=>ModuleWrap.prototype.getStatus.call({}),'ERR_INVALID_THIS');
  const module=new ModuleWrap('fixture:unsupported',undefined,[],()=>{});module.instantiate();
  code(()=>module.evaluate(1,false),'ERR_KANDELO_NOT_IMPLEMENTED');
  code(()=>module.evaluate(-1,true),'ERR_KANDELO_NOT_IMPLEMENTED');
  code(()=>module.createCachedData(),'ERR_KANDELO_NOT_IMPLEMENTED');
  code(()=>binding.setImportModuleDynamicallyCallback(()=>{}),'ERR_KANDELO_NOT_IMPLEMENTED');
  code(()=>new ModuleWrap('fixture:context',{},[],()=>{}),'ERR_KANDELO_NOT_IMPLEMENTED');
  assertEq(module.getStatus(),binding.kInstantiated);
});
check('new-realm-gets-distinct-binding-and-constructors', () => {
  const realm=newGlobal({newCompartment:true});api.initializeContext(realm);
  const other=api.getModuleWrapBinding(realm);assertEq(other===binding,false);
  assertEq(other.ModuleWrap===ModuleWrap,false);assertEq(api.getModuleWrapBinding(realm),other);
  const module=new other.ModuleWrap('fixture:realm',undefined,'export const value=Object.prototype;',0,0);
  module.link([]);module.instantiate();assertEq(module.evaluateSync().value,realm.Object.prototype);
});
check('wrapper-and-graph-identity-survive-gc', () => {
  const dependency=new ModuleWrap('fixture:gc-dep',undefined,['value'],function(){this.setExport('value',{identity:'retained'})});
  const module=new ModuleWrap('fixture:gc-root',undefined,'export {value} from "dep";',0,0);
  module.link([dependency]);gc();module.instantiate();done(module.evaluate(-1,false));gc();
  const namespace=module.getNamespace();assertEq(namespace.value.identity,'retained');assertEq(module.getNamespace(),namespace);
});
check('previous-shell-module-hooks-still-own-non-node-records', () => {
  const dependency=parseModule('export const value=21;','shell:dependency');registerModule('shell-dependency',dependency);
  const module=parseModule('export {value} from "shell-dependency";','shell:root');moduleLink(module);done(moduleEvaluate(module));
  assertEq(api.moduleNamespace(module).value,21);
});
print(JSON.stringify({kind:'native-module-wrap-controls',plannedCases:19,cases:observations.length,
  notRun:19-observations.length,failures,observations,
  limits:['No upstream Node realm/bootstrap/CJS/ESM startup', 'No browser execution',
    'Dynamic/default import.meta/contextify/cache/deadline/signal backends still missing',
    'No complete native differential/security/OOM/finalization proof']}));
if(failures)quit(1);
