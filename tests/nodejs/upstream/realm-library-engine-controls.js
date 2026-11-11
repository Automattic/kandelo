'use strict';
// Execute the complete original realm.js and its builtin loader. This is not
// principal bootstrap/node, a user CJS/ESM entrypath or browser startup proof.
const api=globalThis.__kandeloUpstreamTest;
api.initializeContext();
const observations=[];let failures=0,realm;
function check(name,callback){try{callback();observations.push({name,status:'pass'})}
  catch(error){let stack;try{stack=error.stack}catch{}failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,code:error.code,stack:typeof stack==='string'?stack:undefined}})}}
function thrown(callback){try{callback()}catch(error){return error}throw new Error('expected failure')}
function fulfilled(promise){let done=false,value,error;promise.then(result=>{done=true;value=result},reason=>{done=true;error=reason});drainJobQueue();assertEq(done,true);if(error)throw error;return value}
check('complete-original-realm-script-registers-real-loaders',()=>{
  const exports=api.getContextExports(),original=exports.primordials;let reads=0;
  Object.defineProperty(exports,'primordials',{get(){reads++;throw new Error('public export container used as native owner')},configurable:true});
  try{realm=api.initializeRealm()}finally{Object.defineProperty(exports,'primordials',{value:original,writable:true,enumerable:true,configurable:true})}
  assertEq(reads,0);assertEq(realm.phase,2);assertEq(realm.loadersRegistered,true);
  assertEq(typeof realm.require,'function');assertEq(typeof realm.internalBinding,'function');
  assertEq(typeof realm.process.binding,'function');assertEq(Array.isArray(realm.process.moduleLoadList),true);
  assertEq(realm.compiledBuiltinIds.join(','),'internal/bootstrap/realm,internal/errors,internal/assert');
});
check('original-loader-self-require-and-native-retention-agree',()=>{
  const loaders=realm.require('internal/bootstrap/realm');assertEq(loaders.require,realm.require);
  assertEq(loaders.internalBinding,realm.internalBinding);assertEq(typeof loaders.BuiltinModule,'function');
  assertEq(api.getRealm().require,realm.require);assertEq(api.getRealm().process,realm.process);
});
check('native-source-registry-ids-are-complete-fresh-and-frozen-binding-owned',()=>{
  const binding=realm.internalBinding('builtins');assertEq(Object.isFrozen(binding),true);
  const first=binding.builtinIds,second=binding.builtinIds;assertEq(first===second,false);
  assertEq(first.length,443);assertEq(new Set(first).size,443);assertEq(first.includes('internal/bootstrap/realm'),true);
  assertEq(first.includes('internal/errors'),true);assertEq(first.includes('fs'),true);
  first[0]='changed by caller';assertEq(second.includes('changed by caller'),false);
});
check('native-process-reads-actual-guest-kernel-metadata',()=>{
  assertEq(realm.process.platform,'wasm-posix');assertEq(realm.process.arch,'wasm32');
  assertEq(Number.isInteger(realm.process.pid)&&realm.process.pid>0,true);
  assertEq(Number.isInteger(realm.process.ppid)&&realm.process.ppid>=0,true);
  const descriptor=Object.getOwnPropertyDescriptor(realm.process,'pid');assertEq(descriptor.writable,false);
  const prototype=Object.getPrototypeOf(realm.process);assertEq(prototype===Object.prototype,false);
  assertEq(Object.getPrototypeOf(prototype),Object.prototype);assertEq(realm.process.constructor.prototype,prototype);
});
check('original-internal-binding-cache-uses-canonical-native-owners',()=>{
  assertEq(realm.internalBinding('module_wrap'),api.getModuleWrapBinding());
  assertEq(realm.internalBinding('errors'),api.getErrorBinding());
  const util=realm.internalBinding('util');assertEq(realm.internalBinding('util'),util);
  assertEq(Object.getPrototypeOf(util.privateSymbols),Object.prototype);
  const canonical=api.inspectContext().privateSymbols;
  assertEq(Object.keys(util.privateSymbols).length,22);
  for(const name of Object.keys(canonical))assertEq(util.privateSymbols[name],canonical[name]);
});
check('upstream-module-cache-and-complete-assert-body-execute',()=>{
  const assert=realm.require('internal/assert');assertEq(typeof assert,'function');assertEq(assert(true),undefined);
  assertEq(assert,realm.require('internal/assert'));assertEq(typeof assert.fail,'function');
  const {BuiltinModule}=realm.require('internal/bootstrap/realm');
  assertEq(BuiltinModule.map.get('internal/assert').loaded,true);assertEq(BuiltinModule.map.get('internal/assert').exports,assert);
});
check('module-load-list-is-produced-by-the-original-js-loader',()=>{
  assertEq(realm.process.moduleLoadList.join(','),'Internal Binding builtins,Internal Binding module_wrap,Internal Binding errors,NativeModule internal/assert,Internal Binding util,NativeModule internal/errors');
  const descriptor=Object.getOwnPropertyDescriptor(realm.process,'moduleLoadList');
  assertEq(descriptor.writable,false);assertEq(descriptor.configurable,true);assertEq(descriptor.enumerable,true);
});
check('unknown-js-module-and-missing-native-backend-fail-honestly',()=>{
  const missing=thrown(()=>realm.require('missing-original-module'));
  assertEq(missing instanceof TypeError,true);assertEq(missing.message.includes('Missing internal module'),true);
  const native=thrown(()=>realm.internalBinding('fs'));assertEq(native.code,'ERR_KANDELO_NOT_IMPLEMENTED');
  assertEq(thrown(()=>realm.process._linkedBinding('not-linked')).code,'ERR_INVALID_MODULE');
});
check('original-exposure-policy-and-native-builtin-esm-facade-work',()=>{
  const {BuiltinModule}=realm.require('internal/bootstrap/realm');
  assertEq(BuiltinModule.canBeRequiredByUsers('internal/assert'),false);BuiltinModule.exposeInternals();
  assertEq(BuiltinModule.canBeRequiredByUsers('internal/assert'),true);
  assertEq(BuiltinModule.canBeRequiredByUsers('internal/bootstrap/realm'),false);
  const builtin=BuiltinModule.map.get('internal/assert');const exports=builtin.compileForPublicLoader();
  const module=builtin.getESMFacade();assertEq(module,builtin.getESMFacade());
  fulfilled(module.evaluate(-1,false));assertEq(module.getNamespace().default,exports);assertEq(module.getStatus(),4);
});
check('original-error-preparation-and-native-frames-are-connected',()=>{
  const errors=realm.require('internal/errors');assertEq(Error.prepareStackTrace,errors.ErrorPrepareStackTrace);
  const error=new Error('realm-backed-error');gc();
  assertEq(error.stack.startsWith('Error: realm-backed-error\n    at '),true);
});
check('original-error-module-uses-the-canonical-private-arrow-symbol',()=>{
  const errors=realm.require('internal/errors'),error=new Error('arrow');
  const symbol=realm.internalBinding('util').privateSymbols.arrow_message_private_symbol;
  assertEq(typeof errors.setArrowMessage,'function');errors.setArrowMessage(error,'real source arrow');
  assertEq(error[symbol],'real source arrow');assertEq(Reflect.ownKeys(error).includes(symbol),false);
  assertEq(Object.create(error)[symbol],undefined);
});
check('snapshot-mutation-and-repeat-initialization-cannot-replace-the-owner',()=>{
  realm.compiledBuiltinIds.length=0;realm.phase=99;const next=api.getRealm();
  assertEq(next.phase,2);assertEq(next.compiledBuiltinIds.length>=3,true);assertEq(next.require,realm.require);
  assertEq(thrown(()=>api.initializeRealm()).message.includes('already initialized'),true);
});
check('fresh-realm-requires-original-context-and-library-initialization',()=>{
  const target=newGlobal({newCompartment:true});
  assertEq(thrown(()=>api.initializeRealm(target)).message.includes('context has not been initialized'),true);
  api.initializeContext(target);assertEq(thrown(()=>api.getRealm(target)).message.includes('realm has not been initialized'),true);
});
check('original-js-exception-is-preserved-and-failure-is-terminal',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);
  const marker={identity:'original realm getter exception'};target.marker=marker;
  target.eval('Object.defineProperty(Array.prototype,"filter",{get(){throw marker},configurable:true})');
  assertEq(thrown(()=>api.initializeRealm(target)),marker);assertEq(api.inspectRealm(target).phase,3);
  assertEq('require' in api.inspectRealm(target),false);
  assertEq(thrown(()=>api.getRealm(target)).message.includes('initialization failed'),true);
  assertEq(thrown(()=>api.initializeRealm(target)).message.includes('initialization failed'),true);
});
check('reentrant-original-js-bootstrap-cannot-create-another-owner',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);
  target.reenter=()=>api.initializeRealm(target);
  target.eval('Object.defineProperty(Array.prototype,"filter",{get(){reenter()},configurable:true})');
  const error=thrown(()=>api.initializeRealm(target));assertEq(error.message.includes('Reentrant Node realm'),true);
  assertEq(api.inspectRealm(target).phase,3);assertEq(api.getRealm().require,realm.require);
});
check('other-realm-has-distinct-loaders-process-and-module-cache',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target);
  assertEq(other.require===realm.require,false);assertEq(other.process===realm.process,false);
  assertEq(Object.getPrototypeOf(Object.getPrototypeOf(other.process)),target.Object.prototype);assertEq(other.process.pid,realm.process.pid);
  assertEq(other.require('internal/assert')===realm.require('internal/assert'),false);
  assertEq(other.internalBinding('util').privateSymbols.arrow_message_private_symbol,realm.internalBinding('util').privateSymbols.arrow_message_private_symbol);
  gc();assertEq(other.require('internal/bootstrap/realm').require,other.require);
});
print(JSON.stringify({kind:'upstream-realm-library-controls',plannedCases:16,cases:observations.length,notRun:16-observations.length,failures,observations,
  processMetadata:realm&&{pid:realm.process.pid,ppid:realm.process.ppid,platform:realm.process.platform,arch:realm.process.arch},
  limits:['Complete original realm.js executes, not principal bootstrap/node or user CJS/ESM startup','No browser proof','Only eager native binding closure implemented; process/util/builtins remain partial','No complete backend catalog/native security/OOM/lifecycle differential']}));
if(failures)quit(1);
