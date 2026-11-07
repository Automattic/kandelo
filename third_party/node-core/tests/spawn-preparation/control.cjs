'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
assert.equal(process.version,'v26.13.0');
const platform=require('./platform.cjs'),native=platform.component,source=process.env.SPAWN_SOURCE;
const rows=[],failures=[];
function judge(name,fn){return Promise.resolve().then(fn).then(()=>rows.push({name,pass:true}),error=>{failures.push({name,message:error.message});rows.push({name,pass:false})})}
const snapshots=()=>native.snapshot();
async function synchronous(name,options){await judge(name,()=>{const marker=new Error('original '+name);Object.defineProperty(marker,'errno',{get(){throw new Error('original marker errno must not be inspected')}});const before=snapshots();const fixture=platform.create({source,stopLaunch:marker});let actual;try{fixture.spawn(process.execPath,['-e',''],options(marker))}catch(error){actual=error}try{assert.equal(actual,marker);assert.deepEqual(snapshots(),before);assert.equal(fixture.spawnCalls,0)}finally{fixture.cleanup()}})}
function summary(child){return Object.fromEntries(['pid','exitCode','signalCode','stdin','stdout','stderr','stdio'].map(k=>[k,child[k]===undefined?'undefined':child[k]===null?'null':typeof child[k]==='object'?'object':child[k]]))}
(async()=>{
 for(const [name,options]of[
  ['cwd option getter',m=>({get cwd(){throw m}})],
  ['stdio option getter',m=>({get stdio(){throw m}})],
  ['stdio index1 getter',m=>({stdio:Object.defineProperty(['pipe',null,'pipe'],'1',{get(){throw m}})})],
  ['stdio index2 getter',m=>({stdio:Object.defineProperty(['pipe','pipe',null],'2',{get(){throw m}})})],
  ['stdio fd getter',m=>({stdio:['pipe',{get fd(){throw m}},'pipe']})],
  ['stdio second fd getter',m=>{let count=0;return{stdio:['pipe',{get fd(){if(++count===2)throw m;return 1}},'pipe']}}],
  ['env value conversion',m=>({env:{A:{toString(){throw m}}}})],
 ])await synchronous(name,options);
 for(const step of [1,2,3])await judge('actual EMFILE at pipe '+step,async()=>{
  const before=snapshots(),fixture=platform.create({source,pressureAt:step});let child,thrown;
  try{child=fixture.spawn(process.execPath,['-e',''])}catch(error){thrown=error}
  try{
   assert.equal(thrown,undefined);assert(child instanceof fixture.ChildProcess);
   assert.deepEqual(summary(child),{pid:'undefined',exitCode:'null',signalCode:'null',stdin:'undefined',stdout:'undefined',stderr:'undefined',stdio:'undefined'});
   assert.equal(Object.hasOwn(child,'pid'),false);assert.equal(fixture.spawnCalls,0);assert.equal(fixture.pipeCalls,step);assert.equal(fixture.created.length,step-1);
   const trace=['return'];let operationError;child.on('spawn',()=>trace.push('spawn'));child.on('error',error=>{operationError=error;trace.push('error')});const result=await new Promise(resolve=>child.once('close',(code,signal)=>{trace.push('close');resolve({code,signal})}));
   assert.deepEqual(trace,['return','error','close']);assert.equal(operationError.code,'EMFILE');assert.equal(operationError.syscall,'spawn '+process.execPath);assert.equal(operationError.path,process.execPath);assert.equal(child.exitCode,-os.constants.errno.EMFILE);assert.deepEqual(result,{code:-os.constants.errno.EMFILE,signal:null});assert.deepEqual(snapshots(),before);
   for(const pair of fixture.created){assert.equal(pair.readFlags.cloexec,1);assert.equal(pair.writeFlags.cloexec,1);assert.equal(pair.readFlags.nonblock,pair.parentReads?1:0);assert.equal(pair.writeFlags.nonblock,pair.parentReads?0:1)}
  }finally{fixture.cleanup()}
 });
 await judge('user getter wins before physical EMFILE',()=>{
  const marker={exact:true},before=snapshots(),fixture=platform.create({source,pressureAt:1});let actual;
  try{fixture.spawn(process.execPath,['-e',''],{stdio:Object.defineProperty(['pipe',null,'pipe'],'1',{get(){throw marker}})})}catch(error){actual=error}
  try{assert.equal(actual,marker);assert.equal(fixture.pipeCalls,0);assert.deepEqual(snapshots(),before)}finally{fixture.cleanup()}
 });
 await judge('native pair adoption bypasses user Array iterator',()=>{
  const marker={original:true},before=snapshots(),fixture=platform.create({source,stopLaunch:marker});
  const descriptor=Object.getOwnPropertyDescriptor(Array.prototype,Symbol.iterator);let actual;
  Object.defineProperty(Array.prototype,Symbol.iterator,{configurable:true,writable:true,value(){throw marker}});
  try{fixture.spawn(process.execPath,['-e',''])}catch(error){actual=error}finally{Object.defineProperty(Array.prototype,Symbol.iterator,descriptor)}
  try{assert.equal(actual,marker);assert.equal(fixture.spawnCalls,1);assert.deepEqual(snapshots(),before)}finally{fixture.cleanup()}
 });
 await judge('native own-element fd publication bypasses Array setters',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(Array.prototype,'0');let writes=0,pair;
  Object.defineProperty(Array.prototype,'0',{configurable:true,set(){writes++}});
  try{pair=native.pipe(true,3)}finally{if(descriptor)Object.defineProperty(Array.prototype,'0',descriptor);else delete Array.prototype[0]}
  try{assert.equal(writes,0);assert.equal(Object.getOwnPropertyDescriptor(pair,'0').enumerable,true);assert.equal(typeof pair[0],'number');assert.equal(typeof pair[1],'number');native.flags(pair[0]);native.flags(pair[1])}finally{native.close(pair[0]);native.close(pair[1])}
 });
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-spawn-owner-'));
 try{
  for(const [name,file,code,async]of [['ENOENT',path.join(scratch,'missing'),'ENOENT',true],['EACCES',path.join(scratch,'not-executable'),'EACCES',true]]){
   if(name==='EACCES')fs.writeFileSync(file,'plain data',{mode:0o600});
   await judge('actual '+name+' launch rollback',async()=>{const before=snapshots(),fixture=platform.create({source});try{let child;try{child=fixture.spawn(file,[],{stdio:'pipe'})}catch(error){throw error}const trace=['return'];child.on('spawn',()=>trace.push('spawn'));let actual;child.on('error',error=>{actual=error;trace.push('error')});await new Promise(resolve=>child.once('close',()=>{trace.push('close');resolve()}));assert.deepEqual(trace,['return','error','close']);assert.equal(actual.code,code);assert.deepEqual(snapshots(),before)}finally{fixture.cleanup()}})
  }
  await judge('actual EBADF inherited fd fails synchronously',()=>{const fd=fs.openSync('/dev/null','r');fs.closeSync(fd);const before=snapshots(),fixture=platform.create({source});let actual;try{const child=fixture.spawn(process.execPath,['-e',''],{stdio:['ignore',fd,'ignore']});child?.on('error',()=>{})}catch(error){actual=error}try{assert.equal(actual.code,'EBADF');assert.equal(actual.syscall,'spawn');assert.deepEqual(snapshots(),before)}finally{fixture.cleanup()}});
  await judge('borrowed valid fd survives prepared launch failure',()=>{const fd=fs.openSync(path.join(scratch,'borrowed'),'w');const before=snapshots(),flags=native.flags(fd),marker={original:true},fixture=platform.create({source,stopLaunch:marker});let actual;try{const child=fixture.spawn(process.execPath,['-e',''],{stdio:['pipe',{fd},'pipe']});child?.on('error',()=>{})}catch(error){actual=error}try{assert.equal(actual,marker);assert.deepEqual(native.flags(fd),flags);assert.deepEqual(snapshots(),before)}finally{fixture.cleanup();fs.closeSync(fd)}});
  await judge('real borrowed fd child output and wait cleanup',async()=>{const name=path.join(scratch,'actual-output'),fd=fs.openSync(name,'w'),before=snapshots(),flags=native.flags(fd),fixture=platform.create({source});try{const child=fixture.spawn(process.execPath,['-e','process.stdout.write("actual OFD bytes")'],{stdio:['ignore',fd,'ignore']});const trace=[];child.on('spawn',()=>trace.push('spawn'));child.on('exit',code=>trace.push('exit:'+code));await new Promise((resolve,reject)=>{child.on('error',reject);child.once('close',code=>{trace.push('close:'+code);resolve()})});assert.deepEqual(trace,['spawn','exit:0','close:0']);assert.equal(fs.readFileSync(name,'utf8'),'actual OFD bytes');assert.deepEqual(native.flags(fd),flags);assert.deepEqual(snapshots(),before)}finally{fixture.cleanup();fs.closeSync(fd)}});
  await judge('real pipe child output and stdin exit cleanup',async()=>{const before=snapshots(),fixture=platform.create({source});try{const child=fixture.spawn(process.execPath,['-e','process.stdout.write("actual pipe bytes")']);const chunks=[],trace=[];child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.resume();child.on('spawn',()=>trace.push('spawn'));child.on('exit',code=>trace.push('exit:'+code));await new Promise((resolve,reject)=>{child.on('error',reject);child.once('close',code=>{trace.push('close:'+code);resolve()})});assert.deepEqual(trace,['spawn','exit:0','close:0']);assert.equal(Buffer.concat(chunks).toString(),'actual pipe bytes');assert.equal(child.stdin.destroyed,true);assert.deepEqual(snapshots(),before)}finally{fixture.cleanup()}});
 }finally{fs.rmSync(scratch,{recursive:true,force:true})}
 console.log(JSON.stringify({scope:'exact async-spawn frontend with real native POSIX fd/action/process dependencies; readiness/streams/errors are explicit native host controls, not guest JSAPI/four-host acceptance',rows,failures}));if(failures.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
