const observations=[];let failures=0;
function assert(value,message='native Buffer assertion failed'){if(!value)throw Error(message)}
function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message}})}}
function outcome(callback){try{const value=callback();return {value:value===undefined?'undefined':value}}catch(error){return {error:{name:error.name,code:error.code,message:error.message}}}}
const bytes=(...values)=>Uint8Array.from(values),list=value=>Array.from(value);
// Node deletes setBufferPrototype during bootstrap; compare the shared post-bootstrap surface separately.
check('shared-native-export-descriptors-after-principal-setter-removal',()=>Object.fromEntries(Reflect.ownKeys(binding).filter(name=>name!=='setBufferPrototype').map(name=>{
 const d=Object.getOwnPropertyDescriptor(binding,name),v=d.value;
 return [name,{writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,value:typeof v==='function'?{name:v.name,length:v.length,type:'function'}:{type:typeof v}}];
})));
const input=bytes(0x41,0xc3,0xa9,0xf0,0x9f,0x98,0x80,0,0xff);
for(const method of ['asciiSlice','base64Slice','base64urlSlice','latin1Slice','hexSlice','ucs2Slice','utf8Slice'])check(method+'-real-offset-views-and-defaults',()=>{
 const storage=new Uint8Array(input.length+4).fill(0xaa);storage.set(input,2);const view=storage.subarray(2,-2);
 const result=[binding[method](view),binding[method](view,1,7),binding[method](view,0,0),outcome(()=>binding[method](view,-1)),outcome(()=>binding[method](view,0,99))];
 collect();assert(storage[0]===0xaa&&storage.at(-1)===0xaa);return result;
});
for(const [method,value] of [['asciiWriteStatic','Aé😀'],['latin1WriteStatic','Aé😀'],['utf8WriteStatic','Aé😀'],['ucs2Write','Aé😀'],['base64Write','QcOp8J+YgA=='],['base64urlWrite','QcOp8J-YgA'],['hexWrite','41c3a9f09f9880zz']])check(method+'-bounded-writes-and-native-errors',()=>{
 const storage=new Uint8Array(18).fill(0xaa),view=storage.subarray(2,16),written=binding[method](view,value,1,8);
 collect();assert(storage[0]===0xaa&&storage.at(-1)===0xaa);
 return {written,bytes:list(storage),empty:binding[method](view,value,view.length,0),past:outcome(()=>binding[method](view,value,view.length+1,1)),type:outcome(()=>binding[method](view,{},0,1))};
});
check('utf8-byte-length-real-codeunits-and-long-strings',()=>['','abc','é','😀','\ud800x\udc00','中é😀'.repeat(600)].map(value=>binding.byteLengthUtf8(value)));
check('native-fill-encoding-buffer-alias-and-invalid-results',()=>{
 const results=[];
 for(const [value,encoding]of [[257,undefined],['é😀','utf8'],['A中','ucs2'],['ff01','hex'],[bytes(1,2,3),undefined],['','hex'],['zz','hex']]){
  const target=new Uint8Array(17).fill(0xaa),result=outcome(()=>binding.fill(target,value,1,16,encoding));results.push({result,bytes:list(target)});
 }
 const target=bytes(1,2,3,4,5,6,7,8);const result=binding.fill(target,target.subarray(0,2),2,8);results.push({result:result===undefined?'undefined':result,bytes:list(target)});
 results.push(outcome(()=>binding.fill(target,1,5,2)),outcome(()=>binding.fill({},1,0,1)));return results;
});
check('copy-overlap-view-offset-and-shared-combinations',()=>{
 const results=[];
 for(const [sourceShared,targetShared]of [[false,false],[false,true],[true,false],[true,true]]){
  const source=new Uint8Array(sourceShared?new SharedArrayBuffer(10):new ArrayBuffer(10));source.set([1,2,3,4,5,6,7,8,9,10]);
  const target=new Uint8Array(targetShared?new SharedArrayBuffer(10):new ArrayBuffer(10));target.fill(0xaa);
  results.push({copied:binding.copy(source.subarray(1,8),target.subarray(2,9),1,2,4),bytes:list(target)});
 }
 const target=bytes(1,2,3,4,5,6,7,8);results.push({copied:binding.copy(target,target,2,0,6),bytes:list(target)});
 const source=bytes(1,2),dead=bytes(3,4);detachBuffer(dead.buffer);results.push(binding.copy(source,dead,0,0,2),binding.copy(dead,source,0,0,2));return results;
});
check('copy-arraybuffer-uses-real-backing-bytes',()=>{const source=bytes(1,2,3,4,5),target=new Uint8Array(8).fill(0xaa);assert(binding.copyArrayBuffer(target.buffer,2,source.buffer,1,3)===undefined);return list(target)});
check('compare-whole-and-offset-ranges',()=>{
 const a=bytes(1,2,3,4),b=bytes(1,2,3,5),c=bytes(1,2,3,4,5);
 return [binding.compare(a,b),binding.compare(b,a),binding.compare(a,a),binding.compare(a,c),binding.compareOffset(a,b,1,1,3,3),outcome(()=>binding.compareOffset(a,b,8,1,8,3)),outcome(()=>binding.compare({},a))];
});
check('search-buffer-string-and-number-with-range-and-direction',()=>{
 const a=bytes(0x41,0x42,0x41,0x42,0x43,0x41),results=[];
 for(const forward of [true,false])for(const offset of [-20,-2,0,1,99]){
  results.push([binding.indexOfBuffer(a,bytes(0x41,0x42),offset,1,forward,5),binding.indexOfString(a,'AB',offset,1,forward,5),binding.indexOfNumber(a,0x41,offset,forward,5)]);
 }
 results.push([binding.indexOfBuffer(a,bytes(),99,1,true,4),binding.indexOfString(a,'',99,1,true,4)]);
 const wide=bytes(65,0,66,0,65,0,67,0);results.push([binding.indexOfString(wide,'A',1,3,true,8),binding.indexOfBuffer(wide,bytes(65,0),7,3,false,8)]);return results;
});
for(const method of ['swap16','swap32','swap64'])check(method+'-mutates-actual-shared-and-offset-bytes',()=>{
 const results=[];for(const shared of [false,true]){const storage=new Uint8Array(shared?new SharedArrayBuffer(20):new ArrayBuffer(20));storage.set(Array.from({length:20},(_,i)=>i));const value=binding[method](storage.subarray(2,18));assert(value===undefined);results.push(list(storage));}return results;
});
check('utf8-ascii-latin1-validation-and-replacement-length',()=>{
 const results=[];for(const value of [bytes(),bytes(65,66),bytes(0xc3,0xa9),bytes(0xf0,0x9f,0x98,0x80),bytes(0xe2,0x82,65,0xff),bytes(0xed,0xa0,0x80)])for(const form of [value,value.buffer])results.push([binding.isUtf8(form),binding.isAscii(form),binding.stringLengthUtf8(form)]);
 const shared=new Uint8Array(new SharedArrayBuffer(3));shared.set([0xe2,0x82,0xac]);results.push([binding.isUtf8(shared),binding.isAscii(shared.buffer),binding.stringLengthUtf8(shared)]);
 results.push(['','abc','éÿ','Ā','😀','a'.repeat(1000)+'ÿ'].map(value=>binding.isLatin1(value)));return results;
});
check('mask-overlapping-and-shared-real-memory',()=>{
 const results=[];for(const shared of [false,true])for(const offset of [0,1,4]){const value=new Uint8Array(shared?new SharedArrayBuffer(48):new ArrayBuffer(48));value.set(Array.from({length:48},(_,i)=>i));const done=binding.mask(value,value,offset,40,0xdeadbeef);results.push({done,bytes:list(value)});}return results;
});
check('atob-btoa-native-positive-negative-and-codeunit-results',()=>({decoded:['','YQ==',' Y Q ==\n','YQ','Y','!!','Y===','é'].map(value=>binding.atob(value)),encoded:['','abc','éÿ','Ā','😀','a'.repeat(1500)].map(value=>binding.btoa(value)),type:outcome(()=>binding.atob(1))}));
check('unsafe-allocation-real-length-writable-bytes-and-argument-errors',()=>{
 const results=[];for(const size of [0,1,4096]){const buffer=binding.createUnsafeArrayBuffer(size),view=new Uint8Array(buffer);assert(buffer instanceof ArrayBuffer&&buffer.byteLength===size);view.fill(0x57);assert(view.every(value=>value===0x57));results.push(buffer.byteLength)}
 return {lengths:results,missing:outcome(()=>binding.createUnsafeArrayBuffer()),extra:outcome(()=>binding.createUnsafeArrayBuffer(1,2))};
});
check('aligned-offset-uses-stable-storage-through-moving-gc',()=>{
 for(const size of [128,4096]){const buffer=new ArrayBuffer(size);for(const alignment of [1,2,8,16,32,64]){const first=binding.arrayBufferAlignedOffset(buffer,alignment);assert(first>=0&&first<alignment&&first<=size);collect();assert(binding.arrayBufferAlignedOffset(buffer,alignment)===first,'backing address moved');}}return true;
});
check('coercion-reentry-can-detach-buffer-without-pinning',()=>{
 const target=new Uint8Array(64);target.fill(0x61);let reads=0;
 const result=binding.utf8Slice(target,{valueOf(){reads++;detachBuffer(target.buffer);collect();return 0}},4);
 assert(reads===1&&target.byteLength===0);return {result,reads};
});
check('coercion-reentry-keeps-original-resizable-allocation-live',()=>{
 const target=new Uint8Array(new ArrayBuffer(64,{maxByteLength:128}));target.fill(0x61);let reads=0;
 const result=binding.utf8Slice(target,{valueOf(){reads++;target.buffer.resize(32);collect();return 0}},4);
 assert(reads===1&&target.byteLength===32);return {result,reads,length:target.byteLength};
});
