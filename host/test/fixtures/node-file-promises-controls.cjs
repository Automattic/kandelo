'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {AsyncLocalStorage,createHook}=require('node:async_hooks');
async function root(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-promise-file-'));try{return await run(dir)}finally{fs.rmSync(dir,{force:true,recursive:true})}}
function record(error,dir){return {name:error.name,code:error.code,syscall:error.syscall,path:error.path?.replaceAll(dir,'$ROOT'),message:error.message.replaceAll(dir,'$ROOT'),cause:error.cause}}
async function failure(run,dir){try{await run();return {unexpectedSuccess:true}}catch(e){return record(e,dir)}}
exports.controls={
 async bytesModesAndFrozenAppendOptions(api){return root(async dir=>{
  const out=[];
  for(const [i,data,options] of [[0,'hé\ud800',{encoding:'utf8'}],[1,'ff0081',{encoding:'hex'}],[2,'€',{encoding:'utf16le'}],[3,new DataView(new Uint8Array([0,1,2,0]).buffer,1,2),{}],[4,'',{mode:0}]]){
   const file=path.join(dir,String(i));await api.writeFile(file,data,options);const mode=fs.statSync(file).mode&0o777;if(!mode)fs.chmodSync(file,0o600);out.push([fs.readFileSync(file).toString('hex'),mode]);
  }
  const file=path.join(dir,'append'),options=Object.freeze({encoding:'hex',mode:0o600});await api.writeFile(file,'61',{encoding:'hex'});await api.appendFile(file,'62',options);out.push(fs.readFileSync(file).toString('hex'),options);return out;
 });},
 async flushedIterablesAndFailureCleanup(api){return root(async dir=>{
  const file=path.join(dir,'file');await api.writeFile(file,['a',Buffer.from([0]),new Uint8Array([98])],{flush:true});
  const first=fs.readFileSync(file).toString('hex');
  async function* iterable(){yield '😀';await new Promise(resolve=>setImmediate(resolve));yield Buffer.from('é');}
  await api.appendFile(file,iterable(),{flush:true});const second=fs.readFileSync(file).toString('hex');
  const sentinel=Error('iterator failure');let finalized=false;
  async function* bad(){try{yield 'prefix';throw sentinel}finally{finalized=true}}
  await assert.rejects(api.writeFile(file,bad()),error=>error===sentinel);assert(finalized);
  return [first,second,fs.readFileSync(file,'utf8')];
 });},
 async existingHandlesAndDescriptorOffsets(api){return root(async dir=>{
  const file=path.join(dir,'file');fs.writeFileSync(file,'abcdef');const handle=await api.open(file,'r+');
  try{await handle.read(Buffer.alloc(2),0,2,null);await api.writeFile(handle,'XY');await api.appendFile(handle,new Uint8Array([90]),{flush:true});const output=await api.readFile(handle,'utf8');assert.equal(output,'f');assert.equal((await handle.stat()).isFile(),true);return [output,fs.readFileSync(file,'utf8'),handle.fd>=0]}finally{await handle.close()}
 });},
 async validationAbortAndErrorSettlement(api){return root(async dir=>{
  const file=path.join(dir,'file'),controller=new AbortController();controller.abort('actual reason');
  const results=[];
  for(const [name,args] of [['writeFile',[file,'x',{signal:controller.signal}]],['appendFile',[file,'x',{signal:controller.signal}]],['writeFile',[file,{}]],['writeFile',[file,'x',{flush:'yes'}]],['writeFile',[1,'x']],['writeFile',[path.join(dir,'missing','file'),'x']],['appendFile',[dir,'x']]]){
   let returned=false;const promise=api[name](...args);assert(promise instanceof Promise);const pending=promise.then(()=>({unexpectedSuccess:true}),error=>({...record(error,dir),async:returned}));returned=true;const result=await pending;assert.equal(result.async,true);results.push(result);
  }
  assert.equal(fs.existsSync(file),false);return results;
 });},
 async nativeRequestsAndAsyncScope(api){return root(async dir=>{
  const local=new AsyncLocalStorage(),types=[];const hook=createHook({init(_id,type){if(type==='FSREQCALLBACK'||type==='FSREQPROMISE'||type==='FILEHANDLE')types.push(type)}}).enable();
  try{return await local.run('file-scope',async()=>{const file=path.join(dir,'file');await api.writeFile(file,'first');assert.equal(local.getStore(),'file-scope');await api.appendFile(file,'second');assert.equal(local.getStore(),'file-scope');assert.equal(fs.readFileSync(file,'utf8'),'firstsecond');return types})}finally{hook.disable()}
 });},
};
