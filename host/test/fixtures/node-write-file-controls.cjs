'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createHook,executionAsyncId,AsyncLocalStorage}=require('node:async_hooks');
async function root(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-write-job-'));try{return await run(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const call=(api,method,...args)=>new Promise((resolve,reject)=>api[method](...args,error=>error?reject(error):resolve()));
function errorRecord(error,dir){if(!error)return null;return {name:error.name,code:error.code,syscall:error.syscall,
  path:error.path===undefined?undefined:error.path.replaceAll(dir,'$ROOT'),message:error.message.replaceAll(dir,'$ROOT')};}
exports.controls={
  actualBytesAndModes(api){return root(async dir=>{
    const results=[];
    for(const [index,[data,options]] of [[0,['hé\ud800',{encoding:'utf8'}]],[1,['ff0081',{encoding:'hex'}]],
      [2,['€',{encoding:'utf16le'}]],[3,[new DataView(new Uint8Array([1,2,3,4]).buffer,1,2),{}]],
      [4,[new Uint16Array([0x1234]),{}]],[5,['',{mode:0}]]]){
      const file=path.join(dir,String(index));await call(api,'writeFile',file,data,options);
      const mode=fs.statSync(file).mode&0o777;if(mode===0)fs.chmodSync(file,0o600);
      results.push([fs.readFileSync(file).toString('hex'),mode]);
    }return results;
  });},
  errorsValidationAndAbort(api){return root(async dir=>{
    const rows=[];
    for(const args of [[path.join(dir,'absent','file'),'x'],[dir,'x']]){
      let returned=false;const row=await new Promise(resolve=>{api.writeFile(...args,error=>resolve({error:errorRecord(error,dir),async:returned}));returned=true;});
      assert(row.error);rows.push(row);
    }
    for(const [data,options] of [[{},{}],['x',{flush:'yes'}],['x',{encoding:'unknown'}]]){
      try{api.writeFile(path.join(dir,'unused'),data,options,()=>assert.fail('invalid callback'));rows.push({unexpected:true});}
      catch(e){rows.push({name:e.name,code:e.code,message:e.message});}
    }
    const controller=new AbortController();controller.abort('reason');let returned=false;
    const aborted=await new Promise(resolve=>{api.writeFile(path.join(dir,'aborted'),'bytes',{signal:controller.signal},e=>resolve({code:e.code,cause:e.cause,async:returned}));returned=true;});
    assert.equal(fs.existsSync(path.join(dir,'aborted')),false);rows.push(aborted);return rows;
  });},
  descriptorFlushAndAppendOptions(api){return root(async dir=>{
    const file=path.join(dir,'file'),options=Object.freeze({encoding:'hex',mode:0o600});
    await call(api,'writeFile',file,'6162',{encoding:'hex',flush:true});
    await call(api,'appendFile',file,'63',options);
    const fd=fs.openSync(file,'a');try{await call(api,'appendFile',fd,new Uint8Array([100]),{flush:true});assert.equal(fs.fstatSync(fd).isFile(),true);}finally{fs.closeSync(fd);}
    return {hex:fs.readFileSync(file).toString('hex'),options};
  });},
  nativeResourceScope(api){return root(async dir=>{
    const local=new AsyncLocalStorage(),resources=new Map();
    const hook=createHook({init(id,type,_trigger,resource){if(type==='FSREQCALLBACK')resources.set(id,resource);}}).enable();
    try{return await local.run('write-scope',()=>new Promise((resolve,reject)=>{
      let returned=false;api.writeFile(path.join(dir,'file'),'bytes',function(error){try{
        assert(returned);assert.equal(error,null);assert.equal(arguments.length,1);
        assert.equal(resources.get(executionAsyncId()),this);assert.equal(this.constructor.name,'WriteFileJob');
        assert.equal(local.getStore(),'write-scope');resolve(fs.readFileSync(path.join(dir,'file'),'utf8'));
      }catch(e){reject(e);}});returned=true;
    }));}finally{hook.disable();}
  });},
  resizableSnapshotAfterInit(api){return root(async dir=>{
    const buffer=new ArrayBuffer(4,{maxByteLength:8}),view=new Uint8Array(buffer);view.fill(0x61);
    let initialized=0;
    const hook=createHook({init(_id,type){if(type==='FSREQCALLBACK'){initialized++;view.fill(0x62);}}}).enable();
    try{
      const pending=call(api,'writeFile',path.join(dir,'file'),view);buffer.resize(0);await pending;
      assert.equal(initialized,1);return fs.readFileSync(path.join(dir,'file')).toString('hex');
    }finally{hook.disable();}
  });},
};
