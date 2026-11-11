'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('options');
const observations=[];let failures=0,bootstrapFailure;
function thrown(fn){try{fn()}catch(e){return e}throw new Error('expected failure')}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(e){failures++;observations.push({name,status:'fail',error:{name:e.name,message:e.message,stack:e.stack}})}}
const collect=()=>gc('shrinking');
// @shared-options-controls
check('all-six-guarded-methods-reject-before-genuine-bootstrap-completion',()=>{
  for(const name of ['getCLIOptionsValues','getCLIOptionsInfo','getOptionsAsFlags','getEmbedderOptions','getEnvOptionsInputType','getNamespaceOptionsInputType']){const error=thrown(()=>binding[name]());assertEq(error.code,'ERR_OPTIONS_BEFORE_BOOTSTRAPPING');assertEq(error.message,'Should not query options before bootstrapping is done');assertEq(error instanceof Error,true)}
  assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar('--still-active')),JSON.stringify(['--still-active']));assertEq(api.inspectOptions().serialized,false);assertEq(api.inspectOptions().configured,false);
});
check('complete-original-internal-options-body-executes-and-retains-its-lazy-guards',()=>{
  const original=realm.require('internal/options');assertEq(original,realm.require('internal/options'));assertEq(original.parseNodeOptionsEnvVar,binding.parseNodeOptionsEnvVar);
  assertEq(thrown(()=>original.getOptionValue('--warnings')).code,'ERR_OPTIONS_BEFORE_BOOTSTRAPPING');original.refreshOptions();assertEq(thrown(()=>original.getEmbedderOptions()).code,'ERR_OPTIONS_BEFORE_BOOTSTRAPPING');
});
check('cached-native-binding-functions-and-owner-survive-moving-gc',()=>{
  const method=binding.parseNodeOptionsEnvVar;collect();assertEq(realm.internalBinding('options'),binding);assertEq(binding.parseNodeOptionsEnvVar,method);assertEq(JSON.stringify(method('--live')),JSON.stringify(['--live']));
});
check('foreign-realms-own-distinct-binding-functions',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),b=other.internalBinding('options');
  assertEq(b===binding,false);assertEq(b.parseNodeOptionsEnvVar===binding.parseNodeOptionsEnvVar,false);assertEq(JSON.stringify(b.parseNodeOptionsEnvVar('--other')),JSON.stringify(['--other']));
});
check('original-method-registration-uses-set-before-naming-with-actual-setter-gc',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target);
  target.collect=collect;
  target.eval("Object.defineProperty(Object.prototype,'getCLIOptionsValues',{set(value){globalThis.captured=value;collect()},configurable:true})");
  const b=other.internalBinding('options');assertEq(Object.hasOwn(b,'getCLIOptionsValues'),false);assertEq(target.captured.name,'getCLIOptionsValues');assertEq(target.captured.length,0);
  assertEq(thrown(()=>target.captured()).code,'ERR_OPTIONS_BEFORE_BOOTSTRAPPING');
});
check('whole-original-bootstrap-passes-options-and-preserves-next-failure',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),b=other.internalBinding('options');
  const error=thrown(()=>api.runNodeBootstrap(target));assertEq(error.name,'Error');assertEq(error.code,'ERR_KANDELO_NOT_IMPLEMENTED');assertEq(error.message,"Native Node binding 'async_context_frame' is not implemented");bootstrapFailure={name:error.name,code:error.code,message:error.message,compiledBuiltinIds:api.inspectRealm(target).compiledBuiltinIds};
  assertEq(thrown(()=>b.parseNodeOptionsEnvVar('--not-reusable')).message.includes('Previous Node realm initialization failed'),true);
});
check('actual-cpp-profile-parser-applies-env-before-cli-without-marking-bootstrap-complete',()=>{
  api.configureOptions(['node','--no-warnings','--pending_deprecation'],'--no-pending-deprecation');
  const state=api.inspectOptions();assertEq(state.configured,true);assertEq(state.serialized,false);assertEq(state.failed,false);assertEq(state.nodeInvocation,false);assertEq(state.warnings,false);assertEq(state.pendingDeprecation,true);
  assertEq(thrown(()=>binding.getCLIOptionsValues()).code,'ERR_OPTIONS_BEFORE_BOOTSTRAPPING');assertEq(api.inspectOptions().serialized,false);
});
check('native-profile-is-once-only-and-cannot-replace-the-live-owner',()=>{
  assertEq(thrown(()=>api.configureOptions(['node'])).message.includes('already been configured'),true);assertEq(api.inspectOptions().failed,false);assertEq(api.inspectOptions().warnings,false);
  assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar('--live')),JSON.stringify(['--live']));
});
print(JSON.stringify({kind:'native-options-controls',cases:observations.length,failures,observations,bootstrapFailure,limits:['Original native options translation unit and original internal/options, not successful Node startup','Guarded queries remain unavailable until complete genuine bootstrap','Full CLI/env/config/engine option adoption and post-bootstrap metadata remain unfinished']}));if(failures)quit(1);
