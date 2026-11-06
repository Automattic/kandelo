'use strict';
// Public contracts of the exact native pin. V8 VM realms are not SM security
// CCWs and this does not execute the candidate JSAPI/native backing bridge.
const assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),hooks=require('node:async_hooks');
assert.equal(process.version,'v26.13.0');
let passed=0;const observations=[];
function check(name,fn){const detail=fn();++passed;observations.push({name,...detail});}
const foreign=code=>vm.runInNewContext(code);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const asBytes=value=>Buffer.from(value.buffer,value.byteOffset,value.byteLength);
check('foreign Uint8Array original offset/length',()=>{const view=foreign('const a=new Uint8Array([9,1,2,3,8]);a.subarray(1,4)');assert.equal(digest(view),digest(Buffer.from([1,2,3])));assert(crypto.timingSafeEqual(view,Buffer.from([1,2,3])));return{byteLength:view.byteLength};});
check('foreign DataView offset across digest/key/KDF',()=>{const view=foreign('const a=new Uint8Array([9,1,2,3,8]);new DataView(a.buffer,1,3)');const bytes=Buffer.from([1,2,3]);assert.equal(digest(view),digest(bytes));assert.deepEqual(crypto.createSecretKey(view).export(),bytes);assert.deepEqual(crypto.pbkdf2Sync(view,view,1,16,'sha256'),crypto.pbkdf2Sync(bytes,bytes,1,16,'sha256'));return{byteLength:view.byteLength};});
check('poisoned public byte properties are not input accessors',()=>{const view=foreign('new Uint8Array([1,2,3])');let reads=0;for(const key of ['buffer','byteOffset','byteLength'])Object.defineProperty(view,key,{get(){++reads;throw Error('public getter must not run');}});assert.equal(digest(view),digest(Buffer.from([1,2,3])));assert(crypto.timingSafeEqual(view,Buffer.from([1,2,3])));assert.equal(reads,0);return{publicGetterReads:reads};});
check('empty foreign fixed views hash/compare as empty',()=>{for(const v of [foreign('new Uint8Array(0)'),foreign('new DataView(new ArrayBuffer(4),2,0)')]){assert.equal(digest(v),digest(Buffer.alloc(0)));assert(crypto.timingSafeEqual(v,Buffer.alloc(0)));}return{emptyViews:2};});
check('detached foreign view native crypto range is empty',()=>{const view=foreign('new Uint8Array([1,2,3])');const ab=view.buffer;const receiver=structuredClone(ab,{transfer:[ab]});assert.equal(view.byteLength,0);assert.equal(digest(view),digest(Buffer.alloc(0)));assert(crypto.timingSafeEqual(view,Buffer.alloc(0)));assert.deepEqual([...new Uint8Array(receiver)],[1,2,3]);return{detachedLength:view.byteLength};});
check('RAB out-of-bounds typed/DataView native ranges are empty',()=>{const ab=new ArrayBuffer(8,{maxByteLength:16}),typed=new Uint8Array(ab,4,4),data=new DataView(ab,4,4);ab.resize(2);for(const view of [typed,data]){assert.equal(digest(view),digest(Buffer.alloc(0)));assert(crypto.timingSafeEqual(view,Buffer.alloc(0)));}return{outOfBoundsViews:2};});
check('raw foreign AB/SAB timing ranges and random fill',()=>{for(const shared of [false,true]){const ab=foreign(shared?'new SharedArrayBuffer(16)':'new ArrayBuffer(16)');const view=new Uint8Array(ab);view.fill(0xa5);assert(crypto.timingSafeEqual(ab,view));assert.equal(crypto.randomFillSync(ab,4,8),ab);assert.deepEqual([...view.subarray(0,4)],[0xa5,0xa5,0xa5,0xa5]);assert.deepEqual([...view.subarray(12)],[0xa5,0xa5,0xa5,0xa5]);}return{rawSources:2};});
check('shared foreign DataView digest/key/random offsets',()=>{const view=foreign('const ab=new SharedArrayBuffer(16);new Uint8Array(ab).fill(0xa5);new DataView(ab,4,8)');const original=new Uint8Array(view.buffer);assert.equal(digest(view),digest(Buffer.alloc(8,0xa5)));assert.deepEqual(crypto.createSecretKey(view).export(),Buffer.alloc(8,0xa5));assert.equal(crypto.randomFillSync(view,2,4),view);assert.deepEqual([...original.subarray(0,6)],Array(6).fill(0xa5));assert.deepEqual([...original.subarray(10)],Array(6).fill(0xa5));return{offset:4,length:8};});
check('ordinary proxies are rejected; frontend error formatting remains observable',()=>{
 const plain=new Proxy(new Uint8Array([1]),{});assert.throws(()=>digest(plain),{code:'ERR_INVALID_ARG_TYPE'});
 const marker=new Error('constructor trap');let traps=0;const proxy=new Proxy(new Uint8Array([1]),{get(){++traps;throw marker;}});
 // Pinned errors.js determineSpecificType reads constructor when formatting
 // Hash.update's JS type error. Native timingSafeEqual uses a static message.
 assert.throws(()=>digest(proxy),error=>error===marker);assert.equal(traps,1);
 assert.throws(()=>crypto.timingSafeEqual(proxy,new Uint8Array([1])),{code:'ERR_INVALID_ARG_TYPE'});assert.equal(traps,1);
 return{hashErrorFormatterTrapReads:1,nativeTimingAdmissionTrapReads:0,securityCcwNotTested:true};
});
async function captureAtInit(name,raw,grow=false){
 const ab=foreign(grow?'new ArrayBuffer(32,{maxByteLength:64})':'new ArrayBuffer(32)');new Uint8Array(ab).fill(0xa5);const input=raw?ab:vm.runInNewContext('new Uint8Array(buffer,4,16)',{buffer:ab});let captured=false,receiver,resource;
 const hook=hooks.createHook({init(id,type,trigger,value){if(type!=='RANDOMBYTESREQUEST'||captured)return;captured=true;resource=value;if(grow){ab.resize(64);receiver=ab;}else receiver=structuredClone(ab,{transfer:[ab]});}}).enable();
 let callbackSync=true;let returned;
 try{await new Promise((resolve,reject)=>{crypto.randomFill(input,2,8,(error,result)=>{try{assert.ifError(error);assert.equal(callbackSync,false);returned=result;resolve();}catch(e){reject(e);}});callbackSync=false;});}finally{hook.disable();}
 assert(captured);assert.equal(returned,input);assert.equal(resource.constructor.name,'RandomBytesJob');
 const offset=raw?2:6,bytes=new Uint8Array(receiver);assert.deepEqual([...bytes.subarray(0,offset)],Array(offset).fill(0xa5));assert.deepEqual([...bytes.subarray(offset+8,32)],Array(32-offset-8).fill(0xa5));assert.notDeepEqual([...bytes.subarray(offset,offset+8)],Array(8).fill(0xa5));
 if(!grow)assert.equal(ab.byteLength,0);else assert.equal(ab.byteLength,64);
 ++passed;observations.push({name,capturedBeforeInitMutation:true,callbackOriginalIdentity:true,callbackAsync:true,originalAllocationWritten:true,initResource:'RandomBytesJob',observedLength:bytes.length});
}
(async()=>{await captureAtInit('async foreign-view transfer during actual init preserves original destination',false);await captureAtInit('async raw-AB transfer during actual init preserves original destination',true);await captureAtInit('async RAB growth during actual init preserves initial range',false,true);console.log(JSON.stringify({passed,observations,scope:'Exact native Node26 VM/public crypto reference only; no SpiderMonkey CCW, candidate JSAPI or guest/four-host validation'}));})().catch(error=>{console.error(error);process.exitCode=1;});
