'use strict';
const assert=require('node:assert/strict');
const create=require('./platform.cjs');
const [bundle,manager,execution]=process.argv.slice(2);
const p=create(bundle,manager,execution);const local=new p.async.api.AsyncLocalStorage();
local.enterWith('ambient');const carrier=new p.async.api.AsyncResource('Outer',{requireManualDestroy:true});let zero;
carrier.runInAsyncScope(()=>{
 const old=p.execution.executionAsyncId(),resource=p.async.api.executionAsyncResource();
 assert(old>0);
 let synchronous;
 p.api.request('synchronous-caller-scope',()=>{synchronous={id:p.async.api.executionAsyncId(),resource:p.async.api.executionAsyncResource(),store:local.getStore()};return 17;});
 assert.deepEqual(synchronous,{id:old,resource,store:'ambient'});
 p.async.runInternalImmediate(()=>{zero=p.async.api.executionAsyncResource();assert.equal(p.execution.executionAsyncId(),0);assert.equal(p.execution.triggerAsyncId(),0);assert.equal(p.execution.executionAsyncResource(),zero);assert.equal(local.getStore(),undefined);});
 assert.equal(p.execution.executionAsyncId(),old);assert.equal(p.async.api.executionAsyncResource(),resource);assert.equal(local.getStore(),'ambient');
});carrier.emitDestroy();
// A real stack clear inside the helper must not resurrect its saved frame.
p.async.runInternalImmediate(()=>p.execution.clearAsyncExecution());assert.equal(p.execution.getAsyncContext(),undefined);assert(!p.execution.hasAsyncExecution());
const marker=new Error('internal delivery failure');assert.throws(()=>p.async.runInternalImmediate(()=>{throw marker}),error=>error===marker);assert(p.execution.hasAsyncExecution());assert.equal(p.execution.executionAsyncId(),0);assert.equal(p.execution.getAsyncContext().frame,undefined);p.execution.clearAsyncExecution();assert.equal(p.execution.retainedBytes(),0);
console.log(JSON.stringify({passed:true,scope:'Actual native execution owner with generated helper: nested0/0/default/resource, restoration, clear guard and failed-scope retention. No production JSAPI recovery claim.'}));
