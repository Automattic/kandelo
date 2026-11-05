import {createRequire} from 'node:module';
import * as fs from 'node:fs';
import {describe,expect,it} from 'vitest';
const require=createRequire(import.meta.url),target=require('../../packages/registry/node-compat/target.json');
const {controls}=require('./fixtures/node-file-sync-controls.cjs');
const fixture=require('./fixtures/node-file-sync-platform.cjs');
describe.skipIf(process.versions.node!==target.version)('whole-file sync source with real native descriptors',()=>{
 for(const [name,run] of Object.entries(controls) as [string,(api:unknown)=>unknown][])
  it(name,()=>expect(run(fixture.create().api)).toEqual(run(fs)));
 it('closes the actual owned fd when private allocation or decoding throws',()=>{
  const dir=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'kandelo-sync-cleanup-'));
  const file=dir+'/file';fs.writeFileSync(file,'actual bytes');
  try{
   for(const stage of ['allocation','decoding']){
    const candidate=fixture.create(),failure=Error('injected '+stage+' failure');
    if(stage==='allocation')candidate.allocator.createUnsafeBuffer=()=>{throw failure};
    else candidate.codecs.decodeBytes=()=>{throw failure};
    expect(()=>candidate.api.readFileSync(file,'utf8')).toThrow(failure);
    const closed=candidate.calls.filter((row:unknown[])=>row[0]==='close');
    expect(closed).toHaveLength(1);
    expect(()=>fs.fstatSync(closed[0][1])).toThrow(expect.objectContaining({code:'EBADF'}));
   }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 });
 it('keeps UTF8 binding paths independent of public fs and Buffer replacements',()=>{
  const candidate=fixture.create(),dir=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'kandelo-private-sync-'));
  const fail=()=>{throw Error('public dependency used')};
  const before=Object.getOwnPropertyDescriptor(candidate.Buffer,Symbol.species);
  try{
   for(const name of ['openSync','readSync','writeSync','closeSync'])candidate.fs[name]=fail;
   for(const name of ['from','concat','alloc','allocUnsafe','allocUnsafeSlow'])candidate.Buffer[name]=fail;
   for(const name of ['slice','subarray','toString','utf8Slice','utf8Write'])candidate.Buffer.prototype[name]=fail;
   Object.defineProperty(candidate.Buffer,Symbol.species,{get:fail,configurable:true});
   const file=dir+'/file';candidate.api.writeFileSync(file,'a\0😀\ud800');
   expect(candidate.api.readFileSync(file,'utf8')).toBe('a\0😀�');
   expect(candidate.calls.filter((row:unknown[])=>row[0]==='open')).toHaveLength(2);
   expect(candidate.calls.filter((row:unknown[])=>row[0]==='close')).toHaveLength(2);
  }finally{
   if(before)Object.defineProperty(candidate.Buffer,Symbol.species,before);else delete candidate.Buffer[Symbol.species];
   fs.rmSync(dir,{recursive:true,force:true});
  }
 });
});
