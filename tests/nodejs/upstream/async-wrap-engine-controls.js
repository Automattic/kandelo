'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();
const binding=realm.internalBinding('async_wrap'),symbols=realm.internalBinding('symbols');
const rejectionQueue=realm.internalBinding('task_queue');rejectionQueue.setPromiseRejectCallback(()=>{});
const observations=[];let failures=0,bootstrapFailure;
function thrown(fn){try{fn()}catch(e){return e}throw new Error('expected failure')}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
check('native-constructor-state-comes-from-real-environment-initialization',()=>{
  assertEq(binding.async_hook_fields instanceof Uint32Array,true);assertEq(binding.async_id_fields instanceof Float64Array,true);assertEq(binding.async_ids_stack instanceof Float64Array,true);
  assertEq(binding.async_hook_fields.join(','),'0,0,0,0,0,0,1,0,0');assertEq(binding.async_id_fields.join(','),'0,0,1,-1');assertEq(binding.async_ids_stack.length,32);assertEq(binding.execution_async_resources.length,0);
});
check('binding-cache-methods-and-native-property-attributes',()=>{
  assertEq(realm.internalBinding('async_wrap'),binding);
  for(const name of ['setupHooks','setCallbackTrampoline','pushAsyncContext','popAsyncContext','executionAsyncResource','clearAsyncIdStack','queueDestroyAsyncId','setPromiseHooks','getPromiseHooks','registerDestroyHook']){const d=Object.getOwnPropertyDescriptor(binding,name);assertEq(typeof d.value,'function');assertEq(d.value.name,name);assertEq(d.value.length,0);assertEq(d.writable&&d.enumerable&&d.configurable,true)}
  for(const name of ['async_hook_fields','async_id_fields','execution_async_resources','constants','Providers']){const d=Object.getOwnPropertyDescriptor(binding,name);assertEq(d.enumerable,true);assertEq(d.writable||d.configurable,false)}
  const stack=Object.getOwnPropertyDescriptor(binding,'async_ids_stack');assertEq(stack.writable&&stack.enumerable&&stack.configurable,true);
});
check('all-source-enum-constants-and-provider-names-are-readonly',()=>{
  assertEq(Object.keys(binding.constants).length,13);assertEq(Object.keys(binding.Providers).length,69);
  for(const table of [binding.constants,binding.Providers])for(const name of Object.keys(table)){const d=Object.getOwnPropertyDescriptor(table,name);assertEq(typeof d.value,'number');assertEq(d.writable||d.configurable,false);assertEq(d.enumerable,true)}
});
check('canonical-symbol-binding-uses-original-description-names',()=>{
  assertEq(realm.internalBinding('symbols'),symbols);assertEq(Object.keys(symbols).length,27);
  const context=api.inspectContext().perIsolateSymbols;
  for(const name of Object.keys(symbols)){const d=Object.getOwnPropertyDescriptor(symbols,name);assertEq(typeof d.value,'symbol');assertEq(d.value.description,name);assertEq(d.writable&&d.enumerable&&d.configurable,true)}
  assertEq(symbols.async_id_symbol,context.async_id_symbol);assertEq(symbols.handle_onclose,context.handle_onclose_symbol);assertEq('handle_onclose_symbol' in symbols,false);
});
const internalHooks=realm.require('internal/async_hooks');
check('whole-original-internal-module-registers-trampoline-when-hooks-are-enabled',()=>{
  assertEq(realm.require('internal/async_hooks'),internalHooks);assertEq(typeof internalHooks.nativeHooks.init,'function');assertEq(api.inspectAsync().trampolineRegistered,false);assertEq(api.inspectAsync().hooksRegistered,false);internalHooks.enableHooks();gc('shrinking');assertEq(api.inspectAsync().trampolineRegistered,true);internalHooks.disableHooks();assertEq(api.inspectAsync().trampolineRegistered,false);
});
// Shared assertions are appended by the driver, not imported by guest modules.
// @shared-controls
check('cross-realm-bindings-share-state-and-symbol-identities',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),b=other.internalBinding('async_wrap'),s=other.internalBinding('symbols');
  assertEq(b===binding,false);assertEq(b.async_hook_fields,binding.async_hook_fields);assertEq(b.async_id_fields,binding.async_id_fields);assertEq(b.execution_async_resources,binding.execution_async_resources);assertEq(s.async_id_symbol,symbols.async_id_symbol);
  b.pushAsyncContext(93,12);assertEq(internalHooks.executionAsyncId(),93);assertEq(binding.popAsyncContext(93),false);
});
check('native-stack-uses-protected-backing-after-public-property-replacement',()=>{
  binding.clearAsyncIdStack();const original=binding.async_ids_stack;binding.async_ids_stack=new Float64Array(2);
  try{binding.pushAsyncContext(11,4);assertEq(binding.popAsyncContext(11),false);assertEq(binding.async_ids_stack.length,2)}finally{binding.async_ids_stack=original}
});
const queue=realm.internalBinding('task_queue');queue.setPromiseRejectCallback(()=>{});
check('assigned-promise-callback-reset-skips-obsolete-pop',()=>{
  binding.clearAsyncIdStack();let reject,calls=0;const p=new Promise((resolve,r)=>reject=r);p[symbols.async_id_symbol]=61;p[symbols.trigger_async_id_symbol]=41;
  queue.setPromiseRejectCallback(()=>{calls++;binding.clearAsyncIdStack()});reject({});p.catch(()=>{});queue.runMicrotasks();assertEq(calls,2);assertEq(internalHooks.executionAsyncId(),0);queue.setPromiseRejectCallback(()=>{});
});
check('unsupported-promise-hooks-and-destroy-observers-remain-errors',()=>{
  assertEq(thrown(()=>binding.setPromiseHooks(()=>{})).message.includes('promise lifecycle hooks are not implemented'),true);assertEq(binding.getPromiseHooks().every(v=>v===undefined),true);
  const f=binding.async_hook_fields,c=binding.constants;assertEq(binding.queueDestroyAsyncId(9),undefined);
  f[c.kDestroy]=1;try{assertEq(thrown(()=>binding.queueDestroyAsyncId(9)).message.includes('destroy-event delivery is not implemented'),true)}finally{f[c.kDestroy]=0}
  assertEq(thrown(()=>binding.registerDestroyHook({},8,{})).message.includes('GC destroy observers are not implemented'),true);
});
check('actual-hook-and-trampoline-owners-survive-moving-gc',()=>{
  binding.setupHooks(internalHooks.nativeHooks);internalHooks.enableHooks();gc('shrinking');assertEq(api.inspectAsync().hooksRegistered,true);assertEq(api.inspectAsync().trampolineRegistered,true);
  binding.setCallbackTrampoline(false);assertEq(api.inspectAsync().trampolineRegistered,false);binding.setCallbackTrampoline(()=>{});gc('shrinking');assertEq(api.inspectAsync().trampolineRegistered,true);internalHooks.disableHooks();
});
check('whole-bootstrap-preserves-next-real-backend-failure',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),b=other.internalBinding('async_wrap');
  const error=thrown(()=>api.runNodeBootstrap(target));assertEq(error.code,'ERR_KANDELO_NOT_IMPLEMENTED');assertEq(error.message.includes("binding 'types'"),true);bootstrapFailure={code:error.code,message:error.message,compiledBuiltinIds:api.inspectRealm(target).compiledBuiltinIds};
  assertEq(thrown(()=>b.pushAsyncContext(3,2)).message.includes('Previous Node realm initialization failed'),true);
});
binding.clearAsyncIdStack();queue.runMicrotasks();
print(JSON.stringify({kind:'native-async-wrap-controls',cases:observations.length,failures,observations,bootstrapFailure,constants:binding.constants,providers:binding.Providers,
  limits:['Partial native async state and original internal module; not successful Node startup','Promise lifecycle hooks, GC destroy delivery, continuation frames and common callback scopes remain incomplete']}));
if(failures)quit(1);
