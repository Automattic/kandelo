'use strict';
// Exact target only: a foreign holder's normal release wakes this Environment
// through Node's actual native-immediate queue, without another lock request.
const assert=require('node:assert/strict');
const {Worker,locks}=require('node:worker_threads');
const {once}=require('node:events');
const async=require('node:async_hooks');
assert.equal(process.version,'v26.13.0');
(async()=>{
 const name='native-provider-'+process.pid;const local=new async.AsyncLocalStorage();
 const worker=new Worker(`const {parentPort,locks}=require('node:worker_threads');let release;locks.request(${JSON.stringify(name)},()=>{parentPort.postMessage('held');return new Promise(resolve=>release=resolve)});parentPort.on('message',()=>release())`,{eval:true});
 try{
  assert.equal((await once(worker,'message'))[0],'held');let observed,query;
  const request=local.run('submission-frame',()=>locks.request(name,()=>{
   assert.equal(local.getStore(),undefined);
   const resource=async.executionAsyncResource();const child=new async.AsyncResource('LockCallbackChild',{requireManualDestroy:true});
   observed={execution:async.executionAsyncId(),trigger:async.triggerAsyncId(),store:local.getStore()??null,tag:Object.prototype.toString.call(resource),ownNames:Object.getOwnPropertyNames(resource),ownSymbols:Object.getOwnPropertySymbols(resource).map(x=>x.description),childTrigger:child.triggerAsyncId()};child.emitDestroy();query=locks.query();return 17;
  }));
  local.enterWith('ambient-main-frame');worker.postMessage('release');assert.equal(await request,17);assert((await query).held.some(x=>x.name===name));
  assert.deepEqual(observed,{execution:0,trigger:0,store:null,tag:'[object Object]',ownNames:[],ownSymbols:[],childTrigger:0});
  console.log(JSON.stringify({version:process.version,observed,scope:'Exact native foreign-worker normal release/default native-immediate context; no candidate or guest evidence'}));
 }finally{await worker.terminate();}
})().catch(error=>{console.error(error);process.exitCode=1});
