import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import * as nodeURL from 'node:url';import {createRequire,registerHooks}from'node:module';import vm from'node:vm';
const require=createRequire(import.meta.url);assert.equal(process.version,'v26.13.0');
const mode=process.argv[2],repo=path.resolve(process.argv[3]),addon=process.argv[4];
const {defineNativeLazyDataProperty}=require(addon);const source=fs.readFileSync(path.join(repo,'packages/registry/node-compat/bootstrap.js'),'utf8');
const bundle=fs.readFileSync(path.join(repo,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(bundle+';return{meta:_createNodeImportMetaPlatform};')();
const canonical=value=>value; // Inputs are actual native-resolved URLs from real ModuleWraps below.
let initialize;
if(mode==='after'){
 const a=source.indexOf('globalThis.__kandeloModuleMeta = _createNodeImportMetaPlatform({'),b=source.indexOf('\n// Node.js globals',a);assert(a>=0&&b>a);
 const globals=Object.create(null);
 Function('globalThis','_createNodeImportMetaPlatform','_nodeESMGraph','_nodeWebPlatform','url','_makeRequire','process','_nodeNative',source.slice(a,b))(globals,factories.meta,{canonical},{URL},nodeURL,createRequire,process,{defineNativeLazyDataProperty});
 initialize=globals.__kandeloModuleMeta;
}else if(mode==='before'){
 const before=fs.readFileSync(path.join(repo,'../before/packages/registry/node-compat/bootstrap.js'),'utf8');const a=before.indexOf('globalThis.__kandeloModuleMeta = function(identifier) {'),b=before.indexOf('\n// Node.js globals',a);assert(a>=0&&b>a);const globals=Object.create(null);
 Function('globalThis','_nodeESMGraph','_nodeWebPlatform','url','_makeRequire','path',before.slice(a,b))(globals,{canonical},{URL},nodeURL,createRequire,path);
 initialize=(id,meta)=>{const record=globals.__kandeloModuleMeta(id);meta.url=record.url;for(const key of ['dirname','filename','require'])if(Object.hasOwn(record,key))meta[key]=record[key];return meta;};
}
const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('file:')&&specifier.includes('meta_case='))return{url:specifier,format:'module',shortCircuit:true};return next(specifier,context);},load(url,context,next){if(url.startsWith('file:')&&url.includes('meta_case='))return{format:'module',source:'export default import.meta;',shortCircuit:true};return next(url,context);}});
let sequence=0;const rows=[];
async function make(base='file:///a/entry.mjs'){
 const id=base+(base.includes('?')?'&':'?')+'meta_case='+sequence++;
 const actual=(await import(id)).default;
 if(mode==='native')return actual;
 const meta=Object.create(null);assert.equal(initialize(actual.url,meta),meta,'production initializer returns actual supplied owner');return meta;
}
function desc(meta,key){const d=Object.getOwnPropertyDescriptor(meta,key);return d&&{value:d.value,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,hasGet:'get'in d};}
async function group(name,fn){try{rows.push({name,result:await fn()});}catch(e){rows.push({name,nonpass:{name:e.name,code:e.code,message:e.message}});}}
try{
 await group('exact root path helper',async()=>{const m=await make('file:///entry.mjs');return{dirname:m.dirname,filename:m.filename};});
 await group('exact root directory helper',async()=>{const m=await make('file:///');return{dirname:m.dirname,filename:m.filename};});
 await group('private URL capture survives public url overwrite',async()=>{const m=await make('file:///a/space%20name-%E2%82%AC.mjs');m.url='file:///other/replacement.mjs';return{dirname:m.dirname,filename:m.filename,url:m.url};});
 await group('target path keys order',async()=>{const m=await make();return Reflect.ownKeys(m).filter(x=>['dirname','filename','url'].includes(x));});
 await group('native data descriptors',async()=>{const m=await make();return{dirname:desc(m,'dirname'),filename:desc(m,'filename')};});
 await group('assignment before first read',async()=>{const m=await make();m.filename=19;return{filename:desc(m,'filename'),dirname:m.dirname};});
 await group('delete before first read',async()=>{const m=await make();return{deleted:Reflect.deleteProperty(m,'filename'),filename:desc(m,'filename'),dirname:m.dirname};});
 await group('inherited get retains true holder',async()=>{const m=await make();const child=Object.create(m);const value=child.filename;return{value,childOwn:Object.hasOwn(child,'filename'),parent:desc(m,'filename')};});
 await group('inherited write is receiver own',async()=>{const m=await make();const child=Object.create(m);child.filename=42;return{value:child.filename,childOwn:Object.hasOwn(child,'filename'),parent:desc(m,'filename')};});
 for(const policy of ['freeze','seal','preventExtensions'])await group('native DATA '+policy,async()=>{const m=await make();Object[policy](m);return{dirname:desc(m,'dirname'),filename:desc(m,'filename'),frozen:Object.isFrozen(m),sealed:Object.isSealed(m),extensible:Object.isExtensible(m)};});
 await group('cross context read',async()=>{const m=await make();return vm.runInNewContext('({dirname:m.dirname,filename:m.filename})',{m});});
 await group('private conversion resists public URL getters',async()=>{const m=await make();const d=Object.getOwnPropertyDescriptor(URL.prototype,'pathname');try{Object.defineProperty(URL.prototype,'pathname',{configurable:true,get(){throw Error('mutable public pathname getter');}});return{dirname:m.dirname,filename:m.filename};}finally{Object.defineProperty(URL.prototype,'pathname',d);}});
 await group('private conversion resists inherited URL admission',async()=>{const m=await make();const original=Object.getOwnPropertyDescriptor(Object.prototype,'auth');try{Object.defineProperty(Object.prototype,'auth',{configurable:true,get(){throw Error('inherited auth getter');}});return{dirname:m.dirname,filename:m.filename};}finally{if(original)Object.defineProperty(Object.prototype,'auth',original);else delete Object.prototype.auth;}});
 await group('nonfile URL has no path helpers',async()=>{const id='data:text/javascript,export default import.meta';const actual=(await import(id)).default;let m=actual;if(mode!=='native'){m=Object.create(null);initialize(actual.url,m);}return{dirname:desc(m,'dirname'),filename:desc(m,'filename'),url:m.url};});
 await group('query and hash do not enter path',async()=>{const m=await make('file:///a/name.mjs?query=1#fragment');return{dirname:m.dirname,filename:m.filename};});
 if(mode==='after'){
  const counts={conversion:0,require:0};const init=factories.meta({canonical,URL,fileURLToPath(value){counts.conversion++;return nodeURL.fileURLToPath(value);},makeRequire(value){counts.require++;return createRequire(value);},process,defineNativeLazyDataProperty});
  const m=Object.create(null);init('file:///a/measured.mjs',m);assert.deepEqual(counts,{conversion:1,require:1});m.filename;assert.deepEqual(counts,{conversion:2,require:1});m.filename;assert.deepEqual(counts,{conversion:2,require:1});m.dirname;assert.deepEqual(counts,{conversion:3,require:1});assert.equal(typeof m.require.resolve,'function');
 }
 console.log(JSON.stringify({mode,rows,scope:'Actual production JS metadata initializer over genuine pinned native lazy DATA owner and URL/require dependencies; actual native reference ModuleWrap metadata from real hooks; new SpiderMonkey bridge uncompiled and main/resolve separate.'}));
}finally{hooks.deregister();}
