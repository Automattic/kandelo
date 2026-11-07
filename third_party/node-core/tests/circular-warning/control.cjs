'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../../..');
const target = JSON.parse(fs.readFileSync(path.join(root,'packages/registry/node-compat/target.json')));
assert.equal(process.versions.node, target.version);
const cases = {
  plain: {
    'a.cjs': 'exports.ready=1;exports.b=require("./b.cjs");',
    'b.cjs': 'const a=require("./a.cjs");exports.missing=a.missing;exports.symbol=a[Symbol("probe")];exports.ordinary=a.toString===Object.prototype.toString;exports.esm=a.__esModule;',
  },
  replaced: {
    'a.cjs': 'module.exports={ready:1};module.exports.b=require("./b.cjs");',
    'b.cjs': 'const a=require("./a.cjs");exports.missing=a.replacedMissing;',
  },
  class: {
    'a.cjs': 'class Parent{};module.exports=new Parent();module.exports.b=require("./b.cjs");',
    'b.cjs': 'const a=require("./a.cjs");exports.missing=a.classMissing;',
  },
  transpiled: {
    'a.cjs': 'exports.__esModule=true;exports.b=require("./b.cjs");',
    'b.cjs': 'const a=require("./a.cjs");exports.missing=a.transpiledMissing;',
  },
  proxy: {
    'a.cjs': 'module.exports=new Proxy({},{getPrototypeOf(){throw Error("getProtoTrap")},setPrototypeOf(){throw Error("setProtoTrap")}});module.exports.b=require("./b.cjs");',
    'b.cjs': 'exports.value=require("./a.cjs").proxyMissing;',
  },
  descriptor: {
    'a.cjs': 'exports.b=require("./b.cjs");',
    'b.cjs': 'const a=require("./a.cjs"),p=Object.getPrototypeOf(a);exports.missing=Object.getOwnPropertyDescriptor(p,"descriptorMissing");exports.esm=Object.getOwnPropertyDescriptor(p,"__esModule");exports.inherited=typeof a.hasOwnProperty;',
  },
  failure: {
    'a.cjs': 'exports.b=require("./b.cjs");throw Error("originalFailure");',
    'b.cjs': 'exports.a=require("./a.cjs");exports.missing=exports.a.failedMissing;',
  },
  mutate: {
    'a.cjs': 'exports.b=require("./b.cjs");Object.setPrototypeOf(module.exports,{custom:1});',
    'b.cjs': 'exports.a=require("./a.cjs");exports.missing=exports.a.mutatedMissing;',
  },
};
const privateRoot = path.resolve(root, '..');
function safe(p) {
  const abs = path.resolve(p), rel=path.relative(privateRoot,abs);
  assert(!rel.startsWith('..'+path.sep) && !path.isAbsolute(rel));
  let parent=path.dirname(abs);
  while (!fs.existsSync(parent)) parent=path.dirname(parent);
  const real=fs.realpathSync(parent), r=path.relative(privateRoot,real);
  assert(!r.startsWith('..'+path.sep) && !path.isAbsolute(r));
  return abs;
}
function write(p,s) { safe(p); fs.mkdirSync(path.dirname(p),{recursive:true});safe(p);fs.writeFileSync(p,s); }
function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
if (process.argv[2] === 'child') {
 (async()=>{
  const mode=process.argv[3],name=process.argv[4],dir=process.argv[5];
  // Initialize the identical native parser/control dependency before observing application warnings.
  require('internal/test/binding');
  await new Promise(resolve=>process.nextTick(resolve));
  const warnings=[];process.on('warning', w=>warnings.push({name:w.name,message:w.message}));
  let api;
  const M=mode==='native'?require('node:module'):(api=require(path.join(root,'host/test/fixtures/node-module-records.cjs')).create({skipESMResolver:true,sameRealmCJS:true})).Module;
  if(api) api.proc.emitWarning=(...args)=>process.emitWarning(...args);
  const req=M.createRequire(path.join(dir,'entry.cjs'));
  const result={};
  if(name==='failure') {
    const thrown=[];
    for(let i=0;i<2;i++)try{req('./a.cjs')}catch(e){thrown.push(e.message)}
    const escaped=req('./b.cjs').a;
    result.thrown=thrown;result.inCache=Object.hasOwn(req.cache,path.join(dir,'a.cjs'));
    result.readAfterFailure=escaped.afterFailedLoad;
  } else {
    const a=req('./a.cjs');
    result.cacheIdentity=req('./a.cjs')===a;
    result.value=a.b;
    if(name!=='proxy') {
      result.plain=Object.getPrototypeOf(a)===Object.prototype;
      result.custom=Object.getPrototypeOf(a)?.custom;
      result.readAfterCompletion=a.afterCompletion;
    }
    if(name==='mutate') result.value={missing:a.b.missing,identity:a.b.a===a};
  }
  result.syncWarnings=warnings.length;
  await new Promise(resolve=>process.nextTick(resolve));
  result.warnings=warnings;
  console.log(JSON.stringify(result));
 })().catch(e=>{console.error(e);process.exitCode=1});
} else {
 const out=safe(process.argv[2]);fs.mkdirSync(out,{recursive:true});
 const results=[];
 for(const [name,files]of Object.entries(cases)) {
  const dir=safe(path.join(out,'files',name));
  for(const [file,s]of Object.entries(files))write(path.join(dir,file),s);
  const result={name};
  for(const mode of ['native','candidate']) {
    const r=cp.spawnSync(process.execPath,['--expose-internals',__filename,'child',mode,name,dir],{encoding:'utf8',timeout:10000,maxBuffer:2e6});
    write(path.join(out,name+'-'+mode+'.stdout'),r.stdout||'');write(path.join(out,name+'-'+mode+'.stderr'),r.stderr||'');
    result[mode]={exit:r.status,signal:r.signal,error:r.error?.message};
    try {result[mode].value=JSON.parse(r.stdout);assert.equal(r.status,0,r.stderr)} catch(e){result[mode].failure=e.message}
  }
  try {assert.equal(result.native.exit,0);assert.equal(result.candidate.exit,0);assert.deepEqual(result.candidate.value,result.native.value);result.status='pass'}catch(e){result.status='fail';result.failure=e.message}
  results.push(result);
 }
 const report={version:process.versions.node,native:process.execPath,nativeSha256:sha(process.execPath),scope:'Actual generated CJS record/cache/bootstrap/compiler/warning-admission algorithms; native VM same-realm code compilation, native isProxy and real native process warning dispatch are explicit dependency boundaries. No global product setup, no guest execution or four-host claim.',productSetup:0,compilations:0,processAttempts:results.length*2,pass:results.filter(r=>r.status==='pass').length,fail:results.filter(r=>r.status==='fail').length,results,sourceIdentities:Object.fromEntries(['third_party/node-core/node-core.js','third_party/node-core/build.py','third_party/node-core/sources.json','third_party/node-core/module-record-platform-adapter.js','packages/registry/node-compat/bootstrap.js','host/test/fixtures/node-module-records.cjs',path.relative(root,__filename)].map(f=>[f,sha(path.join(root,f))]))};
 write(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.fail?1:0;
}
