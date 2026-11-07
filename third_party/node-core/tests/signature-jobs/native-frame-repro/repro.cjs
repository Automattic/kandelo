'use strict';
const assert=require('node:assert/strict');const hooks=require('node:async_hooks');const crypto=require('node:crypto');const addon=require('./component.node');
async function observe(explicitFrame){
 const als=new hooks.AsyncLocalStorage(),marker={frame:true};const trace=[];let id,owner;
 const {promise:destroyed,resolve:destroy}=Promise.withResolvers();
 const timer=setTimeout(()=>destroy('timeout'),3000);
 const hook=hooks.createHook({init(n,type){if(type==='NATIVE_FRAME_CONTROL')id=n;},before(n){if(n===id)trace.push({event:'before',frame:als.getStore()===marker});},after(n){if(n===id)trace.push({event:'after',frame:als.getStore()===marker});},destroy(n){if(n===id)destroy('destroy');}});
 hook.enable();
 try{
  const value=await als.run(marker,()=>new Promise(resolve=>{owner=addon.schedule(explicitFrame,function(){resolve({frame:als.getStore()===marker,id:hooks.executionAsyncId()===id,resource:hooks.executionAsyncResource()===this,owner:this===owner});});}));
  assert.equal(await destroyed,'destroy');return{value,trace};
 }finally{clearTimeout(timer);hook.disable();als.disable();}
}
(async()=>{
 const publicPath=await observe(false),explicitPath=await observe(true);
 const als=new hooks.AsyncLocalStorage(),marker={nativeCrypto:true};const pair=crypto.generateKeyPairSync('ed25519');
 const cryptoControl=await als.run(marker,()=>new Promise((resolve,reject)=>crypto.sign(null,Buffer.from('x'),pair.privateKey,function(error){if(error)reject(error);else resolve(als.getStore()===marker);})));als.disable();
 const expectedExplicit={value:{frame:true,id:true,resource:true,owner:true},trace:[{event:'before',frame:true},{event:'after',frame:true}]};
 assert.deepEqual(explicitPath,expectedExplicit);assert.equal(cryptoControl,true);
 const preserved=publicPath.value.id&&publicPath.value.resource&&publicPath.value.owner;
 assert.equal(preserved,true);
 const verdict=publicPath.value.frame?'not-reproduced':'reproduced';
 console.log('REPRO-VERDICT '+JSON.stringify({verdict,details:{version:process.version,os:process.platform,publicPath,explicitPath,cryptoControl,meaning:'native C++ public callback path resets captured ALS frame; no Kandelo code involved'}}));
})().catch(error=>{console.error(error);console.log('REPRO-VERDICT '+JSON.stringify({verdict:'inconclusive',details:{error:error.message}}));process.exitCode=1;});
