'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..'),cases=require('./cases.cjs');
assert.equal(process.versions.node,JSON.parse(fs.readFileSync(path.join(root,'packages/registry/node-compat/target.json'))).version);
if(process.argv[2]==='child'){
 const mode=process.argv[3],name=process.argv[4],tool=process.argv[5],api=mode==='native'?require('node:sqlite'):require('./frontend.cjs')(tool);
 console.log(JSON.stringify(cases[name](api)));
}else{
 const tool=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);fs.mkdirSync(out,{recursive:true});const results=[];
 for(const name of Object.keys(cases)){
  const row={name};for(const mode of ['native','candidate']){
   const r=cp.spawnSync(process.execPath,[__filename,'child',mode,name,tool],{encoding:'utf8',timeout:8000,maxBuffer:4e6});
   fs.writeFileSync(path.join(out,name+'-'+mode+'.stdout'),r.stdout||'');fs.writeFileSync(path.join(out,name+'-'+mode+'.stderr'),r.stderr||'');row[mode]={exit:r.status,signal:r.signal,error:r.error?.message};try{row[mode].value=JSON.parse(r.stdout)}catch(e){row[mode].parseFailure=e.message}
  }
  try{assert.equal(row.native.exit,0);assert.equal(row.candidate.exit,0);assert.deepEqual(row.candidate.value,row.native.value);row.status='pass'}catch(e){row.status='fail';row.failure=e.message}results.push(row);
 }
 const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const report={version:process.versions.node,nativeSha256:sha(process.execPath),parameterTool:{path:tool,sha256:sha(tool)},scope:'Actual candidate frontend over explicit pinned native SQLite, encoding and process dependencies; prepare-only exact SQLite helper metadata. Not native guest binding, JSAPI/GC/VFS or four-host conformance.',results,pass:results.filter(r=>r.status==='pass').length,fail:results.filter(r=>r.status==='fail').length,sourceIdentities:Object.fromEntries(['third_party/node-core/node-core.js','third_party/node-core/sqlite-platform-adapter.js','third_party/node-core/tests/sqlite-lifecycle/cases.cjs','third_party/node-core/tests/sqlite-lifecycle/frontend.cjs','third_party/node-core/tests/sqlite-lifecycle/control.cjs'].map(f=>[f,sha(path.join(root,f))])),globalProductSetup:0,overallSuites:0};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,fail:report.fail,results:results.map(({name,status,failure})=>({name,status,failure}))},null,2));process.exitCode=report.fail?1:0;
}
