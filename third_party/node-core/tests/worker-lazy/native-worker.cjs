'use strict';
const assert=require('node:assert/strict');assert.equal(process.version,'v26.13.0');
const {Worker}=require('node:worker_threads');
const worker=new Worker(`
 const assert=require('node:assert/strict'),wt=require('node:worker_threads');
 const actual=wt.threadId;wt.threadId=91823;
 assert.equal(process.moduleLoadList.includes('NativeModule internal/locks'),false);
 const manager=wt.locks;
 manager.request('lazy-worker-identity',async lock=>{
  const state=await manager.query();
  assert.equal(state.held[0].clientId,'node-'+process.pid+'-'+actual);
  wt.parentPort.postMessage({actual,privateIdentityCorrect:true,lockType:lock.constructor.name});
 });
`,{eval:true});
let message,exit;const deadline=setTimeout(()=>{worker.terminate();throw new Error('Native Worker control timeout');},5000);
worker.on('message',value=>{message=value;});
worker.on('error',error=>{throw error;});
worker.on('exit',code=>{clearTimeout(deadline);exit=code;assert.equal(exit,0);assert.equal(message.privateIdentityCorrect,true);assert.equal(message.actual>0,true);assert.equal(message.lockType,'Lock');console.log(JSON.stringify({scope:'Exact pinned real native Worker only; candidate guest Worker/JSAPI not executed',message,exit}));});
