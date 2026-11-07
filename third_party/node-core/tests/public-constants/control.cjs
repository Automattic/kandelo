'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
function plain(value){return JSON.parse(JSON.stringify(value));}
function descriptors(object){return Object.fromEntries(Object.getOwnPropertyNames(object).map(name=>{
 const descriptor=Object.getOwnPropertyDescriptor(object,name);
 return [name,{value:descriptor.value,get:typeof descriptor.get,set:typeof descriptor.set,
  enumerable:descriptor.enumerable,writable:descriptor.writable,configurable:descriptor.configurable}];
}));}
async function child(mode,name){
 const candidate=mode==='candidate'?require('./platform.cjs').create({tlsCipherList:process.env.CONTROL_CIPHER_LIST}):null;
 const req=candidate?.req||require,proc=candidate?.proc||process;
 const binding=candidate?.binding||require('internal/test/binding').internalBinding('constants');
 const before=Object.hasOwn(binding.crypto,'defaultCipherList');assert.equal(before,false,'fresh-process load order');
 let warnings=0;proc.emitWarning=function(){warnings++;};
 if(name==='header-bags'){
  const native=require('internal/test/binding').internalBinding('constants');
  for(const key of ['errno','priority','dlopen'])assert.deepEqual(descriptors(binding.os[key]),descriptors(native.os[key]));
  assert.deepEqual(descriptors(binding.crypto),descriptors(native.crypto));
  return {counts:{errno:Object.keys(binding.os.errno).length,priority:Object.keys(binding.os.priority).length,dlopen:Object.keys(binding.os.dlopen).length,crypto:Object.keys(binding.crypto).length},warnings};
 }
 if(name==='metadata'){
  const Module=candidate?.Module||require('node:module');
  assert.equal(Module.isBuiltin('constants'),true);assert.equal(Module.isBuiltin('node:constants'),true);
  assert.equal(Object.hasOwn(binding.crypto,'defaultCipherList'),false);
  return {warnings,hasDefaultCipherList:false};
 }
 let value;
 if(name==='constants-first'){
  value=req('constants');assert.equal(Object.hasOwn(value,'defaultCipherList'),false);
  const crypto=req('node:crypto');assert.equal(crypto.constants,binding.crypto);
  assert.equal(Object.hasOwn(value,'defaultCipherList'),false);
  assert.equal(crypto.constants.defaultCipherList,process.env.CONTROL_CIPHER_LIST||binding.crypto.defaultCoreCipherList);
 }else if(name==='crypto-first'||name==='custom-option'||name==='public-descriptor'){
  const crypto=req('crypto');assert.equal(crypto.constants,binding.crypto);
  assert.deepEqual(Object.getOwnPropertyDescriptor(crypto,'constants'),{value:binding.crypto,writable:false,enumerable:true,configurable:false});
  const lazy=Object.getOwnPropertyDescriptor(binding.crypto,'defaultCipherList');
  assert.equal(typeof lazy.get,'function');assert.equal(typeof lazy.set,'function');assert.equal(lazy.configurable,true);assert.equal(lazy.enumerable,true);
  value=req('constants');assert.equal(value.defaultCipherList,process.env.CONTROL_CIPHER_LIST||binding.crypto.defaultCoreCipherList);
  assert.deepEqual(Object.getOwnPropertyDescriptor(binding.crypto,'defaultCipherList'),{value:value.defaultCipherList,writable:true,enumerable:true,configurable:true});
 }else if(name==='setter-before-aggregate'){
  const crypto=req('crypto');crypto.constants.defaultCipherList='changed actual shared bag';
  value=req('constants');assert.equal(value.defaultCipherList,'changed actual shared bag');
 }else if(name==='setter-after-aggregate'){
  const crypto=req('crypto');value=req('constants');const captured=value.defaultCipherList;
  crypto.constants.defaultCipherList='changed after snapshot';assert.equal(value.defaultCipherList,captured);
 }else if(name==='retry'||name==='reentrant'){
  let reads=0,reentered;
  Object.defineProperty(binding.crypto,'CONTROL_GETTER',{enumerable:true,configurable:true,get(){reads++;
   if(name==='retry'&&reads===1)throw Error('actual source-bag getter throws');
   if(name==='reentrant')reentered=req('node:constants');return 73;}});
  if(name==='retry')assert.throws(()=>req('constants'),/actual source-bag getter throws/);
  value=req('constants');assert.equal(value.CONTROL_GETTER,73);
  if(name==='reentrant')assert.equal(reentered,value);
  assert.equal(reads,name==='retry'?2:1);
  delete binding.crypto.CONTROL_GETTER;
 }else if(name==='cache-poison'){
  const Module=candidate?.Module||require('node:module'),fake={cache:true};
  Module._cache.constants={exports:fake,loaded:true};assert.equal(req('constants'),fake);
  value=req('node:constants');assert.notEqual(value,fake);delete Module._cache.constants;
  assert.equal(req('constants'),value);
 }else if(name==='assign-overlap'){
  // Match actual OS initialization. Pinned lib/os.js freezes signals, so
  // injecting an overlap property there is illegal and is not the subject.
  require('node:os');assert.equal(Object.isFrozen(binding.os.signals),true);
  for(const [i,bag]of [[0,binding.os.dlopen],[1,binding.os.errno],[2,binding.os.priority],[4,binding.fs],[5,binding.crypto]])
   Object.defineProperty(bag,'CONTROL_OVERLAP',{value:i,enumerable:true,configurable:true});
  value=req('constants');assert.equal(value.CONTROL_OVERLAP,5);
  for(const bag of [binding.os.dlopen,binding.os.errno,binding.os.priority,binding.os.signals,binding.fs,binding.crypto])delete bag.CONTROL_OVERLAP;
 }else throw Error('unknown case '+name);
 assert.equal(req('constants'),value);assert.equal(req('node:constants'),value);
 assert.equal(proc.getBuiltinModule('node:constants'),value);
 assert.notEqual(value,binding.fs);assert.equal(Object.getPrototypeOf(value),Object.prototype);assert.equal(Object.isFrozen(value),true);
 for(const key of Object.keys(value)){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);assert.equal(descriptor.enumerable,true);
 }
 assert.equal(warnings,0,'DEP0008 is documentation-only');
 return {warnings,count:Object.keys(value).length,hasDefaultCipherList:Object.hasOwn(value,'defaultCipherList'),
  defaultCipherList:value.defaultCipherList,defaultCoreCipherList:value.defaultCoreCipherList,keys:Object.keys(value),values:plain(value)};
}
if(process.argv[2]==='child')child(process.argv[3],process.argv[4]).then(result=>console.log(JSON.stringify(result)),err=>{console.error(err);process.exitCode=1;});
else{
 const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});const results=[];
 for(const name of ['header-bags','metadata','constants-first','crypto-first','custom-option','public-descriptor','setter-before-aggregate','setter-after-aggregate','retry','reentrant','cache-poison','assign-overlap'].filter(name=>!process.argv[3]||name===process.argv[3])){
  const result={name};for(const mode of ['native','candidate']){
   const flags=['--expose-internals'];if(mode==='native'&&name==='custom-option')flags.push('--tls-cipher-list=CUSTOM-ACTUAL-CLI');
   const env={...process.env};delete env.NODE_OPTIONS;if(name==='custom-option')env.CONTROL_CIPHER_LIST='CUSTOM-ACTUAL-CLI';else delete env.CONTROL_CIPHER_LIST;
   const command=[process.execPath,...flags,__filename,'child',mode,name];const run=cp.spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:10000,env});
   fs.writeFileSync(path.join(out,name+'-'+mode+'.stdout'),run.stdout||'');fs.writeFileSync(path.join(out,name+'-'+mode+'.stderr'),run.stderr||'');result[mode]={command,exit:run.status,signal:run.signal,error:run.error?.message};
   try{result[mode].value=JSON.parse(run.stdout);}catch(err){result[mode].parseError=err.message;}
  }
  try{assert.equal(result.native.exit,0);assert.equal(result.candidate.exit,0);assert.deepEqual(result.candidate.value,result.native.value);result.status='pass';}
  catch(err){result.status='fail';result.failure=err.message;}results.push(result);
 }
 const report={scope:'Conditional native header collector and actual generated constants/public-crypto-constants/cache/CJS owners over explicit native FS/signals/VM and opaque existing crypto API identity; no guest/full-crypto/ESM proof',results,pass:results.filter(x=>x.status==='pass').length,fail:results.filter(x=>x.status==='fail').length,compilations:0,overallSuites:0,productSetup:0};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,fail:report.fail,results:results.map(({name,status,failure})=>({name,status,failure}))},null,2));process.exitCode=report.fail?1:0;
}
