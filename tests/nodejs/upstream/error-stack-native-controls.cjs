'use strict';
// Exact native reference. Host assertions are not guest runtime backends.
const assert=require('node:assert/strict');
const {internalBinding}=require('internal/test/binding');
const binding=internalBinding('errors');
const {ModuleWrap}=internalBinding('module_wrap');
const observations=[];let failures=0;
function check(name,callback){try{Error.stackTraceLimit=10;delete Error.prepareStackTrace;callback();observations.push({name,status:'pass'})}
  catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message}})}}
function capture(){const target={name:'Custom',message:'captured'};Error.captureStackTrace(target,capture);return target}
check('capture-is-an-existing-native-intrinsic',()=>{
  assert.equal(typeof Error.captureStackTrace,'function');assert.equal(Error.stackTraceLimit,10);
  assert.equal(Function.prototype.toString.call(Error.captureStackTrace).includes('[native code]'),true);
});
check('preparation-is-lazy-cached-with-own-accessors',()=>{
  let calls=0;const marker={identity:'prepared'};let created;
  Error.prepareStackTrace=function(error,trace){calls++;assert.equal(this,Error);assert.equal(error,created);assert.equal(Array.isArray(trace),true);return marker};
  created=new Error('lazy');assert.equal(calls,0);const descriptor=Object.getOwnPropertyDescriptor(created,'stack');
  assert.equal(typeof descriptor.get,'function');assert.equal(typeof descriptor.set,'function');assert.equal(descriptor.enumerable,false);assert.equal(descriptor.configurable,true);
  assert.equal(created.stack,marker);assert.equal(created.stack,marker);assert.equal(calls,1);
});
check('zero-negative-fractional-and-nan-limits',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;
  for(const [limit,count] of [[0,0],[-1,0],[1.9,1],[NaN,0]]){Error.stackTraceLimit=limit;assert.equal(new Error().stack.length,count);assert.equal(capture().stack.length,count)}
});
check('non-numeric-and-accessor-limits-disable-without-getters',()=>{
  let calls=0,reads=0;Error.prepareStackTrace=()=>{calls++;return 1};
  for(const limit of [undefined,'2',null]){Error.stackTraceLimit=limit;assert.equal(new Error().stack,undefined);assert.equal(capture().stack,undefined)}
  Object.defineProperty(Error,'stackTraceLimit',{get(){reads++;return 2},configurable:true});assert.equal(new Error().stack,undefined);assert.equal(reads,0);assert.equal(calls,0);
  Object.defineProperty(Error,'stackTraceLimit',{value:10,writable:true,configurable:true,enumerable:true});
});
check('capture-limit-is-fixed-at-creation',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;Error.stackTraceLimit=1;const error=new Error('fixed');Error.stackTraceLimit=3;assert.equal(error.stack.length,1);
});
check('constructor-opt-trims-real-frames',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;function outerCapture(){return capture()}
  assert.equal(outerCapture().stack[0].getFunctionName(),'outerCapture');const absent={};Error.captureStackTrace(absent,function notOnStack(){});assert.equal(absent.stack.length,0);
});
check('throwing-preparation-retries-original-exception',()=>{
  let calls=0;const marker={identity:'exception'};Error.prepareStackTrace=()=>{calls++;throw marker};const error=new Error('retry');
  assert.throws(()=>error.stack,value=>value===marker);assert.throws(()=>error.stack,value=>value===marker);assert.equal(calls,2);
});
check('undefined-preparation-is-cached',()=>{
  let calls=0;Error.prepareStackTrace=()=>{calls++;return undefined};const error=new Error('undefined');assert.equal(error.stack,undefined);assert.equal(error.stack,undefined);assert.equal(calls,1);
});
check('stack-assignment-replaces-pending-and-prepared-values',()=>{
  let calls=0;Error.prepareStackTrace=()=>{calls++;return 'unused'};const error=new Error('assigned'),marker={identity:'assigned'};
  error.stack=marker;assert.equal(error.stack,marker);assert.equal(calls,0);error.stack=17;assert.equal(error.stack,17);
});
check('frozen-error-retains-internal-cache',()=>{
  let calls=0;Error.prepareStackTrace=()=>{calls++;return 'frozen'};const error=Object.freeze(new Error('frozen'));assert.equal(error.stack,'frozen');assert.equal(error.stack,'frozen');assert.equal(calls,1);
});
check('recapture-replaces-capture-and-cache',()=>{
  let calls=0;Error.prepareStackTrace=()=>++calls;const target=capture();assert.equal(target.stack,1);Error.captureStackTrace(target);assert.equal(target.stack,2);assert.equal(target.stack,2);
});
check('recursive-preparation-uses-default-frames',()=>{
  let calls=0;Error.prepareStackTrace=(error,trace)=>{calls++;return {recursive:error.stack,nested:new Error('nested').stack,count:trace.length}};
  const result=new Error('recursive').stack;assert.equal(calls,1);assert.equal(result.recursive.startsWith('Error: recursive\n    at '),true);assert.equal(result.nested.startsWith('Error: nested\n    at '),true);assert.equal(result.count>0,true);
});
check('borrowed-accessor-requires-a-real-target-capture',()=>{
  const get=Object.getOwnPropertyDescriptor(capture(),'stack').get;assert.equal(get.call({}),undefined);assert.equal(get.call(null),undefined);const other=new Error('other');assert.equal(get.call(other),other.stack);
});
check('proxy-capture-refuses-without-property-traps',()=>{
  let traps=0;const proxy=new Proxy({},{defineProperty(){traps++;return true}});assert.throws(()=>Error.captureStackTrace(proxy),TypeError);assert.equal(traps,0);assert.throws(()=>Error.captureStackTrace(Object.preventExtensions({})),TypeError);
});
check('inherited-data-limit-is-read',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;delete Error.stackTraceLimit;Object.defineProperty(Function.prototype,'stackTraceLimit',{value:1,configurable:true});
  try{assert.equal(new Error().stack.length,1)}finally{delete Function.prototype.stackTraceLimit;Error.stackTraceLimit=10}
  const originalPrototype=Object.getPrototypeOf(Error);delete Error.stackTraceLimit;let traps=0;
  Object.setPrototypeOf(Error,new Proxy({stackTraceLimit:2},{get(){traps++;return 2},getOwnPropertyDescriptor(){traps++;return {value:2,configurable:true}}}));
  try{assert.equal(new Error().stack,undefined);assert.equal(traps,0)}finally{Object.setPrototypeOf(Error,originalPrototype);Error.stackTraceLimit=10}
});
check('callsite-core-reads-actual-module-source',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;
  const module=new ModuleWrap('reference:error-stack-source',undefined,'export function origin(){return new Error("actual source")}',0,0);
  module.link([]);module.instantiate();module.evaluateSync();const site=module.getNamespace().origin().stack[0];
  assert.equal(site.getFileName(),'reference:error-stack-source');assert.equal(site.getScriptNameOrSourceURL(),'reference:error-stack-source');assert.equal(site.getFunctionName(),'origin');assert.equal(site.getLineNumber(),1);assert.equal(site.getColumnNumber()>0,true);assert.equal(site.toString().includes('reference:error-stack-source:1:'),true);assert.throws(()=>site.getLineNumber.call({}),TypeError);
  const pragmas=new ModuleWrap('reference:error-stack-pragmas',undefined,'export function pragmaOrigin(){return new Error("pragma")}\n//# sourceURL=displayed-source.js',0,0);
  pragmas.link([]);pragmas.instantiate();pragmas.evaluateSync();const pragmaSite=pragmas.getNamespace().pragmaOrigin().stack[0];
  gc();assert.equal(pragmaSite.getFileName(),'reference:error-stack-pragmas');assert.equal(pragmaSite.getScriptNameOrSourceURL(),'displayed-source.js');
});
check('retained-callsite-survives-collection',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;function retainedOrigin(){return new Error('retained').stack[0]}
  const site=retainedOrigin();gc();assert.equal(site.getFunctionName(),'retainedOrigin');assert.equal(typeof site.getFileName(),'string');assert.equal(site.getLineNumber()>0,true);
});
check('native-bootstrap-callback-receives-global-error-and-trace',()=>{
  let calls=0;const error=new Error('native callback');binding.setPrepareStackTraceCallback(function(global,value,trace){calls++;assert.equal(this,undefined);assert.equal(global,globalThis);assert.equal(value,error);assert.equal(Array.isArray(trace),true);return {identity:'native callback result'}});
  const result=error.stack;assert.equal(error.stack,result);assert.equal(result.identity,'native callback result');assert.equal(calls,1);
});
console.log(JSON.stringify({kind:'native-error-stack-reference-only',version:process.version,platform:process.platform,arch:process.arch,v8:process.versions.v8,execArgv:process.execArgv,cases:observations.length,failures,observations,limits:['Native reference only','No guest/browser/startup proof','Bounded core fields; no complete structured stack/security/OOM/lifecycle differential']}));
if(failures)process.exitCode=1;
