 'use strict';
const assert=require('node:assert/strict'),nativeTimers=require('node:timers'),nativePromises=require('node:timers/promises'),events=require('node:events');
const subject=require('./platform.cjs'),p=subject.promises,t=subject.timers;
const results=[];
const shape=e=>({name:e.name,code:e.code,message:e.message,cause:e.cause});
async function group(name,body){try{results.push({name,result:await body()});}catch(e){results.push({name,nonpass:shape(e)});}}
function observedSignal(){const ac=new AbortController(),trace=[];const add=ac.signal.addEventListener,remove=ac.signal.removeEventListener;
 ac.signal.addEventListener=function(type,...args){trace.push('add:'+type);return Reflect.apply(add,this,[type,...args]);};
 ac.signal.removeEventListener=function(type,...args){trace.push('remove:'+type);return Reflect.apply(remove,this,[type,...args]);};return{ac,trace};}
(async()=>{
 await group('valid options getters are reread in target order',async()=>{
  const order=[],ac=new AbortController();const options={get signal(){order.push('signal');return ac.signal;},get ref(){order.push('ref');return true;}};
  const promise=p.setTimeout(1,'value',options);const during=order.slice();return {value:await promise,during,after:order};
 });
 await group('invalid signal short circuits ref getter',async()=>{
  const trace=[],original={marker:'ref'};let caught,same=false;
  try{await p.setTimeout(1,undefined,{get signal(){trace.push('signal');return null;},get ref(){trace.push('ref');throw original;}});}catch(e){same=e===original;caught=shape(e);}
  return{trace,sameOriginal:caught? same:false,caught};
 });
 await group('original signal getter throw identity',async()=>{
  const marker={sentinel:true};let trace=[],same=false;try{await p.setImmediate(0,{get signal(){trace.push('signal');throw marker;},get ref(){trace.push('ref');return true;}});}catch(e){same=e===marker;}return{trace,same};
 });
 await group('timeout abort cleanup occurs in rejection reaction',async()=>{
  const{ac,trace}=observedSignal();const promise=p.setTimeout(10000,'never',{signal:ac.signal});trace.push('created');ac.abort('because');trace.push('after abort');const immediate=trace.slice();let error;try{await promise;}catch(e){error=shape(e);}return{immediate,final:trace,error};
 });
 await group('immediate abort cleanup occurs in rejection reaction',async()=>{
  const{ac,trace}=observedSignal();const promise=p.setImmediate('never',{signal:ac.signal});trace.push('created');ac.abort('because');trace.push('after abort');const immediate=trace.slice();let error;try{await promise;}catch(e){error=shape(e);}return{immediate,final:trace,error};
 });
 await group('successful timeout removes listener before returned continuation',async()=>{
  const{ac,trace}=observedSignal();const value=await p.setTimeout(1,42,{signal:ac.signal});trace.push('continued');return{value,trace,listeners:events.getEventListeners(ac.signal,'abort').length};
 });
 await group('protected abort resists earlier stopImmediatePropagation',async()=>{
  const ac=new AbortController();ac.signal.addEventListener('abort',event=>event.stopImmediatePropagation());const promise=p.setTimeout(10000,0,{signal:ac.signal});ac.abort('reason');try{await promise;}catch(e){return shape(e);}
  throw Error('Expected abort rejection');
 });
 await group('already aborted reason and rejection',async()=>{
  const signal=AbortSignal.abort('cause');let e;try{await p.setTimeout(1,0,{signal});}catch(x){e=shape(x);}return e;
 });
 await group('invalid ref rich error and no timer',async()=>{try{await p.setTimeout(1,0,{ref:'yes'});}catch(e){return shape(e);}throw Error('Missing invalid-ref rejection');});
 await group('null options rejected as target object error',async()=>{try{await p.setImmediate(0,null);}catch(e){return shape(e);}throw Error('Missing invalid-options rejection');});
 await group('interval return retires listener and preserves values',async()=>{
  const{ac,trace}=observedSignal();const it=p.setInterval(1,'tick',{signal:ac.signal});const first=await it.next(),second=await it.next(),done=await it.return('stop');return{first,second,done,trace,listeners:events.getEventListeners(ac.signal,'abort').length};
 });
 await group('interval abort while waiting retires actual interval',async()=>{
  const{ac,trace}=observedSignal();const it=p.setInterval(10000,0,{signal:ac.signal});const pending=it.next();ac.abort('interval');let error;try{await pending;}catch(e){error=shape(e);}return{error,trace,listeners:events.getEventListeners(ac.signal,'abort').length};
 });
 await group('scheduler actual methods receiver and constructor errors',async()=>{
  const scheduler=p.scheduler;let ctor,wait,yieldError;try{new scheduler.constructor();}catch(e){ctor=shape(e);}try{scheduler.wait.call({},1);}catch(e){wait=shape(e);}try{scheduler.yield.call({});}catch(e){yieldError=shape(e);}return{ctor,wait,yieldError,value:await scheduler.wait(1),yieldValue:await scheduler.yield()};
 });
 await group('real returned owner namespace and function descriptors',()=>{
  const fn=x=>({name:x.name,length:x.length,ownPrototype:Object.hasOwn(x,'prototype'),constructor:x.constructor.name});return{same:t.promises===p,promisifyTimeout:require('node:util').promisify(t.setTimeout)===p.setTimeout,promisifyImmediate:require('node:util').promisify(t.setImmediate)===p.setImmediate,timeout:fn(p.setTimeout),immediate:fn(p.setImmediate),interval:fn(p.setInterval),scheduler:Object.getOwnPropertyNames(Object.getPrototypeOf(p.scheduler))};
 });
 await group('unreferenced timeout still runs with real referenced keeper',async()=>{const keeper=nativeTimers.setTimeout(()=>{},1000);try{return{value:await p.setTimeout(1,'unref',{ref:false})};}finally{nativeTimers.clearTimeout(keeper);}});
 await group('Promise timeout uses current monotonic insertion origin',async()=>{const start=process.hrtime.bigint();await p.setTimeout(40);const elapsed=Number(process.hrtime.bigint()-start)/1e6;return{delayedAtLeast25ms:elapsed>=25};});
 await group('classic timeout immediate and interval still deliver once',async()=>{
  let a=0,b=0,c=0;const x=t.setTimeout(()=>a++,1);t.setImmediate(()=>b++);const interval=t.setInterval(()=>{c++;t.clearInterval(interval);},1);await nativePromises.setTimeout(25);return{a,b,c,timeoutDestroyed:x._destroyed,intervalDestroyed:interval._destroyed};
 });
 await group('Timeout construction alone does not insert a scheduled task',async()=>{
  const timer=t.setTimeout(()=>{},10000),Ctor=timer.constructor;t.clearTimeout(timer);let fired=false;const orphan=new Ctor(()=>fired=true,1,undefined,false,true);await nativePromises.setTimeout(20);const result={fired};t.clearTimeout(orphan);return result;
 });
 console.log(JSON.stringify({phase:subject.phase,results,scope:'Actual shared production timer/Promise source over explicit native scheduler/event/byte/errors/async fixture owners; no guest JSAPI/four-host acceptance'}));
})().finally(subject.cleanup).catch(e=>{console.error(e);process.exitCode=1});
