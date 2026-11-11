'use strict';
const api=__kandeloUpstreamTest,setDetachKey=api.setBufferDetachKey,collect=()=>gc('shrinking');
const clone=(value,transfers)=>deserialize(serialize(value,transfers));
// @shared-buffer-detach-controls
runBufferDetachControls();
const sharedCases=observations.length;
check('matching-key-detaches-and-invalidates-every-existing-view',()=>{
 const buffer=seeded(),key={token:'native-owner'},view=new Uint8Array(buffer),data=new DataView(buffer);setDetachKey(buffer,key);collect();
 assert(thrown(()=>api.detachBufferWithKey(buffer,{token:'native-owner'})).name==='TypeError'&&view.byteLength===16);
 api.detachBufferWithKey(buffer,key);assert(buffer.detached&&view.byteLength===0&&thrown(()=>data.getUint8(0)).name==='TypeError');return true;
});
check('key-comparison-uses-same-value-without-coercion',()=>{
 for(const key of [undefined,null,false,0,-0,NaN,'',Symbol('key'),1n]){
  const buffer=seeded();setDetachKey(buffer,key);api.detachBufferWithKey(buffer,key);assert(buffer.detached);
 }
 for(const [key,other] of [[0,-0],[-0,0],[NaN,0],[null,undefined],['1',1],[false,0]]){
  const buffer=seeded();setDetachKey(buffer,key);assert(thrown(()=>api.detachBufferWithKey(buffer,other)).name==='TypeError');assert(!buffer.detached);
 }return {matches:9,mismatches:6};
});
check('key-only-reference-is-traced-through-moving-gc',()=>{
 const buffer=seeded();let key={token:'traced-only-owner'};const weak=new WeakRef(key);setDetachKey(buffer,key);key=null;clearKeptObjects();collect();
 assert(weak.deref()?.token==='traced-only-owner');api.detachBufferWithKey(buffer,weak.deref());assert(buffer.detached);return true;
});
check('clearing-key-releases-its-only-strong-reference',()=>{
 const buffer=seeded();let key={token:'released-key'};const weak=new WeakRef(key);setDetachKey(buffer,key);key=null;clearKeptObjects();collect();
 assert(weak.deref()!==undefined);setDetachKey(buffer,undefined);clearKeptObjects();collect();
 assert(weak.deref()===undefined,'cleared native key remained rooted');return true;
});
check('authorized-detach-still-respects-native-length-pinning',()=>{
 const buffer=seeded(16,{maxByteLength:64}),key={token:'pinned'},view=new Uint8Array(buffer);setDetachKey(buffer,key);
 assert(pinArrayBufferOrViewLength(buffer,true));
 try{assert(thrown(()=>api.detachBufferWithKey(buffer,key)).name==='RangeError');assert(!buffer.detached&&view.byteLength===16)}
 finally{assert(pinArrayBufferOrViewLength(buffer,false))}
 api.detachBufferWithKey(buffer,key);assert(buffer.detached&&view.byteLength===0);return true;
});
check('repeated-authorized-detach-preserves-key-validation',()=>{
 const buffer=seeded(),key={token:'idempotent'};setDetachKey(buffer,key);api.detachBufferWithKey(buffer,key);api.detachBufferWithKey(buffer,key);
 assert(thrown(()=>api.detachBufferWithKey(buffer,undefined)).name==='TypeError');setDetachKey(buffer,undefined);api.detachBufferWithKey(buffer,undefined);assert(buffer.detached);return true;
});
check('foreign-realm-key-and-buffer-use-the-same-native-slot',()=>{
 const global=newGlobal({newCompartment:true}),buffer=global.eval('new ArrayBuffer(16)'),key={token:'foreign-key'},view=new global.Uint8Array(buffer);
 setDetachKey(buffer,key);collect();assert(thrown(()=>buffer.transfer()).name==='TypeError');api.detachBufferWithKey(buffer,key);assert(view.byteLength===0&&buffer.detached);return true;
});
check('foreign-key-is-wrapped-into-local-buffer-storage',()=>{
 const global=newGlobal({newCompartment:true}),key=global.eval('({token:"foreign-value"})'),buffer=seeded();setDetachKey(buffer,key);collect();
 api.detachBufferWithKey(buffer,key);assert(buffer.detached);return true;
});
check('different-process-serialization-also-enforces-the-key',()=>{
 for(const scope of ['SameProcess','DifferentProcess','DifferentProcessForIndexedDB'])for(const size of [16,1024]){
  const buffer=seeded(size);setDetachKey(buffer,'pool');thrown(()=>serialize(buffer,[buffer],{scope}));assert(!buffer.detached&&bytes(buffer)[0]===11);
  setDetachKey(buffer,undefined);const copy=deserialize(serialize(buffer,[buffer],{scope}));assert(buffer.detached&&copy.byteLength===size&&bytes(copy)[0]===11);
 }return 6;
});
check('ordinary-jsapi-detach-cannot-bypass-the-key',()=>{
 const buffer=seeded();setDetachKey(buffer,'pool');assert(thrown(()=>detachArrayBuffer(buffer)).name==='TypeError');assert(!buffer.detached);
 setDetachKey(buffer,undefined);detachArrayBuffer(buffer);assert(buffer.detached);return true;
});
check('buffer-memory-controls-reject-nonbuffer-values-and-shared-backing',()=>{
 for(const value of [{},new Uint8Array(8),new SharedArrayBuffer(8),new Proxy(new ArrayBuffer(8),{})]){
  thrown(()=>setDetachKey(value,'pool'));thrown(()=>api.detachBufferWithKey(value,'pool'));
 }return 4;
});
print(JSON.stringify({kind:'buffer-memory-prerequisite-controls',cases:observations.length,sharedCases,failures,observations,originalBufferExercisedByThesePrerequisiteControls:false,upstreamStartup:false}));if(failures)quit(1);
