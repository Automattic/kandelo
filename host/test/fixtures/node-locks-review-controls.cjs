'use strict';
// Focused native26/adapter differentials and injected receiver-transaction
// failures. The addon owns the real portable manager, not host Web Locks.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const worker=require('node:worker_threads'),dc=require('node:diagnostics_channel');
const {createHook}=require('node:async_hooks');
const mode=process.argv[2]||'native',root=path.resolve(__dirname,'../../..');
let locks=worker.locks,failReceiverAt=0,addon;
if(mode==='adapter'){
  const globals=['internalBinding','primordials'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  const {internalBinding}=require('internal/test/binding');
  const markPromiseAsHandled=internalBinding('util').markPromiseAsHandled;
  for(const [key,descriptor] of globals){
    if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
  const original=Function('primordials',fs.readFileSync(path.join(root,'third_party/node-core/upstream/primordials.js'),'utf8')+'\nreturn primordials;')({});
  // Test-only injection before native commit, leaving actual Promise/Map and
  // all portable manager operations intact. Production has no injection path.
  const descriptors=Object.getOwnPropertyDescriptors(original);
  descriptors.Error={...descriptors.Error,value:function(...args){
    if(args[0]==='LOCK_STOLEN'&&failReceiverAt>0&&--failReceiverAt===0)throw new Error('Injected receiver allocation failure');
    return new original.Error(...args);
  }};
  const P=Object.create(null,descriptors);
  const source=fs.readFileSync(path.join(root,'third_party/node-core/locks-platform-adapter.js'),'utf8')
    .replace('/* NODE_LOCKS_MODULE */',fs.readFileSync(path.join(root,'third_party/node-core/upstream/locks/lib/internal/locks.js'),'utf8'))
    .replace('/* NODE_WORKER_LOCKS_LAZY_EXPORT */',(() => {
      const source=fs.readFileSync(path.join(root,'third_party/node-core/upstream/object-marks/lib/worker_threads.js'),'utf8');
      return source.slice(source.indexOf('// The Web Locks API implementation is only needed once `locks` is used.'));
    })());
  const lazyOwner=require(process.env.NODE_LOCKS_LAZY_REFERENCE_BINDING);
  const create=Function('_createNodePrimordials',source+'\nreturn _createNodeLocksPlatform;')(()=>P);
  addon=require(process.argv[3]);
  const platform=create({process,worker,diagnostics:dc,types:require('node:util/types'),
    values:{errors:require('internal/errors'),util:require('internal/util'),validators:require('internal/validators')},
    eventRequire:name=>require(name),native:{locks:addon.locks,markPromiseAsHandled,
      defineNativeLazyDataProperty:lazyOwner.defineNativeLazyDataProperty}});
  const api={};platform.install(api);locks=api.locks;
}
const gate=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const results=[];
async function collected(weak){for(let i=0;i<5;i++){await new Promise(setImmediate);global.gc();}return weak.deref()===undefined;}
(async()=>{
  let promiseCount=0,atCallback;
  const countHook=createHook({init(_id,type){if(type==='PROMISE')promiseCount++;}}).enable();
  const counted=locks.request('actual-promise-count',()=>{atCallback=promiseCount;return 17;});
  countHook.disable();assert.equal(await counted,17);assert.equal(atCallback,3);
  results.push({name:'public plus actual waiting/released Promise init order',atCallback});
  let reads=0,calls=0;
  const value=await locks.request('dual-thenable',()=>({get then(){reads++;return resolve=>{calls++;resolve(calls);};}}));
  assert.deepEqual({reads,calls,value},{reads:2,calls:2,value:2});
  results.push({name:'two real internal Promise assimilations',reads,calls,value});
  reads=0;
  assert.equal(await locks.request('changing-getter',()=>({get then(){if(++reads===1)throw new Error('waiting only');return resolve=>resolve(41);}})),41);
  assert.equal(reads,2);results.push({name:'waiting rejection does not replace independent release result',reads});
  const hold=gate(),held=locks.request('miss-thenable',()=>hold.promise);reads=0;calls=0;
  assert.equal(await locks.request('miss-thenable',{ifAvailable:true},lock=>{
    assert.equal(lock,null);return {get then(){reads++;return resolve=>{calls++;resolve(calls);};}};
  }),2);
  assert.equal(reads,2);assert.equal(calls,2);hold.resolve();await held;
  results.push({name:'miss also owns waiting and released',reads,calls});
  const observations=[];
  assert.equal(await locks.request('getters-and-release',()=>({get then(){
    locks.request('getters-and-release',{ifAvailable:true},lock=>observations.push(lock!==null));
    return resolve=>resolve(59);
  }})),59);
  assert.deepEqual(observations,[false,true]);results.push({name:'waiting getter before release, released getter after',observations});

  let active=false,initializations=0,mutated=false,initVictim;
  const hook=createHook({init(_id,type){if(type==='PROMISE'&&active&&++initializations===2){
    active=false;mutated=true;initVictim=locks.request('query-init-owned',()=>new Promise(()=>{}));initVictim.catch(()=>{});
  }}}).enable();
  active=true;const query=locks.query();active=false;const snapshot=await query;hook.disable();
  assert(mutated);assert(snapshot.held.some(info=>info.name==='query-init-owned'));
  await locks.request('query-init-owned',{steal:true},()=>{});
  results.push({name:'query Promise init precedes snapshot',initializations,mutated});

  async function throwPayload(){
    const payload={token:7},weak=new WeakRef(payload);
    await locks.request('throw-owned-root',()=>{if(payload.token!==7)throw new Error('payload');throw 71;}).catch(()=>{});
    return weak;
  }
  const weak=await throwPayload();assert(await collected(weak));
  assert((await locks.query()).held.some(info=>info.name==='throw-owned-root'));
  await locks.request('throw-owned-root',{steal:true},()=>{});
  results.push({name:'consumed callback root retired, throw-held lock preserved'});

  // These failpoints belong only to the fixture. They validate actual native
  // manager/receiver ownership, not a claim that the real JSAPI was OOM tested.
  if(mode==='adapter'){
    for(let step=0;step<8;step++){
      const name='packet-failure-'+step,block=gate();let settled=false,called=false;
      const victim=locks.request(name,()=>block.promise).then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
      addon.locks('failPacket',step);
      await assert.rejects(locks.request(name,{steal:true},()=>{called=true;}),/Injected packet allocation failure/);
      const state=await locks.query();assert(!called);assert(!settled);
      assert.equal(state.held.filter(info=>info.name===name).length,1);
      assert.equal(state.pending.filter(info=>info.name===name).length,0);
      block.resolve(73);assert.equal(await victim,73);
      assert.equal((await locks.query()).held.filter(info=>info.name===name).length,0);
    }
    results.push({name:'eight packet failure boundaries preserve victims and retire only failed submitter'});
    const block=gate();let settled=false;
    const victim=locks.request('receiver-failure',{mode:'shared'},()=>block.promise).then(value=>{settled=true;return value;});
    const secondVictim=locks.request('receiver-failure',{mode:'shared'},()=>block.promise);
    failReceiverAt=2;
    await assert.rejects(locks.request('receiver-failure',{steal:true},()=>assert.fail('undelivered callback')),/Injected receiver allocation failure/);
    assert(!settled);assert.equal((await locks.query()).held.filter(info=>info.name==='receiver-failure').length,2);
    block.resolve(79);assert.equal(await victim,79);assert.equal(await secondVictim,79);
    results.push({name:'receiver JS allocation before commit leaves holder authoritative'});
  }
  console.log(JSON.stringify({mode,node:process.version,passed:true,results,
    scope:mode==='native'?'exact native26 public/roots controls':'portable owner and receiver adapter; no guest JSAPI, provider runtime or real OOM execution'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
