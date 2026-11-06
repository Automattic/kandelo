'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const make=Function(fs.readFileSync(path.resolve(__dirname,'../../third_party/node-core/node-core.js'),'utf8')+';return _createNodeValuesPlatform;')();
const values=make({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
// Exercise actual pinned Stats lazy getters over real native stat records.
// Native allocation/stat syscalls remain explicit dependency boundaries.
const {internalBinding}=require('internal/test/binding');
const nativeStats=require('internal/fs/utils');
const makeStats=Function(fs.readFileSync(path.resolve(__dirname,'../../third_party/node-core/node-core.js'),'utf8')+';return _createNodeFsStats;')();
const stats=makeStats({fs,process,Buffer,types:util.types,values,
 truncation:{vfsState:{handlers:null},FSReqCallback:internalBinding('fs').FSReqCallback},native:{},
 permissionEnabled:()=>false,toPathIfFileURL:input=>input});
for(const bigint of [false,true]){
 const record=internalBinding('fs').stat(__filename,bigint,undefined,true);
 const input=bigint?BigInt64Array.from(record):Float64Array.from(record);
 const actual=stats.getStatsFromBinding(input),expected=nativeStats.getStatsFromBinding(input);
 for(const field of ['atime','mtime','ctime','birthtime']){
  const first=actual[field],nativeFirst=expected[field];
  assert(first instanceof Date,`${bigint?'BigInt':'Number'} Stats ${field} must return Date on first access`);
  assert.equal(first.getTime(),nativeFirst.getTime());assert.equal(actual[field],first);
  const descriptor=Object.getOwnPropertyDescriptor(actual,field);
  assert.deepEqual(descriptor,{value:first,writable:true,enumerable:true,configurable:true});
 }
 console.log(JSON.stringify({stats:bigint?'BigInt':'Number',firstDates:4,cachedIdentity:true,ownDescriptors:true}));
}
for(const [name,set]of[['native',require('internal/util').setOwnProperty],['candidate',values.util.setOwnProperty]]){
 let inherited=0;const object=Object.create({set field(value){inherited++;}}),value={sentinel:true};
 assert.equal(set(object,'field',value),value);assert.equal(inherited,0);
 assert.deepEqual(Object.getOwnPropertyDescriptor(object,'field'),{value,writable:true,enumerable:true,configurable:true});
 const failure={sentinel:'define-failed'};const proxy=new Proxy({}, {defineProperty(){throw failure;}});
 assert.throws(()=>set(proxy,'field',value),error=>error===failure);
 assert.throws(()=>set(Object.preventExtensions({}),'field',value),TypeError);
 console.log(JSON.stringify({name,returnedIdentity:true,ownDescriptor:true,inheritedSetters:inherited,originalThrow:true}));
}
