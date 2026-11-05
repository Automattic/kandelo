import {createRequire} from 'node:module';
import * as fs from 'node:fs';
import {describe,expect,it} from 'vitest';
const require=createRequire(import.meta.url),target=require('../../packages/registry/node-compat/target.json');
const {controls}=require('./fixtures/node-file-promises-controls.cjs');
const {create}=require('./fixtures/node-file-promises-platform.cjs');
describe.skipIf(process.versions.node!==target.version)('whole-file promises with real native requests',()=>{
 for(const [name,run] of Object.entries(controls) as [string,(api:unknown)=>Promise<unknown>][])
  it(name,async()=>expect(await run(create().api)).toEqual(await run(fs.promises)));
 it('selects queued jobs for small writes and real descriptor promises for flush/iterables',async()=>{
  const candidate=create(),dir=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'kandelo-job-routing-'));
  try{
   await candidate.api.writeFile(dir+'/file','small');expect(candidate.calls.filter((row:unknown[])=>row[0]==='writeJob')).toHaveLength(1);
   await candidate.api.appendFile(dir+'/file',['bytes'],{flush:true});
   expect(candidate.calls.some((row:unknown[])=>row[0]==='open')).toBe(true);
   expect(candidate.calls.some((row:unknown[])=>row[0]==='fsync')).toBe(true);
   expect(fs.readFileSync(dir+'/file','utf8')).toBe('smallbytes');
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 });
});
