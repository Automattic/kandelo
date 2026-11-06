'use strict';
const fs=require('fs'),assert=require('assert/strict'),vm=require('vm'),util=require('util');
const root=require('path').resolve(__dirname, '../../../..'),work=root,out=process.env.KANDELO_VM_MODULES_CONTROL_OUT;
assert(out, 'Set KANDELO_VM_MODULES_CONTROL_OUT');fs.mkdirSync(out,{recursive:true});
const create=require(work+'/host/test/fixtures/node-vm-modules-platform.cjs').create;
const rows=[];
function error(run){try{return{value:run()};}catch(e){return{name:e.name,code:e.code,message:e.message};}}
async function scenario(api,name){
 if(name==='validation'){
  const errors=[];for(const run of[()=>new api.Module({}),()=>new api.SourceTextModule(1),()=>new api.SourceTextModule('',null),()=>new api.SourceTextModule('',{context:{}}),()=>new api.SourceTextModule('',{lineOffset:0.5}),()=>new api.SourceTextModule('',{initializeImportMeta:1}),()=>new api.SourceTextModule('',{importModuleDynamically:1}),()=>new api.SourceTextModule('',{cachedData:{}}),()=>new api.SyntheticModule(['x','x'],()=>{}),()=>new api.SyntheticModule([1],()=>{}),()=>new api.SyntheticModule([],1)])errors.push(error(run));return errors;
 }
 if(name==='synthetic-live'){
  let calls=0,receiver;const m=new api.SyntheticModule(['value'],function(){calls++;receiver=this;this.setExport('value',7);return Promise.resolve(99);},{identifier:'synthetic'});
  const before={status:m.status,context:m.context,identifier:m.identifier,value:m.namespace.value,link:m.link(()=>{throw Error('synthetic linker called');})};m.setExport('value',3);assert.equal(m.namespace.value,3);const ns=m.namespace;const promise=m.evaluate();const during=m.status;assert.equal(await promise,undefined);assert.equal(await m.evaluate(),undefined);m.setExport('value',11);
  return{before,during,after:m.status,calls,value:ns.value,sameNamespace:ns===m.namespace,nativeNamespace:util.types.isModuleNamespaceObject(ns),nullPrototype:Object.getPrototypeOf(ns)===null,receiverIsPublic:receiver===m,tag:ns[Symbol.toStringTag],missing:error(()=>m.setExport('absent',1))};
 }
 if(name==='requests-link-meta'){
  let metaCalls=0,referrerOK=false;const dep=new api.SyntheticModule(['value'],function(){this.setExport('value',40);},{identifier:'dep'});
  const m=new api.SourceTextModule(`import {value} from 'dep'; export const answer=value+2; export const info=import.meta.marker;`,{identifier:'root',initializeImportMeta(meta,module){metaCalls++;referrerOK=module===m;meta.marker='owner';assert.equal(Object.getPrototypeOf(meta),null);}});
  const requests=m.moduleRequests;assert(Object.isFrozen(requests)&&Object.isFrozen(requests[0])&&Object.isFrozen(requests[0].attributes));assert.equal(Object.getPrototypeOf(requests[0]),null);assert.equal(Object.getPrototypeOf(requests[0].attributes),null);const before={status:m.status,tla:m.hasTopLevelAwait(),ns:error(()=>m.namespace),asyncGraph:error(()=>m.hasAsyncGraph())};let linkerArgs;
  await m.link((specifier,referrer,extra)=>{linkerArgs={specifier,same:referrer===m,assertSame:extra.assert===extra.attributes,frozen:Object.isFrozen(extra.attributes)};return dep;});
  const linked=m.status;await m.evaluate();return{before,requests,dependencySpecifiers:m.dependencySpecifiers,cacheIdentity:m.dependencySpecifiers===m.dependencySpecifiers,linked,status:m.status,answer:m.namespace.answer,info:m.namespace.info,metaCalls,referrerOK,linkerArgs,async:m.hasAsyncGraph()};
 }
 if(name==='direct-requests-cycle'){
  const a=new api.SourceTextModule(`import { b } from 'b'; export function a(){return 'a'};export function result(){return b()}`,{identifier:'a'}),b=new api.SourceTextModule(`import {a} from 'a';export function b(){return a()+'b'}`,{identifier:'b'});
  a.linkRequests([b]);b.linkRequests([a]);a.instantiate();await a.evaluate();return{a:a.status,b:b.status,result:a.namespace.result(),async:a.hasAsyncGraph(),missing:error(()=>new api.SourceTextModule(`import 'missing'`,{identifier:'missing'}).linkRequests([]))};
 }
 if(name==='async-cycle-linker'){
  const a=new api.SourceTextModule(`import {b} from 'b';export function a(){return 'a'};export const result=()=>b();`,{identifier:'a'}),b=new api.SourceTextModule(`import {a} from 'a';export const b=()=>a()+'b';`,{identifier:'b'});await a.link(async s=>s==='a'?a:b);await a.evaluate();return{a:a.status,b:b.status,result:a.namespace.result()};
 }
 if(name==='tla-graph'){
  let release;globalThis.__kandeloVmTlaGate=new Promise(r=>release=r);try{const child=new api.SourceTextModule(`await globalThis.__kandeloVmTlaGate;export const value=42`,{identifier:'child'}),m=new api.SourceTextModule(`import {value}from'child';export{value}`,{identifier:'root'});await m.link(()=>child);const before={rootTla:m.hasTopLevelAwait(),childTla:child.hasTopLevelAwait(),async:m.hasAsyncGraph()};let settled=false;const pending=m.evaluate();pending.then(()=>settled=true);const status=m.status;await Promise.resolve();const wasPending=!settled;release();await pending;return{before,status,wasPending,after:m.status,value:m.namespace.value};}finally{delete globalThis.__kandeloVmTlaGate;}
 }
 if(name==='errors'){
  const sentinel={message:'owned exception'};globalThis.__kandeloVmThrow=sentinel;try{const m=new api.SourceTextModule(`throw globalThis.__kandeloVmThrow`,{identifier:'throw'});await m.link(()=>{});let same=false;try{await m.evaluate();}catch(e){same=e===sentinel;}let repeated=false;try{await m.evaluate();}catch(e){repeated=e===sentinel;}const s=new api.SyntheticModule([],()=>{throw sentinel},{identifier:'synthetic-throw'});let syntheticSame=false;try{await s.evaluate();}catch(e){syntheticSame=e===sentinel;}return{status:m.status,same,errorSame:m.error===sentinel,repeated,syntheticStatus:s.status,syntheticSame,syntheticErrorSame:s.error===sentinel};}finally{delete globalThis.__kandeloVmThrow;}
 }
 if(name==='link-errors-context'){
  const m=new api.SourceTextModule(`import 'dep'`,{identifier:'wrong'});let wrong;try{await m.link(()=>({}));}catch(e){wrong={name:e.name,code:e.code,message:e.message};}const a=api.createContext({}),b=api.createContext({}),x=new api.SourceTextModule(`import 'dep'`,{context:a,identifier:'a'}),y=new api.SourceTextModule('',{context:b,identifier:'b'});let different;try{await x.link(()=>y);}catch(e){different={name:e.name,code:e.code,message:e.message};}return{wrong,status:m.status,errorCode:m.error.code,different,contextIdentity:x.context===a};
 }
 if(name==='dynamic-import'){
  const dep=new api.SyntheticModule(['value'],function(){this.setExport('value',42)},{identifier:'dynamic-dep'});await dep.evaluate();let seen;const m=new api.SourceTextModule(`export const load=()=>import('dynamic-dep')`,{identifier:'dynamic-root',importModuleDynamically(specifier,referrer,attributes,phase){seen={specifier,referrer:referrer===m,attributes,phase};return dep;}});await m.link(()=>{});await m.evaluate();const ns=await m.namespace.load();const missing=new api.SourceTextModule(`export const load=()=>import('missing')`,{identifier:'missing-import'});await missing.link(()=>{});await missing.evaluate();let missingError;try{await missing.namespace.load();}catch(e){missingError={name:e.name,code:e.code,message:e.message};}return{value:ns.value,sameNamespace:ns===dep.namespace,seen,missingError};
 }
 if(name==='foreign-realm-callbacks'){
  const foreign=vm.createContext({seen:[]}),target=api.createContext({});
  const callbacks=vm.runInContext(`({synthetic(){seen.push('synthetic');this.setExport('value',41)},meta(meta,referrer){seen.push('meta');meta.marker=1},link(specifier,referrer,extra){seen.push('link');return dep},dynamic(specifier,referrer,attributes,phase){seen.push('dynamic');return dep}})`,foreign);
  const dep=new api.SyntheticModule(['value'],callbacks.synthetic,{context:target,identifier:'foreign-dep'});foreign.dep=dep;
  const module=new api.SourceTextModule(`import{value}from'dep';export const answer=value+import.meta.marker;export const load=()=>import('dep')`,{context:target,identifier:'foreign-root',initializeImportMeta:callbacks.meta,importModuleDynamically:callbacks.dynamic});
  await module.link(callbacks.link);await module.evaluate();const ns=await module.namespace.load();return{value:module.namespace.answer,dynamicValue:ns.value,sameNamespace:ns===dep.namespace,seen:Array.from(foreign.seen),status:module.status};
 }
 if(name==='context-live'){
  const sandbox={value:7},context=api.createContext(sandbox);const m=new api.SourceTextModule('globalThis.value+=1;export const value=globalThis.value;export const global=globalThis',{context,identifier:'context'});await m.link(()=>{});await m.evaluate();return{value:m.namespace.value,sandbox:sandbox.value,context:m.context===context,globalDiffers:m.namespace.global!==sandbox,nativeNamespace:util.types.isModuleNamespaceObject(m.namespace)};
 }
 throw Error(name);
}
(async()=>{for(const name of['validation','synthetic-live','requests-link-meta','direct-requests-cycle','async-cycle-linker','tla-graph','errors','link-errors-context','dynamic-import','foreign-realm-callbacks','context-live']){
 try{const actual=await scenario(create(),name),expected=await scenario(vm,name);assert.deepEqual(actual,expected);rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.stack});}}
 const report={scope:'Pinned candidate public/internal VM module classes over actual native26 ModuleWrap, context and registry dependencies; no candidate SM JSAPI/engine execution or four-host proof',pass:rows.filter(x=>x.pass).length,fail:rows.filter(x=>!x.pass).length,cases:rows};fs.writeFileSync(out+'/frontend-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.fail?1:0;})().catch(e=>{console.error(e);process.exitCode=1});
