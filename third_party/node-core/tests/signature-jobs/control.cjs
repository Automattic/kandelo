'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.version,'v26.13.0');
const api=require('./platform.cjs').create();
const fixture=name=>fs.readFileSync(path.join(process.env.NODE26_SOURCE,'test/fixtures/keys',name));
const rsa=fixture('rsa_private.pem'),rsaPublic=crypto.createPublicKey(rsa),data=Buffer.from('actual one-shot\0bytes');
const rows=[],failures=[];async function judge(name,fn){try{await fn();rows.push({name,pass:true})}catch(error){rows.push({name,pass:false});failures.push({name,message:error.message,stack:error.stack})}}
function project(error){return Object.fromEntries(['name','message','code','library','function','reason','opensslErrorStack'].filter(k=>error[k]!==undefined).map(k=>[k,error[k]]))}
function failed(fn){try{fn();return undefined}catch(e){return project(e)}}
function asyncSign(c,algorithm,data,key){return new Promise((resolve,reject)=>c.sign(algorithm,data,key,function(e,value){if(e)reject(e);else resolve({value,receiver:this})}))}
function asyncVerify(c,algorithm,data,key,sig){return new Promise((resolve,reject)=>c.verify(algorithm,data,key,sig,function(e,value){if(e)reject(e);else resolve({value,receiver:this})}))}
(async()=>{
 await judge('RSA actual one-shot bytes',()=>{const signature=api.sign('sha256',data,rsa);assert.deepEqual(Buffer.from(signature),crypto.sign('sha256',data,rsa));assert.equal(api.verify('sha256',data,rsaPublic,signature),true)});
 for(const algorithm of ['ed25519','ed448','ec','rsa']){
  const options=algorithm==='ec'?{namedCurve:'prime256v1'}:algorithm==='rsa'?{modulusLength:2048}:{};
  const keys=crypto.generateKeyPairSync(algorithm,options),digest=algorithm.startsWith('ed')?null:'sha256';
  for(const encoding of ['der','ieee-p1363'])await judge(algorithm+' '+encoding+' sync/async actual provider',async()=>{
   const priv={key:keys.privateKey,dsaEncoding:encoding},pub={key:keys.publicKey,dsaEncoding:encoding};
   const signature=api.sign(digest,data,priv);assert.equal(crypto.verify(digest,data,pub,signature),true);assert.equal(api.verify(digest,data,pub,crypto.sign(digest,data,priv)),true);
   const signed=await asyncSign(api,digest,data,priv);assert.equal(signed.receiver.constructor.name,'SignJob');assert.equal(crypto.verify(digest,data,pub,signed.value),true);const verified=await asyncVerify(api,digest,data,pub,signed.value);assert.equal(verified.value,true);assert.equal(verified.receiver.constructor.name,'SignJob');
  });
 }
 for(const padding of [-1,crypto.constants.RSA_PKCS1_PADDING,crypto.constants.RSA_PKCS1_PSS_PADDING])await judge('actual one-shot padding '+padding,()=>{const key={key:rsa,padding},pub={key:rsaPublic,padding};const sig=api.sign('sha256',data,key);assert.equal(crypto.verify('sha256',data,pub,sig),true);assert.equal(api.verify('sha256',data,pub,crypto.sign('sha256',data,key)),true)});
 for(const context of [undefined,Buffer.alloc(0),Buffer.from('ctx')])await judge('context actual provider/error '+String(context),async()=>{const key={key:rsa,context};assert.deepEqual(failed(()=>api.sign('sha256',data,key)),failed(()=>crypto.sign('sha256',data,key)));const outcomes=[];for(const c of [crypto,api]){let returned=false;const value=await new Promise(resolve=>{c.sign('sha256',data,key,function(error,result){resolve({afterReturn:returned,error:error&&project(error),bytes:result&&Buffer.from(result).toString('hex')})});returned=true});outcomes.push(value)}assert.deepEqual(outcomes[1],outcomes[0])});
 for(const [label,args]of [['bad algorithm',[1,data,rsa]],['bad digest',['missing',data,rsa]],['data type',['sha256',{},rsa]],['missing key',['sha256',data,null]],['public key',['sha256',data,rsaPublic]],['context length',['sha256',data,{key:rsa,context:Buffer.alloc(256)}]],['context type',['sha256',data,{key:rsa,context:{}}]],['callback',['sha256',data,rsa,{}]],['bad key',['sha256',data,Buffer.from('invalid')]],['negative salt',['sha256',data,{key:rsa,saltLength:-999}]]])await judge('one-shot validation '+label,()=>assert.deepEqual(failed(()=>api.sign(...args)),failed(()=>crypto.sign(...args))));
 const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 await judge('malformed one-shot P1363 is false',()=>{const key={key:keys.publicKey,dsaEncoding:'ieee-p1363'};assert.equal(api.verify('sha256',data,key,Buffer.alloc(3)),crypto.verify('sha256',data,key,Buffer.alloc(3)))});
 await judge('real async callback follows public return',async()=>{let returned=false;await new Promise((resolve,reject)=>{api.sign('sha256',data,rsa,(e,value)=>{try{assert.ifError(e);assert.equal(returned,true);assert.equal(crypto.verify('sha256',data,rsaPublic,value),true);resolve()}catch(e){reject(e)}});returned=true})});

 for(const async of [false,true])for(const detach of [false,true])await judge('SIGNREQUEST '+(async?'async snapshot':'sync original')+' data'+(detach?' with detach/GC':''),async()=>{
  const outcomes=[];
  for(const c of [crypto,api]){
   const input=new Uint8Array(new ArrayBuffer(data.length));input.fill(1);let transferred;
   const hook=require('node:async_hooks').createHook({init(_id,type){if(type==='SIGNREQUEST'){input.fill(2);if(detach)transferred=structuredClone(input.buffer,{transfer:[input.buffer]});global.gc()}}});
   let result;
   hook.enable();try{if(async){const pending=asyncSign(c,'sha256',input,rsa);hook.disable();result=(await pending).value}else result=c.sign('sha256',input,rsa)}finally{hook.disable()}
   assert.equal(crypto.verify('sha256',Buffer.alloc(data.length,async?1:2),rsaPublic,result),true);if(detach)assert.equal(input.byteLength,0);assert.equal(transferred?.byteLength,detach?data.length:undefined);outcomes.push(Buffer.from(result).toString('hex'));
  }
  assert.equal(outcomes[1],outcomes[0]);
 });
 for(const async of [false,true])for(const encoding of ['der','ieee-p1363'])await judge('constructor '+encoding+' signature ownership '+(async?'async':'sync'),async()=>{
  const key={key:keys.publicKey,dsaEncoding:encoding},signatureOptions={key:keys.privateKey,dsaEncoding:encoding};
  const outcomes=[];
  for(const c of [crypto,api]){
   const signature=crypto.sign('sha256',data,signatureOptions);
   const hook=require('node:async_hooks').createHook({init(_id,type){if(type==='SIGNREQUEST')signature[signature.length-1]^=1}});
   let result;hook.enable();try{if(async){const pending=asyncVerify(c,'sha256',data,key,signature);hook.disable();result=(await pending).value}else result=c.verify('sha256',data,key,signature)}finally{hook.disable()}
   outcomes.push(result);
  }
  assert.deepEqual(outcomes,[async||encoding==='ieee-p1363',async||encoding==='ieee-p1363']);
 });
 for(const async of [false,true])await judge('ToResult setter exception exact identity '+(async?'async callback':'sync throw'),async()=>{
  for(const c of [crypto,api]){
   const marker={original:true},descriptor=Object.getOwnPropertyDescriptor(Error.prototype,'code');let actual;
   Object.defineProperty(Error.prototype,'code',{configurable:true,set(){throw marker}});
   try{if(async)actual=await new Promise(resolve=>c.sign('sha256',data,{key:rsa,context:Buffer.from('ctx')},function(error){resolve(error)}));else try{c.sign('sha256',data,{key:rsa,context:Buffer.from('ctx')})}catch(error){actual=error}}
   finally{if(descriptor)Object.defineProperty(Error.prototype,'code',descriptor);else delete Error.prototype.code}
   assert.equal(actual,marker);
  }
 });
 await judge('actual callback async context/resource and destroy lifecycle',async()=>{
  for(const c of [crypto,api]){
   const hooks=require('node:async_hooks'),storage=new hooks.AsyncLocalStorage(),marker={frame:true},trace=[];let id,done;
   const destroyed=new Promise(resolve=>{done=resolve}),timer=setTimeout(()=>done('timeout'),3000);
   const hook=hooks.createHook({init(n,type){if(type==='SIGNREQUEST'){id=n;trace.push('init')}},before(n){if(n===id)trace.push('before')},after(n){if(n===id)trace.push('after')},destroy(n){if(n===id){trace.push('destroy');done('destroy')}}});
   hook.enable();try{
    await storage.run(marker,()=>new Promise((resolve,reject)=>c.sign('sha256',data,rsa,function(error){try{assert.ifError(error);assert.equal(storage.getStore(),marker);assert.equal(hooks.executionAsyncId(),id);assert.equal(hooks.executionAsyncResource(),this);trace.push('callback');resolve()}catch(error){reject(error)}})));
    assert.equal(await destroyed,'destroy');assert.deepEqual(trace,['init','before','callback','after','destroy']);
   }finally{clearTimeout(timer);hook.disable();storage.disable()}
  }
 });
 for(const type of ['ml-dsa-44','ml-dsa-65'])await judge('actual provider '+type+' one-shot/context',async()=>{
  const pair=crypto.generateKeyPairSync(type),options={key:pair.privateKey,context:Buffer.from('ctx')},pub={key:pair.publicKey,context:Buffer.from('ctx')};
  assert.equal(crypto.verify(null,data,pub,api.sign(null,data,options)),true);
  assert.equal(api.verify(null,data,pub,crypto.sign(null,data,options)),true);
  const signature=(await asyncSign(api,null,data,options)).value;assert.equal((await asyncVerify(api,null,data,pub,signature)).value,true);
 });
 console.log(JSON.stringify({scope:'one-shot actual portable provider operations over identified native V8 backing/Node async-resource/libuv queue controls; not guest queue/JSAPI/four-host acceptance',rows,failures}));if(failures.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
