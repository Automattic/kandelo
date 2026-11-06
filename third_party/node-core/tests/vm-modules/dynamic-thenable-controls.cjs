'use strict';
// Native target plus pinned public-wrapper/dependency control. This does not
// execute the candidate SpiderMonkey reaction or prove its Promise job order.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { create } = require('../../../../host/test/fixtures/node-vm-modules-platform.cjs');
const target = JSON.parse(fs.readFileSync(path.resolve(__dirname,
  '../../../../packages/registry/node-compat/target.json'), 'utf8'));
assert.equal(process.versions.node, target.version);
const observations = [];
async function exercise(api) {
  const dependency = new api.SyntheticModule(['then'], function() {
    this.setExport('then', resolve => resolve(42));
  });
  await dependency.evaluate();
  const source = new api.SourceTextModule("export const load=()=>import('dependency')", {
    importModuleDynamically: () => dependency,
  });
  await source.link(() => {});
  await source.evaluate();
  const result = await source.namespace.load();
  assert.equal(result, 42);
  const invalid = new api.SourceTextModule("export const load=()=>import('invalid')", {
    importModuleDynamically: () => 42,
  });
  await invalid.link(() => {});
  await invalid.evaluate();
  await assert.rejects(invalid.namespace.load(), { code: 'ERR_VM_MODULE_NOT_MODULE' });
  return { assimilatedResult: result, invalidModuleRejected: true };
}
(async () => {
  for (const [owner, api] of [['native', vm], ['candidate-dependency', create()]])
    observations.push({ owner, ...await exercise(api) });
  const report = { node: process.version, observations,
    scope: 'Native reference and pinned JS wrapper over native dependencies; candidate SM Promise reaction remains uncompiled/unvalidated' };
  const out = process.env.KANDELO_VM_MODULES_CONTROL_OUT;
  assert(out); fs.writeFileSync(path.join(out, 'dynamic-thenable-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
