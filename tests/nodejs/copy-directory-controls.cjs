'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const util=require('node:util');
const {pathToFileURL}=require('node:url');
const candidate=process.argv[2]==='candidate';
const impl=candidate?require('../../host/test/fixtures/node-copy-directory-platform.cjs').create():{api:fs,promises:fs.promises};
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'kandelo-cp-'));
function clean(p){fs.rmSync(p,{force:true,recursive:true});}
function normalize(text){return text.replaceAll(fs.realpathSync(root),'ROOT').replaceAll(root,'ROOT');}
function error(e){return {name:e.name,message:normalize(e.message),code:e.code,
  errno:e.errno,syscall:e.syscall,path:typeof e.path==='string'?normalize(e.path):e.path,
  dest:typeof e.dest==='string'?normalize(e.dest):e.dest,
  own:Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(e)).filter(([k])=>k!=='stack'&&k!=='message').map(([k,v])=>[k,{enumerable:v.enumerable,writable:v.writable,configurable:v.configurable}]))};}
async function call(name,src,dst,opts){
 if(name==='sync')return impl.api.cpSync(src,dst,opts);
 if(name==='promise')return impl.promises.cp(src,dst,opts);
 return new Promise((resolve,reject)=>{let returned=false;
  const value=impl.api.cp(src,dst,opts,e=>{assert(returned,'callback must be asynchronous');e?reject(e):resolve();});
  assert.equal(value,undefined);returned=true;
 });
}
function tree(p){
 if(!fs.existsSync(p))return null;
 const result=[];
 function visit(current,rel){const s=fs.lstatSync(current);const value={path:rel,mode:s.mode&0o7777,type:s.isSymbolicLink()?'link':s.isDirectory()?'dir':s.isFile()?'file':'other'};
  if(s.isSymbolicLink())value.target=normalize(fs.readlinkSync(current));
  if(s.isFile())value.bytes=fs.readFileSync(current).toString('hex');
  result.push(value);if(s.isDirectory())for(const name of fs.readdirSync(current).sort())visit(path.join(current,name),path.join(rel,name));}
 visit(p,'.');return result;
}
const observations=[];
async function outcome(label,callback){try{observations.push({label,value:await callback()});}catch(e){observations.push({label,error:error(e)});}}
const scenarios={
 async tree(){
  const src=path.join(root,'src');fs.mkdirSync(src);fs.mkdirSync(src+'/nested');fs.writeFileSync(src+'/nested/a',Buffer.from([0,1,255,2]));fs.writeFileSync(src+'/b','hello');fs.chmodSync(src+'/nested',0o751);fs.chmodSync(src+'/nested/a',0o640);fs.symlinkSync('nested/a',src+'/link');
  for(const mode of ['sync','promise','callback']){
   const dst=path.join(root,'dst');await call(mode,src,dst,{recursive:true});
   observations.push({mode,tree:tree(dst)});assert.equal(fs.readFileSync(dst+'/nested/a').toString('hex'),'0001ff02');assert.equal(fs.readlinkSync(dst+'/link'),(mode==='sync'?fs.realpathSync(src):src)+'/nested/a');clean(dst);
  }
 },
 async options(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','new');fs.writeFileSync(src+'/b','bee');
  for(const mode of ['sync','promise','callback']){
   fs.mkdirSync(dst);fs.writeFileSync(dst+'/a','old');
   await call(mode,src,dst,{recursive:true,force:false});assert.equal(fs.readFileSync(dst+'/a','utf8'),'old');assert.equal(fs.readFileSync(dst+'/b','utf8'),'bee');
   await outcome(mode+'-exists',()=>call(mode,src,dst,{recursive:true,force:false,errorOnExist:true}));
   const filtered=[];await call(mode,src,dst,{recursive:true,filter:(a,b)=>{filtered.push([a.replaceAll(root,'ROOT'),b.replaceAll(root,'ROOT')]);return !a.endsWith('/b');}});
   assert.equal(fs.readFileSync(dst+'/a','utf8'),'new');observations.push({mode,filtered,tree:tree(dst)});clean(dst);
  }
  const opts={recursive:true,filter:async()=>true};await outcome('sync-async-filter',()=>impl.api.cpSync(src,dst,opts));
  await call('promise',src,dst,opts);assert.equal(fs.readFileSync(dst+'/a','utf8'),'new');
 },
 async errors(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','data');
  for(const mode of ['sync','promise','callback']){
   await outcome(mode+'-same',()=>call(mode,src+'/a',src+'/a',{}));
   await outcome(mode+'-subdirectory',()=>call(mode,src,src+'/sub',{recursive:true}));
   await outcome(mode+'-file-to-dir',()=>call(mode,src+'/a',src,{}));
   await outcome(mode+'-dir-to-file',()=>call(mode,src,src+'/a',{recursive:true}));
   await outcome(mode+'-recursive',()=>call(mode,src,dst,{}));
   await outcome(mode+'-missing',()=>call(mode,src+'/absent',dst,{}));
  }
  assert.equal(fs.readFileSync(src+'/a','utf8'),'data');assert.equal(fs.existsSync(src+'/sub'),false);
 },
 async links(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','data');fs.symlinkSync('a',src+'/link');fs.symlinkSync('missing',src+'/dangling');
  for(const mode of ['sync','promise','callback']){
   await call(mode,src,dst,{recursive:true,verbatimSymlinks:true});assert.equal(fs.readlinkSync(dst+'/link'),'a');assert.equal(fs.readlinkSync(dst+'/dangling'),'missing');observations.push({mode,tree:tree(dst)});clean(dst);
   await outcome(mode+'-dereference',()=>call(mode,src,dst,{recursive:true,dereference:true}));observations.push({mode,partial:tree(dst)});clean(dst);
  }
 },
 async validation(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.writeFileSync(src,'hello');
  for(const options of [null,false,[],{recursive:1},{dereference:true,verbatimSymlinks:true},{filter:1},{mode:-1},{mode:0.5}])
   for(const mode of ['sync','promise','callback'])await outcome(mode+'-'+util.inspect(options),()=>call(mode,src,dst,options));
  for(const name of ['cp','cpSync'])await outcome(name+'-bad-path',()=>impl.api[name](null,dst,{},()=>{}));
  await call('promise',pathToFileURL(src),pathToFileURL(dst),{});assert.equal(fs.readFileSync(dst,'utf8'),'hello');
 },
 async timestamps(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','hello');fs.utimesSync(src+'/a',1000000000.25,1000000001.75);fs.chmodSync(src+'/a',0o444);
  for(const mode of ['sync','promise','callback']){
   await call(mode,src,dst,{recursive:true,preserveTimestamps:true});const a=fs.statSync(src+'/a'),b=fs.statSync(dst+'/a');
   assert.equal(b.mtimeMs,a.mtimeMs);assert.equal(b.mode&0o7777,0o444);observations.push({mode,mtime:b.mtimeMs,permissions:b.mode&0o7777});clean(dst);
  }
 },
 async filterThrow(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','hello');
  for(const mode of ['sync','promise','callback']){const original={mode};let count=0;
   try{await call(mode,src,dst,{recursive:true,filter:()=>{if(++count===2)throw original;return true;}});assert.fail('must throw');}catch(e){assert.equal(e,original);}
   assert.equal(fs.readFileSync(src+'/a','utf8'),'hello');observations.push({mode,partial:tree(dst)});clean(dst);
  }
 },
 async defaults(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.writeFileSync(src,'new');
  for(const mode of ['sync','promise','callback']){
   fs.writeFileSync(dst,'old');await call(mode,src,dst,undefined);
   assert.equal(fs.readFileSync(dst,'utf8'),'new');observations.push({mode,tree:tree(dst)});
  }
 },
 async errorSetter(){
  const src=path.join(root,'src');fs.writeFileSync(src,'data');let calls=0;
  Object.defineProperty(Error.prototype,'code',{configurable:true,set(value){
   calls++;Object.defineProperty(this,'code',{value,writable:true,enumerable:true,configurable:true});
  }});
  let observed;
  try{impl.api.cpSync(src,src,{});assert.fail('same inode must fail');}catch(e){observed=error(e);}
  finally{delete Error.prototype.code;}
  assert.equal(calls,1);assert.equal(observed.code,'ERR_FS_CP_EINVAL');observations.push({calls,error:observed});
 },
 async special(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','hello');
  require(process.env.KANDELO_CP_COMPONENT).makeFifo(src+'/pipe');
  for(const mode of ['sync','promise','callback']){
   await outcome(mode+'-tree-fifo',()=>call(mode,src,dst,{recursive:true}));
   observations.push({mode,tree:tree(dst)});clean(dst);
   await outcome(mode+'-direct-fifo',()=>call(mode,src+'/pipe',dst,{}));
  }
 },
 async replace(){
  const src=path.join(root,'src'),dst=path.join(root,'dst'),kept=path.join(root,'kept');fs.writeFileSync(src,'new');
  for(const mode of ['sync','promise','callback']){
   fs.writeFileSync(kept,'kept');fs.symlinkSync(kept,dst);
   await call(mode,src,dst,{force:true});assert.equal(fs.lstatSync(dst).isSymbolicLink(),false);
   assert.equal(fs.readFileSync(kept,'utf8'),'kept');assert.equal(fs.readFileSync(dst,'utf8'),'new');clean(dst);
   fs.linkSync(src,dst);await outcome(mode+'-same-inode',()=>call(mode,src,dst,{}));clean(dst);
  }
 },
 async freshRace(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','new');
  for(const mode of ['promise','callback']){
   let injected=false;
   const hook=require('node:async_hooks').createHook({init(id,type,trigger,resource){
    if(type==='FSREQCALLBACK'&&resource.constructor.name==='CpDirJob'&&!injected){
     injected=true;fs.mkdirSync(dst);fs.writeFileSync(dst+'/a','race-winner');
    }
   }}).enable();
   try{await outcome(mode+'-race',()=>call(mode,src,dst,{recursive:true}));}
   finally{hook.disable();}
   assert(injected,'actual CpDirJob init must be observable');assert.equal(fs.readFileSync(dst+'/a','utf8'),'race-winner');
   observations.push({mode,tree:tree(dst)});clean(dst);
  }
 },
 async cloneForce(){
  const src=path.join(root,'src'),dst=path.join(root,'dst');fs.mkdirSync(src);fs.writeFileSync(src+'/a','hello');
  for(const mode of ['sync','promise','callback']){await outcome(mode,()=>call(mode,src,dst,{recursive:true,mode:fs.constants.COPYFILE_FICLONE_FORCE}));observations.push({mode,tree:tree(dst)});clean(dst);}
 },
};
Promise.resolve().then(()=>scenarios[process.argv[3]]()).then(()=>console.log(JSON.stringify({scenario:process.argv[3],observations}))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clean(root));
