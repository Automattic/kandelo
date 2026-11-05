'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {AsyncLocalStorage,createHook,executionAsyncId}=require('node:async_hooks');
function root() { return fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-path-metadata-')); }
function outcome(fn,base) {
  try { return {value:fn()}; }
  catch(e) {
    const text=value=>typeof value==='string'?value.replaceAll(base,'<root>'):value;
    return {name:e.name,code:e.code,errno:e.errno,message:text(e.message),path:text(e.path),dest:text(e.dest),keys:Object.keys(e)};
  }
}
module.exports={
  accessModeAndErrors(candidate) {
    const base=root(),file=path.join(base,'file');fs.writeFileSync(file,'bytes',{mode:0o600});
    try {
      const result=[];
      for(const mode of [undefined,null,0,1,7,8,-1,1.9,-0.9,7.9,2**32,NaN,Infinity,'1',true,{}]) {
        result.push(outcome(()=>candidate.api.accessSync(file,mode),base));
      }
      return result;
    } finally { fs.rmSync(base,{recursive:true,force:true}); }
  },
  syncIdentityModeAndTimes(candidate) {
    const base=root(),file=path.join(base,'file'),link=path.join(base,'link'),dangling=path.join(base,'dangling');
    fs.writeFileSync(file,'bytes');fs.symlinkSync('file',link);fs.symlinkSync('missing',dangling);
    try {
      assert.equal(candidate.api.chmodSync(Buffer.from(file),'0640'),undefined);
      assert.equal(candidate.api.chownSync(pathToFileURL(file),process.getuid(),process.getgid()),undefined);
      assert.equal(candidate.api.lchownSync(dangling,-1,-1),undefined);
      assert.equal(candidate.api.utimesSync(link,new Date(1000125),'2000.25'),undefined);
      const before=fs.statSync(file,{bigint:true}).mtimeNs;
      assert.equal(candidate.api.lutimesSync(new Uint8Array(Buffer.from(link)),3000.125,4000.25),undefined);
      return {mode:fs.statSync(file).mode&0o7777,uid:fs.statSync(file).uid,gid:fs.statSync(file).gid,
        before:String(before),target:String(fs.statSync(file,{bigint:true}).mtimeNs),link:String(fs.lstatSync(link,{bigint:true}).mtimeNs)};
    } finally { fs.rmSync(base,{recursive:true,force:true}); }
  },
  async callbacks(candidate) {
    const base=root(),file=path.join(base,'file');fs.writeFileSync(file,'bytes');
    const storage=new AsyncLocalStorage(),resources=new Set();
    const hook=createHook({init(id,type){if(type==='FSREQCALLBACK')resources.add(id);}}).enable();
    try {
      return await storage.run('metadata-scope',async()=>{
        const results=[];
        for(const [name,args] of [['access',[file]],['chmod',[file,0o640]],['chown',[file,-1,-1]],
          ['lchown',[file,-1,-1]],['utimes',[file,1000.125,2000.25]],['lutimes',[file,3000.125,4000.25]]]) {
          let returned=false;
          await new Promise((resolve,reject)=>{
            candidate.api[name](...args,function(error){
              try {
                assert.equal(returned,true);assert.equal(error,null);assert.equal(arguments.length,1);
                assert.equal(this,undefined);assert.equal(storage.getStore(),'metadata-scope');
                assert(resources.has(executionAsyncId()));results.push(name);resolve();
              } catch(e){reject(e);}
            });
            returned=true;
          });
        }
        return results;
      });
    } finally { hook.disable();fs.rmSync(base,{recursive:true,force:true}); }
  },
  async promiseAndErrorParity(candidate) {
    const base=root(),file=path.join(base,'file'),missing=path.join(base,'missing');fs.writeFileSync(file,'bytes');
    try {
      const results=[];
      for(const [name,args] of [['access',[]],['chmod',[0o640]],['chown',[-1,-1]],['lchown',[-1,-1]],
        ['utimes',[1000.125,2000.25]],['lutimes',[3000.125,4000.25]]]) {
        assert.equal(await candidate.promises[name](file,...args),undefined);
        try { await candidate.promises[name](missing,...args);assert.fail('missing path must reject'); }
        catch(e) {assert.equal(e.code,'ENOENT');results.push({name,code:e.code,syscall:e.syscall,path:e.path.replaceAll(base,'<root>')});}
      }
      return results;
    } finally { fs.rmSync(base,{recursive:true,force:true}); }
  },
  async initAndQueuedPathSnapshots(candidate) {
    const base=root(),alpha=path.join(base,'alpha'),bravo=path.join(base,'bravo');
    try {
      fs.writeFileSync(bravo,'bytes');
      let bytes=Buffer.from(alpha),seen=0;
      let hook=createHook({init(_id,type){if(type==='FSREQCALLBACK'){seen++;bytes.set(Buffer.from(bravo));}}}).enable();
      try {
        await new Promise((resolve,reject)=>{
          candidate.api.access(bytes,error=>error?reject(error):resolve());
          bytes.fill(0x78);
        });assert.equal(seen,1);
      } finally {hook.disable();}
      fs.writeFileSync(alpha,'bytes');fs.unlinkSync(bravo);bytes=Buffer.from(alpha);seen=0;
      hook=createHook({init(_id,type){if(type==='FSREQPROMISE'){seen++;bytes.set(Buffer.from(bravo));}}}).enable();
      try {await candidate.promises.access(bytes);assert.equal(seen,1);}finally{hook.disable();}
      return ['callback-after-init','promise-before-init','queued-owned-path'];
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
  rawAndEmptyPathErrors(candidate) {
    const base=root();
    try {
      const paths=['',Buffer.alloc(0),Buffer.concat([Buffer.from(path.join(base,'raw-')),Buffer.from([0xff,0xfe])]),
        pathToFileURL(path.join(base,'missing snow 雪'))];
      return paths.map(value=>outcome(()=>candidate.api.accessSync(value),base));
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
  validationOrder(candidate) {
    const base=root();
    try {
      return [
        outcome(()=>candidate.api.access(null,{},undefined),base),
        outcome(()=>candidate.api.chown(null,true,-1,undefined),base),
        outcome(()=>candidate.api.lchown(null,true,-1,undefined),base),
        outcome(()=>candidate.api.chmodSync(null,{}),base),
        outcome(()=>candidate.api.utimes(null,'bad',{},undefined),base),
        outcome(()=>candidate.api.lutimes(null,'bad',{},undefined),base),
        outcome(()=>candidate.api.chownSync('/unused',-2,0),base),
        outcome(()=>candidate.api.chmodSync('/unused',-1),base),
      ];
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
  hardlinkSyncOwnership(candidate) {
    const base=root(),src=path.join(base,'source'),dst=path.join(base,'destination');
    try {
      fs.writeFileSync(src,'before');
      assert.equal(candidate.api.linkSync(pathToFileURL(src),Buffer.from(dst)),undefined);
      const same=fs.statSync(src).ino===fs.statSync(dst).ino;
      const links=fs.statSync(src).nlink;
      fs.appendFileSync(dst,' after');fs.unlinkSync(src);
      const retained=fs.readFileSync(dst,'utf8'),remaining=fs.statSync(dst).nlink;
      const symlink=path.join(base,'symlink'),alias=path.join(base,'symlink-alias');
      fs.symlinkSync('destination',symlink);candidate.api.linkSync(symlink,alias);
      return {same,links,retained,remaining,symlink:fs.lstatSync(alias).isSymbolicLink(),target:fs.lstatSync(alias).isSymbolicLink()?fs.readlinkSync(alias):fs.readFileSync(alias,'utf8')};
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
  hardlinkErrorsAndValidation(candidate) {
    const base=root(),src=path.join(base,'source'),dst=path.join(base,'destination');
    try {
      fs.writeFileSync(src,'source');fs.writeFileSync(dst,'destination');
      const raw=Buffer.concat([Buffer.from(base+'/missing-'),Buffer.from([0xff])]);
      return [[null,null],[src,null],['',dst],[src,''],[path.join(base,'missing'),dst],
        [src,dst],[raw,path.join(base,'raw-dest')],[src,path.join(base,'missing-parent/dest')]]
        .map(args=>outcome(()=>candidate.api.linkSync(...args),base)).concat([
          outcome(()=>candidate.api.link(null,null,undefined),base),
          outcome(()=>candidate.api.link(src,null,()=>{}),base),
        ]);
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
  async hardlinkCallbackScopeAndCopies(candidate) {
    const base=root(),src=path.join(base,'source'),alpha=path.join(base,'alpha'),bravo=path.join(base,'bravo');
    const storage=new AsyncLocalStorage(),resources=new Set();let dest=Buffer.from(alpha),seen=0;
    fs.writeFileSync(src,'owned');
    const hook=createHook({init(id,type){if(type==='FSREQCALLBACK'){resources.add(id);seen++;dest.set(Buffer.from(bravo));}}}).enable();
    try {
      await storage.run('hardlink-context',()=>new Promise((resolve,reject)=>{
        let returned=false;
        candidate.api.link(Buffer.from(src),dest,function(error){
          try {assert.equal(error,null);assert.equal(arguments.length,1);assert.equal(this,undefined);
            assert.equal(returned,true);assert.equal(storage.getStore(),'hardlink-context');
            assert(resources.has(executionAsyncId()));resolve();}catch(e){reject(e);}
        });
        returned=true;dest.fill(0x78);
      }));
      return {seen,alpha:fs.existsSync(alpha),bravo:fs.readFileSync(bravo,'utf8'),links:fs.statSync(src).nlink};
    } finally {hook.disable();fs.rmSync(base,{recursive:true,force:true});}
  },
  async hardlinkPromiseDestination(candidate) {
    const base=root(),src=path.join(base,'source'),dst=path.join(base,'destination');fs.writeFileSync(src,'promise');
    try {
      assert.equal(await candidate.promises.link(Buffer.from(src),pathToFileURL(dst)),undefined);
      const results=[];
      for(const [from,to] of [[src,dst],[path.join(base,'missing'),path.join(base,'alias')]]) {
        let error;try{await candidate.promises.link(from,to);}catch(e){error=e;}
        assert(error);results.push(outcome(()=>{throw error;},base));
      }
      let returned=false;const promise=candidate.promises.link(null,null);returned=true;
      await assert.rejects(promise,{code:'ERR_INVALID_ARG_TYPE'});assert(returned);
      return {contents:fs.readFileSync(dst,'utf8'),errors:results};
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
  sharedCompletionDestination(candidate) {
    const base=root(),src=path.join(base,'missing'),dst=path.join(base,'destination');
    try {
      const expected=outcome(()=>fs.linkSync(src,dst),base);
      if(!candidate.complete)return expected;
      let received;
      candidate.complete.call({oncomplete(error){assert.equal(arguments.length,1);received=error;}},
        expected.errno,'link',undefined,Buffer.from(src),Buffer.from(dst));
      const result=outcome(()=>{throw received;},base);
      assert.deepEqual(result,expected);
      let arity;
      candidate.complete.call({oncomplete(error){assert.equal(error,null);arity=arguments.length;}},0,'access',undefined,undefined,undefined);
      assert.equal(arity,1);
      return result;
    } finally {fs.rmSync(base,{recursive:true,force:true});}
  },
};
