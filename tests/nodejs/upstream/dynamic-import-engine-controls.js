'use strict';
// Native callback/engine controls. This does not run the upstream Node loader.
const api=globalThis.__kandeloUpstreamTest;
api.initializeContext();
const binding=api.getModuleWrapBinding();
const {ModuleWrap}=binding;
const observations=[];
let failures=0;
function check(name, callback) {
  try {callback();observations.push({name,status:'pass'});}
  catch(error) {failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}});}
}
function state(promise) {
  const result={status:'pending'};
  promise.then(value=>{result.status='fulfilled';result.value=value},error=>{result.status='rejected';result.error=error});
  drainJobQueue();return result;
}
function fulfilled(promise) {const r=state(promise);assertEq(r.status,'fulfilled');return r.value;}
function rejected(promise) {const r=state(promise);assertEq(r.status,'rejected');return r.error;}
let serial=0;
function source(text,identity=Symbol('importer'),url='fixture:dynamic-'+serial++) {
  const module=new ModuleWrap(url,undefined,text,0,0,identity);
  module.link([]);module.instantiate();return module;
}
function imported(expression='import("target")') {
  const module=source('export const value='+expression+';');
  fulfilled(module.evaluate(-1,false));return module.getNamespace().value;
}
check('five-original-callback-arguments-and-frozen-attributes',()=>{
  const identity=Symbol('original id');let calls=0;
  binding.setImportModuleDynamicallyCallback(function(...args){
    calls++;assertEq(this,undefined);assertEq(args.length,5);assertEq(args[0],identity);
    assertEq(args[1],'target');assertEq(args[2],binding.kEvaluationPhase);
    assertEq(Object.getPrototypeOf(args[3]),null);assertEq(Object.isFrozen(args[3]),true);
    assertEq(args[3].custom,'retained');assertEq(args[3].type,'unknown-native-type');
    assertEq(args[4],'fixture:original-resource');return 42;
  });
  const module=source('export const value=import("target",{with:{custom:"retained",type:"unknown-native-type"}});',identity,'fixture:original-resource');
  module.url='fixture:changed-public-property';fulfilled(module.evaluate(-1,false));
  assertEq(fulfilled(module.getNamespace().value),42);assertEq(calls,1);
});
check('ordinary-values-and-referrer-promise',()=>{
  const marker={identity:'callback value'};
  binding.setImportModuleDynamicallyCallback(()=>marker);
  const promise=imported();assertEq(Object.getPrototypeOf(promise),Promise.prototype);
  assertEq(fulfilled(promise),marker);
  binding.setImportModuleDynamicallyCallback(()=>undefined);assertEq(fulfilled(imported()),undefined);
});
check('thenable-adoption-is-asynchronous-and-once',()=>{
  let invoked=0;const order=[];
  binding.setImportModuleDynamicallyCallback(()=>({then(resolve,reject){invoked++;order.push('then');resolve(12);reject('ignored');resolve(13)}}));
  const module=source('export const value=import("target");');
  const evaluated=module.evaluate(-1,false);assertEq(invoked,0);order.push('returned');
  fulfilled(evaluated);assertEq(fulfilled(module.getNamespace().value),12);
  assertEq(invoked,1);assertEq(order.join(','),'returned,then');
});
check('pending-promise-owns-real-completion-through-gc',()=>{
  let release;binding.setImportModuleDynamicallyCallback(()=>new Promise(resolve=>{release=resolve}));
  const promise=imported();const pending=state(promise);assertEq(pending.status,'pending');
  gc();release({answer:27});drainJobQueue();assertEq(pending.status,'fulfilled');assertEq(pending.value.answer,27);
});
check('callback-promise-rejection-preserves-original-value',()=>{
  const marker={identity:'rejection'};
  binding.setImportModuleDynamicallyCallback(()=>Promise.reject(marker));
  assertEq(rejected(imported()),marker);
});
check('throwing-then-getter-rejects-import-with-original-value',()=>{
  const marker={identity:'then getter'};
  binding.setImportModuleDynamicallyCallback(()=>({get then(){throw marker}}));
  assertEq(rejected(imported()),marker);
});
check('synchronous-callback-exception-stops-importing-module',()=>{
  const marker={identity:'callback exception'};globalThis.afterDynamicCallback=false;
  binding.setImportModuleDynamicallyCallback(()=>{throw marker});
  const module=source('export const value=import("target");globalThis.afterDynamicCallback=true;');
  assertEq(rejected(module.evaluate(-1,false)),marker);
  assertEq(globalThis.afterDynamicCallback,false);assertEq(module.getError(),marker);
});
check('invalid-options-reject-before-callback',()=>{
  let calls=0;binding.setImportModuleDynamicallyCallback(()=>{calls++;return 1});
  for(const expression of ['import("target",0)','import("target",{with:0})','import("target",{with:{type:0}})','import("target",{with:{custom:0}})'])
    assertEq(rejected(imported(expression)) instanceof TypeError,true);
  const marker={identity:'options getter'};globalThis.dynamicOptions={get with(){throw marker}};
  assertEq(rejected(imported('import("target",globalThis.dynamicOptions)')),marker);assertEq(calls,0);
});
check('specifier-coercion-options-order-and-numeric-attribute-keys',()=>{
  const order=[];
  globalThis.dynamicSpecifier={toString(){order.push('specifier');return 'coerced'}};
  globalThis.dynamicOptions={get with(){order.push('with');return {get 7(){order.push('attribute');return 'numeric'}}}};
  binding.setImportModuleDynamicallyCallback((id,specifier,phase,attributes)=>{
    order.push('callback');assertEq(specifier,'coerced');assertEq(attributes['7'],'numeric');return 7;
  });
  assertEq(fulfilled(imported('import(globalThis.dynamicSpecifier,globalThis.dynamicOptions)')),7);
  assertEq(order.join(','),'specifier,with,attribute,callback');
});
check('actual-namespace-and-top-level-await-use-one-engine-graph',()=>{
  const dependency=new ModuleWrap('fixture:dynamic-dependency',undefined,['value'],function(){this.setExport('value',51)});
  dependency.instantiate();fulfilled(dependency.evaluate(-1,false));
  binding.setImportModuleDynamicallyCallback(()=>dependency.getNamespace());
  const module=source('const ns=await import("not-a-static-request");export {ns};export const value=ns.value;');
  fulfilled(module.evaluate(-1,false));assertEq(module.getNamespace().ns,dependency.getNamespace());
  assertEq(module.getNamespace().value,51);dependency.setExport('value',52);assertEq(module.getNamespace().ns.value,52);
});
check('top-level-await-remains-pending-until-callback-settles',()=>{
  let release;binding.setImportModuleDynamicallyCallback(()=>new Promise(resolve=>{release=resolve}));
  const module=source('export const value=await import("pending");');
  const evaluation=state(module.evaluate(-1,false));assertEq(evaluation.status,'pending');
  gc();release(63);drainJobQueue();assertEq(evaluation.status,'fulfilled');assertEq(module.getNamespace().value,63);
});
check('foreign-promise-is-adopted-in-referrer-realm',()=>{
  const realm=newGlobal({newCompartment:true});const marker=realm.eval('({identity:"foreign value"})');
  realm.foreignValue=marker;const foreignPromise=realm.eval('Promise.resolve(foreignValue)');
  binding.setImportModuleDynamicallyCallback(()=>foreignPromise);
  const promise=imported();assertEq(Object.getPrototypeOf(promise),Promise.prototype);
  gc();assertEq(fulfilled(promise),marker);
});
check('realm-callback-registration-and-pending-replacement-are-distinct',()=>{
  let release;binding.setImportModuleDynamicallyCallback(()=>new Promise(resolve=>{release=resolve}));
  const pending=imported();binding.setImportModuleDynamicallyCallback(()=>81);
  const realm=newGlobal({newCompartment:true});api.initializeContext(realm);
  const other=api.getModuleWrapBinding(realm);other.setImportModuleDynamicallyCallback(()=>82);
  const module=new other.ModuleWrap('fixture:other-callback',undefined,'export const value=import("target");',0,0);
  module.link([]);module.instantiate();fulfilled(module.evaluate(-1,false));
  assertEq(Object.getPrototypeOf(module.getNamespace().value),realm.Promise.prototype);
  assertEq(fulfilled(module.getNamespace().value),82);assertEq(fulfilled(imported()),81);
  release(80);assertEq(fulfilled(pending),80);
});
check('ordinary-shell-record-dynamic-import-keeps-original-loader',()=>{
  const dependency=parseModule('export const value=93;','shell:dynamic-dependency');
  registerModule('dynamic-shell-dependency',dependency);
  const module=parseModule('export const value=import("dynamic-shell-dependency");','shell:dynamic-root');
  moduleLink(module);fulfilled(moduleEvaluate(module));assertEq(fulfilled(api.moduleNamespace(module).value).value,93);
});
print(JSON.stringify({kind:'native-dynamic-import-controls',plannedCases:14,cases:observations.length,
  notRun:14-observations.length,failures,observations,
  limits:['No upstream realm/bootstrap/CJS/ESM startup','No browser proof','Only ModuleWrap-owned evaluation-phase imports covered','Default metadata/contextify/cache/facade/interrupt backends remain unfinished']}));
if(failures)quit(1);
