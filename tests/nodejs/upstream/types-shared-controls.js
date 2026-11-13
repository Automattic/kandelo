// The harness supplies actual native predicates, module namespace, opaque
// pointer value, native readback, detachment and GC operations.
const predicates=Object.keys(types),classificationMatrix=[];
function record(name,value,expected){const actual=predicates.filter(key=>types[key](value));assertEq(actual.join(','),expected.join(','));classificationMatrix.push({name,matches:actual})}
check('all-native-method-attributes-and-call-signatures',()=>{
  assertEq(predicates.length,26);
  for(const name of predicates){const fn=types[name],d=Object.getOwnPropertyDescriptor(types,name);assertEq(fn.name,'');assertEq(fn.length,0);assertEq(d.enumerable&&d.writable&&d.configurable,true);assertEq(fn(),false);assertEq(fn.call({}),false);assertEq(fn(undefined,{}),false)}
});
check('primitive-and-ordinary-values-have-no-native-object-tags',()=>{
  for(const [name,value] of [['undefined',undefined],['null',null],['false',false],['zero',0],['nan',NaN],['string','s'],['symbol',Symbol()],['bigint',1n],['object',{}],['null-prototype',Object.create(null)],['array',[]],['function',function(){}],['class',class {}],['typed-array',new Uint8Array(2)],['data-view',new DataView(new ArrayBuffer(2))],['string-iterator','x'[Symbol.iterator]()],['array-iterator',[][Symbol.iterator]()]])record(name,value,[]);
});
check('boxed-primitives-use-real-internal-slots',()=>{
  for(const [name,value,expected] of [['number-object',new Number(2),'isNumberObject'],['boolean-object',new Boolean(false),'isBooleanObject'],['string-object',new String('s'),'isStringObject'],['bigint-object',Object(1n),'isBigIntObject'],['symbol-object',Object(Symbol()),'isSymbolObject']])record(name,value,[expected,'isBoxedPrimitive']);
});
check('real-collections-iterators-and-buffers-are-distinguished',()=>{
  for(const [name,value,expected] of [['map',new Map(),'isMap'],['set',new Set(),'isSet'],['weak-map',new WeakMap(),'isWeakMap'],['weak-set',new WeakSet(),'isWeakSet'],['map-iterator',new Map().entries(),'isMapIterator'],['set-iterator',new Set().values(),'isSetIterator'],['date',new Date(),'isDate'],['regexp',/x/,'isRegExp'],['promise',Promise.resolve(1),'isPromise']])record(name,value,[expected]);
  record('array-buffer',new ArrayBuffer(8),['isArrayBuffer','isAnyArrayBuffer']);record('shared-array-buffer',new SharedArrayBuffer(8),['isSharedArrayBuffer','isAnyArrayBuffer']);
});
check('native-error-tags-ignore-javascript-inheritance',()=>{
  for(const [name,value] of [['error',new Error()],['type-error',new TypeError()],['aggregate-error',new AggregateError([])],['error-subclass',new(class extends Error{})()]])record(name,value,['isNativeError']);
  record('domexception',new DOMExceptionForTest('x','AbortError'),['isNativeError']);record('fake-error-prototype',Object.create(Error.prototype),[]);
});
check('function-and-generator-flags-match-original-node',()=>{
  const asyncFn=async function(){},generator=function*(){},asyncGenerator=async function*(){};
  record('async-function',asyncFn,['isAsyncFunction']);record('generator-function',generator,['isGeneratorFunction']);record('async-generator-function',asyncGenerator,['isAsyncFunction','isGeneratorFunction']);
  record('generator-object',generator(),['isGeneratorObject']);record('async-generator-object',asyncGenerator(),['isGeneratorObject']);
  record('bound-async-function',asyncFn.bind(null),[]);record('bound-generator-function',generator.bind(null),[]);record('generator-prototype',generator.prototype,[]);
});
check('mapped-and-unmapped-arguments-use-engine-tags',()=>{
  record('mapped-arguments',Function('return arguments')(1),['isArgumentsObject']);record('unmapped-arguments',(function(){'use strict';return arguments})(1),['isArgumentsObject']);
});
check('builtin-prototypes-retain-their-actual-native-types',()=>{
  for(const [name,value] of [['date-prototype',Date.prototype],['regexp-prototype',RegExp.prototype],['map-prototype',Map.prototype],['set-prototype',Set.prototype],['weak-map-prototype',WeakMap.prototype],['weak-set-prototype',WeakSet.prototype],['symbol-prototype',Symbol.prototype],['bigint-prototype',BigInt.prototype],['error-prototype',Error.prototype],['async-function-prototype',Object.getPrototypeOf(async function(){})],['generator-function-prototype',Object.getPrototypeOf(function*(){})]])record(name,value,[]);
  record('number-prototype',Number.prototype,['isNumberObject','isBoxedPrimitive']);record('boolean-prototype',Boolean.prototype,['isBooleanObject','isBoxedPrimitive']);record('string-prototype',String.prototype,['isStringObject','isBoxedPrimitive']);
});
check('scripted-and-revoked-proxies-do-not-unwrap-or-run-traps',()=>{
  let traps=0;const handler=new Proxy({}, {get(){traps++;throw new Error('USER_PROXY_TRAP')}});
  for(const value of [new Map(),new Number(2),Promise.resolve(2),async function(){},function*(){},new ArrayBuffer(1),external])record('proxy-'+classificationMatrix.length,new Proxy(value,handler),['isProxy']);
  const revoked=Proxy.revocable(new Set(),handler);revoked.revoke();record('revoked-proxy',revoked.proxy,['isProxy']);assertEq(traps,0);
});
check('spoofed-tags-and-prototypes-do-not-invoke-user-code',()=>{
  let reads=0;for(const tag of ['Date','Map','Set','Promise','Number','Generator','Module','External']){const value={get [Symbol.toStringTag](){reads++;throw new Error('TAG_GETTER')}};record('spoofed-'+tag,value,[])}
  record('inherited-map',Object.create(Map.prototype),[]);record('inherited-date',Object.create(Date.prototype),[]);assertEq(reads,0);
});
check('detached-buffer-and-modified-prototypes-preserve-native-identity',()=>{
  const buffer=new ArrayBuffer(8);detach(buffer);record('detached-array-buffer',buffer,['isArrayBuffer','isAnyArrayBuffer']);
  const value=new Map();Object.setPrototypeOf(value,null);record('prototype-cleared-map',value,['isMap']);
});
check('module-namespace-is-genuine-and-is-not-a-scripted-proxy',()=>{assertEq(namespace.value,7);record('module-namespace',namespace,['isModuleNamespaceObject']);record('module-namespace-proxy',new Proxy(namespace,{}),['isProxy'])});
check('opaque-external-retains-real-native-pointer-through-gc',()=>{
  record('native-external',external,['isExternal']);assertEq(Object.getPrototypeOf(external),null);assertEq(Object.isExtensible(external),false);assertEq(readExternal(external),42);assertEq(Reflect.set(external,'fakePointer',99),false);collect();assertEq(readExternal(external),42);assertEq(types.isExternal(Object.assign({},external)),false);
});
