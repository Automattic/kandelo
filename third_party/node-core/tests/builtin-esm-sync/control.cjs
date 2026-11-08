const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
assert.equal(process.version,'v26.13.0');
const [mode,subject,root]=process.argv.slice(2);const M=require('node:module');
let api,graph,owner;
if(mode==='candidate'){
 const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
 const makeGraph=Function(bundle+';return _createNodeESMGraphPlatform;')();
 const saved=new Map(['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 api=require(path.join(root,'host/test/fixtures/node-module-records.cjs')).create({skipESMResolver:true,configureBuiltins(table){Object.defineProperty(table,'test',{enumerable:true,get(){return process.getBuiltinModule('node:test')}});}});
 for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
 owner=vm.runInContext('_nodeBuiltinExports',api.context);
 const records=vm.runInContext('_nodeModuleRecords',api.context),policy=vm.runInContext('_nodeBuiltinPolicy',api.context);
 graph=makeGraph({records,builtinExports:owner,values:{errors:require('internal/errors'),validators:require('internal/validators'),util:require('internal/util')},url:require('node:url'),types:require('node:util').types,TextDecoder,
  normalizeBuiltin:id=>policy.normalizeRequirableId(id),loadBuiltin:id=>owner.load(id)});
}
const sync=mode==='candidate'?api.Module.syncBuiltinESMExports:M.syncBuiltinESMExports;
const requirePublic=id=>mode==='candidate'?api.make(__filename)(id):require(id);
const getInternal=id=>mode==='candidate'?api.proc.getBuiltinModule(id):process.getBuiltinModule(id);
const modules=new Map();
async function builtin(id){
 if(mode==='native')return import('node:'+id);
 if(modules.has(id))return modules.get(id).namespace;
 const rec=graph.record('node:'+id),d=graph.load(rec);
 const mod=new vm.SyntheticModule(d.exportNames,function(){assert.equal(d.evaluate(this),this);},{identifier:'node:'+id});
 d.initialize(mod);modules.set(id,mod);await mod.link(()=>{throw Error('unexpected builtin dependency')});await mod.evaluate();return mod.namespace;
}
async function run(){
 if(subject==='update-delete-own'){
  const ex=requirePublic('fs'),ns=await builtin('fs'),original=ex.readFile;
  const a=()=>1;ex.readFile=a;assert.equal(ns.readFile,original);sync();assert.equal(ns.readFile,a);
  delete ex.readFile;sync();assert.equal(ns.readFile,undefined);ex.readFile=original;sync();return{updated:true,deleted:true,defaultIdentity:ns.default===ex};
 }
 if(subject==='no-new-export-and-default'){
  const ex=requirePublic('dns'),ns=await builtin('dns');ex.kandeloAdded=43;ex.default='changed';sync();return{addedAbsent:!Object.hasOwn(ns,'kandeloAdded'),defaultIdentity:ns.default===ex,defaultNotProperty:ns.default!=='changed'};
 }
 if(subject==='first-public-after-internal'){
  const ex=getInternal('dns');ex.kandeloPublicKey=42;
  requirePublic('dns');delete ex.kandeloPublicKey;const ns=await builtin('dns');sync();return{keyCaptured:Object.hasOwn(ns,'kandeloPublicKey'),deletedValue:ns.kandeloPublicKey===undefined};
 }
 if(subject==='first-public-before-import'){
  const ex=requirePublic('dns');ex.kandeloLateKey=42;const ns=await builtin('dns');return{lateAbsent:!Object.hasOwn(ns,'kandeloLateKey')};
 }
 if(subject==='inherited-own-receiver'){
  const ex=requirePublic('fs'),ns=await builtin('fs');delete ex.readFile;const proto=Object.create(Object.getPrototypeOf(ex));let hits=0;Object.defineProperty(proto,'readFile',{get(){hits++;return 55},configurable:true});Object.setPrototypeOf(ex,proto);sync();assert.equal(ns.readFile,undefined);assert.equal(hits,0);
  let rightThis=false;Object.defineProperty(ex,'readFile',{get(){rightThis=this===ex;return 56},configurable:true,enumerable:true});sync();return{inheritedNotRead:hits===0,ownRead:ns.readFile===56,rightThis};
 }
 if(subject==='getter-throw-partial-update'){
  const ex=requirePublic('fs'),ns=await builtin('fs');const keys=Object.keys(ex),first=keys.find(n=>n!=='default'),second=keys.slice(keys.indexOf(first)+1).find(n=>n!=='default');const marker={original:true};let calls=0;
  const descriptors=[Object.getOwnPropertyDescriptor(ex,first),Object.getOwnPropertyDescriptor(ex,second)];
  Object.defineProperty(ex,first,{get(){calls++;return 123},configurable:true,enumerable:true});Object.defineProperty(ex,second,{get(){throw marker},configurable:true,enumerable:true});let same=false;try{sync()}catch(e){same=e===marker};const changed=ns[first]===123;
  Object.defineProperty(ex,first,descriptors[0]);Object.defineProperty(ex,second,descriptors[1]);sync();return{sameError:same,earlierBindingCommitted:changed,firstGetterCalls:calls};
 }
 if(subject==='reentrant-sync'){
  const ex=requirePublic('fs'),ns=await builtin('fs');let entered=false,calls=0;Object.defineProperty(ex,'readFile',{get(){calls++;if(!entered){entered=true;sync()}return 77},configurable:true,enumerable:true});sync();return{value:ns.readFile,calls};
 }
 if(subject==='scheme-only-excluded'){
  const ex=requirePublic('node:test'),ns=await builtin('test'),original=ex.skip;const changed=()=>9;ex.skip=changed;sync();return{defaultActual:ns.default===ex,namedUnchanged:ns.skip===original,publicChanged:ex.skip===changed};
 }
 if(subject==='lazy-no-load'){
  // Native warning-producing deprecated builtin must remain unopened.
  const before=process.moduleLoadList.filter(x=>x==='NativeModule punycode').length;sync();const after=process.moduleLoadList.filter(x=>x==='NativeModule punycode').length;return{unloaded:before===0&&after===0};
 }
 if(subject==='property-shape'){
  const fn=mode==='candidate'?api.Module.syncBuiltinESMExports:M.syncBuiltinESMExports,d=Object.getOwnPropertyDescriptor(mode==='candidate'?api.Module:M,'syncBuiltinESMExports');return{name:fn.name,length:fn.length,enumerable:d.enumerable,writable:d.writable,configurable:d.configurable,result:fn()===undefined};
 }
 if(subject==='upstream'){
  const file=path.join(process.cwd(),'.context/nodejs-lts-cache-v2/node-v26.13.0/test/es-module/test-esm-live-binding.mjs');
  if(mode==='native'){await import(require('node:url').pathToFileURL(file).href);return{unchangedFilePassed:true};}
  const source=fs.readFileSync(file,'utf8');const mod=new vm.SourceTextModule(source,{identifier:require('node:url').pathToFileURL(file).href});
  await mod.link(async(specifier)=>{
   if(specifier.startsWith('../common/')){const ns=await import(new URL(specifier,require('node:url').pathToFileURL(file)).href);const names=Object.keys(ns);return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,ns[name])});}
   const id=specifier.replace(/^node:/,'');await builtin(id);return modules.get(id);
  });await mod.evaluate();return{unchangedFilePassed:true};
 }
 throw Error('unknown subject '+subject);
}
run().then(value=>console.log(JSON.stringify({subject,value}))).catch(error=>{console.error(error);process.exitCode=1});
