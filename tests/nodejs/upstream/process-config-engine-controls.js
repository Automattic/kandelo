'use strict';
// Owning native state controls. A captured missing backend is not startup proof.
const api=__kandeloUpstreamTest;
api.initializeContext();const realm=api.initializeRealm();
const observations=[];let failures=0,failed;
const config=realm.internalBinding('config'),util=realm.internalBinding('util');
const exitKey=util.privateSymbols.exit_info_private_symbol;
function context(){const global=newGlobal({newCompartment:true});api.initializeContext(global);return {global,realm:api.initializeRealm(global)}}
function thrown(callback){try{callback()}catch(error){return error}throw new Error('expected failure')}
function check(name,callback){try{callback();observations.push({name,status:'pass'})}catch(error){let stack;try{stack=error.stack}catch{}failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,code:error.code,stack}})}}
check('config-identity-and-readonly-real-build-fields',()=>{
  assertEq(realm.internalBinding('config'),config);
  for(const [name,value] of Object.entries({bits:32,isDebugBuild:false,hasOpenSSL:true,openSSLIsBoringSSL:false,hasIntl:typeof Intl==='object',hasInspector:false,noBrowserGlobals:false})){
    assertEq(config[name],value);const descriptor=Object.getOwnPropertyDescriptor(config,name);
    assertEq(descriptor.writable,false);assertEq(descriptor.enumerable,true);
  }
});
check('config-does-not-copy-unimplemented-native-feature-metadata',()=>{
  for(const name of ['hasNodeOptions','hasTracing','hasSmallICU'])assertEq(name in config,false);
  assertEq(thrown(()=>config.fipsMode).code,'ERR_KANDELO_NOT_IMPLEMENTED');
  assertEq(thrown(()=>realm.internalBinding('builtins').config).code,'ERR_KANDELO_NOT_IMPLEMENTED');
});
check('default-locale-comes-from-the-native-engine',()=>{
  const locale=config.getDefaultLocale();assertEq(typeof locale,'string');assertEq(locale.length>0,true);
  assertEq(typeof new Intl.Locale(locale).baseName,'string');
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Intl');
  Object.defineProperty(globalThis,'Intl',{get(){throw new Error('public Intl read')},configurable:true});
  try{assertEq(config.getDefaultLocale(),locale)}finally{Object.defineProperty(globalThis,'Intl',descriptor)}
});
check('actual-process-has-a-distinct-mutable-native-class-prototype',()=>{
  const prototype=Object.getPrototypeOf(realm.process),C=realm.process.constructor;
  assertEq(prototype===Object.prototype,false);assertEq(Object.getPrototypeOf(prototype),Object.prototype);
  assertEq(C.name,'process');assertEq(C.length,0);assertEq(C.prototype,prototype);
  const descriptor=Object.getOwnPropertyDescriptor(C,'prototype');
  assertEq(descriptor.writable,true);assertEq(descriptor.enumerable,false);assertEq(descriptor.configurable,false);
  const constructor=Object.getOwnPropertyDescriptor(prototype,'constructor');
  assertEq(constructor.value,C);assertEq(constructor.writable,true);assertEq(constructor.enumerable,false);assertEq(constructor.configurable,true);
});
check('native-process-constructor-creates-empty-instances-and-honors-new-target',()=>{
  const C=realm.process.constructor,instance=new C();assertEq(Object.getPrototypeOf(instance),C.prototype);
  assertEq(Reflect.ownKeys(instance).length,0);assertEq(C()===globalThis,true);assertEq(C.call(null)===globalThis,true);const receiver={};assertEq(C.call(receiver),receiver);assertEq(C.call(7).valueOf(),7);
  class Child extends C{}const child=new Child();assertEq(Object.getPrototypeOf(child),Child.prototype);
  assertEq(Reflect.ownKeys(child).length,0);assertEq('pid' in child,false);
  function Target(){}const custom=Reflect.construct(C,[],Target);assertEq(Object.getPrototypeOf(custom),Target.prototype);
});
check('changing-process-ancestry-does-not-mutate-object-prototype',()=>{
  const target=context(),prototype=Object.getPrototypeOf(target.realm.process),parent=target.global.Object.prototype;
  const eventPrototype={eventMethod(){return this}};Object.setPrototypeOf(prototype,eventPrototype);
  assertEq(target.realm.process.eventMethod(),target.realm.process);
  assertEq(Object.getPrototypeOf(parent),null);assertEq('eventMethod' in parent,false);
});
check('exit-info-is-a-real-hidden-live-int32-array',()=>{
  const fields=realm.process[exitKey];assertEq(fields instanceof Int32Array,true);assertEq(fields.length,3);
  assertEq(fields.join(','),'0,0,0');assertEq(util.constants.kExiting,0);assertEq(util.constants.kExitCode,1);assertEq(util.constants.kHasExitCode,2);
  assertEq(Reflect.ownKeys(realm.process).includes(exitKey),false);assertEq(Object.create(realm.process)[exitKey],undefined);
});
check('one-runtime-shares-exit-state-across-distinct-realm-processes',()=>{
  const target=context(),fields=realm.process[exitKey],other=target.realm.process[exitKey];assertEq(other,fields);
  try{fields[util.constants.kExiting]=1;other[util.constants.kExitCode]=-17;fields[util.constants.kHasExitCode]=1;gc();
    assertEq(other.join(','),'1,-17,1');assertEq(realm.process[exitKey][1],-17);
  }finally{fields.fill(0)}
});
check('config-and-process-prototypes-remain-per-realm',()=>{
  const target=context(),other=target.realm;
  assertEq(other.process===realm.process,false);assertEq(other.internalBinding('config')===config,false);
  assertEq(Object.getPrototypeOf(other.process)===Object.getPrototypeOf(realm.process),false);
  assertEq(Object.getPrototypeOf(Object.getPrototypeOf(other.process)),target.global.Object.prototype);
  gc();assertEq(other.internalBinding('config').bits,32);assertEq(other.process[exitKey],realm.process[exitKey]);
});
check('native-node-stage-requires-existing-context-and-realm-ownership',()=>{
  const target=newGlobal({newCompartment:true});assertEq(thrown(()=>api.runNodeBootstrap(target)).message.includes('context has not been initialized'),true);
  api.initializeContext(target);assertEq(thrown(()=>api.runNodeBootstrap(target)).message.includes('realm has not been initialized'),true);
  api.initializeRealm(target);assertEq(api.inspectRealm(target).nodeBootstrapPhase,0);
});
check('native-node-stage-uses-protected-state-and-preserves-actual-missing-backend',()=>{
  failed=context();failed.builtins=failed.realm.internalBinding('builtins');const exports=api.getContextExports(failed.global),descriptor=Object.getOwnPropertyDescriptor(exports,'primordials');let reads=0;
  Object.defineProperty(exports,'primordials',{get(){reads++;throw new Error('diagnostic container used')},configurable:true});
  let error;try{error=thrown(()=>api.runNodeBootstrap(failed.global))}finally{Object.defineProperty(exports,'primordials',descriptor)}
  assertEq(reads,0);assertEq(error.name,'Error');assertEq(error.code,'ERR_KANDELO_NOT_IMPLEMENTED');assertEq(error.message,"Native Node binding 'trace_events' is not implemented");
  assertEq(error.stack.includes('node:internal/trace_events:'),true);
  failed.error=error;
});
check('failed-node-body-is-terminal-and-diagnostics-do-not-expose-partial-loaders',()=>{
  const snapshot=api.inspectRealm(failed.global);assertEq(snapshot.phase,3);assertEq(snapshot.nodeBootstrapPhase,3);
  assertEq(snapshot.compiledBuiltinIds.includes('internal/bootstrap/node'),true);assertEq(snapshot.compiledBuiltinIds.includes('internal/timers'),true);
  assertEq('process' in snapshot,false);assertEq('require' in snapshot,false);
  assertEq(thrown(()=>api.runNodeBootstrap(failed.global)).message.includes('Previous Node bootstrap failed'),true);
  assertEq(failed.realm.internalBinding('builtins'),failed.builtins);
  assertEq(thrown(()=>failed.builtins.compileFunction('internal/assert')).message.includes('initialization failed'),true);
  assertEq(thrown(()=>api.getRealm(failed.global)).message.includes('initialization failed'),true);
});
check('failed-principal-body-does-not-retire-another-realms-library-owner',()=>{
  gc();assertEq(api.getRealm().require,realm.require);assertEq(api.inspectRealm().nodeBootstrapPhase,0);
  assertEq(realm.require('internal/assert')(true),undefined);assertEq(config.bits,32);
  assertEq(realm.process[exitKey].join(','),'0,0,0');
});
print(JSON.stringify({kind:'native-process-config-controls',plannedCases:13,cases:observations.length,notRun:13-observations.length,failures,observations,
  configSnapshot:Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(config)).filter(([,d])=>'value' in d&&typeof d.value!=='function').map(([name,d])=>[name,d.value])),
  locale:config.getDefaultLocale(),bootstrapFailure:failed&&{code:failed.error.code,message:failed.error.message,compiledBuiltinIds:api.inspectRealm(failed.global).compiledBuiltinIds},
  limits:['Native state/failed-stage controls; not successful principal bootstrap or user CJS/ESM entry','No browser proof','No exit dispatch or full process/config/util implementation','FIPS configuration remains explicit Missing','No full differential/security/OOM/lifecycle proof']}));
if(failures)quit(1);
