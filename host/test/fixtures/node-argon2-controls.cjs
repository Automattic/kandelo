'use strict';
const assert = require('node:assert/strict');
const { createHook, executionAsyncId, AsyncLocalStorage } = require('node:async_hooks');
const options = () => ({ message:Buffer.from('password'), nonce:Buffer.from('saltsalt'),
  parallelism:2, tagLength:32, memory:32, passes:2,
  secret:Buffer.from('private'), associatedData:Buffer.from('context') });
function failure(fn) {
  try { fn(); return {unexpectedSuccess:true}; }
  catch(e) { return {name:e.name,code:e.code,message:e.message}; }
}
exports.controls = {
  variantsAndByteInputs(api) {
    const result=[];
    for(const algorithm of ['argon2d','argon2i','argon2id']) {
      const value=api.argon2Sync(algorithm,options());
      assert(Buffer.isBuffer(value));assert.equal(value.length,32);result.push(value.toString('hex'));
    }
    for(const message of ['',new Uint8Array([1,2,3]).buffer,new DataView(new Uint8Array([4,5]).buffer),
      new Uint16Array([0x1234]),new Uint8Array(new SharedArrayBuffer(3))]) {
      result.push(api.argon2Sync('argon2id',{...options(),message}).toString('hex'));
    }
    assert.equal(new Set(result.slice(0,3)).size,3);
    return result;
  },
  validationAndAccessOrder(api) {
    const cases=[];
    for(const [algorithm,parameters] of [[undefined,options()],['bad',options()],['argon2id',null],
      ['argon2id',{...options(),nonce:'short'}],['argon2id',{...options(),tagLength:3}],
      ['argon2id',{...options(),memory:15}],['argon2id',{...options(),parallelism:0}],
      ['argon2id',{...options(),passes:0}],['argon2id',{...options(),message:{byteLength:3}}]]) {
      cases.push(failure(()=>api.argon2Sync(algorithm,parameters)));
      cases.push(failure(()=>api.argon2(algorithm,parameters,()=>{})));
    }
    cases.push(failure(()=>api.argon2('argon2id',options(),undefined)));
    const trace=[],parameters={};
    for(const [name,value] of Object.entries(options())) Object.defineProperty(parameters,name,{
      get(){trace.push(name);return value;},enumerable:true});
    cases.push(api.argon2Sync('argon2id',parameters).toString('hex'),trace);
    assert(cases.slice(0,19).every(x=>x.code==='ERR_INVALID_ARG_TYPE'||x.code==='ERR_OUT_OF_RANGE'||x.code==='ERR_INVALID_ARG_VALUE'));
    return cases;
  },
  asyncScopeAndSnapshot: async function(api) {
    const local=new AsyncLocalStorage(),resources=new Map();
    const hook=createHook({init(id,type,_trigger,resource){if(type==='ARGON2REQUEST')resources.set(id,resource);}}).enable();
    try {
      return await local.run('argon-scope',()=>new Promise((resolve,reject)=>{
        const parameters=options();let returned=false;
        api.argon2('argon2id',parameters,function(error,result){
          try {
            assert(returned);assert.equal(error,null);assert(Buffer.isBuffer(result));
            assert.equal(local.getStore(),'argon-scope');assert.equal(resources.get(executionAsyncId()),this);
            assert.equal(this.constructor.name,'Argon2Job');resolve(result.toString('hex'));
          }catch(e){reject(e);}
        });
        for(const key of ['message','nonce','secret','associatedData'])parameters[key].fill(0);
        returned=true;
      }));
    } finally {hook.disable();}
  },
  initializationReadsAllFourInputs: async function(api) {
    const results=[];
    for(const async of [false,true]) {
      const parameters=options();let count=0;
      const hook=createHook({init(_id,type){if(type==='ARGON2REQUEST'){
        count++;for(const key of ['message','nonce','secret','associatedData'])parameters[key].fill(0x71);
      }}}).enable();
      try {
        const bytes=async?await new Promise((resolve,reject)=>api.argon2('argon2id',parameters,
          (error,value)=>error?reject(error):resolve(value))):api.argon2Sync('argon2id',parameters);
        assert.equal(count,1);results.push(bytes.toString('hex'));
      } finally {hook.disable();}
    }
    assert.notEqual(results[0],results[1]);return results;
  },
};
