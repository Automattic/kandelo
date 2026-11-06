'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const wt=require('node:worker_threads'),dc=require('node:diagnostics_channel');
assert.equal(process.version,'v26.13.0');
const root=path.resolve(__dirname,'../../../..'),mode=process.argv[2],scenario=process.argv[3];
const loaded=()=>process.moduleLoadList.includes('NativeModule internal/locks');
assert.equal(loaded(),false);
let api=wt,adapter,privateRequire;
if(mode==='adapter') {
 const {internalBinding}=require('internal/test/binding');
 const primordials=Function('primordials',fs.readFileSync(path.join(root,'third_party/node-core/upstream/primordials.js'),'utf8')+'\nreturn primordials;')({});
 const values={errors:require('internal/errors'),util:require('internal/util'),validators:require('internal/validators')};
 const workerSource=fs.readFileSync(path.join(root,'third_party/node-core/worker-platform-adapter.js'),'utf8');
 const createWorker=Function('_createNodePrimordials',workerSource+'\nreturn _createNodeWorkerPlatform;')(()=>primordials);
 const worker=createWorker({native:{worker(){throw new Error('Worker launch outside this control scope');}},process,EventEmitter:require('node:events').EventEmitter,values,ports:{}});
 api=worker.api;
 const publicSource=fs.readFileSync(path.join(root,'third_party/node-core/upstream/locks/lib/internal/locks.js'),'utf8');
 const workerPublic=fs.readFileSync(path.join(root,'third_party/node-core/upstream/object-marks/lib/worker_threads.js'),'utf8');
 const anchor='// The Web Locks API implementation is only needed once `locks` is used.';
 let source=fs.readFileSync(path.join(root,'third_party/node-core/locks-platform-adapter.js'),'utf8');
 source=source.replace('/* NODE_LOCKS_MODULE */',publicSource).replace('/* NODE_WORKER_LOCKS_LAZY_EXPORT */',workerPublic.slice(workerPublic.indexOf(anchor)));
 const createLocks=Function('_createNodePrimordials',source+'\nreturn _createNodeLocksPlatform;')(()=>primordials);
 adapter=createLocks({process,worker:worker.internal,values,diagnostics:dc,types:require('node:util/types'),eventRequire:require,
  native:require('./adapter-surface.cjs')({locks:require(process.argv[4]).locks,
   markPromiseAsHandled:internalBinding('util').markPromiseAsHandled,
   defineNativeLazyDataProperty:require(process.argv[5]).defineNativeLazyDataProperty})});
 adapter.install(api);privateRequire=id=>adapter.require(id);
} else privateRequire=require;
const descriptor=()=>{const d=Object.getOwnPropertyDescriptor(api,'locks');return d&&{keys:Object.keys(d),type:typeof d.value,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable};};
const requireModule=()=>privateRequire('internal/locks');
(async()=>{
 const trace={scenario,initial:loaded()};assert.equal(trace.initial,false);
 switch(scenario) {
 case 'keys':trace.value=Object.keys(api).includes('locks');assert.equal(trace.value,true);break;
 case 'has':trace.value=Object.hasOwn(api,'locks')&&'locks'in api;assert.equal(trace.value,true);break;
 case 'descriptor':trace.descriptor=descriptor();assert.deepEqual(trace.descriptor,{keys:['value','writable','enumerable','configurable'],type:'object',writable:true,enumerable:true,configurable:true});break;
 case 'inherited':{const child=Object.create(api);trace.same=child.locks===api.locks;trace.own=Object.hasOwn(child,'locks');assert.equal(trace.same,true);assert.equal(trace.own,false);break;}
 case 'foreign':{const value=vm.runInNewContext('obj.locks',{obj:api});trace.same=value===api.locks;trace.mainPrototype=Object.getPrototypeOf(value)===requireModule().LockManager.prototype;assert.equal(trace.same,true);assert.equal(trace.mainPrototype,true);break;}
 case 'inherited-set':{const child=Object.create(api);child.locks=19;trace.value=child.locks;trace.own=Object.hasOwn(child,'locks');assert.equal(trace.value,19);assert.equal(trace.own,true);break;}
 case 'own-set':api.locks=19;trace.value=api.locks;assert.equal(trace.value,19);break;
 case 'delete':trace.value=delete api.locks;assert.equal(trace.value,true);assert.equal(Object.hasOwn(api,'locks'),false);break;
 case 'define-empty':Object.defineProperty(api,'locks',{});trace.descriptor=descriptor();assert.equal(trace.descriptor.type,'object');break;
 case 'define-value':Object.defineProperty(api,'locks',{value:19});trace.value=api.locks;assert.equal(trace.value,19);break;
 case 'define-accessor':Object.defineProperty(api,'locks',{get(){return 19;}});trace.value=api.locks;assert.equal(trace.value,19);break;
 case 'define-nonenum':Object.defineProperty(api,'locks',{enumerable:false});trace.descriptor=descriptor();assert.equal(trace.descriptor.enumerable,false);assert.equal(trace.descriptor.type,'object');break;
 case 'define-nonwrite':Object.defineProperty(api,'locks',{writable:false});trace.descriptor=descriptor();assert.equal(trace.descriptor.writable,false);assert.equal(trace.descriptor.type,'object');break;
 case 'define-nonconfig':Object.defineProperty(api,'locks',{configurable:false});trace.descriptor=descriptor();assert.equal(trace.descriptor.configurable,false);assert.equal(trace.descriptor.type,'object');break;
 case 'sealed-set':Object.seal(api);api.locks=19;trace.value=api.locks;assert.equal(trace.value,19);assert.equal(Object.getOwnPropertyDescriptor(api,'locks').configurable,false);break;
 case 'seal':case 'freeze':case 'preventExtensions':{
  Object[scenario](api);trace.beforeRead=loaded();assert.equal(trace.beforeRead,false);
  trace.type=typeof api.locks;trace.descriptor=descriptor();assert.equal(trace.type,'object');
  assert.equal(trace.descriptor.configurable,scenario==='preventExtensions');assert.equal(trace.descriptor.writable,scenario!=='freeze');break;
 }
 case 'frozen-set-delete':Object.freeze(api);assert.throws(()=>{api.locks=19;},TypeError);assert.equal(Reflect.deleteProperty(api,'locks'),false);trace.beforeRead=loaded();assert.equal(trace.beforeRead,false);trace.type=typeof api.locks;break;
 case 'frozen-define-reject':Object.freeze(api);assert.throws(()=>Object.defineProperty(api,'locks',{writable:true}),TypeError);trace.type=typeof api.locks;break;
 case 'singleton-shadow':{const singleton=requireModule().locks;api.locks=19;trace.same=requireModule().locks===singleton;trace.value=api.locks;assert.equal(trace.same,true);assert.equal(trace.value,19);break;}
 case 'singleton-delete':{const singleton=api.locks;delete api.locks;trace.same=requireModule().locks===singleton;assert.equal(trace.same,true);break;}
 case 'initialization-retry':{
  const channel=dc.channel,sentinel={sentinel:true};let calls=0;
  dc.channel=function(...args){calls++;if(calls===1)throw sentinel;return Reflect.apply(channel,this,args);};
  try{assert.throws(()=>api.locks,e=>e===sentinel);trace.afterThrow=loaded();assert.equal(trace.afterThrow,false);const manager=api.locks;trace.same=manager===requireModule().locks;assert.equal(trace.same,true);trace.calls=calls;assert.equal(calls,5);}finally{dc.channel=channel;}break;
 }
 case 'initialization-cycle':{
  const channel=dc.channel;let partial;
  dc.channel=function(...args){if(!partial)partial=requireModule();return Reflect.apply(channel,this,args);};
  try{const manager=api.locks;trace.partialKeys=Object.keys(partial);trace.replaced=partial!==requireModule();trace.same=manager===requireModule().locks;assert.deepEqual(trace.partialKeys,[]);assert.equal(trace.replaced,true);assert.equal(trace.same,true);}finally{dc.channel=channel;}break;
 }
 case 'thread-id-shadow':{
  const actual=wt.threadId;api.threadId=98123;
  const manager=api.locks;await manager.request('worker-lazy-identity',async lock=>{
   trace.lockName=lock.name;trace.lockMode=lock.mode;const state=await manager.query();const held=state.held.find(x=>x.name===lock.name);
   assert.equal(held.clientId,`node-${process.pid}-${actual}`);trace.correctIdentity=true;
  });break;
 }
 case 'real-lock-classes':{
  const module=requireModule(),manager=api.locks;assert.equal(manager,module.locks);assert.equal(manager.constructor,module.LockManager);
  assert.throws(()=>new module.LockManager(),TypeError);assert.throws(()=>new module.Lock(),TypeError);
  await manager.request('lazy-real-lock',lock=>{assert.equal(lock.constructor,module.Lock);trace.tags=[Object.prototype.toString.call(manager),Object.prototype.toString.call(lock)];trace.attrs=['name','mode'].map(k=>{const d=Object.getOwnPropertyDescriptor(module.Lock.prototype,k);assert.equal(d.enumerable,true);assert.equal(d.set,undefined);return[d.enumerable,d.configurable,typeof d.get,d.set===undefined];});});break;
 }
 case 'gc-retained':{
  assert.equal(typeof global.gc,'function');global.gc();const manager=api.locks;global.gc();trace.same=manager===api.locks&&manager===requireModule().locks;assert.equal(trace.same,true);assert.deepEqual(await manager.query(),{held:[],pending:[]});break;
 }
 case 'reentry-property':{
  const channel=dc.channel;let reentered=false;
  dc.channel=function(...args){if(!reentered){reentered=true;void api.locks;}return Reflect.apply(channel,this,args);};
  try{void api.locks;}finally{dc.channel=channel;}break;
 }
 default:throw new Error('Unknown scenario');
 }
 trace.after=loaded();
 if(['keys','has','inherited-set','own-set','delete','sealed-set'].includes(scenario))assert.equal(trace.after,false);else assert.equal(trace.after,true);
 console.log(JSON.stringify({scope:mode==='adapter'?'Candidate JS consumer + actual portable LockManager over real V8 native lazy owner; NOT SpiderMonkey/guest proof':'Exact pinned Node26 target',trace}));
})().catch(e=>{console.error(e);process.exitCode=1;});
