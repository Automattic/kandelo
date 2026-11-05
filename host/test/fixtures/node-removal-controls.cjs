'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {execFileSync}=require('node:child_process');
const {create}=require('./node-removal-platform.cjs');
const scenario=process.argv[2];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-rm-control-'));
const outcome=fn=>{try{fn();return undefined;}catch(e){return {name:e.name,code:e.code,errno:e.errno,syscall:e.syscall};}};
const callback=(api,p,options)=>new Promise((resolve,reject)=>api.rm(p,options,error=>error?reject(error):resolve()));
(async()=>{try{
 const candidate=create();
 if(scenario==='validation') {
  for(const options of [null,[],false,{force:1},{recursive:'yes'},{retryDelay:-1},{retryDelay:1.5},{maxRetries:-1},{maxRetries:1.5}]) {
   assert.deepEqual(outcome(()=>candidate.api.rmSync(path.join(root,'missing'),options)),outcome(()=>fs.rmSync(path.join(root,'missing'),options)));
  }
  for(const p of [undefined,{},42,'a\0b',Buffer.from([97,0,98])])
   assert.deepEqual(outcome(()=>candidate.api.rmSync(p)),outcome(()=>fs.rmSync(p)));
 } else if(scenario==='force-errors') {
  for(const force of [false,true]) {
   assert.deepEqual(outcome(()=>candidate.api.rmSync(path.join(root,'missing'),{force})),outcome(()=>fs.rmSync(path.join(root,'missing'),{force})));
   let callbackDone=false;
   const promise=new Promise(resolve=>candidate.api.rm(path.join(root,'missing'),{force},error=>{assert.equal(callbackDone,true);resolve(error?.code);}));
   callbackDone=true;assert.equal(await promise,force?undefined:'ENOENT');
  }
  const denied=Object.assign(Error('denied'),{code:'EACCES',errno:-13});
  const c=create({fs:{lstatSync(){throw denied;},lstat(p,cb){setImmediate(cb,denied);}}});
  assert.throws(()=>c.api.rmSync(path.join(root,'denied'),{force:true}),error=>error===denied);
  await assert.rejects(c.promises.rm(path.join(root,'denied'),{force:true}),error=>error===denied);
 } else if(scenario==='trees') {
  for(const mode of ['sync','callback','promise']) {
   const target=path.join(root,mode);fs.mkdirSync(path.join(target,'a','b'),{recursive:true});fs.writeFileSync(path.join(target,'a','file'),'x');
   const outside=path.join(root,mode+'-outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'keep');fs.symlinkSync(outside,path.join(target,'link'));
   if(mode==='sync')assert.equal(candidate.api.rmSync(target,{recursive:true}),undefined);
   else if(mode==='callback')await callback(candidate.api,target,{recursive:true});else await candidate.promises.rm(target,{recursive:true});
   assert.equal(fs.existsSync(target),false);assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'keep');
  }
 } else if(scenario==='paths') {
  for(const p of [path.join(root,'space name'),path.join(root,'utf8-\u00ff')]) {
   fs.writeFileSync(p,'x');candidate.api.rmSync(pathToFileURL(p));assert.equal(fs.existsSync(p),false);
   fs.writeFileSync(p,'x');await candidate.promises.rm(Buffer.from(p));assert.equal(fs.existsSync(p),false);
  }
  for(const mode of ['sync','callback','promise']) {
   const p=path.join(root,'dir-'+mode);fs.mkdirSync(p);
   const expected=outcome(()=>fs.rmSync(p,{force:true}));
   if(mode==='sync')assert.deepEqual(outcome(()=>candidate.api.rmSync(p,{force:true})),expected);
   else {let error;try{if(mode==='callback')await callback(candidate.api,p,{force:true});else await candidate.promises.rm(p,{force:true});}catch(e){error=e;}assert.equal(error.code,expected.code);assert.equal(error.syscall,'rm');}
   assert.equal(fs.existsSync(p),true);
  }
 } else if(scenario==='retry') {
  const p=path.join(root,'busy');fs.writeFileSync(p,'x');let attempts=0;const delays=[];
  const c=create({fs:{unlink(p,cb){if(++attempts<3)return setImmediate(cb,Object.assign(Error('busy'),{code:'EBUSY'}));return fs.unlink(p,cb);}},
   timers:{setTimeout(fn,delay,...args){delays.push(delay);return setTimeout(fn,delay,...args);}}});
  await c.promises.rm(p,{maxRetries:2,retryDelay:1});assert.equal(attempts,3);assert.deepEqual(delays,[1,2]);assert.equal(fs.existsSync(p),false);
  const denied=Object.assign(Error('read-only'),{code:'EROFS'});
  const c2=create({fs:{unlink(p,cb){setImmediate(cb,denied);}},timers:{setTimeout(){assert.fail('Nonretryable failure scheduled a retry');}}});
  fs.writeFileSync(p,'x');await assert.rejects(c2.promises.rm(p,{recursive:true,force:true,maxRetries:3}),error=>error===denied);assert.equal(fs.existsSync(p),true);
 } else if(scenario==='race') {
  const p=path.join(root,'disappears');fs.writeFileSync(p,'x');
  const c=create({fs:{unlink(p,cb){fs.unlinkSync(p);fs.unlink(p,cb);}}});await c.promises.rm(p);assert.equal(fs.existsSync(p),false);
 } else if(scenario==='vfs') {
  let sync=0,async=0;candidate.truncation.vfsState.handlers={rmSync(){sync++;return true;},rm(){async++;return Promise.resolve();}};
  candidate.api.rmSync({});await callback(candidate.api,{},{});await candidate.promises.rm({});assert.equal(sync,1);assert.equal(async,2);
 } else if(scenario==='scan') {
  const helper=process.env.KANDELO_REMOVAL_NATIVE_HELPER;assert.ok(helper);
  for(const name of ['z','a','\u00ff'])fs.writeFileSync(path.join(root,name),'x');
  const actual=JSON.parse(execFileSync(helper,['scan',Buffer.from(root).toString('hex')],{encoding:'utf8',timeout:5000}));
  assert.equal(actual.status,0);assert.deepEqual(actual.names,fs.readdirSync(root,{encoding:'buffer'}).map(name=>name.toString('hex')));
  const missing=path.join(root,'missing');const error=outcome(()=>fs.readdirSync(missing));
  const failed=JSON.parse(execFileSync(helper,['scan',Buffer.from(missing).toString('hex')],{encoding:'utf8',timeout:5000}));assert.equal(failed.status,error.errno);
 } else throw Error('Unknown control '+scenario);
 console.log(JSON.stringify({scenario,passed:true}));
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
