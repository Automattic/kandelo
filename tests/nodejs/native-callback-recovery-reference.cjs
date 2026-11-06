'use strict';
// Exact Node reference only. Every event is synchronous raw stdout so native
// fatal exits retain observations without depending on an exit listener.
const fs=require('node:fs');
const ah=require('node:async_hooks');
const variant=process.argv[2];
const marker=new Error('original native callback failure');
const second=new Error('exception handler failure');
const ids=new Map([[0,'root']]);const resources=new Map();
let requests=0, immediates=0, callbackResource, nativeId;
const local=new ah.AsyncLocalStorage();
function state(){return {execution:ids.get(ah.executionAsyncId())||'other',trigger:ids.get(ah.triggerAsyncId())||'other',store:local.getStore()};}
function event(kind,extra={}){fs.writeSync(1,JSON.stringify({kind,...state(),...extra})+'\n');}
const hook=ah.createHook({
 init(id,type,trigger,resource){
  if(type==='FSREQCALLBACK'){
   ids.set(id,'request'+(++requests));resources.set(id,resource);nativeId=id;
   event('init',{id:ids.get(id),type,parent:ids.get(trigger)||'other'});
   if(variant==='hookInitThrows')throw marker;
  }else if(type==='OuterScope'){ids.set(id,'outer');resources.set(id,resource);event('init',{id:'outer',type,parent:ids.get(trigger)||'other'});}
  else if(type==='Immediate'){ids.set(id,'immediate'+(++immediates));event('init',{id:ids.get(id),type,parent:ids.get(trigger)||'other'});}
 },
 before(id){if(ids.has(id)&&id!==0){event('before',{id:ids.get(id)});if(variant==='hookBeforeThrows'&&id===nativeId)throw marker;}},
 after(id){if(ids.has(id)&&id!==0){event('after',{id:ids.get(id)});if(variant==='hookAfterThrows'&&id===nativeId)throw marker;}},
 destroy(id){if(ids.has(id)&&id!==0){event('destroy',{id:ids.get(id)});if(variant==='hookDestroyThrows'&&id===nativeId)throw marker;}},
}).enable();
process.on('uncaughtExceptionMonitor',(error,origin)=>event('monitor',{original:error===marker,secondary:error===second,origin,sameResource:ah.executionAsyncResource()===callbackResource}));
process.on('exit',code=>event('exit',{code,exiting:process._exiting,exitCode:process.exitCode}));
if(!['absent','capture','fatalFalse','fatalUndefined','fatalNoncallable','fatalThrows','fatalGetterThrows'].includes(variant)){
 process.on('uncaughtException',(error,origin)=>{
  event('uncaught',{original:error===marker,origin,sameResource:ah.executionAsyncResource()===callbackResource});
  if(variant==='handlerThrows')throw second;
  if(variant==='handlerExit')process.exit(23);
  if(variant==='handlerExitCode')process.exitCode=17;
 });
}
if(variant==='capture'){
 process.setUncaughtExceptionCaptureCallback(error=>event('capture',{original:error===marker,hasCapture:process.hasUncaughtExceptionCaptureCallback()}));
}
if(variant==='fatalFalse'||variant==='fatalUndefined'||variant==='fatalThrows'){
 process._fatalException=function(error,fromPromise){event('fatalOverride',{original:error===marker,fromPromise,receiver:this===process});
  if(variant==='fatalThrows')throw second;
  return variant==='fatalFalse'?false:undefined;
 };
}
if(variant==='fatalNoncallable')process._fatalException=17;
if(variant==='fatalGetterThrows')Object.defineProperty(process,'_fatalException',{configurable:true,get(){event('fatalGetter');throw second;}});
const deadline=setTimeout(()=>{event('deadline');process.exit(99);},3000);deadline.unref();
local.run('request-frame',()=>fs.stat(__filename,()=>{
 callbackResource=ah.executionAsyncResource();event('callback',{sameResource:callbackResource===resources.get(ah.executionAsyncId())});
 if(variant==='hookAfterThrows'||variant==='hookDestroyThrows')return;
 if(variant==='nested'){
  const outer=new ah.AsyncResource('OuterScope',{requireManualDestroy:true});
  outer.runInAsyncScope(()=>{callbackResource=ah.executionAsyncResource();event('nested');throw marker;});
 }else throw marker;
}));
