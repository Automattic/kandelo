'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
assert.equal(process.versions.node,JSON.parse(fs.readFileSync(path.join(root,'packages/registry/node-compat/target.json'))).version);
const names=[
 'test-module-hooks-resolve-invalid.js','test-module-hooks-load-invalid.js',
 'test-module-hooks-load-context-merged.js','test-module-hooks-load-context-optional.js',
 'test-module-hooks-resolve-context-merged.js','test-module-hooks-resolve-context-optional.js',
 'test-module-hooks-load-buffers.js','test-module-hooks-resolve-require-resolve-redirect.js',
 'test-module-hooks-load-builtin-override-commonjs.js','test-module-hooks-load-builtin-override-json.js',
 'test-module-hooks-load-short-circuit-required-start.js','test-module-hooks-load-short-circuit-required-middle.js',
 'test-module-hooks-resolve-short-circuit-required-start.js','test-module-hooks-resolve-short-circuit-required-middle.js',
];
if(process.argv[2]==='child'){
 const sourceRoot=process.argv[3],mode=process.argv[4],name=process.argv[5],test=path.join(sourceRoot,'test/module-hooks',name);
 if(mode==='native')require(test);
 else{
  // Execute the byte-identical upstream test through actual candidate CJS
  // loader. Native upstream common and fixtures provide real mustCall exit
  // accounting/native test-process infrastructure; they are explicit fixture
  // dependencies, not guest-module/runtime conformance claims.
  const common=require(path.join(sourceRoot,'test/common'));
  const fixtures=require(path.join(sourceRoot,'test/common/fixtures'));
  const api=require(path.join(root,'host/test/fixtures/node-module-records.cjs')).create();
  for(const [f,value] of [[path.join(sourceRoot,'test/common/index.js'),common],[path.join(sourceRoot,'test/common/fixtures.js'),fixtures]]){
   const mod=new api.Module(f);mod.filename=f;mod.loaded=true;mod.exports=value;api.Module._cache[f]=mod;
  }
  api.Module.createRequire(path.join(sourceRoot,'test/entry.cjs'))(test);
 }
}else{
 const sourceRoot=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);fs.mkdirSync(out,{recursive:true});const results=[];
 for(const name of names){const row={name,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,'test/module-hooks',name))).digest('hex')};
  for(const mode of ['native','candidate']){
   const r=cp.spawnSync(process.execPath,['--expose-internals',__filename,'child',sourceRoot,mode,name],{encoding:'utf8',timeout:8000,maxBuffer:4e6});
   fs.writeFileSync(path.join(out,name+'-'+mode+'.stdout'),r.stdout||'');fs.writeFileSync(path.join(out,name+'-'+mode+'.stderr'),r.stderr||'');row[mode]={exit:r.status,signal:r.signal,error:r.error?.message};
  }
  row.status=row.native.exit===0&&row.candidate.exit===0?'pass':'fail';results.push(row);
 }
 const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const report={scope:'Unchanged upstream synchronous CJS hook assertions executed through actual candidate loader and pinned native VM/filesystem/builtin dependencies. Native upstream common/fixtures dependency supplies process/mustCall accounting. Not standalone product/guest/four-host conformance.',version:process.versions.node,nativeSha256:sha(process.execPath),sourceCommit:JSON.parse(fs.readFileSync(path.join(root,'packages/registry/node-compat/target.json'))).source.commit,upstreamCommonSha256:sha(path.join(sourceRoot,'test/common/index.js')),upstreamFixturesSha256:sha(path.join(sourceRoot,'test/common/fixtures.js')),sourceRoot,results,pass:results.filter(r=>r.status==='pass').length,fail:results.filter(r=>r.status==='fail').length,sourceIdentities:Object.fromEntries(['third_party/node-core/node-core.js','packages/registry/node-compat/bootstrap.js','host/test/fixtures/node-module-records.cjs','third_party/node-core/tests/module-hooks/upstream.cjs'].map(f=>[f,sha(path.join(root,f))])),globalProductSetup:0,overallSuites:0,compilations:0};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,fail:report.fail,results},null,2));process.exitCode=report.fail?1:0;
}
