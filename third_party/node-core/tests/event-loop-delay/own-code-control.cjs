'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const {primordials}=require('internal/test/binding');
const root=path.resolve(__dirname,'../..');
let source=fs.readFileSync(process.env.ELD_ADAPTER_CONTROL_FILE || path.join(root,'event-loop-delay-platform-adapter.js'),'utf8');
source=source.replace('/* NODE_EVENT_LOOP_DELAY_PUBLIC_WRAPPER */','module.exports = function() {};');
const create=vm.runInThisContext(`(function(_createNodePrimordials){${source};return _createNodeEventLoopDelayPlatform;})`)(()=>primordials);
let setterCalls=0;const old=Object.getOwnPropertyDescriptor(Error.prototype,'code');
Object.defineProperty(Error.prototype,'code',{configurable:true,set(){setterCalls++;}});
try {
 for(const name of ['Error','RangeError','TypeError']) {
  const code=name==='RangeError'?'ERR_OUT_OF_RANGE':'ERR_INVALID_ARG_VALUE';
  const api=create({native:{eventLoopDelayOperation(){return {error:{name,code,message:'owned native error'}};}},histogram:{binding:{Histogram:class{}}}});
  let caught;try{api.binding.createELDHistogram(1,false,1,100,2);}catch(e){caught=e;}
  assert(caught instanceof globalThis[name]);assert.equal(caught.message,'owned native error');
  assert.deepEqual(Object.getOwnPropertyDescriptor(caught,'code'),{value:code,writable:true,enumerable:true,configurable:true});
 }
 assert.equal(setterCalls,0);
}finally{if(old)Object.defineProperty(Error.prototype,'code',old);else delete Error.prototype.code;}
console.log('3 ELD native-packet error classes keep own coded-error properties under inherited setter poisoning; adapter dependency control only');
