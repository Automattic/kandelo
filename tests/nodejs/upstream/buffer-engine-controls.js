'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('buffer'),collect=()=>gc('shrinking'),detachBuffer=buffer=>api.detachBufferWithKey(buffer,undefined);
// @shared-buffer-controls
const sharedCases=observations.length;
const {FastBuffer,addBufferPrototypeMethods}=realm.require('internal/buffer');
binding.setBufferPrototype(FastBuffer.prototype);addBufferPrototypeMethods(FastBuffer.prototype);
check('original-set-detach-key-export-reaches-the-engine-native-key',()=>{
 const buffer=new ArrayBuffer(8),key=Symbol('native-buffer-key');assert(binding.setDetachKey(buffer,key)===undefined);
 assert(outcome(()=>api.detachBufferWithKey(buffer,undefined)).error.name==='TypeError'&&buffer.byteLength===8);
 binding.setDetachKey(buffer,undefined);api.detachBufferWithKey(buffer,undefined);assert(buffer.detached===true);return true;
});
check('complete-original-internal-buffer-runs-against-real-binding',()=>{
 const value=new FastBuffer(32);value.writeUInt32LE(0xdeadbeef,1);value.writeDoubleBE(Math.PI,8);collect();
 assert(value.readUInt32LE(1)===0xdeadbeef&&value.readDoubleBE(8)===Math.PI);
 assert(value.utf8Write('é😀',16,6)===6&&value.utf8Slice(16,22)==='é😀');return true;
});
check('original-native-constructors-use-the-real-principal-prototype',()=>{
 for(const op of ['copy','adopt','tracked']){
  const input=bytes(65,66,67),value=api.bufferNative(op,input);assert(Object.getPrototypeOf(value)===FastBuffer.prototype&&value instanceof Uint8Array);input.fill(0);collect();assert(value.utf8Slice(0,3)==='ABC');
 }
 const value=api.bufferNative('new',13);assert(value.length===13&&Object.getPrototypeOf(value)===FastBuffer.prototype);value.fill(0x63);assert(binding.utf8Slice(value)==='c'.repeat(13));return true;
});
check('original-native-string-constructor-promotes-escaped-engine-roots',()=>{
 const matrix=[];for(const [value,encoding]of [['é😀',1],['4142zz',5],['QUL/',2],['QUL_',7],['A中',3],['éÿ',4],['',1]]){
  const result=api.bufferNative('string',value,encoding);collect();assert(Object.getPrototypeOf(result)===FastBuffer.prototype);matrix.push(list(result));
 }
 assert(JSON.stringify(matrix)==='[[195,169,240,159,152,128],[65,66],[65,66,255],[65,66,255],[65,0,45,78],[233,255],[]]');return matrix;
});
check('original-callbackinfo-releases-unreachable-adopted-bytes-on-foreground',()=>{
 api.bufferNative('clean');drainJobQueue();collect();drainJobQueue();const before=api.bufferNative('inspect');
 function allocate(){const value=api.bufferNative('tracked',bytes(1,2,3,4));assert(value.length===4)}allocate();
 const created=api.bufferNative('inspect');assert(created.created===before.created+1&&created.bytes===before.bytes+4);
 collect();drainJobQueue();const after=api.bufferNative('inspect');assert(after.freed===before.freed+1&&after.bytes===before.bytes);return true;
});
check('original-callbackinfo-null-data-callback-is-asynchronous-and-once',()=>{
 const before=api.bufferNative('inspect'),value=api.bufferNative('trackedNull');assert(value.length===0&&value.buffer.detached===true);
 const pending=api.bufferNative('inspect');assert(pending.created===before.created+1&&pending.freed===before.freed);
 drainJobQueue();const after=api.bufferNative('inspect');assert(after.freed===before.freed+1&&after.bytes===before.bytes);collect();drainJobQueue();assert(api.bufferNative('inspect').freed===after.freed);return true;
});
check('original-callbackinfo-environment-cleanup-detaches-live-arraybuffers',()=>{
 const before=api.bufferNative('inspect'),values=Array.from({length:6},()=>api.bufferNative('tracked',bytes(1,2,3,4)));
 collect();assert(values.every(value=>value.byteLength===4));api.bufferNative('clean');
 assert(values.every(value=>value.byteLength===0&&value.buffer.detached===true));const cleaned=api.bufferNative('inspect');assert(cleaned.freed===before.freed+6&&cleaned.bytes===before.bytes);
 drainJobQueue();collect();drainJobQueue();assert(api.bufferNative('inspect').freed===cleaned.freed);return true;
});
check('whole-original-icu-transcode-returns-real-native-buffer',()=>{
 const value=realm.internalBinding('icu').transcode(bytes(65,0xc3,0xa9),'utf8','utf16le');collect();
 assert(Object.getPrototypeOf(value)===FastBuffer.prototype&&JSON.stringify(list(value))==='[65,0,233,0]');return list(value);
});
check('principal-buffer-prototype-survives-foreign-native-call-and-gc',()=>{
 const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global);assert(other.internalBinding('buffer')!==binding);
 const value=global.eval('new Uint8Array([65,66])');assert(binding.utf8Slice(value)==='AB');collect();assert(api.bufferNative('copy',value).utf8Slice(0,2)==='AB');return true;
});
check('retained-native-storage-follows-real-same-size-transfer-ownership',()=>{
 const value=new Uint8Array(4096).fill(0x61);let transferred;
 const result=binding.utf8Slice(value,{valueOf(){transferred=value.buffer.transfer();new Uint8Array(transferred).fill(0x7a,0,4);collect();return 0}},4);
 assert(result==='zzzz'&&value.byteLength===0&&transferred.byteLength===4096);collect();assert(new Uint8Array(transferred)[0]===0x7a);return true;
});
check('retained-native-storage-survives-transfer-that-reallocates',()=>{
 const value=new Uint8Array(4096).fill(0x61);let transferred;
 const result=binding.utf8Slice(value,{valueOf(){transferred=value.buffer.transfer(8192);collect();return 0}},4);
 assert(result==='aaaa'&&value.byteLength===0&&transferred.byteLength===8192);assert(new Uint8Array(transferred).slice(4096).every(byte=>byte===0));return true;
});
check('raw-structured-clone-transport-copies-without-invalidating-native-span',()=>{
 const value=new Uint8Array(4096).fill(0x61);let transferred;
 const result=binding.utf8Slice(value,{valueOf(){transferred=deserialize(serialize(value.buffer,[value.buffer]));new Uint8Array(transferred).fill(0x7a,0,4);collect();return 0}},4);
 assert(result==='aaaa'&&value.byteLength===0&&transferred.byteLength===4096&&new Uint8Array(transferred)[0]===0x7a);return true;
});
let bootstrapFailure;
check('upstream-bootstrap-advances-to-next-real-backend-gap',()=>{
 const global=newGlobal({newCompartment:true});api.initializeContext(global);api.initializeRealm(global);const error=outcome(()=>api.runNodeBootstrap(global));
 assert(error.error&&error.error.code==='ERR_KANDELO_NOT_IMPLEMENTED');bootstrapFailure={...error.error,compiledBuiltinIds:api.inspectRealm(global).compiledBuiltinIds};assert(!error.error.message.includes("binding 'buffer'"));return bootstrapFailure;
});
print(JSON.stringify({kind:'whole-original-native-buffer-controls',cases:observations.length,sharedCases,failures,observations,bootstrapFailure,native:api.bufferNative('inspect'),upstreamStartup:false}));if(failures)quit(1);
