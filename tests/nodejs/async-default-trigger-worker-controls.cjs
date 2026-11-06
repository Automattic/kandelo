'use strict';
const assert=require('node:assert/strict');
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
if(!isMainThread){const owner=require(workerData);parentPort.postMessage({initial:owner.resolve(123),previous:owner.swap(88),after:owner.resolve(123)});}
else (async()=>{
 const addon=process.env.KANDELO_DEFAULT_TRIGGER_ADDON;const owner=require(addon);assert.equal(owner.swap(77),-1);
 try{const result=await new Promise((resolve,reject)=>{const worker=new Worker(__filename,{workerData:addon});worker.once('error',reject);worker.once('message',resolve);});
 assert.deepEqual(result,{initial:123,previous:-1,after:88});assert.equal(owner.resolve(123),77);
 console.log(JSON.stringify({scope:'actual native numeric owner per NAPI environment; not candidate Worker engine integration',result,parent:77}));
 }finally{assert.equal(owner.swap(-1),77);}
})().catch(error=>{console.error(error);process.exitCode=1;});
