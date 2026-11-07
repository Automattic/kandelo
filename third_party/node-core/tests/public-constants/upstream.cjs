'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),assert=require('node:assert/strict'),Module=require('node:module');
const filename=process.env.NODE26_SOURCE+'/test/parallel/test-constants.js';
if(process.argv[2]==='child'){
 if(process.argv[3]==='native')require(filename);
 else{
  const api=require('./platform.cjs').create();const nativeRequire=Module.createRequire(filename);
  const module={exports:{}};const text=fs.readFileSync(filename,'utf8');
  const wrapper=vm.compileFunction(text,['exports','require','module','__filename','__dirname'],{filename});
  const req=id=>{
   if(id==='../common')return nativeRequire(id);
   if(id==='internal/test/binding')return{internalBinding(name){
    if(name!=='constants')throw Error('This control supplies only its genuine constants owner');return api.binding;
   }};
   return api.req(id);
  };
  wrapper(module.exports,req,module,filename,path.dirname(filename));
 }
}else{
 const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});const results=[];
 for(const mode of ['native','candidate']){
  const command=[process.execPath,'--expose-internals',__filename,'child',mode];const run=cp.spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:10000});
  fs.writeFileSync(path.join(out,mode+'.stdout'),run.stdout||'');fs.writeFileSync(path.join(out,mode+'.stderr'),run.stderr||'');results.push({mode,command,exit:run.status,signal:run.signal,error:run.error?.message});
 }
 const report={scope:'Unchanged pinned public legacy-aggregate test with genuine header-backed constants binding; explicit native common/FS/signals/VM plus opaque existing crypto API object. --expose-internals retained on both native processes. This is not guest private-binding/CLI/engine/four-host proof.',filename,unchangedAssertions:true,results};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=results.some(r=>r.exit!==0)?1:0;
}
