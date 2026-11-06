'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');const cases=require('./cases.cjs');
const target=JSON.parse(fs.readFileSync(path.join(root,'packages/registry/node-compat/target.json'),'utf8'));assert.equal(process.versions.node,target.version);
if(process.argv[2]==='child'){
 const mode=process.argv[3],name=process.argv[4],dir=process.argv[5];
 const M=mode==='native'?require('node:module'):require(path.join(root,'host/test/fixtures/node-module-records.cjs')).create().Module;
 const req=M.createRequire(path.join(dir,'main.cjs'));
 const value=cases[name]({M,req,dir,url:require('node:url')});
 console.log(JSON.stringify(value));
}else{
 const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-hooks-')));
 const files={'main.cjs':'','a.cjs':'module.exports={value:"disk",child:require("./child.cjs"),filename:__filename,dirname:__dirname}','child.cjs':'module.exports=43','node_modules/pkg/package.json':JSON.stringify({exports:{custom:'./custom.cjs',require:'./require.cjs'}}),'node_modules/pkg/custom.cjs':'module.exports="custom"','node_modules/pkg/require.cjs':'module.exports="require"'};
 for(const [f,s]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),s)}
 const results=[];
 try{for(const name of Object.keys(cases)){
  const entry={name};
  for(const mode of ['native','candidate']){
   const r=cp.spawnSync(process.execPath,['--expose-internals',__filename,'child',mode,name,dir],{encoding:'utf8',timeout:8000,maxBuffer:4e6});
   fs.writeFileSync(path.join(out,name+'-'+mode+'.stdout'),r.stdout||'');fs.writeFileSync(path.join(out,name+'-'+mode+'.stderr'),r.stderr||'');entry[mode]={exit:r.status,signal:r.signal,error:r.error?.message};
   try{entry[mode].value=JSON.parse(r.stdout);assert.equal(r.status,0,r.stderr)}catch(e){entry[mode].failure=e.message}
  }
  try{assert.equal(entry.native.exit,0);assert.equal(entry.candidate.exit,0);assert.deepEqual(entry.candidate.value,entry.native.value);entry.status='pass'}catch(e){entry.status='fail';entry.failure=e.message}
  results.push(entry);
 }}finally{fs.rmSync(dir,{recursive:true,force:true})}
 const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const report={scope:'Actual generated pinned hook/record/policy plus bootstrap loader/compiler source over pinned native VM, filesystem, URL, Buffer and native builtins as explicit dependencies; no product setup, guest, engine JSAPI or four-host validation.',version:process.versions.node,nativeSha256:sha(process.execPath),pass:results.filter(x=>x.status==='pass').length,fail:results.filter(x=>x.status==='fail').length,results,sourceIdentities:Object.fromEntries(['third_party/node-core/node-core.js','third_party/node-core/module-hooks-platform-adapter.js','third_party/node-core/module-record-platform-adapter.js','packages/registry/node-compat/bootstrap.js','host/test/fixtures/node-module-records.cjs','third_party/node-core/tests/module-hooks/cases.cjs','third_party/node-core/tests/module-hooks/control.cjs'].map(f=>[f,sha(path.join(root,f))])),productSetup:0,compilations:0,overallSuites:0};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,fail:report.fail,results:results.map(({name,status,failure})=>({name,status,failure}))},null,2));process.exitCode=report.fail?1:0;
}
