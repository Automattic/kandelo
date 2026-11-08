 'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const nativeTimers=require('node:timers'),nativePromises=require('node:timers/promises');
const util=require('node:util'),osNative=require('node:os'),events=require('node:events');
const base=path.resolve(process.env.TIMER_OWNER_CAPSULE||path.join(__dirname,'..'));
const repository=path.resolve(process.env.TIMER_OWNER_REPO||path.join(__dirname,'../../../..'));
const phase=process.env.TIMER_OWNER_PHASE||'after';
assert(['native','before','after'].includes(phase));
let cleanup=()=>{};
function build(){
 const source=fs.readFileSync(phase==='before'?path.join(base,'before/packages/registry/node-compat/bootstrap.js'):(process.env.TIMER_OWNER_BOOTSTRAP||path.join(repository,'packages/registry/node-compat/bootstrap.js')),'utf8');
 const bundle=fs.readFileSync(phase==='before'?path.join(base,'baseline-core.js'):path.join(repository,'third_party/node-core/node-core.js'),'utf8');
 const factory=Function(bundle+';return {primordials:_createNodePrimordials,values:_createNodeValuesPlatform,promises:typeof _createNodeTimersPromisesPlatform==="function"?_createNodeTimersPromisesPlatform:undefined};')();
 const values=factory.values({process,Buffer,util,inspection:util,os:osNative,signals:osNative.constants.signals,getDOMException:()=>DOMException});
 const async=require(path.join(repository,'host/test/fixtures/node-async-platform.cjs')).createAsyncPlatformControl();
 const live=new Set(),metrics={timeoutStarts:0,immediateStarts:0,cancels:0};
 function timerNow(){return Number(process.hrtime.bigint())/1e6;}
 const os={timerNow,
  setTimeout(callback,delay,ref,start){
   metrics.timeoutStarts++;const token={kind:'timeout'};
   const remaining=start===undefined?delay:Math.max(0,delay-(timerNow()-start));
   token.handle=nativeTimers.setTimeout(()=>{live.delete(token);callback();},remaining);
   if(!ref)token.handle.unref();live.add(token);return token;
  },
  setImmediate(callback){metrics.immediateStarts++;const token={kind:'immediate'};token.handle=nativeTimers.setImmediate(()=>{live.delete(token);callback();});live.add(token);return token;},
  clearTimeout(token){if(!token)return;metrics.cancels++;(token.kind==='immediate'?nativeTimers.clearImmediate:nativeTimers.clearTimeout)(token.handle);live.delete(token);},
  timerRef(token,ref){if(token)(ref?token.handle.ref():token.handle.unref());},
 };
 const begin=source.indexOf(source.includes('let _nodeTimerInternals;')?'let _nodeTimerInternals;':'const timers = (() => {');
 const end=source.indexOf('\nconst _nodeRemovalPlatform',begin);assert(begin>=0&&end>begin);
 const pa=source.indexOf('const timersPromises = ',end),pb=source.indexOf('\n_nodeEventPlatform = _createNodeEventPlatform({',pa);assert(pa>end&&pb>pa);
 const event={validators:values.validators,addAbortListener:events.addAbortListener,require(name){assert.equal(name,'internal/event_target');return require('internal/event_target');}};
 const execute=Function('os','process','_nodeAsyncPlatform','_nodeEventPlatform','_nodeDispose','_nodeValues','_createNodeTimersPromisesPlatform','_createNodePrimordials','_nodeInspection',source.slice(begin,end)+'\n'+source.slice(pa,pb)+';return {timers,promises:timersPromises};');
 const result=execute(os,process,async,event,Symbol.dispose,values,factory.promises,factory.primordials,{inspect:util.inspect});
 cleanup=()=>{for(const token of live)os.clearTimeout(token);async.close();};
 return {...result,metrics,live,asyncHooks:async.api};
}
const subject=phase==='native'?{timers:nativeTimers,promises:nativePromises,asyncHooks:require('node:async_hooks')}:build();
module.exports={...subject,phase,cleanup};
if(process.env.TIMER_OWNER_PRELOAD==='1'){
 const Module=require('node:module'),load=Module._load;
 Module._load=function(name,...args){
  if(name==='node:timers/promises'||name==='timers/promises')return subject.promises;
  if(name==='node:timers'||name==='timers')return subject.timers;
  return Reflect.apply(load,this,[name,...args]);
 };
 process.on('exit',cleanup);
}
