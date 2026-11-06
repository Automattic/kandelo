'use strict';
// Actual generated async + unchanged fatal-handler algorithm over the actual
// portable native execution owner, with explicit N-API ref/host event/timer
// dependencies. This does not execute production SpiderMonkey callbacks/GC.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const util=require('node:util');
const os=require('node:os');
const { EventEmitter }=require('node:events');
const nativeTimers=require('node:timers');
const root=path.resolve(__dirname,'../../../..');
const raw=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const {makeValues,makeAsync,install}=Function(raw+';return {makeValues:_createNodeValuesPlatform,makeAsync:_createNodeAsyncPlatform,install:_installNodeProcessExceptions}')();
const values=makeValues({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const owner=require(path.resolve(process.argv[2]));
const adapter=fs.readFileSync(path.join(root,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const start=adapter.indexOf('    const _nodeNative = {'),end=adapter.indexOf('\n\n    const entryPath =',start);
const helperStart=adapter.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;'),helperEnd=adapter.indexOf('    // The deadline heap owns',helperStart);
assert(start>=0&&end>start&&helperStart>=0&&helperEnd>helperStart);
let passed=0;
function create(after=true){
 owner.clearAsyncExecution();
 const records=new WeakMap(),destroys=[];
 let lifecycle,registered;
 const native={...owner,isPromise:util.types.isPromise,
  setAsyncLifecycle(fn){lifecycle=fn},setAsyncDestroyTracking(){},
  getAsyncResourceInfo(resource){assert(records.has(resource));return records.get(resource)},
  enqueueAsyncDestroyId(id,promise){destroys.push([id,promise])},
  drainNativeAsyncDestroyIds(){return destroys.splice(0)},
  asyncHookFatal(error){throw error}, // Fatal hook process exit not covered here.
  setUncaughtProcess(proc){registered=proc},
 };
 const actual=Function('native','workerEnvironment',adapter.slice(helperStart,helperEnd)+adapter.slice(start,end)+'\nreturn _nodeNative;')(native,null);
 for(const name of ['pushAsyncExecution','popAsyncExecution','clearAsyncExecution','executionAsyncId','triggerAsyncId','hasAsyncExecution','executionAsyncResource','setUncaughtProcess'])assert.equal(typeof actual[name],'function');
 const guest=new EventEmitter();guest.report={reportOnUncaughtException:false};guest._exiting=false;guest.exitCode=undefined;
 const async=makeAsync({native:actual,values,process:guest});
 let immediate=0;const pending=[];
 install({process:guest,values,async,native:actual,timers:{setImmediate(fn){++immediate;const handle=nativeTimers.setImmediate(fn);pending.push(handle);return handle;}}});
 assert.equal(registered,guest);
 const events=[];
 const hook=async.api.createHook({before(id){events.push(['before',id,async.api.executionAsyncId()])},...(after?{after(id){events.push(['after',id,async.api.executionAsyncId()])}}:{})}).enable();
 const als=new async.api.AsyncLocalStorage();
 function enter(fn){return als.run('real-frame',()=>{
  const resource={};const id=owner.allocateAsyncId();const trigger=owner.getDefaultTriggerAsyncId();
  records.set(resource,[id,trigger,undefined,'FSREQCALLBACK']);lifecycle('native:init',resource);
  const captured=owner.getAsyncContext();lifecycle('before',resource,captured.frame);
  assert.equal(async.api.executionAsyncId(),id);assert.equal(async.api.executionAsyncResource(),resource);
  return fn({id,resource});
 });}
 return {guest,async,events,als,enter,immediate:()=>immediate,close(){hook.disable();for(const handle of pending)nativeTimers.clearImmediate(handle);owner.clearAsyncExecution();owner.swapDefaultTriggerAsyncId(-1);assert.equal(owner.retainedBytes(),0);}};
}
{
 const c=create();const marker=new Error('ordinary callback');let monitored=0,handled=0;
 c.guest.on('uncaughtExceptionMonitor',(error,origin)=>{assert.equal(error,marker);assert.equal(origin,'uncaughtException');assert.equal(c.als.getStore(),'real-frame');++monitored;});
 c.guest.on('uncaughtException',(error,origin)=>{assert.equal(error,marker);assert.equal(origin,'uncaughtException');assert.equal(c.als.getStore(),'real-frame');++handled;});
 c.enter(({id,resource})=>{owner.swapDefaultTriggerAsyncId(999);assert.equal(c.guest._fatalException(marker,false),true);assert.equal(monitored,1);assert.equal(handled,1);assert.equal(c.immediate(),1);assert.deepEqual(c.events,[['before',id,id],['after',id,id]]);assert.equal(owner.executionAsyncId(),0);assert.equal(owner.getDefaultTriggerAsyncId(),0);assert(!owner.hasAsyncExecution());assert.notEqual(c.async.api.executionAsyncResource(),resource);});c.close();++passed;
}
{
 const c=create();const marker=new Error('unhandled');let exits=0;
 c.guest.on('exit',code=>{assert.equal(code,1);assert.equal(c.als.getStore(),'real-frame');++exits;});
 c.enter(({id})=>{assert.equal(c.guest._fatalException(marker,false),false);assert.equal(exits,1);assert(c.guest._exiting);assert.equal(c.guest.exitCode,1);assert.equal(c.immediate(),0);assert.deepEqual(c.events,[['before',id,id]]);assert.equal(owner.executionAsyncId(),id);});c.close();++passed;
}
{
 const c=create();const marker=new Error('capture');let captured=0;
 c.guest.report.reportOnUncaughtException=true;
 c.guest.setUncaughtExceptionCaptureCallback(error=>{assert.equal(error,marker);assert.equal(c.als.getStore(),'real-frame');++captured;});
 assert(c.guest.hasUncaughtExceptionCaptureCallback());assert.equal(c.guest.report.reportOnUncaughtException,false);
 assert.throws(()=>c.guest.setUncaughtExceptionCaptureCallback(()=>{}),{code:'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET'});
 c.enter(()=>{assert(c.guest._fatalException(marker,false));assert.equal(captured,1);});
 c.guest.setUncaughtExceptionCaptureCallback(null);assert(!c.guest.hasUncaughtExceptionCaptureCallback());assert.equal(c.guest.report.reportOnUncaughtException,true);
 assert.throws(()=>c.guest.setUncaughtExceptionCaptureCallback(1),{code:'ERR_INVALID_ARG_TYPE'});c.close();++passed;
}
{
 const c=create(false);c.guest.on('uncaughtException',()=>{});
 c.enter(({id})=>{assert(c.guest._fatalException(new Error('no after hooks'),false));assert.deepEqual(c.events,[['before',id,id]]);assert(!owner.hasAsyncExecution());assert.equal(owner.executionAsyncId(),0);});c.close();++passed;
}
{
 const c=create();const marker=new Error('handler failure');c.guest.on('uncaughtException',()=>{throw marker});
 c.enter(({id})=>{assert.throws(()=>c.guest._fatalException(new Error('original'),false),error=>error===marker);assert.equal(owner.executionAsyncId(),id);assert.equal(c.immediate(),0);assert.deepEqual(c.events,[['before',id,id]]);});c.close();++passed;
}
{
 const c=create();const marker=new Error('nested');c.guest.on('uncaughtException',()=>{});
 c.enter(({id})=>{const outer=new c.async.api.AsyncResource('OuterScope',{requireManualDestroy:true});const nested=outer.asyncId();assert.throws(()=>outer.runInAsyncScope(()=>{throw marker}),error=>error===marker);assert.equal(owner.executionAsyncId(),id);assert(c.guest._fatalException(marker,false));assert.deepEqual(c.events,[['before',id,id],['before',nested,nested],['after',nested,nested],['after',id,id]]);});c.close();++passed;
}
{
 const c=create();const marker=new Error('timer body');c.guest.on('uncaughtException',()=>{});
 const resource={};c.als.run('timer-frame',()=>c.async.createTask(resource,'Timeout'));
 assert.throws(()=>c.async.runTask(resource,()=>{throw marker},resource,[]),error=>error===marker);
 const id=owner.executionAsyncId();assert(id>0);assert.equal(c.als.getStore(),'timer-frame');assert(c.guest._fatalException(marker,false));assert.deepEqual(c.events,[['before',id,id],['after',id,id]]);assert(!owner.hasAsyncExecution());c.close();++passed;
}
{
 const c=create();const marker=new Error('real adapter wrapper');c.guest.on('uncaughtException',()=>{});
 const resource={};c.als.run('wrapper-frame',()=>c.async.createTask(resource,'Immediate'));
 const native={...owner};const actual=Function('native','workerEnvironment',adapter.slice(helperStart,helperEnd)+adapter.slice(start,end)+'\nreturn _nodeNative;')(native,null);
 assert.throws(()=>actual.runWithAsyncContext(owner.getAsyncContext(),()=>c.async.runTask(resource,()=>{throw marker},resource,[]),undefined,[]),error=>error===marker);
 assert.equal(c.als.getStore(),'wrapper-frame');assert(c.guest._fatalException(marker,false));assert(!owner.hasAsyncExecution());c.close();++passed;
}
console.log(JSON.stringify({groups:passed,scope:'Actual generated async/unchanged fatal handler and production adapter over actual portable native owner/N-API roots; explicit host event/timer and metadata/destroy dependencies. No production JSAPI, guest, fatal C++ exit policy or four-host claim.'}));
