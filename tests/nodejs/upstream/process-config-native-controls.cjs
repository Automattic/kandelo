'use strict';
const assert=require('assert/strict');
const {internalBinding}=require('internal/test/binding');
const config=internalBinding('config'),util=internalBinding('util');
const exitKey=util.privateSymbols.exit_info_private_symbol;
const observations=[];let failures=0;
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
check('native-config-binding-is-cached-with-readonly-build-fields',()=>{
  assert.equal(internalBinding('config'),config);assert.equal(config.bits,64);
  for(const name of ['isDebugBuild','hasOpenSSL','openSSLIsBoringSSL','hasInspector','noBrowserGlobals','bits']){
    const d=Object.getOwnPropertyDescriptor(config,name);assert.equal(d.writable,false);assert.equal(d.enumerable,true);
  }
});
check('native-config-default-locale-is-a-real-language-tag',()=>{
  const locale=config.getDefaultLocale();assert.equal(typeof locale,'string');assert.ok(locale.length);assert.equal(typeof new Intl.Locale(locale).baseName,'string');
});
check('native-locale-does-not-depend-on-a-public-intl-replacement',()=>{
  const locale=config.getDefaultLocale(),descriptor=Object.getOwnPropertyDescriptor(globalThis,'Intl');
  Object.defineProperty(globalThis,'Intl',{get(){throw new Error('public Intl read')},configurable:true});
  try{assert.equal(config.getDefaultLocale(),locale)}finally{Object.defineProperty(globalThis,'Intl',descriptor)}
});
check('native-process-has-distinct-mutable-class-prototype',()=>{
  const prototype=Object.getPrototypeOf(process),C=process.constructor;assert.notEqual(prototype,Object.prototype);assert.equal(C.name,'process');assert.equal(C.length,0);assert.equal(C.prototype,prototype);
  const d=Object.getOwnPropertyDescriptor(C,'prototype');assert.equal(d.writable,true);assert.equal(d.configurable,false);assert.equal(d.enumerable,false);
  const c=Object.getOwnPropertyDescriptor(prototype,'constructor');assert.equal(c.value,C);assert.equal(c.writable,true);assert.equal(c.configurable,true);assert.equal(c.enumerable,false);
});
check('native-process-constructor-creates-empty-instances',()=>{
  const C=process.constructor,p=new C();assert.equal(Object.getPrototypeOf(p),C.prototype);assert.deepEqual(Reflect.ownKeys(p),[]);assert.equal(C(),globalThis);assert.equal(C.call(null),globalThis);const receiver={};assert.equal(C.call(receiver),receiver);assert.equal(C.call(7).valueOf(),7);assert.equal('pid' in p,false);
});
check('native-process-constructor-honors-subclass-and-new-target',()=>{
  const C=process.constructor;class Child extends C{}const child=new Child();assert.equal(Object.getPrototypeOf(child),Child.prototype);assert.deepEqual(Reflect.ownKeys(child),[]);
  function Target(){}assert.equal(Object.getPrototypeOf(Reflect.construct(C,[],Target)),Target.prototype);
});
check('native-process-exit-info-has-original-private-int32-layout',()=>{
  const fields=process[exitKey];assert.ok(fields instanceof Int32Array);assert.equal(fields.length,3);
  assert.equal(util.constants.kExiting,0);assert.equal(util.constants.kExitCode,1);assert.equal(util.constants.kHasExitCode,2);
  assert.equal(Reflect.ownKeys(process).includes(exitKey),false);assert.equal(Object.create(process)[exitKey],undefined);
});
check('original-process-accessors-share-the-live-native-exit-info',()=>{
  const fields=process[exitKey],before=fields.slice(),{kExiting,kExitCode,kHasExitCode}=util.constants;
  try{fields[kExitCode]=-17;fields[kHasExitCode]=1;assert.equal(process.exitCode,-17);process.exitCode=23;assert.equal(fields[kExitCode],23);
    process._exiting=true;assert.equal(fields[kExiting],1);process.exitCode=undefined;assert.equal(fields[kHasExitCode],0);
  }finally{fields.set(before)}
});
const fields={};for(const name of Object.keys(config))if(typeof config[name]!=='function')fields[name]=config[name];
console.log(JSON.stringify({kind:'native-process-config-reference-only',version:process.version,platform:process.platform,arch:process.arch,v8:process.versions.v8,cases:observations.length,failures,observations,config:fields,locale:config.getDefaultLocale(),limits:['Native process already bootstrapped; separate target/build capabilities','No native multi-realm Environment/GC/security/OOM/lifecycle differential','No guest startup or exit-dispatch proof']}));
if(failures)process.exitCode=1;
