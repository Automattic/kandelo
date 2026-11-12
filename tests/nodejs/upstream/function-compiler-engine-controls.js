'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();
const compileBody=(global,filename,body)=>api.compileFunctionBody(global,filename,body);
const createCompilerRealm=()=>newGlobal({newCompartment:true});
const evaluateCompilerScript=(global,source)=>evaluate(source,{global});
const compilerFullGC=()=>gc('shrinking');
const collectCompilerGarbage=async()=>{clearKeptObjects();compilerFullGC();await 0;clearKeptObjects();compilerFullGC()};
const compilerErrorLocation=error=>({file:error.fileName,line:error.lineNumber});
// @shared-native-function-compiler-controls
(async()=>{
 const shared=await runFunctionCompilerControls(),observations=[...shared.observations];let failures=shared.failures;
 function assert(value,message='compiler diagnostic assertion failed'){if(!value)throw Error(message)}
 function thrown(callback){try{callback()}catch(error){return error}throw Error('expected exception')}
 function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
 check('private-probe-rejects-nonglobals-without-proxy-traps',()=>{
  let traps=0;const proxy=new Proxy({},{get(){traps++;throw Error('PROXY_TRAP')}});for(const target of [{},proxy,new Uint8Array(8),null,undefined])thrown(()=>compileBody(target,'f','return 1'));assert(traps===0);return true;
 });
 check('private-probe-type-validation-does-not-coerce-source-objects',()=>{
  let coerced=0;const value={toString(){coerced++;return 'return 1'}};thrown(()=>compileBody(globalThis,'f',value));thrown(()=>compileBody(globalThis,value,'return 1'));thrown(()=>api.compileFunctionBody(globalThis,'f'));assert(coerced===0);return true;
 });
 check('native-cstring-probe-rejects-unrepresentable-origin-metadata-explicitly',()=>{
  for(const file of ['a\0b','a\ud800b','a\udc00b'])assert(thrown(()=>compileBody(globalThis,file,'return 1')).message.includes('metadata without NUL'));
  assert(compileBody(globalThis,'fixture:😀.js','return 79')()===79);return true;
 });
 let bootstrapFailure;
 check('compiler-prerequisite-does-not-fabricate-mksnapshot-or-bootstrap-completion',()=>{
  const global=newGlobal({newCompartment:true});api.initializeContext(global);api.initializeRealm(global);const error=thrown(()=>api.runNodeBootstrap(global));assert(error.code==='ERR_KANDELO_NOT_IMPLEMENTED'&&error.message==="Native Node binding 'mksnapshot' is not implemented");bootstrapFailure={name:error.name,code:error.code,message:error.message};return bootstrapFailure;
 });
 print(JSON.stringify({kind:'native-function-body-compiler-prerequisite',cases:observations.length,sharedCases:shared.cases,failures,observations,bootstrapFailure,upstreamStartup:false}));if(failures)quit(1);
})().catch(error=>{print(error.stack);quit(1)});
