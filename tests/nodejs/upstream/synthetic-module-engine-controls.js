'use strict';
// Engine prerequisite for Node's real ModuleWrap owner. No Node loader/bootstrap.
const api = globalThis.__kandeloUpstreamTest;
const observations = [];
let failures = 0;
function check(name, callback) {
  try { callback(); observations.push({ name, status: 'pass' }); }
  catch (error) {
    failures++;
    observations.push({ name, status: 'fail', error: {
      name: error.name, message: error.message, stack: error.stack,
    } });
  }
}
function thrown(callback, message) {
  let caught;
  try { callback(); } catch (error) { caught = error; }
  if (!caught || !String(caught.message).includes(message))
    throw new Error('expected ' + message + ', got ' + String(caught));
}
function observe(promise) {
  const result = { state: 'pending' };
  promise.then(value => { result.state = 'fulfilled'; result.value = value; },
    error => { result.state = 'rejected'; result.error = error; });
  drainJobQueue();
  return result;
}
function fulfilled(promise) {
  const result = observe(promise);
  assertEq(result.state, 'fulfilled');
  assertEq(result.value, undefined);
}
function source(id, text, type = 'js') {
  const module = parseModule(text, id, type);
  registerModule(id, module);
  return module;
}
check('real-module-record-link-and-synchronous-evaluation', () => {
  let calls = 0;
  const module = api.newSyntheticModule(['answer'], function() {
    assertEq(this, undefined);
    calls++;
    api.setSyntheticExport(module, 'answer', 42);
  });
  // Shell wrappers intentionally hide synthetic internals. Observe lifecycle
  // through actual Link/Evaluate operations instead of their debug getters.
  assertEq(calls, 0);
  thrown(() => moduleEvaluate(module), 'unexpected status');
  assertEq(calls, 0);
  moduleLink(module);
  const namespace = api.moduleNamespace(module);
  assertEq(namespace.answer, undefined);
  const promise = moduleEvaluate(module);
  assertEq(calls, 1);
  assertEq(namespace.answer, 42);
  fulfilled(promise);
  assertEq(moduleEvaluate(module), promise);
  assertEq(calls, 1);
});
check('live-native-exports-and-real-namespace', () => {
  const module = api.newSyntheticModule(['default', 'value'], () => {});
  moduleLink(module);
  api.setSyntheticExport(module, 'value', 1);
  const namespace = api.moduleNamespace(module);
  assertEq(Object.getPrototypeOf(namespace), null);
  assertEq(Object.isExtensible(namespace), false);
  assertEq(namespace[Symbol.toStringTag], 'Module');
  assertEq(Reflect.set(namespace, 'value', 9), false);
  api.setSyntheticExport(module, 'value', 2);
  assertEq(namespace.value, 2);
  assertEq(api.moduleNamespace(module), namespace);
  fulfilled(moduleEvaluate(module));
});
check('source-importer-evaluates-synthetic-dependency-first', () => {
  globalThis.syntheticOrder = [];
  const dependency = api.newSyntheticModule(['value'], () => {
    syntheticOrder.push('dependency');
    api.setSyntheticExport(dependency, 'value', 7);
  });
  registerModule('synthetic-order', dependency);
  const importer = source('synthetic-importer',
    'import { value } from "synthetic-order"; globalThis.syntheticOrder.push(value); export const result = value + 1;');
  moduleLink(importer);
  assertEq(syntheticOrder.length, 0);
  fulfilled(moduleEvaluate(importer));
  assertEq(syntheticOrder.join(','), 'dependency,7');
  assertEq(api.moduleNamespace(importer).result, 8);
});
check('source-imports-observe-live-binding-updates', () => {
  const dependency = api.newSyntheticModule(['value'], () => {
    api.setSyntheticExport(dependency, 'value', 10);
  });
  registerModule('synthetic-live', dependency);
  const importer = source('synthetic-live-importer',
    'import { value } from "synthetic-live"; export { value }; export function read() { return value; }');
  moduleLink(importer);
  fulfilled(moduleEvaluate(importer));
  const namespace = api.moduleNamespace(importer);
  assertEq(namespace.read(), 10);
  api.setSyntheticExport(dependency, 'value', 20);
  assertEq(namespace.value, 20);
  assertEq(namespace.read(), 20);
});
check('callback-exception-becomes-cached-rejected-promise', () => {
  const sentinel = { identity: 'original synthetic exception' };
  let calls = 0;
  const module = api.newSyntheticModule(['value'], () => { calls++; throw sentinel; });
  moduleLink(module);
  const promise = moduleEvaluate(module);
  const result = observe(promise);
  assertEq(result.state, 'rejected');
  assertEq(result.error, sentinel);
  gc();
  assertEq(moduleEvaluate(module), promise);
  assertEq(calls, 1);
});
check('dependency-failure-prevents-importer-body', () => {
  const sentinel = new Error('synthetic dependency failed');
  let calls = 0;
  globalThis.syntheticImporterRan = false;
  const dependency = api.newSyntheticModule([], () => { calls++; throw sentinel; });
  registerModule('synthetic-failed', dependency);
  const importer = source('synthetic-failed-importer',
    'import "synthetic-failed"; globalThis.syntheticImporterRan = true;');
  moduleLink(importer);
  const promise = moduleEvaluate(importer);
  const result = observe(promise);
  assertEq(result.state, 'rejected');
  assertEq(result.error, sentinel);
  assertEq(syntheticImporterRan, false);
  assertEq(calls, 1);
  assertEq(moduleEvaluate(importer), promise);
  assertEq(observe(moduleEvaluate(dependency)).error, sentinel);
});
check('synthetic-dependency-under-real-top-level-await', () => {
  let release;
  globalThis.syntheticGate = new Promise(resolve => { release = resolve; });
  const dependency = api.newSyntheticModule(['value'], () => {
    api.setSyntheticExport(dependency, 'value', 30);
  });
  registerModule('synthetic-async', dependency);
  const importer = source('synthetic-async-importer',
    'import { value } from "synthetic-async"; await globalThis.syntheticGate; export const result = value;');
  moduleLink(importer);
  const promise = moduleEvaluate(importer);
  assertEq(api.moduleNamespace(dependency).value, 30);
  assertEq(observe(promise).state, 'pending');
  release();
  fulfilled(promise);
  assertEq(api.moduleNamespace(importer).result, 30);
});
check('reentrant-evaluate-returns-published-promise', () => {
  let calls = 0;
  let inner;
  const module = api.newSyntheticModule([], () => {
    calls++;
    inner = moduleEvaluate(module);
  });
  moduleLink(module);
  const outer = moduleEvaluate(module);
  assertEq(inner, outer);
  fulfilled(outer);
  assertEq(calls, 1);
});
check('reentrant-dependent-graph-cannot-use-incomplete-evaluation', () => {
  let inner;
  let calls = 0;
  globalThis.syntheticReentrantImporterRan = false;
  const dependency = api.newSyntheticModule([], () => {
    calls++;
    inner = moduleEvaluate(importer);
  });
  registerModule('synthetic-reentrant', dependency);
  const importer = source('synthetic-reentrant-importer',
    'import "synthetic-reentrant"; globalThis.syntheticReentrantImporterRan = true;');
  moduleLink(importer);
  fulfilled(moduleEvaluate(dependency));
  const result = observe(inner);
  assertEq(result.state, 'rejected');
  assertEq(result.error.message.includes('already evaluating'), true);
  assertEq(syntheticReentrantImporterRan, false);
  assertEq(calls, 1);
});
check('arbitrary-export-names-do-not-alias-engine-bindings', () => {
  const names = ['', '0', '*namespace*', 'a-b', 'has space', 'π', 'null\0x', 'synthetic0', 'default', '__proto__'];
  const module = api.newSyntheticModule(names, () => {
    for (let i = 0; i < names.length; i++) api.setSyntheticExport(module, names[i], i);
  });
  registerModule('synthetic-unusual', module);
  const importer = source('synthetic-unusual-importer',
    'export { "" as empty, "0" as zero, "*namespace*" as special } from "synthetic-unusual";');
  moduleLink(importer);
  fulfilled(moduleEvaluate(importer));
  const namespace = api.moduleNamespace(module);
  for (let i = 0; i < names.length; i++) assertEq(namespace[names[i]], i);
  const imported = api.moduleNamespace(importer);
  assertEq(imported.empty, 0);
  assertEq(imported.zero, 1);
  assertEq(imported.special, 2);
});
check('empty-module-has-no-fabricated-exports', () => {
  let calls = 0;
  const module = api.newSyntheticModule([], () => { calls++; });
  moduleLink(module);
  fulfilled(moduleEvaluate(module));
  assertEq(Object.getOwnPropertyNames(api.moduleNamespace(module)).length, 0);
  assertEq(calls, 1);
});
check('invalid-names-and-unknown-exports-fail-honestly', () => {
  thrown(() => api.newSyntheticModule(['a', 'a'], () => {}), 'Duplicate');
  thrown(() => api.newSyntheticModule([3], () => {}), 'must be strings');
  thrown(() => api.newSyntheticModule({}, () => {}), 'names array');
  const module = api.newSyntheticModule(['a'], () => {});
  thrown(() => api.moduleNamespace(module), 'must be linked');
  thrown(() => api.setSyntheticExport(module, 'a', 1), 'must be linked');
  moduleLink(module);
  thrown(() => api.setSyntheticExport(module, 'missing', 1), 'Unknown');
  thrown(() => api.setSyntheticExport({}, 'a', 1), 'genuine shell module');
  const ordinary = parseModule('export const a = 1');
  thrown(() => api.setSyntheticExport(ordinary, 'a', 1), 'Expected a synthetic');
});
check('native-private-callback-and-export-values-survive-gc', () => {
  function create() {
    const retained = { identity: 'traced native callback value' };
    const module = api.newSyntheticModule(['value'], () => {
      api.setSyntheticExport(module, 'value', retained);
    });
    return module;
  }
  const module = create();
  gc();
  moduleLink(module);
  fulfilled(moduleEvaluate(module));
  gc();
  assertEq(api.moduleNamespace(module).value.identity, 'traced native callback value');
});
check('json-module-path-preserves-real-parser-and-type', () => {
  source('synthetic-json-baseline', '{"value": 56}', 'json');
  const importer = source('synthetic-json-importer',
    'import data from "synthetic-json-baseline" with { type: "json" }; export const result = data.value;');
  moduleLink(importer);
  fulfilled(moduleEvaluate(importer));
  assertEq(api.moduleNamespace(importer).result, 56);
});
check('shared-synthetic-dependency-runs-once-across-importers', () => {
  let calls = 0;
  const dependency = api.newSyntheticModule(['value'], () => {
    calls++;
    api.setSyntheticExport(dependency, 'value', calls);
  });
  registerModule('synthetic-shared', dependency);
  const left = source('synthetic-left', 'export { value } from "synthetic-shared";');
  const right = source('synthetic-right', 'export { value } from "synthetic-shared";');
  moduleLink(left);
  moduleLink(right);
  fulfilled(moduleEvaluate(left));
  fulfilled(moduleEvaluate(right));
  assertEq(calls, 1);
  assertEq(api.moduleNamespace(left).value, 1);
  assertEq(api.moduleNamespace(right).value, 1);
});
print(JSON.stringify({ kind: 'engine-synthetic-module-controls', plannedCases: 15,
  cases: observations.length, notRun: 15 - observations.length, failures, observations,
  limits: ['No Node ModuleWrap binding or upstream realm/bootstrap execution',
    'No browser execution', 'No OOM/security-wrapper/complete finalization proof'] }));
if (failures) quit(1);
