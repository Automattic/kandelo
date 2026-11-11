'use strict';
// Pinned native Node reference only. Host VM APIs are not guest backends.
const vm = require('node:vm');
const assert = require('node:assert/strict');
const observations = [];
let failures = 0;
async function check(name, callback) {
  try { await callback(); observations.push({ name, status: 'pass' }); }
  catch (error) {
    failures++;
    observations.push({ name, status: 'fail', error: {
      name: error.name, message: error.message, stack: error.stack,
    } });
  }
}
(async () => {
  await check('arbitrary-live-synthetic-exports', async () => {
    let calls = 0;
    const module = new vm.SyntheticModule(['*namespace*', '0', ''], function() {
      calls++;
      this.setExport('*namespace*', 42);
      this.setExport('0', 43);
      this.setExport('', 44);
    });
    await module.evaluate();
    assert.equal(calls, 1);
    assert.equal(module.namespace['*namespace*'], 42);
    assert.equal(module.namespace['0'], 43);
    assert.equal(module.namespace[''], 44);
    module.setExport('0', 45);
    assert.equal(module.namespace['0'], 45);
  });
  await check('public-vm-reentry-rejected', async () => {
    let calls = 0;
    let inner;
    const module = new vm.SyntheticModule([], () => { calls++; inner = module.evaluate(); });
    const outer = module.evaluate();
    await assert.rejects(inner, { code: 'ERR_VM_MODULE_STATUS' });
    await outer;
    assert.equal(calls, 1);
  });
  await check('public-vm-terminal-failure-and-promise-results', async () => {
    let calls = 0;
    const sentinel = { identity: 'original exception' };
    const module = new vm.SyntheticModule([], () => { calls++; throw sentinel; });
    const first = module.evaluate();
    await assert.rejects(first, error => error === sentinel);
    const second = module.evaluate();
    await assert.rejects(second, error => error === sentinel);
    assert.notEqual(first, second);
    assert.equal(calls, 1);
    assert.equal(module.status, 'errored');
  });
  await check('source-module-live-binding-and-failure-order', async () => {
    const dependency = new vm.SyntheticModule(['value'], function() { this.setExport('value', 10); });
    const importer = new vm.SourceTextModule('import { value } from "dependency"; export { value }; export function read() { return value; }');
    await importer.link(() => dependency);
    await importer.evaluate();
    assert.equal(importer.namespace.read(), 10);
    dependency.setExport('value', 20);
    assert.equal(importer.namespace.value, 20);
    assert.equal(importer.namespace.read(), 20);
    const sentinel = new Error('failed dependency');
    const failed = new vm.SyntheticModule([], () => { throw sentinel; });
    globalThis.syntheticNativeImporterRan = false;
    const failedImporter = new vm.SourceTextModule('import "failed"; globalThis.syntheticNativeImporterRan = true;');
    await failedImporter.link(() => failed);
    await assert.rejects(failedImporter.evaluate(), error => error === sentinel);
    assert.equal(globalThis.syntheticNativeImporterRan, false);
    delete globalThis.syntheticNativeImporterRan;
  });
  console.log(JSON.stringify({ kind: 'native-synthetic-reference-only', version: process.version,
    platform: process.platform, arch: process.arch, v8: process.versions.v8,
    execArgv: process.execArgv, cases: observations.length, failures, observations,
    limits: ['Public VM wrapper observations are not raw engine API contracts',
      'No guest runtime or Node ModuleWrap binding conformance',
      'No browser/security-wrapper/OOM/finalization proof'] }));
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
