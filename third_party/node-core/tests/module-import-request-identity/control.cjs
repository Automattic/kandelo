'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),{pathToFileURL}=require('node:url');
assert.equal(process.version,'v26.13.0');
const util=require('node:util');
const root=path.resolve(process.argv[2]),graphPath=path.resolve(process.argv[3]),mode=process.argv[4];
const bundlePath=path.resolve(process.argv[5] || path.join(root,'third_party/node-core/node-core.js'));const bundleBytes=fs.readFileSync(bundlePath);const baseBundle=bundleBytes.toString();
const primordials=Function(baseBundle+';return _createNodePrimordials;')();
const factory=Function('_createNodePrimordials',fs.readFileSync(graphPath,'utf8')+';return _createNodeESMGraphPlatform;')(primordials);
const loader=require('internal/modules/esm/loader').getOrInitializeCascadedLoader();
const descriptors=new Map(['internalBinding','primordials'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
const {internalBinding}=require('internal/test/binding');for(const[name,d]of descriptors){if(d)Object.defineProperty(globalThis,name,d);else delete globalThis[name];}
const {ModuleWrap}=internalBinding('module_wrap');
const graph=factory({records:{Module,getModuleResolver:()=>loader},values:{validators:require('internal/validators'),errors:require('internal/errors'),util:require('internal/util')},url:require('node:url'),types:util.types,TextDecoder});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-import-review-'))),parentURL=pathToFileURL(path.join(dir,'parent.mjs')).href;
const physical=path.join(dir,'target.mjs');fs.writeFileSync(physical,'export const selected="physical-wrong";');const target=pathToFileURL(physical).href;
const supplied='export const selected="actual hook source";';const replacement={};let typeReads=0,resolveCalls=0,loadCalls=0;
const marker={review:'original-type-getter'};const attributes=Object.create(null);Object.defineProperty(attributes,'type',{get(){typeReads++;throw marker;}});
const wrap=new ModuleWrap('kandelo-review-real-request',undefined,'import "review:raw";',0,0);const request=wrap.getModuleRequests()[0];assert.deepEqual(request,wrap.getModuleRequests()[0]);
const hook=Module.registerHooks({resolve(specifier,context,next){if(specifier==='review:raw'){resolveCalls++;assert.equal(context.importAttributes,attributes);return{url:target,importAttributes:replacement,format:'module',shortCircuit:true};}if(specifier==='review:A'||specifier==='review:B')return{url:target,importAttributes:{label:specifier},format:'module',shortCircuit:true};return next(specifier,context);},load(url,context,next){if(url===target){loadCalls++;assert.equal(context.importAttributes,replacement);return{format:'module',source:supplied,shortCircuit:true};}return next(url,context);}});
async function main(){
 const expected=await loader.import('review:raw',parentURL,attributes);assert.equal(expected.selected,'actual hook source');assert.equal(typeReads,0);console.log(JSON.stringify({stage:'native replacement-attributes baseline',typeReads,resolveCalls,loadCalls,actualSuppliedSource:true}));
 let resolved;
 assert.doesNotThrow(()=>{resolved=graph.resolve('review:raw',parentURL,attributes,false,request);},'Actual graph must not read original type after hook replaces attributes');
 const record=graph.record(resolved,attributes,request);assert.equal(record.importAttributes,replacement);assert.equal(record.parentURL,parentURL);assert.equal(typeReads,0);
 const loaded=graph.load(record);assert.equal(loaded.source,supplied);assert.equal(loaded.format,'module');assert.equal(typeReads,0);
 const reqs=new ModuleWrap('kandelo-review-two-requests',undefined,'import "review:A";import "review:B";',0,0).getModuleRequests();
 const a=graph.resolve('review:A',parentURL,{},false,reqs[0]);const b=graph.resolve('review:B',parentURL,{},false,reqs[1]);assert.equal(a,b);
 assert.equal(graph.record(a,{},reqs[0]).importAttributes.label,'review:A');assert.equal(graph.record(b,{},reqs[1]).importAttributes.label,'review:B');
 hook.deregister();
 const entry=path.join(dir,'link.mjs');fs.writeFileSync(entry,'import "review:missing";export const okay=true;');const url=pathToFileURL(entry).href;let failures=0,allow=false;const linkError={review:'original-link-error'};
 const linkHook=Module.registerHooks({resolve(specifier,context,next){if(specifier==='review:missing'){failures++;if(!allow)throw linkError;return{url:target,format:'module',shortCircuit:true};}return next(specifier,context);}});
 try{await assert.rejects(loader.import(url,parentURL,{}),error=>error===linkError);allow=true;assert.equal((await loader.import(url,parentURL,{})).okay,true);assert.equal(failures,2);}finally{linkHook.deregister();}
 console.log(JSON.stringify({passed:true,mode,groups:3,replacementAttributesAndSuppliedSource:true,actualRequestRecordsRemainDistinct:true,originalTypeGetterReads:typeReads,nativeFirstResolveErrorIdentity:true,nativeResolveFailureRetry:true,nativeLinkHookCalls:failures,scope:'Actual candidate graph resolve/record/load with genuine native Node hooks/loader/source/request-record dependencies; new C++ request bridge and guest runtime unexecuted'}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{hook.deregister();fs.rmSync(dir,{recursive:true,force:true});});
