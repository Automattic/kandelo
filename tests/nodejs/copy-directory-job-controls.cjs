'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const hooks=require('node:async_hooks');
const component=process.argv[2]==='candidate';
const binding=component?require('../../host/test/fixtures/node-copy-directory-platform.cjs').create().binding:require('internal/test/binding').internalBinding('fs');
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'kandelo-cp-job-'));
const events=[];
let job,id,trigger,resolveDestroy,resolveException;
let caller;
const destroyed=new Promise(resolve=>resolveDestroy=resolve);
const thrown=new Promise(resolve=>resolveException=resolve);
const hook=hooks.createHook({
 init(asyncId,type,parent,resource){if(type==='FSREQCALLBACK'){assert.equal(id,undefined);id=asyncId;trigger=parent;events.push('init');}},
 before(asyncId){if(asyncId===id)events.push('before');},
 after(asyncId){if(asyncId===id)events.push('after');},
 destroy(asyncId){if(asyncId===id){events.push('destroy');resolveDestroy();}},
}).enable();
const marker=new Error('original completion failure');
const test=process.argv[3];
if(test==='getterThrow'||test==='callbackThrow')process.once('uncaughtException',error=>{
 assert.equal(error,marker);events.push('uncaught');resolveException();
});
const deadline=setTimeout(()=>{console.error('copy-directory destroy/exception deadline');process.exitCode=1;process.exit(1);},5000);
Promise.resolve().then(async()=>{
 caller=hooks.executionAsyncId();
 const src=root+'/src',dst=root+'/dst';fs.mkdirSync(src);fs.writeFileSync(src+'/file','owned');
 job=new binding.CpDirJob(src,dst,true,false,false,false,false,0);
 assert.equal(trigger,caller);
 Object.defineProperty(job,'ondone',{get(){
  assert.equal(hooks.executionAsyncId(),0);events.push('getter');
  if(test==='getterThrow')throw marker;
  if(test==='noncallable')return 17;
  return function(error,special,specialPath){
   assert.equal(this,job);assert.equal(hooks.executionAsyncId(),id);assert.equal(hooks.executionAsyncResource(),job);
   assert.equal(error,null);assert.equal(special,undefined);assert.equal(specialPath,undefined);
   events.push('callback');if(test==='callbackThrow')throw marker;
  };
 }});
 job.run();
 await destroyed;
 if(test==='getterThrow'||test==='callbackThrow')await thrown;
 assert.equal(fs.readFileSync(dst+'/file','utf8'),'owned');
 if(test==='callable')assert.deepEqual(events,['init','getter','before','callback','after','destroy']);
 if(test==='noncallable')assert.deepEqual(events,['init','getter','destroy']);
 if(test==='getterThrow'){assert.equal(events.includes('before'),false);assert.equal(events.includes('callback'),false);}
 console.log(JSON.stringify({test,events}));
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
 clearTimeout(deadline);hook.disable();fs.rmSync(root,{recursive:true,force:true});
});
