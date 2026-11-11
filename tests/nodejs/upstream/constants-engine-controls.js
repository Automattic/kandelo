'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const constants=realm.internalBinding('constants');
const observations=[];let failures=0,bootstrapFailure;
function thrown(fn){try{fn()}catch(e){return e}throw new Error('expected failure')}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(e){failures++;observations.push({name,status:'fail',error:{name:e.name,message:e.message,stack:e.stack}})}}
// @shared-constants-controls
check('real-binding-is-cached-in-its-own-realm',()=>{assertEq(realm.internalBinding('constants'),constants);gc('shrinking');assertEq(realm.internalBinding('constants').os.signals,constants.os.signals)});
check('separate-realms-own-distinct-native-constant-tables',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),c=other.internalBinding('constants');
  assertEq(c===constants,false);assertEq(c.os===constants.os,false);assertEq(c.os.signals.SIGINT,constants.os.signals.SIGINT);c.fs={child:true};assertEq(typeof constants.fs.O_RDONLY,'number');
});
check('native-population-ignores-poisoned-object-prototype-properties',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target);
  target.eval("Object.defineProperty(Object.prototype,'os',{set(){throw new Error('PROTOTYPE_SETTER_USED')},configurable:true})");
  const c=other.internalBinding('constants');assertEq(Object.getPrototypeOf(c),null);assertEq(typeof c.os.signals.SIGINT,'number');
});
check('whole-original-bootstrap-passes-constants-and-preserves-next-failure',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);api.initializeRealm(target);const error=thrown(()=>api.runNodeBootstrap(target));
  assertEq(error.name,'Error');assertEq(error.code,'ERR_KANDELO_NOT_IMPLEMENTED');assertEq(error.message,"Native Node binding 'icu' is not implemented");bootstrapFailure={name:error.name,code:error.code,message:error.message,compiledBuiltinIds:api.inspectRealm(target).compiledBuiltinIds};
});
function snapshot(object){return Object.fromEntries(Object.entries(object).map(([name,value])=>[name,value&&typeof value==='object'?snapshot(value):typeof value==='number'&&!Number.isFinite(value)?{nonfinite:String(value)}:value]))}
print(JSON.stringify({kind:'native-constants-controls',cases:observations.length,failures,observations,bootstrapFailure,constants:snapshot(constants),limits:['Native constant metadata, not implementation of the corresponding filesystem/network/crypto/compression operations','Complete original Node startup and full backend graph remain incomplete']}));if(failures)quit(1);
