'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),types=realm.internalBinding('types');
const external=api.newExternal(),readExternal=value=>api.readExternal(value),DOMExceptionForTest=api.getContextExports().DOMException;
const detach=value=>detachArrayBuffer(value),collect=()=>gc('shrinking');
const module=parseModule('export const value=7');moduleLink(module);moduleEvaluate(module);drainJobQueue();const namespace=api.moduleNamespace(module);
const observations=[];let failures=0,bootstrapFailure;
function thrown(fn){try{fn()}catch(e){return e}throw new Error('expected failure')}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(e){failures++;observations.push({name,status:'fail',error:{name:e.name,message:e.message,stack:e.stack}})}}
// @shared-types-controls
check('native-binding-and-functions-remain-cached-through-moving-gc',()=>{
  const fn=types.isMap;gc('shrinking');assertEq(realm.internalBinding('types'),types);assertEq(types.isMap,fn);assertEq(fn(new Map()),true);
});
check('separate-realms-own-distinct-native-predicate-functions',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),b=other.internalBinding('types');
  assertEq(b===types,false);assertEq(b.isMap===types.isMap,false);b.isMap=()=>false;assertEq(types.isMap(new Map()),true);
});
check('engine-wrappers-preserve-foreign-native-types-without-scripted-proxy-traps',()=>{
  const target=newGlobal({newCompartment:true});const values=target.eval("[new Map(),new Number(2),async function(){},function*(){},new Error(),new ArrayBuffer(1),new Proxy(new Map(),{get(){throw new Error('FOREIGN_TRAP')}})]");
  for(const [i,expected] of [[0,['isMap']],[1,['isNumberObject','isBoxedPrimitive']],[2,['isAsyncFunction']],[3,['isGeneratorFunction']],[4,['isNativeError']],[5,['isArrayBuffer','isAnyArrayBuffer']],[6,['isProxy']]])record('foreign-'+i,values[i],expected);
  const other=target.eval('value=>value');assertEq(types.isExternal(other(external)),true);assertEq(readExternal(other(external)),42);
});
check('complete-original-types-module-uses-real-binding-and-intrinsic-view-getters',()=>{
  const original=realm.require('internal/util/types');assertEq(original,realm.require('internal/util/types'));
  for(const name of predicates)assertEq(original[name],types[name]);
  const constructors=[Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Float16Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array];
  for(const C of constructors){const value=new C(2);assertEq(original['is'+C.name](value),true);assertEq(original.isTypedArray(value),true);assertEq(original.isArrayBufferView(value),true);assertEq(original.isDataView(value),false)}
  const view=new DataView(new ArrayBuffer(2));assertEq(original.isDataView(view),true);assertEq(original.isTypedArray(view),false);
  let reads=0;const spoof={get [Symbol.toStringTag](){reads++;throw new Error('SPOOFED_VIEW_TAG')}};assertEq(original.isTypedArray(spoof),false);assertEq(original.isDataView(spoof),false);assertEq(original.isUint8Array(spoof),false);assertEq(reads,0);
});
check('opaque-pointer-readback-rejects-ordinary-and-scripted-proxy-values',()=>{
  let traps=0;for(const value of [{},Object.create(null),new Proxy(external,{get(){traps++;throw new Error('EXTERNAL_PROXY_TRAP')}})])assertEq(thrown(()=>readExternal(value)).message.includes('actual native External'),true);
  assertEq(traps,0);assertEq(readExternal(external),42);
});
check('real-module-namespace-classification-survives-moving-gc',()=>{
  gc('shrinking');assertEq(types.isModuleNamespaceObject(namespace),true);assertEq(types.isProxy(namespace),false);assertEq(namespace.value,7);
});
check('native-predicate-inspection-ignores-poisoned-public-constructor-properties',()=>{
  const value=new Map();Object.defineProperties(value,{constructor:{get(){throw new Error('CONSTRUCTOR_GETTER')}},[Symbol.toStringTag]:{get(){throw new Error('TAG_GETTER')}}});Object.setPrototypeOf(value,null);record('poisoned-real-map',value,['isMap']);
});
check('whole-original-bootstrap-passes-types-and-invalidates-failed-realm-functions',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),b=other.internalBinding('types'),predicate=b.isMap;
  const error=thrown(()=>api.runNodeBootstrap(target));assertEq(error.name,'TypeError');assertEq(error.code,undefined);assertEq(error.message.includes("process.versions is undefined"),true);
  bootstrapFailure={name:error.name,code:error.code,message:error.message,compiledBuiltinIds:api.inspectRealm(target).compiledBuiltinIds};
  assertEq(thrown(()=>predicate(new Map())).message.includes('Previous Node realm initialization failed'),true);assertEq(thrown(()=>predicate()).message.includes('Previous Node realm initialization failed'),true);assertEq(types.isMap(new Map()),true);
});
print(JSON.stringify({kind:'native-types-controls',cases:observations.length,failures,observations,classificationMatrix,bootstrapFailure,limits:['Actual engine native predicates and complete original internal/util/types execution, not successful Node startup','Opaque borrowed pointer carrier is not a resource handle or Node-API implementation','Security-denied wrappers, OOM and complete teardown remain unvalidated']}));if(failures)quit(1);
