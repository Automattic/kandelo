'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {AsyncLocalStorage}=require('node:async_hooks');
const mode=process.argv[2],kind=process.argv[3],tree=path.resolve(process.argv[4]);
assert.equal(process.version,'v26.13.0');assert(['native','candidate'].includes(mode));
if(mode==='candidate')require('./platform.cjs').install(tree);
const out={kind},events=[];
function done(){process.stdout.write('RESULT '+JSON.stringify({...out,events})+'\n');}
function caught(fn){try{return{value:fn()};}catch(e){return{name:e.name,code:e.code,message:e.message};}}
if(kind==='public'){
 out.methods=['setUncaughtExceptionCaptureCallback','addUncaughtExceptionCaptureCallback','hasUncaughtExceptionCaptureCallback'].map(name=>{const d=Object.getOwnPropertyDescriptor(process,name);return{name,fn:process[name].name,length:process[name].length,enumerable:d.enumerable,configurable:d.configurable,writable:d.writable};});
 out.invalid=[];for(const v of [undefined,null,0,false,'x',{},[],Symbol('s')])out.invalid.push({set:caught(()=>process.setUncaughtExceptionCaptureCallback(v)),add:caught(()=>process.addUncaughtExceptionCaptureCallback(v))});
 out.has=process.hasUncaughtExceptionCaptureCallback();done();
}else if(kind==='report-order'){
 const r=process.report,key='reportOnUncaughtException',d=Object.getOwnPropertyDescriptor(r,key);assert.equal(typeof d.get,'function');assert.equal(typeof d.set,'function');
 r[key]=true;Object.defineProperty(r,key,{configurable:true,enumerable:d.enumerable,get(){events.push('get');return Reflect.apply(d.get,r,[]);},set(v){events.push(['set',v]);Reflect.apply(d.set,r,[v]);}});
 process.addUncaughtExceptionCaptureCallback(()=>false);events.push(['add1',process.hasUncaughtExceptionCaptureCallback()]);
 process.addUncaughtExceptionCaptureCallback(()=>true);events.push(['add2',process.hasUncaughtExceptionCaptureCallback()]);
 process.setUncaughtExceptionCaptureCallback(()=>{});events.push(['set-primary',process.hasUncaughtExceptionCaptureCallback()]);
 process.setUncaughtExceptionCaptureCallback(null);events.push(['clear-primary',process.hasUncaughtExceptionCaptureCallback()]);out.final=Reflect.apply(d.get,r,[]);done();
}else if(kind==='report-throw-set'||kind==='report-throw-add'){
 const original={marker:'original-report-error'},r=process.report,key='reportOnUncaughtException',d=Object.getOwnPropertyDescriptor(r,key);assert.equal(typeof d.get,'function');assert.equal(typeof d.set,'function');
 Object.defineProperty(r,key,{configurable:true,get(){events.push('get');return true;},set(v){events.push(['set',v]);throw original;}});
 try{process[kind.endsWith('set')?'setUncaughtExceptionCaptureCallback':'addUncaughtExceptionCaptureCallback'](()=>{});out.same=false;}catch(e){out.same=e===original;}
 out.has=process.hasUncaughtExceptionCaptureCallback();Object.defineProperty(r,key,d);done();
}else if(kind==='aux-order'||kind==='primary-priority'||kind==='aux-unhandled'||kind==='aux-throws'){
 const als=new AsyncLocalStorage();process.on('uncaughtExceptionMonitor',(error,origin)=>events.push(['monitor',error.message,origin,als.getStore()]));
 if(kind==='aux-order'){
  process.addUncaughtExceptionCaptureCallback(e=>{events.push(['oldest',e.message,als.getStore()]);return true;});
  process.addUncaughtExceptionCaptureCallback(e=>{events.push(['truthy',e.message,als.getStore()]);return 1;});
  process.addUncaughtExceptionCaptureCallback(e=>{events.push(['newest',e.message,als.getStore()]);return false;});
 }else if(kind==='primary-priority'){
  process.addUncaughtExceptionCaptureCallback(e=>{events.push(['auxiliary',e.message,als.getStore()]);return true;});
  process.setUncaughtExceptionCaptureCallback(e=>{events.push(['primary',e.message,als.getStore()]);process.setUncaughtExceptionCaptureCallback(null);setImmediate(()=>{throw Error('second');});});
 }else if(kind==='aux-unhandled')process.addUncaughtExceptionCaptureCallback(e=>{events.push(['false',e.message,als.getStore()]);return false;});
 else process.addUncaughtExceptionCaptureCallback(e=>{events.push(['throwing',e.message,als.getStore()]);throw Error('handler-failure');});
 process.on('exit',()=>done());als.run('session-store',()=>setImmediate(()=>{throw Error('first');}));
}else if(kind==='plain-abort'||kind==='listener-abort'||kind==='clear-abort'){
 process.on('exit',()=>done());
 if(kind==='listener-abort')process.on('uncaughtException',e=>events.push(['listener',e.message]));
 if(kind==='clear-abort')process.setUncaughtExceptionCaptureCallback(e=>{process.stdout.write('CAPTURE '+e.message+'\n');process.setUncaughtExceptionCaptureCallback(null);setImmediate(()=>{throw Error('second-after-clear');});});
 setImmediate(()=>{throw Error('first');});
}else if(kind==='worker-inherit'){
 const {Worker}=require('node:worker_threads');const helper=require.resolve('./platform.cjs');
 const code=`const{workerData}=require('node:worker_threads');if(workerData.mode==='candidate')require(workerData.helper).install(workerData.tree);setImmediate(()=>{throw Error('worker-failure');});`;
 const w=new Worker(code,{eval:true,workerData:{mode,tree,helper}});w.on('error',e=>events.push(['worker-error',e.message]));w.on('exit',status=>{out.workerExit=status;done();});
}else throw Error('unknown kind '+kind);
