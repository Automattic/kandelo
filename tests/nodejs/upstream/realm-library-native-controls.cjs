'use strict';
// Pinned native reference only; this does not provide any guest backend.
const assert=require('node:assert/strict');
const {internalBinding}=require('internal/test/binding');
const helpers=require('internal/modules/helpers');
const assertionModule=helpers.loadBuiltinModule('internal/assert');
const BuiltinModule=assertionModule.constructor;
const observations=[];let failures=0;
function check(name,callback){try{callback();observations.push({name,status:'pass'})}
  catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message}})}}
check('original-realm-source-remains-private-in-native-loader-policy',()=>{
  assert.equal(BuiltinModule.map.has('internal/bootstrap/realm'),true);
  assert.equal(BuiltinModule.canBeRequiredByUsers('internal/bootstrap/realm'),false);
  assert.equal(helpers.loadBuiltinModule('internal/bootstrap/realm'),undefined);
});
check('native-builtin-ids-are-fresh-and-binding-is-frozen',()=>{
  const binding=internalBinding('builtins'),first=binding.builtinIds,second=binding.builtinIds;
  assert.equal(Object.isFrozen(binding),true);assert.notEqual(first,second);assert.equal(new Set(first).size,first.length);
  assert.equal(first.includes('internal/bootstrap/realm'),true);assert.equal(first.includes('internal/errors'),true);
  first[0]='changed';assert.equal(second.includes('changed'),false);
});
check('complete-original-assert-module-is-cached',()=>{
  const fn=assertionModule.compileForInternalLoader();assert.equal(typeof fn,'function');assert.equal(fn(true),undefined);
  assert.equal(fn,require('internal/assert'));assert.equal(typeof fn.fail,'function');
  assert.equal(BuiltinModule.map.get('internal/assert').exports,fn);assert.equal(BuiltinModule.map.get('internal/assert').loaded,true);
});
check('original-policy-rejects-public-exposure-of-the-realm-loader',()=>{
  assert.throws(()=>BuiltinModule.allowRequireByUsers('internal/bootstrap/realm'),error=>error.message.includes('Should not allow'));
});
check('native-process-pid-is-readonly-and-metadata-is-real',()=>{
  assert.equal(Number.isInteger(process.pid)&&process.pid>0,true);assert.equal(Number.isInteger(process.ppid)&&process.ppid>=0,true);
  assert.equal(Object.getOwnPropertyDescriptor(process,'pid').writable,false);
  assert.equal(typeof process.platform,'string');assert.equal(typeof process.arch,'string');
});
check('native-internal-binding-cache-preserves-identity',()=>{
  assert.equal(internalBinding('module_wrap'),internalBinding('module_wrap'));
  assert.equal(internalBinding('errors'),internalBinding('errors'));assert.equal(internalBinding('util'),internalBinding('util'));
});
check('original-policy-keeps-realm-private-and-builds-native-facades',()=>{
  BuiltinModule.exposeInternals();assert.equal(BuiltinModule.canBeRequiredByUsers('internal/bootstrap/realm'),false);
  const builtin=BuiltinModule.map.get('internal/assert'),exports=builtin.compileForPublicLoader(),module=builtin.getESMFacade();
  assert.equal(module,builtin.getESMFacade());assert.equal(module.getNamespace().default,exports);assert.equal(module.getStatus(),4);
});
check('original-error-preparation-is-installed',()=>{
  const errors=require('internal/errors');assert.equal(Error.prepareStackTrace,errors.ErrorPrepareStackTrace);
  assert.equal(new Error('native realm error').stack.startsWith('Error: native realm error\n    at '),true);
});
check('original-private-arrow-symbol-is-hidden-and-own-only',()=>{
  const errors=require('internal/errors'),error=new Error('arrow'),symbol=internalBinding('util').privateSymbols.arrow_message_private_symbol;
  errors.setArrowMessage(error,'source arrow');assert.equal(error[symbol],'source arrow');assert.equal(Reflect.ownKeys(error).includes(symbol),false);assert.equal(Object.create(error)[symbol],undefined);
});
check('unlinked-native-module-has-original-error-code',()=>{
  assert.throws(()=>process._linkedBinding('_kandelo_no_such_linked_binding'),{code:'ERR_INVALID_MODULE'});
});
check('native-source-loader-map-and-cache-reflect-real-state',()=>{
  assert.equal(BuiltinModule.map.size,internalBinding('builtins').builtinIds.length);
  const entry=BuiltinModule.map.get('internal/errors');assert.equal(entry.loaded,true);assert.equal(entry.loading,false);assert.equal(entry.exports,require('internal/errors'));
});
check('native-node-error-constructor-reference',()=>{
  const {codes:{ERR_INTERNAL_ASSERTION}}=require('internal/errors');const error=new ERR_INTERNAL_ASSERTION('native reference');
  assert.equal(error.code,'ERR_INTERNAL_ASSERTION');assert.equal(error.message.includes('native reference'),true);
});
console.log(JSON.stringify({kind:'native-realm-library-reference-only',version:process.version,platform:process.platform,arch:process.arch,v8:process.versions.v8,
  execArgv:process.execArgv,builtinCount:internalBinding('builtins').builtinIds.length,cases:observations.length,failures,observations,
  limits:['Native runtime already bootstrapped; not a guest startup reference','Different target capability/source availability may change builtin ids','Bounded reference only; no full native lifecycle/security/OOM differential']}));
if(failures)process.exitCode=1;
