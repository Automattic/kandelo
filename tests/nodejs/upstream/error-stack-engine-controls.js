'use strict';
// Genuine saved-frame/lazy preparation controls; no upstream realm startup.
const api=globalThis.__kandeloUpstreamTest;
const originalCapture=Error.captureStackTrace;
api.initializeContext();
const binding=api.getErrorBinding();
const observations=[];let failures=0;
function check(name,callback){
  try{Error.stackTraceLimit=10;delete Error.prepareStackTrace;callback();observations.push({name,status:'pass'});}
  catch(error){let stack;try{stack=error.stack}catch{}failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:typeof stack==='string'?stack:undefined}});}
}
function thrown(callback){try{callback()}catch(error){return error}throw new Error('expected failure')}
function capture(){const target={name:'Custom',message:'captured'};Error.captureStackTrace(target,capture);return target}
check('original-native-capture-survives-primordials-initialization',()=>{
  assertEq(typeof originalCapture,'function');assertEq(Error.captureStackTrace,originalCapture);
  assertEq(api.getContextExports().primordials.ErrorCaptureStackTrace,originalCapture);
  assertEq(Error.stackTraceLimit,10);assertEq(api.getErrorBinding(),binding);
});
check('preparation-is-lazy-cached-and-has-real-own-accessors',()=>{
  let calls=0;const marker={identity:'prepared'};
  Error.prepareStackTrace=function(error,trace){calls++;assertEq(this,Error);assertEq(error,created);assertEq(Array.isArray(trace),true);return marker};
  const created=new Error('lazy');assertEq(calls,0);
  const descriptor=Object.getOwnPropertyDescriptor(created,'stack');
  assertEq(typeof descriptor.get,'function');assertEq(typeof descriptor.set,'function');assertEq(descriptor.enumerable,false);assertEq(descriptor.configurable,true);
  assertEq(created.stack,marker);assertEq(created.stack,marker);assertEq(calls,1);
});
check('zero-negative-fractional-and-nan-limits',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;
  for(const [limit,count] of [[0,0],[-1,0],[1.9,1],[NaN,0]]){Error.stackTraceLimit=limit;assertEq(new Error().stack.length,count);assertEq(capture().stack.length,count)}
});
check('non-numeric-and-accessor-limits-disable-without-getters',()=>{
  let calls=0,reads=0;Error.prepareStackTrace=()=>{calls++;return 1};
  for(const limit of [undefined,'2',null]){Error.stackTraceLimit=limit;assertEq(new Error().stack,undefined);assertEq(capture().stack,undefined)}
  Object.defineProperty(Error,'stackTraceLimit',{get(){reads++;return 2},configurable:true});
  assertEq(new Error().stack,undefined);assertEq(reads,0);assertEq(calls,0);
  Object.defineProperty(Error,'stackTraceLimit',{value:10,writable:true,configurable:true,enumerable:true});
});
check('capture-limit-is-fixed-at-creation',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;Error.stackTraceLimit=1;
  const error=new Error('fixed');Error.stackTraceLimit=3;assertEq(error.stack.length,1);
});
check('constructor-opt-trims-real-captured-frames',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;
  function outerCapture(){return capture()}
  const trace=outerCapture().stack;assertEq(trace[0].getFunctionName(),'outerCapture');
  const absent={};Error.captureStackTrace(absent,function notOnStack(){});assertEq(absent.stack.length,0);
});
check('thrown-preparation-is-retried-with-original-exception',()=>{
  let calls=0;const marker={identity:'preparation exception'};Error.prepareStackTrace=()=>{calls++;throw marker};
  const error=new Error('retry');assertEq(thrown(()=>error.stack),marker);assertEq(thrown(()=>error.stack),marker);assertEq(calls,2);
});
check('undefined-return-is-cached-as-a-real-result',()=>{
  let calls=0;Error.prepareStackTrace=()=>{calls++;return undefined};const error=new Error('undefined');
  assertEq(error.stack,undefined);assertEq(error.stack,undefined);assertEq(calls,1);
});
check('stack-assignment-replaces-pending-and-prepared-values',()=>{
  let calls=0;Error.prepareStackTrace=()=>{calls++;return 'unused'};const error=new Error('assigned');
  const marker={identity:'assigned'};error.stack=marker;assertEq(error.stack,marker);assertEq(calls,0);
  error.stack=17;assertEq(error.stack,17);
});
check('frozen-error-retains-functional-internal-cache',()=>{
  let calls=0;Error.prepareStackTrace=()=>{calls++;return 'frozen'};const error=Object.freeze(new Error('frozen'));
  assertEq(error.stack,'frozen');assertEq(error.stack,'frozen');assertEq(calls,1);
});
check('recapture-replaces-original-capture-and-cache',()=>{
  let calls=0;Error.prepareStackTrace=()=>++calls;const target=capture();assertEq(target.stack,1);
  Error.captureStackTrace(target);assertEq(target.stack,2);assertEq(target.stack,2);
});
check('recursive-preparation-uses-real-default-frames',()=>{
  let calls=0;Error.prepareStackTrace=(error,trace)=>{calls++;return {recursive:error.stack,nested:new Error('nested').stack,count:trace.length}};
  const error=new Error('recursive');const result=error.stack;assertEq(calls,1);
  assertEq(result.recursive.startsWith('Error: recursive\n    at '),true);
  assertEq(result.nested.startsWith('Error: nested\n    at '),true);assertEq(result.count>0,true);
});
check('borrowed-stack-accessor-reads-only-real-target-captures',()=>{
  const target=capture();const get=Object.getOwnPropertyDescriptor(target,'stack').get;
  assertEq(get.call({}),undefined);assertEq(get.call(null),undefined);
  const other=new Error('other');assertEq(get.call(other),other.stack);
});
check('proxy-capture-refuses-without-running-property-traps',()=>{
  let traps=0;const proxy=new Proxy({},{defineProperty(){traps++;return true}});
  assertEq(thrown(()=>Error.captureStackTrace(proxy)) instanceof TypeError,true);assertEq(traps,0);
  const target=Object.preventExtensions({});assertEq(thrown(()=>Error.captureStackTrace(target)) instanceof TypeError,true);
});
check('inherited-data-limit-is-read-without-coercion',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;delete Error.stackTraceLimit;
  Object.defineProperty(Function.prototype,'stackTraceLimit',{value:1,configurable:true});
  try{assertEq(new Error().stack.length,1)}finally{delete Function.prototype.stackTraceLimit;Error.stackTraceLimit=10}
  const originalPrototype=Object.getPrototypeOf(Error);delete Error.stackTraceLimit;let traps=0;
  Object.setPrototypeOf(Error,new Proxy({stackTraceLimit:2},{get(){traps++;return 2},getOwnPropertyDescriptor(){traps++;return {value:2,configurable:true}}}));
  try{assertEq(new Error().stack,undefined);assertEq(traps,0)}finally{Object.setPrototypeOf(Error,originalPrototype);Error.stackTraceLimit=10}
});
check('saved-callsite-methods-use-actual-module-source-and-survive-gc',()=>{
  Error.prepareStackTrace=(error,trace)=>trace;
  const {ModuleWrap}=api.getModuleWrapBinding();
  const module=new ModuleWrap('fixture:error-stack-source',undefined,'export function origin(){return new Error("from actual source")}',0,0);
  module.link([]);module.instantiate();module.evaluateSync();const error=module.getNamespace().origin();
  const site=error.stack[0];gc();assertEq(site.getFileName(),'fixture:error-stack-source');
  assertEq(site.getScriptNameOrSourceURL(),'fixture:error-stack-source');assertEq(site.getFunctionName(),'origin');
  assertEq(site.getLineNumber(),1);assertEq(site.getColumnNumber()>0,true);assertEq(site.toString().includes('fixture:error-stack-source:1:'),true);
  assertEq(thrown(()=>site.getThis()).code,'ERR_KANDELO_NOT_IMPLEMENTED');
  assertEq(thrown(()=>site.getLineNumber.call({})) instanceof TypeError,true);
  const pragmas=new ModuleWrap('fixture:error-stack-pragmas',undefined,'export function pragmaOrigin(){return new Error("pragma")}\n//# sourceURL=displayed-source.js',0,0);
  pragmas.link([]);pragmas.instantiate();pragmas.evaluateSync();const pragmaSite=pragmas.getNamespace().pragmaOrigin().stack[0];
  gc();assertEq(pragmaSite.getFileName(),'fixture:error-stack-pragmas');assertEq(pragmaSite.getScriptNameOrSourceURL(),'displayed-source.js');
});
check('unowned-realm-keeps-original-engine-capture-path',()=>{
  const realm=newGlobal({newCompartment:true});
  assertEq(realm.eval('Error.stackTraceLimit'),undefined);
  assertEq(realm.eval('const target={};Error.captureStackTrace(target);typeof Object.getOwnPropertyDescriptor(target,"stack").value'),'string');
});
check('foreign-owned-error-prepares-in-its-original-realm',()=>{
  const realm=newGlobal({newCompartment:true});api.initializeContext(realm);
  realm.eval('Error.prepareStackTrace=(error,trace)=>({error,trace,realm:Object.prototype});');
  const error=realm.eval('new Error("foreign")');gc();assertEq(error.stack.realm,realm.Object.prototype);
  const get=Object.getOwnPropertyDescriptor(capture(),'stack').get;assertEq(get.call(error),error.stack);
});
check('native-fatal-enhancers-retain-and-invoke-real-callbacks',()=>{
  const error=new Error('fatal');const phases=[];
  binding.setEnhanceStackForFatalException(function(value){assertEq(this,undefined);assertEq(value,error);phases.push('before');return 'before'},
    function(value){assertEq(this,undefined);assertEq(value,error);phases.push('after');return 'after'});
  gc();assertEq(api.enhanceFatalStack(error,false),'before');assertEq(api.enhanceFatalStack(error,true),'after');assertEq(phases.join(','),'before,after');
});
check('error-binding-requires-successful-original-context-initialization',()=>{
  const realm=newGlobal({newCompartment:true});
  assertEq(thrown(()=>api.getErrorBinding(realm)).message.includes('has not been initialized'),true);
  const marker={identity:'original initializer failure'};realm.marker=marker;
  realm.eval('Object.defineProperty(globalThis,"Array",{get(){throw marker},configurable:true})');
  assertEq(thrown(()=>api.initializeContext(realm)),marker);
  assertEq(thrown(()=>api.getErrorBinding(realm)).message.includes('initialization failed'),true);
});
check('registered-bootstrap-preparation-receives-global-error-and-trace',()=>{
  let calls=0;const error=new Error('bootstrap callback');
  binding.setPrepareStackTraceCallback(function(global,value,trace){calls++;assertEq(this,undefined);assertEq(global===globalThis,true);assertEq(value===error,true);assertEq(Array.isArray(trace),true);assertEq(trace.length>0,true);return {identity:'native callback result'}});
  const result=error.stack;gc();assertEq(error.stack,result);assertEq(result.identity,'native callback result');assertEq(calls,1);
});
print(JSON.stringify({kind:'native-error-stack-controls',plannedCases:21,cases:observations.length,notRun:21-observations.length,failures,observations,
  limits:['No upstream realm/bootstrap/startup','No browser proof','Saved-frame CallSite core only; receiver/function/eval/native/async/constructor/Wasm metadata remains explicit gaps','No full security/OOM/finalization/native differential']}));
if(failures)quit(1);
