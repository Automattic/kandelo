'use strict';
// Candidate JS/native-admission routing with an explicit genuine native Node
// loader dependency. The production C++ request/completion owner is not compiled
// or executed by this control; no guest/engine/four-host acceptance is implied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../..');
const bundle = fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factory = Function(bundle+';return _createNodeESMGraphPlatform;')();
const loader = require('internal/modules/esm/loader').getOrInitializeCascadedLoader();
const values = { errors: require('internal/errors'), validators: require('internal/validators'), util: require('internal/util') };
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-module-import-'));
const parentURL = pathToFileURL(path.join(dir,'parent.mjs')).href;
const nativeCalls = [];
const graph = factory({records:{Module},values,url:require('node:url'),native:{
  importModule(specifier,parent,attributes) {
    nativeCalls.push({specifier,parent,attributes});
    return loader.import(specifier,parent,attributes);
  },
}});
function write(name,text){const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);return pathToFileURL(f).href;}
const records=[];
async function group(name,fn){await fn();records.push({name,pass:true});}
async function main(){
 await group('original specifier conversion/referrer/raw attribute identity',async()=>{
  write('esm.mjs','export const answer=42');const hints=[];
  const attributes={};const specifier={[Symbol.toPrimitive](hint){hints.push(hint);return './esm.mjs';}};
  const count=nativeCalls.length;const ns=await graph.importModule(specifier,parentURL,attributes);
  assert.equal(ns.answer,42);assert.deepEqual(hints,['string']);
  assert.equal(nativeCalls.length,count+1);assert.deepEqual(nativeCalls.at(-1),{specifier:'./esm.mjs',parent:parentURL,attributes});
  assert.equal(nativeCalls.at(-1).attributes,attributes);
 });
 await group('bare package and builtin native namespaces',async()=>{
  write('node_modules/pkg/package.json','{"type":"module","exports":"./index.mjs"}');write('node_modules/pkg/index.mjs','export const value="package"');
  const ns=await graph.importModule('pkg',parentURL);assert.equal(ns.value,'package');
  const builtin=await graph.importModule('node:path',parentURL);assert.equal(builtin.default,require('node:path'));
 });
 await group('genuine CommonJS/JSON namespace providers',async()=>{
  write('owner.cjs','exports.answer=42;');write('data.json','{"answer":42}');
  const cjs=await graph.importModule('./owner.cjs',parentURL);assert.equal(cjs.answer,42);assert.equal(cjs.default,require(path.join(dir,'owner.cjs')));
  const data=await graph.importModule('./data.json',parentURL,{type:'json'});assert.equal(data.default.answer,42);assert.equal(data.default,require(path.join(dir,'data.json')));
 });
 await group('one top-level hook per request/cache-false namespace selection',async()=>{
  const a=write('a.mjs','export const value="a"'),b=write('b.mjs','export const value="b"');let hits=0;const seen=[];
  const h=Module.registerHooks({resolve(specifier,context,next){if(specifier==='component:flip'){hits++;seen.push([specifier,context.parentURL]);return{url:hits%2?a:b,shortCircuit:true};}return next(specifier,context);}});
  try{const first=await graph.importModule('component:flip',parentURL);const second=await graph.importModule('component:flip',parentURL);assert.equal(first.value,'a');assert.equal(second.value,'b');assert.notEqual(first,second);assert.equal(hits,2);assert.deepEqual(seen,[['component:flip',parentURL],['component:flip',parentURL]]);}finally{h.deregister();}
 });
 await group('stable cache/query identities/evaluation once',async()=>{
  globalThis.__kandeloImportCount=0;const target=write('cached.mjs','globalThis.__kandeloImportCount++;export const answer=42;');const canonicalTarget=pathToFileURL(fs.realpathSync(path.join(dir,'cached.mjs'))).href;let loads=0;
  const h=Module.registerHooks({load(url,context,next){if(url===canonicalTarget)loads++;return next(url,context);}});
  try{const a=await graph.importModule('./cached.mjs',parentURL),b=await graph.importModule('./cached.mjs',parentURL);assert.equal(a,b);assert.equal(loads,1);assert.equal(globalThis.__kandeloImportCount,1);const c=await graph.importModule('./cached.mjs?v=2',parentURL);assert.notEqual(c,a);assert.equal(globalThis.__kandeloImportCount,2);}finally{h.deregister();delete globalThis.__kandeloImportCount;}
 });
 await group('raw custom attributes reach hooks before actual load validation',async()=>{
  const target=write('hooked.json','{"value":"json"}');const attributes={custom:'retained'};let resolved=0,loaded=0;
  const h=Module.registerHooks({resolve(specifier,context,next){if(specifier==='component:attributes'){resolved++;assert.equal(context.importAttributes,attributes);return{url:target,importAttributes:{type:'json'},shortCircuit:true};}return next(specifier,context);},load(url,context,next){if(url===target){loaded++;assert.equal(context.importAttributes.type,'json');}return next(url,context);}});
  try{const ns=await graph.importModule('component:attributes',parentURL,attributes);assert.equal(ns.default.value,'json');assert.equal(resolved,1);assert.equal(loaded,1);}finally{h.deregister();}
 });
 await group('original conversion/hook/evaluation thrown identities',async()=>{
  const marker={owned:'conversion'};const n=nativeCalls.length;
  await assert.rejects(graph.importModule({[Symbol.toPrimitive](){throw marker;}},parentURL),e=>e===marker);assert.equal(nativeCalls.length,n);
  await assert.rejects(graph.importModule(Symbol('not coerced'),parentURL),TypeError);assert.equal(nativeCalls.length,n);
  const h=Module.registerHooks({resolve(specifier,context,next){if(specifier==='component:throw')throw marker;return next(specifier,context);}});
  try{await assert.rejects(graph.importModule('component:throw',parentURL),e=>e===marker);}finally{h.deregister();}
  globalThis.__kandeloImportError=marker;write('throws.mjs','throw globalThis.__kandeloImportError;');
  try{await assert.rejects(graph.importModule('./throws.mjs',parentURL),e=>e===marker);}finally{delete globalThis.__kandeloImportError;}
 });
 await group('evaluation asynchronous/TLA actual completion ownership',async()=>{
  const {promise:started,resolve:start}=Promise.withResolvers();const {promise:gate,resolve:release}=Promise.withResolvers();
  globalThis.__kandeloImportStart=start;globalThis.__kandeloImportGate=gate;
  write('tla.mjs','globalThis.__kandeloImportStart();await globalThis.__kandeloImportGate;export const answer=42;');let settled=false,entered=false;
  const oldStart=globalThis.__kandeloImportStart;globalThis.__kandeloImportStart=()=>{entered=true;oldStart();};
  const pending=graph.importModule('./tla.mjs',parentURL).then(ns=>{settled=true;return ns;});
  assert.equal(entered,false);await started;assert.equal(settled,false);release();assert.equal((await pending).answer,42);assert.equal(settled,true);
  delete globalThis.__kandeloImportStart;delete globalThis.__kandeloImportGate;
 });
 await group('namespace then export assimilation retained',async()=>{
  write('then.mjs','export function then(resolve){resolve("actual namespace then");}');
  assert.equal(await graph.importModule('./then.mjs',parentURL),'actual namespace then');
 });
 console.log(JSON.stringify({groups:records.length,failures:0,records,scope:'Actual JS forwarding+native Node loader component; production native C++ request/completion uncompiled/unexecuted',compiles:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
