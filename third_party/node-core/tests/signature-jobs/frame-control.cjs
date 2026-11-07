'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),hooks=require('node:async_hooks');
const api=require('./platform.cjs').create();const key=crypto.generateKeyPairSync('ed25519').privateKey;const data=Buffer.from('actual callback frames');
async function observe(c,kind){
 const storage=new hooks.AsyncLocalStorage(),outer={},init={},before={},callback={};const trace=[];let id,resource,expectedTrigger;
 const name=()=>{const x=storage.getStore();return x===outer?'outer':x===init?'init':x===before?'before':x===callback?'callback':x===undefined?'none':'other';};
 const {promise:destroyed,resolve:finish}=Promise.withResolvers();const timeout=setTimeout(()=>finish('timeout'),3000);
 const hook=hooks.createHook({init(n,type,trigger,owner){if(type==='SIGNREQUEST'&&id===undefined){id=n;resource=owner;trace.push({event:'init',frame:name(),trigger:trigger===expectedTrigger});if(kind==='init changes ambient')storage.enterWith(init);}},before(n){if(n===id){trace.push({event:'before',frame:name()});if(kind==='before/callback changes')storage.enterWith(before);}},after(n){if(n===id)trace.push({event:'after',frame:name()});},destroy(n){if(n===id){trace.push({event:'destroy'});finish('destroy');}}});
 hook.enable();
 try{
  let afterCall;
  await storage.run(outer,()=>new Promise((resolve,reject)=>{
   expectedTrigger=hooks.executionAsyncId();c.sign(null,data,key,function(error,result){
    try{assert.ifError(error);trace.push({event:'callback',frame:name(),id:hooks.executionAsyncId()===id,trigger:hooks.triggerAsyncId()===expectedTrigger,resource:hooks.executionAsyncResource()===resource,receiver:this===resource,verified:crypto.verify(null,data,crypto.createPublicKey(key),result)});if(kind==='before/callback changes')storage.enterWith(callback);resolve();}catch(error){reject(error);}
   });afterCall=name();
  }));
  assert.equal(storage.getStore(),undefined);assert.equal(await destroyed,'destroy');
  return {trace,afterCall,restored:true};
 }finally{clearTimeout(timeout);hook.disable();storage.disable();}
}
(async()=>{
 const rows=[];
 for(const kind of ['normal','init changes ambient','before/callback changes']){
  const native=await observe(crypto,kind),candidate=await observe(api,kind);assert.deepEqual(candidate,native,kind);
  const callback=native.trace.find(x=>x.event==='callback');assert.equal(callback.frame,kind==='before/callback changes'?'before':'outer');
  assert.ok(callback.id&&callback.trigger&&callback.resource&&callback.receiver&&callback.verified);
  assert.deepEqual(native.trace.map(x=>x.event),['init','before','callback','after','destroy']);
  rows.push({kind,pass:true,native,candidate});
 }
 console.log(JSON.stringify({groups:rows.length,failures:0,rows,scope:'Exact native callback entry plus actual captured frame/IDs/hooks/destroy; candidate guest JSAPI/fatal/worker conformance unexecuted'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
