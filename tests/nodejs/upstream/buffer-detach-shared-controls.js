const observations=[];let failures=0;
function assert(value,message='buffer memory assertion failed'){if(!value)throw Error(message)}
function thrown(callback){try{callback()}catch(error){return error}throw Error('expected exception')}
function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
function bytes(buffer){return Array.from(new Uint8Array(buffer))}
function seeded(size=16,options){const buffer=new ArrayBuffer(size,options);new Uint8Array(buffer).set([11,22,33,44]);return buffer}
function rejectedTransfer(buffer,method='transfer'){
  const size=buffer.byteLength,view=new Uint8Array(buffer),before=bytes(buffer);
  assert(thrown(()=>buffer[method]()).name==='TypeError');
  assert(buffer.byteLength===size&&view.byteLength===size&&JSON.stringify(bytes(buffer))===JSON.stringify(before),'rejected transfer changed storage');
}
function runBufferDetachControls(){
 check('ordinary-transfers-retain-bytes-and-retire-all-views',()=>{
  for(const size of [16,1024])for(const method of ['transfer','transferToFixedLength']){
   const buffer=seeded(size),view=new Uint8Array(buffer),data=new DataView(buffer),copy=buffer[method]();
   assert(buffer.byteLength===0&&view.byteLength===0&&copy.byteLength===size);
   assert(thrown(()=>data.getUint8(0)).name==='TypeError');assert(bytes(copy).slice(0,4).join(',')==='11,22,33,44');
  }return 4;
 });
 check('all-defined-key-values-block-both-transfer-methods',()=>{
  const keys=[null,false,0,-0,NaN,'',42,'pool',Symbol('key'),{},()=>{},1n];
  for(const key of keys)for(const method of ['transfer','transferToFixedLength']){
   const buffer=seeded();setDetachKey(buffer,key);collect();rejectedTransfer(buffer,method);
   setDetachKey(buffer,undefined);const copy=buffer[method]();assert(copy.byteLength===16&&bytes(copy)[0]===11);
  }return keys.length*2;
 });
 check('key-replacement-and-clear-follow-current-native-state',()=>{
  const buffer=seeded();setDetachKey(buffer,'first');rejectedTransfer(buffer);setDetachKey(buffer,{second:true});collect();rejectedTransfer(buffer);
  setDetachKey(buffer,undefined);assert(buffer.transfer().byteLength===16);return true;
 });
 check('native-key-is-hidden-and-independent-of-frozen-properties',()=>{
  const buffer=seeded();Object.freeze(buffer);setDetachKey(buffer,Symbol('pool'));collect();
  assert(Reflect.ownKeys(buffer).length===0);rejectedTransfer(buffer);setDetachKey(buffer,undefined);assert(buffer.transfer().byteLength===16);return true;
 });
 check('ordinary-properties-cannot-clear-or-forge-a-native-key',()=>{
  const buffer=seeded();buffer.detachKey='decorative';buffer.kDetachKey=undefined;buffer[Symbol('detach_key_for_untransferable_arraybuffer')]=undefined;
  assert(buffer.transfer().byteLength===16);
  const protectedBuffer=seeded();setDetachKey(protectedBuffer,'real');protectedBuffer.detachKey=undefined;rejectedTransfer(protectedBuffer);return true;
 });
 check('resizable-key-survives-shrink-growth-and-view-revalidation',()=>{
  const buffer=seeded(16,{maxByteLength:256}),view=new Uint8Array(buffer),fixed=new Uint8Array(buffer,8,8);setDetachKey(buffer,'pool');
  buffer.resize(4);collect();assert(view.byteLength===4&&fixed.byteLength===0);rejectedTransfer(buffer);
  buffer.resize(128);collect();assert(view.byteLength===128&&fixed.byteLength===8&&bytes(buffer)[0]===11);rejectedTransfer(buffer,'transferToFixedLength');
  setDetachKey(buffer,undefined);const copy=buffer.transfer();assert(copy.resizable&&copy.maxByteLength===256&&copy.byteLength===128&&view.byteLength===0);return true;
 });
 check('length-coercion-can-protect-before-transfer-checks-the-key',()=>{
  const buffer=seeded();assert(thrown(()=>buffer.transfer({valueOf(){setDetachKey(buffer,'late');return 8}})).name==='TypeError');
  assert(buffer.byteLength===16&&bytes(buffer)[0]===11);return true;
 });
 check('length-coercion-can-clear-before-transfer-checks-the-key',()=>{
  const buffer=seeded();setDetachKey(buffer,'pool');const copy=buffer.transfer({valueOf(){setDetachKey(buffer,undefined);return 8}});
  assert(buffer.byteLength===0&&copy.byteLength===8&&bytes(copy)[0]===11);return true;
 });
 check('serialization-transfer-rejects-protected-fixed-and-resizable-backing',()=>{
  for(const size of [16,1024])for(const resizable of [false,true]){
   const buffer=seeded(size,resizable?{maxByteLength:size*2}:undefined);setDetachKey(buffer,'pool');
   thrown(()=>clone(buffer,[buffer]));assert(buffer.byteLength===size&&bytes(buffer)[0]===11);
   setDetachKey(buffer,undefined);const copy=clone(buffer,[buffer]);assert(copy.byteLength===size&&buffer.byteLength===0&&bytes(copy)[0]===11);
  }return 4;
 });
 check('serialization-copy-keeps-source-key-and-gives-copy-independent-storage',()=>{
  const buffer=seeded();setDetachKey(buffer,'pool');const view=new Uint8Array(buffer),copy=clone(view,[]);
  assert(copy.byteLength===16&&copy[0]===11&&copy.buffer!==buffer);copy[0]=99;assert(view[0]===11);rejectedTransfer(buffer);
  assert(copy.buffer.transfer().byteLength===16);return true;
 });
 check('slice-does-not-inherit-a-source-detach-key',()=>{
  const buffer=seeded();setDetachKey(buffer,'pool');const copy=buffer.slice(0,4);assert(bytes(copy).join(',')==='11,22,33,44');
  assert(copy.transfer().byteLength===4);rejectedTransfer(buffer);return true;
 });
 check('zero-length-key-protects-the-real-detached-state',()=>{
  const buffer=new ArrayBuffer(0);assert(!buffer.detached);setDetachKey(buffer,0);rejectedTransfer(buffer);
  assert(!buffer.detached);setDetachKey(buffer,undefined);const copy=buffer.transfer();assert(buffer.detached&&!copy.detached);return true;
 });
}
