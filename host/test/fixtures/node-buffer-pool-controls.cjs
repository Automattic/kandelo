'use strict';
const assert=require('node:assert/strict'),native=require('node:buffer').Buffer,worker=require('node:worker_threads'),vm=require('node:vm');
const {create}=require('./node-buffer-pool.cjs');
function failure(fn){try{return {value:fn()};}catch(e){return {name:e.name,code:e.code,message:e.message};}}
function snapshot(v){return {bytes:[...v],constructor:v.constructor.name,isBuffer:v instanceof v.constructor,tag:Object.prototype.toString.call(v)};}
const cases={
 constructor(){
  const warnings=[];const {Buffer:B}=create({process:{emitWarning(...v){warnings.push(v);}}});const original=process.emitWarning;let expected=[];process.emitWarning=(...v)=>expected.push(v);
  try{
   for(const v of [0,3,3.5,'abc',[1,258,-1],{type:'Buffer',data:[2,5]},new Uint16Array([257,2])]){
    assert.deepEqual(snapshot(B(v)),snapshot(native(v)));assert.deepEqual(snapshot(new B(v)),snapshot(new native(v)));
   }
   for(const args of [[3,'utf8'],[-1],[NaN],[Infinity],[undefined],[null],[3n]])assert.deepEqual(failure(()=>B(...args)),failure(()=>native(...args)));
   class Child extends B{};class NativeChild extends native{};assert.equal(new Child('x') instanceof Child,new NativeChild('x') instanceof NativeChild);
   assert.deepEqual(warnings,expected);assert.equal(warnings.length,1);assert.equal(B.length,native.length);
  }finally{process.emitWarning=original;}
 },
 metadata(){
  const {Buffer:B,FastBuffer}=create();for(const name of ['prototype','poolSize','allocUnsafe','isBuffer']){const a=Object.getOwnPropertyDescriptor(B,name),b=Object.getOwnPropertyDescriptor(native,name);assert.deepEqual({enumerable:a.enumerable,writable:a.writable,configurable:a.configurable},{enumerable:b.enumerable,writable:b.writable,configurable:b.configurable});}
  assert.equal(B[Symbol.species],FastBuffer);assert.equal(FastBuffer.name,native[Symbol.species].name);assert.equal(FastBuffer.length,native[Symbol.species].length);assert.equal(Object.getPrototypeOf(B),Object.getPrototypeOf(native));
  assert.deepEqual(Reflect.ownKeys(FastBuffer),Reflect.ownKeys(native[Symbol.species]));assert.equal(new FastBuffer(2).constructor,B);assert.equal(B.isBuffer(new Uint8Array(2)),false);
  assert.equal(B.allocUnsafe.name,native.allocUnsafe.name);assert.equal(B.allocUnsafe.length,native.allocUnsafe.length);
 },
 pool(){
  const {Buffer:B}=create();const a=B.allocUnsafe(3),b=B.allocUnsafe(5);assert.equal(a.buffer,b.buffer);assert.equal(b.byteOffset-a.byteOffset,8);assert.equal(worker.isMarkedAsUntransferable(a.buffer),true);
  const large=B.allocUnsafe(B.poolSize>>>1);assert.notEqual(a.buffer,large.buffer);assert.equal(worker.isMarkedAsUntransferable(large.buffer),false);
  const safe=B.alloc(3);assert.notEqual(safe.buffer,a.buffer);assert.deepEqual([...safe],[0,0,0]);
  const slow=B.allocUnsafeSlow(3);assert.notEqual(slow.buffer,a.buffer);assert.equal(worker.isMarkedAsUntransferable(slow.buffer),false);
 },
 strings(){
  const {Buffer:B}=create();const first=B.allocUnsafe(1);
  for(const [text,enc] of [['a💩b','utf8'],['abcd','hex'],['aGVsbG8=','base64'],['\u0100x','utf16le'],['bad input','base64'],['é','latin1']]){const actual=B.from(text,enc);assert.deepEqual([...actual],[...native.from(text,enc)]);assert.equal(actual.buffer,first.buffer);assert.equal(worker.isMarkedAsUntransferable(actual.buffer),true);}
  const copy=B.from([1,2,3]);assert.equal(copy.buffer,first.buffer);assert.deepEqual([...copy],[1,2,3]);
  const source=B.from([9,8,7]);const duplicate=B.from(source);source[0]=0;assert.deepEqual([...duplicate],[9,8,7]);
  const foreign=vm.runInNewContext('new Uint16Array([257, 258])');assert.deepEqual([...B.from(foreign)],[...native.from(foreign)]);assert.equal(B.copyBytesFrom(new Uint16Array([257])).buffer,first.buffer);
 },
 rollover(){
  function rollover(C){const previous=C.poolSize;try{C.poolSize=128;const first=C.allocUnsafe(8);let different;for(let i=0;i<10000;i++){const b=C.allocUnsafe(8);if(b.buffer!==first.buffer){different=b;break;}}assert(different);const next=C.allocUnsafe(8);assert.equal(next.buffer,different.buffer);return {capacity:different.buffer.byteLength,marked:worker.isMarkedAsUntransferable(different.buffer),nextDelta:next.byteOffset-different.byteOffset};}finally{C.poolSize=previous;}}
  assert.deepEqual(rollover(create().Buffer),rollover(native));
 },
 alignment(){
  const {Buffer:B,native:backend}=create();for(const size of [0,1,7,64,65,50000])for(const alignment of [1,2,8,16,64,128,4096]){const a=B.allocUnsafe(size,alignment),b=native.allocUnsafe(size,alignment);assert.equal(a.length,b.length);if(size)assert.equal(backend.arrayBufferAlignedOffset(a.buffer,alignment),a.byteOffset%alignment);}
  for(const args of [[1,0],[1,3],[1,'4'],[1,Infinity],[-1,8]])assert.deepEqual(failure(()=>B.allocUnsafe(...args)),failure(()=>native.allocUnsafe(...args)));
 },
 transfer(){
  const {Buffer:B}=create();const p=B.from('abc'),before=p.buffer.byteLength,other=new ArrayBuffer(5);
  const error=failure(()=>structuredClone({p},{transfer:[other,p.buffer]}));const ref=native.from('abc'),expected=failure(()=>structuredClone({p:ref},{transfer:[new ArrayBuffer(5),ref.buffer]}));assert.deepEqual(error,expected);assert.equal(other.byteLength,5);assert.equal(p.buffer.byteLength,before);assert.equal(p.toString(),'abc');
  assert.equal(failure(()=>p.buffer.transfer()).name,failure(()=>ref.buffer.transfer()).name);assert.equal(p.toString(),'abc');assert.deepEqual([...structuredClone(p)],[97,98,99]);
  const slow=B.allocUnsafeSlow(4);slow.fill(7);const moved=structuredClone(slow,{transfer:[slow.buffer]});assert.equal(slow.byteLength,0);assert.deepEqual([...moved],[7,7,7,7]);
 },
 warnings(){
  for(const pending of [false,true]){const calls=[];const owner={emitWarning(...v){calls.push(v);}};const {Buffer:B}=create({pending,process:owner,isInsideNodeModules:()=>true});B('a');B('b');assert.equal(calls.length,pending?1:0);}
  let attempts=0;const {Buffer:B}=create({process:{emitWarning(){if(++attempts===1)throw Error('warning failure');}}});assert.throws(()=>B('a'),/warning failure/);B('b');B('c');assert.equal(attempts,2);
 },
};
const name=process.argv[2];if(!cases[name])throw Error('Unknown case '+name);cases[name]();console.log(JSON.stringify({name,status:'pass',scope:'Actual constructor/pool/codec/bytes source over pinned native storage, alignment, detach-key/transfer, error and process/warning dependencies; guest engine binding/CLI/GC/four-host not executed.'}));
