'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {Worker,threadId}=require('node:worker_threads');
const {once}=require('node:events');
const create=require('./platform.cjs');
assert.equal(process.version,'v26.13.0');
const [bundle,managerPath,executionPath]=process.argv.slice(2);
(async()=>{
 const {api,locks,async,execution,addon,zeroEntries}=create(bundle,managerPath,executionPath);
 const local=new async.api.AsyncLocalStorage();const name='component-provider-'+process.pid;
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');const create=require(${JSON.stringify(require.resolve('./platform.cjs'))});const {api}=create(${JSON.stringify(bundle)},${JSON.stringify(managerPath)},${JSON.stringify(executionPath)});let release;api.request(${JSON.stringify(name)},()=>{parentPort.postMessage('held');return new Promise(resolve=>release=resolve)});parentPort.on('message',()=>release())`,{eval:true,execArgv:['--expose-internals']});
 try{
  assert.equal((await once(worker,'message'))[0],'held');let observed,query;
  const request=local.run('submission-frame',()=>api.request(name,()=>{
   assert.equal(local.getStore(),undefined);
   const resource=async.api.executionAsyncResource();const child=new async.api.AsyncResource('LockCallbackChild',{requireManualDestroy:true});
   observed={execution:async.api.executionAsyncId(),trigger:async.api.triggerAsyncId(),store:local.getStore()??null,tag:Object.prototype.toString.call(resource),ownNames:Object.getOwnPropertyNames(resource),ownSymbols:Object.getOwnPropertySymbols(resource).map(x=>x.description),childTrigger:child.triggerAsyncId()};
   assert.equal(execution.executionAsyncResource(),resource,'The native stack owns the actual zero resource');
   assert.equal(execution.executionAsyncId(),0);child.emitDestroy();query=api.query();return 17;
  }));
  local.enterWith('ambient-main-frame');
  const carrier=new async.api.AsyncResource('Carrier',{requireManualDestroy:true});let outside;
  worker.postMessage('release');
  // This is an explicit component driver, not the production event loop: the
  // actual manager condition variable waits for another real Worker to release.
  assert.equal(addon.locks('waitForReady',2000),true);
  carrier.runInAsyncScope(()=>{outside=async.api.executionAsyncResource();assert.equal(local.getStore(),'ambient-main-frame');assert.equal(locks.dispatch(),1);assert.equal(async.api.executionAsyncResource(),outside);assert.equal(local.getStore(),'ambient-main-frame');});
  carrier.emitDestroy();assert.equal(await request,17);assert((await query).held.some(x=>x.name===name));
  assert.deepEqual(observed,{execution:0,trigger:0,store:null,tag:'[object Object]',ownNames:[],ownSymbols:[],childTrigger:0});
  // No deliverable work creates no extra internal scope or resource.
  const context=execution.getAsyncContext(),entered=zeroEntries();assert.equal(locks.dispatch(),0);assert.equal(zeroEntries(),entered);assert.equal(execution.getAsyncContext(),context);assert(!execution.hasAsyncExecution());assert.equal(execution.retainedBytes(),0);
  console.log(JSON.stringify({observed,readyFromRealWorker:true,callerContextRestored:true,emptyDispatchCreatesScope:false,scope:'Actual portable manager/condition wake and generated149 native-stack adapter over Node-API roots. Blocking component driver/host dependencies are explicit; not production SM/event loop/four-host proof'}));
 }finally{await worker.terminate();execution.clearAsyncExecution();}
})().catch(error=>{console.error(error);process.exitCode=1});
