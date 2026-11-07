'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
assert.equal(process.version,'v26.13.0');const mode=process.argv[2],repo=path.resolve(process.argv[3]);const rows=[];
let Module,helpers,api;
if(mode==='native'){Module=require('node:module');helpers=require('internal/modules/helpers');}
else{
 const base=mode==='before'?path.resolve(repo,'../before'):repo;
 api=require(path.join(base,'host/test/fixtures/node-module-records.cjs')).create({skipESMResolver:true});
 Module=api.Module;helpers=vm.runInContext('_nodeModuleRecords',api.context);
}
const selected=['fs','path','_http_agent','fs/promises','module','buffer','util','process','sys'];
function withNames(fn){const old=Object.getOwnPropertyDescriptor(Module,'builtinModules');try{Object.defineProperty(Module,'builtinModules',{...old,value:selected});return fn();}finally{Object.defineProperty(Module,'builtinModules',old);}}
function scope(initial){const result=Object.assign(Object.create(null),initial);helpers.addBuiltinLibsToObject(result,'<eval>');return result;}
function desc(object,key){const d=Object.getOwnPropertyDescriptor(object,key);return d&&{kind:'get'in d?'accessor':'data',enumerable:d.enumerable,configurable:d.configurable,writable:d.writable,get:d.get?.name,set:d.set?.name,valueType:typeof d.value};}
function loads(fn){const old=Module._load,requests=[];Module._load=function(name,parent,...args){requests.push({name,parent:parent?.id});return Reflect.apply(old,this,[name,parent,...args]);};try{return fn(requests);}finally{Module._load=old;}}
async function group(name,fn){try{rows.push({name,result:await withNames(fn)});}catch(e){rows.push({name,nonpass:{name:e.name,code:e.code,message:e.message}});}}
(async()=>{
 await group('shared helper identity exists',()=>({requireName:helpers.makeRequireFunction.name,requireLength:helpers.makeRequireFunction.length,builtinName:helpers.addBuiltinLibsToObject.name,builtinLength:helpers.addBuiltinLibsToObject.length}));
 await group('namespace filter and lazy descriptor',()=>{const object=scope();return{names:Object.getOwnPropertyNames(object),keys:Object.keys(object),fs:desc(object,'fs'),path:desc(object,'path'),hidden:Object.hasOwn(object,'_http_agent'),subpath:Object.hasOwn(object,'fs/promises')};});
 await group('existing own properties retained',()=>{const existing={marker:1};const object=scope({fs:existing});return{same:object.fs===existing,fs:desc(object,'fs'),path:desc(object,'path')};});
 await group('inherited property does not suppress binding',()=>{const object=Object.create({fs:19});helpers.addBuiltinLibsToObject(object,'<eval>');return{own:Object.hasOwn(object,'fs'),value:object.fs===fs,descriptor:desc(object,'fs')};});
 await group('genuine builtin cache identity after first read',()=>loads(requests=>{const object=scope();const first=object.fs,second=object.fs;return{same:first===second,native:first===fs,requests,after:desc(object,'fs')};}));
 await group('assignment before load never loads',()=>loads(requests=>{const object=scope();object.fs=27;return{value:object.fs,requests,descriptor:desc(object,'fs')};}));
 await group('assignment after load replaces cached accessor',()=>loads(requests=>{const object=scope();object.fs;object.fs=27;return{value:object.fs,requests,descriptor:desc(object,'fs')};}));
 await group('inherited setter follows captured target',()=>loads(requests=>{const object=scope(),child=Object.create(object);child.fs=17;return{parent:object.fs,child:child.fs,childOwn:Object.hasOwn(child,'fs'),requests,parentDescriptor:desc(object,'fs')};}));
 await group('deletion before load',()=>loads(requests=>{const object=scope();return{deleted:delete object.fs,value:object.fs,own:Object.hasOwn(object,'fs'),requests};}));
 await group('nonconfigurable getter still returns real module',()=>loads(requests=>{const object=scope();Object.defineProperty(object,'fs',{configurable:false});return{same:object.fs===object.fs,native:object.fs===fs,requests,descriptor:desc(object,'fs')};}));
 await group('failed load keeps getter retry and original throw',()=>{const old=Module._load,marker=Error('original failed load');let count=0;Module._load=function(name,...args){if(name==='fs'&&++count===1)throw marker;return Reflect.apply(old,this,[name,...args]);};try{const object=scope();let original=false;try{object.fs;}catch(e){original=e===marker;}const value=object.fs;return{original,native:value===fs,count,descriptor:desc(object,'fs')};}finally{Module._load=old;}});
 await group('frozen scope remains a real getter',()=>loads(requests=>{const object=scope();Object.freeze(object);return{native:object.fs===fs,descriptor:desc(object,'fs'),frozen:Object.isFrozen(object),requests};}));
 await group('shared makeRequireFunction uses actual module record',()=>{const owner=new Module('<helper>');owner.filename=path.join(process.cwd(),'repl');owner.paths=Module._nodeModulePaths(owner.filename);const req=helpers.makeRequireFunction(owner);return{name:req.name,length:req.length,fs:req('node:fs')===fs,cache:req.cache===Module._cache,extensions:req.extensions===Module._extensions,resolve:req.resolve('node:fs'),resolveName:req.resolve.name};});
 await group('makeRequireFunction invalid owner error',()=>{try{helpers.makeRequireFunction({});return'no error';}catch(e){return{name:e.name,code:e.code,message:e.message};}});
 if(mode==='after'){
  const source=fs.readFileSync(path.join(repo,'packages/registry/node-compat/bootstrap.js'),'utf8');const a=source.indexOf('// Node\'s actual --eval entry exposes builtins'),b=source.indexOf('let _nodeWorkerStartupInitialized',a);assert(a>=0&&b>a);const selectedSource=source.slice(a,b);
  const presenceLine=source.split('\n').find(line=>line.startsWith('const _nodeHasEvalSource ='));assert(presenceLine);
  const readPresence=Function('_nodeNative',presenceLine+';return _nodeHasEvalSource;');
  const cases=[
   {boundary:{cliOptions:{evalSource:'',hasEvalSource:false}},expected:false},
   {boundary:{cliOptions:{evalSource:'',hasEvalSource:true}},expected:true},
   {boundary:{cliOptions:{evalSource:'1+1',hasEvalSource:true}},expected:true},
   {boundary:{workerEnvironment:{},cliOptions:{evalSource:'',hasEvalSource:true}},expected:false},
  ];
  for(const{boundary,expected}of cases){
   const present=readPresence(boundary);assert.equal(present,expected);
   const object=Object.create(null);Function('_nodeHasEvalSource','_nodeModuleRecords','globalThis',selectedSource)(present,helpers,object);
   assert.equal(Object.hasOwn(object,'fs'),expected);if(expected)assert.equal(object.fs,fs);
  }
 }
 console.log(JSON.stringify({mode,rows,scope:'Complete pinned builtin-binding/helper source consumed by real candidate Module/cache and actual eval guard over explicit native VM/fs/package/URL/builtin dependencies; not guest/REPL acceptance'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
