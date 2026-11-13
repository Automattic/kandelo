'use strict';
// Native reference only. These host modules are test assertions/realm fixtures.
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {internalBinding}=require('internal/test/binding');
const binding=internalBinding('module_wrap');
const {ModuleWrap}=binding;
const observations=[];let failures=0,serial=0;
async function check(name,callback){
  try{await callback();observations.push({name,status:'pass'});}
  catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}});}
}
function source(text,id=Symbol('importer'),url='reference:dynamic-'+serial++){
  const module=new ModuleWrap(url,undefined,text,0,0,id);module.link([]);module.instantiate();return module;
}
async function imported(expression='import("target")'){
  const module=source('export const value='+expression+';');await module.evaluate(-1,false);
  // Return a box so this helper does not itself assimilate the import Promise.
  return {promise:module.getNamespace().value};
}
(async()=>{
  await check('five-original-arguments-and-complete-frozen-attributes',async()=>{
    const id=Symbol('original');let calls=0;
    binding.setImportModuleDynamicallyCallback(function(...args){
      calls++;assert.equal(this,undefined);assert.equal(args.length,5);assert.equal(args[0],id);
      assert.equal(args[1],'target');assert.equal(args[2],3);
      assert.equal(Object.getPrototypeOf(args[3]),null);assert.equal(Object.isFrozen(args[3]),true);
      assert.equal(args[3].custom,'retained');assert.equal(args[3].type,'unknown-native-type');
      assert.equal(args[4],'reference:original-resource');return 42;
    });
    const module=source('export const value=import("target",{with:{custom:"retained",type:"unknown-native-type"}});',id,'reference:original-resource');
    module.url='changed';await module.evaluate(-1,false);assert.equal(await module.getNamespace().value,42);assert.equal(calls,1);
  });
  await check('ordinary-values-and-referrer-promise',async()=>{
    const marker={identity:'plain value'};binding.setImportModuleDynamicallyCallback(()=>marker);
    const {promise}=await imported();assert.equal(Object.getPrototypeOf(promise),Promise.prototype);assert.equal(await promise,marker);
    binding.setImportModuleDynamicallyCallback(()=>undefined);assert.equal(await (await imported()).promise,undefined);
  });
  await check('thenable-adoption-is-asynchronous-and-once',async()=>{
    let invoked=0;const order=[];
    binding.setImportModuleDynamicallyCallback(()=>({then(resolve,reject){invoked++;order.push('then');resolve(12);reject('ignored');resolve(13)}}));
    const module=source('export const value=import("target");');const evaluation=module.evaluate(-1,false);
    assert.equal(invoked,0);order.push('returned');await evaluation;assert.equal(await module.getNamespace().value,12);
    assert.equal(invoked,1);assert.equal(order.join(','),'returned,then');
  });
  await check('pending-promise-has-real-settlement',async()=>{
    let release;binding.setImportModuleDynamicallyCallback(()=>new Promise(resolve=>{release=resolve}));
    const {promise}=await imported();let settled=false;promise.then(()=>{settled=true});await Promise.resolve();assert.equal(settled,false);
    release(27);assert.equal(await promise,27);
  });
  await check('promise-rejection-preserves-original-value',async()=>{
    const marker={identity:'rejection'};binding.setImportModuleDynamicallyCallback(()=>Promise.reject(marker));
    await assert.rejects((await imported()).promise,error=>error===marker);
  });
  await check('throwing-then-getter-preserves-original-value',async()=>{
    const marker={identity:'then getter'};binding.setImportModuleDynamicallyCallback(()=>({get then(){throw marker}}));
    await assert.rejects((await imported()).promise,error=>error===marker);
  });
  await check('synchronous-callback-exception-stops-importing-module',async()=>{
    const marker={identity:'synchronous'};globalThis.afterDynamicCallback=false;
    binding.setImportModuleDynamicallyCallback(()=>{throw marker});
    const module=source('export const value=import("target");globalThis.afterDynamicCallback=true;');
    const evaluation=module.evaluate(-1,false);assert.equal(evaluation instanceof Promise,true);
    await assert.rejects(evaluation,error=>error===marker);assert.equal(globalThis.afterDynamicCallback,false);assert.equal(module.getError(),marker);
  });
  await check('invalid-options-reject-before-callback',async()=>{
    let calls=0;binding.setImportModuleDynamicallyCallback(()=>{calls++;return 1});
    for(const expression of ['import("target",0)','import("target",{with:0})','import("target",{with:{type:0}})','import("target",{with:{custom:0}})'])
      await assert.rejects((await imported(expression)).promise,TypeError);
    const marker={identity:'options getter'};globalThis.dynamicOptions={get with(){throw marker}};
    await assert.rejects((await imported('import("target",globalThis.dynamicOptions)')).promise,error=>error===marker);assert.equal(calls,0);
  });
  await check('specifier-options-order-and-numeric-attributes',async()=>{
    const order=[];globalThis.dynamicSpecifier={toString(){order.push('specifier');return 'coerced'}};
    globalThis.dynamicOptions={get with(){order.push('with');return {get 7(){order.push('attribute');return 'numeric'}}}};
    binding.setImportModuleDynamicallyCallback((id,specifier,phase,attributes)=>{order.push('callback');assert.equal(specifier,'coerced');assert.equal(attributes['7'],'numeric');return 7});
    assert.equal(await (await imported('import(globalThis.dynamicSpecifier,globalThis.dynamicOptions)')).promise,7);
    assert.equal(order.join(','),'specifier,with,attribute,callback');
  });
  await check('actual-namespace-and-top-level-await',async()=>{
    const dependency=new ModuleWrap('reference:dependency',undefined,['value'],function(){this.setExport('value',51)});
    dependency.instantiate();await dependency.evaluate(-1,false);binding.setImportModuleDynamicallyCallback(()=>dependency.getNamespace());
    const module=source('const ns=await import("not-a-static-request");export {ns};export const value=ns.value;');
    await module.evaluate(-1,false);assert.equal(module.getNamespace().ns,dependency.getNamespace());assert.equal(module.getNamespace().value,51);
    dependency.setExport('value',52);assert.equal(module.getNamespace().ns.value,52);
  });
  await check('top-level-await-waits-for-callback-completion',async()=>{
    let release;binding.setImportModuleDynamicallyCallback(()=>new Promise(resolve=>{release=resolve}));
    const module=source('export const value=await import("pending");');const evaluation=module.evaluate(-1,false);
    let settled=false;evaluation.then(()=>{settled=true});await Promise.resolve();assert.equal(settled,false);
    release(63);await evaluation;assert.equal(module.getNamespace().value,63);
  });
  await check('foreign-promise-is-adopted-in-referrer-realm',async()=>{
    const context=vm.createContext({});const marker=vm.runInContext('({identity:"foreign"})',context);context.marker=marker;
    const foreign=vm.runInContext('Promise.resolve(marker)',context);binding.setImportModuleDynamicallyCallback(()=>foreign);
    const {promise}=await imported();assert.equal(Object.getPrototypeOf(promise),Promise.prototype);assert.equal(await promise,marker);
  });
  console.log(JSON.stringify({kind:'native-dynamic-import-reference-only',version:process.version,platform:process.platform,arch:process.arch,
    v8:process.versions.v8,execArgv:process.execArgv,cases:observations.length,failures,observations,
    limits:['Exact native internal binding reference only','No guest/browser/startup proof','No full security/OOM/lifecycle differential']}));
  if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
