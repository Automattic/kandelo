import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,it,expect} from 'vitest';
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
const fixture=fileURLToPath(new URL('./fixtures/node-process-usage-control.cjs',import.meta.url));
describe.skipIf(process.versions.node!==target.version)('process usage source over explicit native measurement boundary',()=>{
 for(const name of ['validation','cpuValuesAndGetterOrder','memoryAndResourceFieldMapping','explicitMissingProviders','actualMetadataConsumers'])it(name,()=>{
  const result=spawnSync(process.execPath,[fixture,name],{encoding:'utf8',timeout:15000});
  expect(result.error,result.stderr).toBeUndefined();expect(result.signal,result.stderr).toBeNull();expect(result.status,result.stderr).toBe(0);
  const report=JSON.parse(result.stdout);expect(report.case).toBe(name);expect(report.passed).toBe(true);
 });
});
