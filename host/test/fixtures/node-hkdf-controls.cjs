'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {AsyncLocalStorage,createHook,executionAsyncId}=require('node:async_hooks');
const outcome=run=>{try{return {hex:Buffer.from(run()).toString('hex')}}catch(e){const o={name:e.name,code:e.code,message:e.message};for(const k of ['library','reason','opensslErrorStack'])if(Object.hasOwn(e,k))o[k]=e[k];return o;}};
module.exports={
  synchronousByteSources(api){
    const backing=Uint8Array.from([9,1,0,2,8]);
    const keyInputs=['é\0key',backing.subarray(1,4),new DataView(backing.buffer,1,3),new Uint16Array([1,256]),backing.buffer,new SharedArrayBuffer(0),crypto.createSecretKey('key')];
    return keyInputs.map(key=>{
      const salt=new DataView(backing.buffer,1,3),info=new Uint8Array(new SharedArrayBuffer(4));info.set([1,2,0,3]);
      const result=api.hkdfSync('sha256',key,salt,info,33);
      assert(result instanceof ArrayBuffer);assert.equal(result.byteLength,33);assert(!Buffer.isBuffer(result));
      return Buffer.from(result).toString('hex');
    });
  },
  validationAndOrder(api){
    const run=args=>outcome(()=>api.hkdf(...args));
    return [run([]),run([null,null,null,null,-1,null]),run(['sha256',{},'','',1,()=>{}]),
      run(['sha256','key',null,'',1,()=>{}]),run(['sha256','key','',{},1,()=>{}]),
      run(['sha256','key','',Buffer.alloc(1025),1,null]),run(['sha256','key','','',-1,()=>{}]),
      run(['sha256','key','','',NaN,()=>{}]),run(['no-digest','key','','',1,null]),run(['no-digest','key','','',1,()=>{}]),
      outcome(()=>api.hkdfSync('sha256',crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey,'','',1))];
  },
  nativeDigestAliasesLimitsAndErrors(api){
    const result=[];
    for(const digest of ['sha1','sha256','sha512','sha3-256','dss1','RSA-SHA256','sha256\0ignored','md4','shake128','no-digest'])
      result.push(outcome(()=>api.hkdfSync(digest,'key','salt','info',32)));
    for(const length of [0,1,8160,8161])result.push(outcome(()=>api.hkdfSync('sha256','','','',length)));
    return result;
  },
  asyncSnapshotAndResourceScope:async function(api){
    const store=new AsyncLocalStorage(),resources=new Map();
    const hook=createHook({init(id,type,_trigger,resource){if(type==='DERIVEBITSREQUEST')resources.set(id,resource);}}).enable();
    try{return await store.run('hkdf-scope',async()=>{
      const key=Buffer.from('key'),salt=Buffer.from('salt'),info=Buffer.from('info');let returned=false;
      const result=await new Promise((resolve,reject)=>{
        api.hkdf('sha256',key,salt,info,32,function(error,result){
          try{assert.equal(returned,true);assert.equal(error,null);assert.equal(store.getStore(),'hkdf-scope');
            assert.equal(resources.get(executionAsyncId()),this);assert.equal(this.constructor.name,'HKDFJob');
            assert(result instanceof ArrayBuffer);resolve(Buffer.from(result).toString('hex'));}catch(e){reject(e)}
        });key.fill(0);salt.fill(0);info.fill(0);returned=true;
      });return result;
    });}finally{hook.disable();}
  },
  syncInitReentryReadsLiveBytes(api){
    const key=Buffer.from('key'),salt=Buffer.from('salt'),info=Buffer.from('info');let seen=0;
    const hook=createHook({init(_id,type){if(type==='DERIVEBITSREQUEST'){seen++;key.fill(1);salt.fill(2);info.fill(3);}}}).enable();
    try{const value=api.hkdfSync('sha256',key,salt,info,32);assert.equal(seen,1);return Buffer.from(value).toString('hex');}finally{hook.disable();}
  },
  secretKeyConsumerAndMetadata(api){
    const key=crypto.createSecretKey(Buffer.from('immutable'));
    const methodNames=['hkdf','hkdfSync'].map(name=>[api[name].name,api[name].length]);
    return {key:Buffer.from(api.hkdfSync('sha256',key,'salt','info',32)).toString('hex'),methodNames};
  },
};
