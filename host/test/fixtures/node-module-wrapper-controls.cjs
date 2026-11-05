'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),util=require('node:util'),NativeModule=require('node:module');
const mode=process.argv[2],name=process.argv[3];
if(!['candidate','native'].includes(mode))throw Error('Choose candidate or native');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-module-wrapper-')));
const candidate=mode==='candidate'?require('./node-module-records.cjs').create():undefined;
const M=candidate?candidate.Module:NativeModule;
const globalObject=candidate?candidate.context:globalThis;
if(candidate)vm.runInContext('globalThis.global=globalThis',candidate.context);
const write=(name,source)=>{const filename=path.join(root,name);fs.writeFileSync(filename,source);return filename;};
const req=M.createRequire(path.join(root,'entry.cjs'));
function caught(run){try{return {value:run()};}catch(error){return {name:error.name,code:error.code,message:error.message.replaceAll(root,'<root>')};}}
function compile(source){const module=new M(path.join(root,'direct.cjs'));module.filename=path.join(root,'direct.cjs');return module._compile(source,module.filename);}
function descriptor(name){const d=Object.getOwnPropertyDescriptor(M,name);return {enumerable:d.enumerable,configurable:d.configurable,get:[d.get.name,d.get.length],set:[d.set.name,d.set.length]};}
let result;
try{
 if(name==='metadata'){
  const conversions=[];const input={ [Symbol.toPrimitive](hint){conversions.push(hint);return 'converted';} };
  const values=['text',7,null,undefined,input].map(value=>M.wrap(value));
  const keys=Object.getOwnPropertyNames(M);
  const cacheBeforeWrapper=['_cache','_pathCache','_extensions','globalPaths'].map(key=>keys.indexOf(key)<keys.indexOf('wrap'));
  result={wrap:descriptor('wrap'),wrapper:descriptor('wrapper'),cacheBeforeWrapper,name:M.wrap.name,length:M.wrap.length,array:Array.isArray(M.wrapper),proxy:util.types.isProxy(M.wrapper),parts:Array.from(M.wrapper),values,conversions,symbol:caught(()=>M.wrap(Symbol('source')))};
 }else if(name==='functionOverride'){
  write('a.cjs','exports.value=3;exports.child=require("./b.cjs");exports.receiver=this===exports;exports.count=arguments.length;');write('b.cjs','module.exports=4;');
  const original=M.wrap,seen=[];
  M.wrap=function(source){seen.push({receiver:this===M,child:source.includes('module.exports=4')});return original(source+'\n;exports.injected=11;');};
  const value=req('./a.cjs');assert.equal(req('./a.cjs'),value);
  result={seen,value};
 }else if(name==='wrapperMutation'){
  write('a.cjs','exports.value=3;');write('b.cjs','exports.value=4;');write('c.cjs','exports.value=5;');
  M.wrapper[0]+='exports.prefix=6;';const first=req('./a.cjs');
  Object.defineProperty(M.wrapper,'1',{value:';exports.suffix=7;\n});'});const second=req('./b.cjs');
  M.wrapper={0:'(function(exports,require,module,__filename,__dirname){exports.object=8;',1:'\n});'};
  result={first,second,third:req('./c.cjs'),array:Array.isArray(M.wrapper)};
 }else if(name==='failureAndCache'){
  const file=write('a.cjs','module.exports=23;');const original=M.wrap;const token={actual:'wrap failure'};
  M.wrap=()=>{throw token;};let same=false;try{req('./a.cjs');}catch(error){same=error===token;}
  assert.equal(same,true);assert.equal(M._cache[file],undefined);
  M.wrap=()=>'(function () {';const syntax=caught(()=>req('./a.cjs'));assert.equal(syntax.name,'SyntaxError');assert.equal(M._cache[file],undefined);
  M.wrap=original;const value=req('./a.cjs');
  result={same,syntax,value,loaded:M._cache[file].loaded};
 }else if(name==='rawSourceAndDetection'){
  write('shebang.cjs','#!/usr/bin/env node\nmodule.exports=12;');write('ambiguous.js','export const value=4;');
  const first=req('./shebang.cjs');delete M._cache[req.resolve('./shebang.cjs')];
  const original=M.wrap,seen=[];M.wrap=function(source){seen.push(source.startsWith('#!'));return original(source);};
  const shebang=caught(()=>req('./shebang.cjs')),esm=caught(()=>req('./ambiguous.js'));
  assert.equal(shebang.name,'SyntaxError');assert.equal(esm.name,'SyntaxError');
  result={first,seen,shebang,esm};
 }else if(name==='wholeScriptAndBytes'){
  const original=M.wrap;
  M.wrap=function(source){return 'globalThis.__wrapperPrelude=(globalThis.__wrapperPrelude||0)+1;'+original(source);};
  const returned=compile('return 37;');assert.equal(globalObject.__wrapperPrelude,1);
  write('unicode.cjs','module.exports="😀\\ud800";');const unicode=req('./unicode.cjs');
  M.wrap=()=> 'globalThis.__mustNotRun=1;\0(function(){})';const nul=caught(()=>compile(''));
  assert.equal(nul.name,'SyntaxError');assert.equal(globalObject.__mustNotRun,undefined);
  result={returned,preludes:globalObject.__wrapperPrelude,unicodeLength:unicode.length,units:Array.from({length:unicode.length},(_,i)=>unicode.charCodeAt(i)),nul};
 }else if(name==='exportsGetterOwnership'){
  let reads=0;const first={mark:1},later={mark:2};const file=path.join(root,'getter.cjs');const child=new M(file);
  const originalDirname=path.dirname;let value;
  Object.defineProperty(child,'exports',{configurable:true,get(){reads++;path.dirname=()=>'/changed-by-exports-getter';return reads===1?first:later;}});
  try{value=child._compile('"use strict";return {same:this===exports,mark:exports.mark,dirname:__dirname};',file);}
  finally{path.dirname=originalDirname;}
  value.dirname=value.dirname.replaceAll(root,'<root>');
  result={reads,value};
 }else if(name==='proxyDeleteAndStickyState'){
  // The target proxy only marks set/defineProperty, not deletion. Preserve
  // that actual target policy and its sticky state once a setter is used.
  delete M.wrapper[0];write('a.cjs','module.exports=31;');const before=req('./a.cjs');
  M.wrapper=M.wrapper;const after=caught(()=>compile('return 2;'));
  result={before,after,wrapped:M.wrap('body')};
 }else if(name==='upstreamWrap'||name==='upstreamWrapper'){
  const sourceRoot=process.argv[4];if(!sourceRoot)throw Error('Pinned source root required');
  const file=path.join(sourceRoot,'test/fixtures',name==='upstreamWrap'?'cjs-module-wrap.js':'cjs-module-wrapper.js');
  if(candidate)candidate.make(file)(file);else NativeModule.createRequire(file)(file);
  result={completed:true};
 }else throw Error('Unknown case '+name);
 console.log(JSON.stringify({result}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
