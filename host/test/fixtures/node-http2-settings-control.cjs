'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),native=require('node:http2');
assert.equal(process.version,'v26.13.0');
const {api:candidate,Buffer:CandidateBuffer}=require('./node-http2-settings-platform.cjs').create();
const NativeBuffer=Buffer;
function normalize(value){
 if(value instanceof Uint8Array)return {bytes:NativeBuffer.from(value).toString('hex'),length:value.length,offset:value.byteOffset,backing:value.buffer.byteLength};
 if(typeof value==='symbol')return {symbol:value.description,global:Symbol.keyFor(value)};
 if(value&&typeof value==='object')return {prototype:Object.getPrototypeOf(value)===null?'null':'Object',entries:Reflect.ownKeys(value).map(k=>[String(k),normalize(value[k])])};
 if(typeof value==='number'&&Number.isNaN(value))return 'NaN';return value;
}
function outcome(fn){try{return {value:normalize(fn())}}catch(e){return {error:{name:e.name,code:e.code,message:e.message,own:Reflect.ownKeys(e).filter(k=>!['stack','message','name','code'].includes(k)).map(k=>[String(k),normalize(e[k])])}}}}
const cases=[];function pack(name,build){cases.push([name,api=>api.getPackedSettings(build(api))])}function unpack(name,build,options){cases.push([name,api=>api.getUnpackedSettings(build(),options)])}
cases.push(['defaults',api=>api.getDefaultSettings()]);cases.push(['fresh-default-owner',api=>{const a=api.getDefaultSettings();a.headerTableSize=1;return {same:a===api.getDefaultSettings(),next:api.getDefaultSettings()}}]);
for(const[key,values]of Object.entries({headerTableSize:[0,1.9,NaN,0xffffffff,-1,2**32,'1',null],initialWindowSize:[0,2**31-1,2**31,NaN],maxFrameSize:[16384,16383,2**24-1,2**24,NaN,16384.9],maxConcurrentStreams:[0,0xffffffff,NaN,-1],maxHeaderListSize:[0,0xffffffff,NaN],enablePush:[true,false,0,null],enableConnectProtocol:[true,false,'true']}))for(const value of values)pack(key+':'+String(value),()=>({[key]:value}));
for(const input of [undefined,null,1,'',[],()=>{},new Date(0)])pack('input:'+String(input),()=>input);
for(const map of [{'0':1},{'1':1},{'2':7},{'3':16384},{'4':32},{'5':100},{'6':1},{'8':1},{'9':1},{'9':2},{'10':0},{'10':1},{'10.5':1},{'65535':0xffffffff},{'65536':1},{'-1':1},{no:1},{'22':NaN},{'20':'1'},null])pack('custom:'+JSON.stringify(map),()=>({customSettings:map}));
pack('too-many-custom',()=>({customSettings:Object.fromEntries(Array.from({length:11},(_,i)=>[i+20,i+1]))}));
pack('inherited-custom',()=>({customSettings:Object.assign(Object.create({'20':2}),{'21':3})}));
pack('own-getter-reentry',api=>{const object={};Object.defineProperty(object,'headerTableSize',{enumerable:true,get(){api.getDefaultSettings();return 15}});return object});
pack('spread-and-inherited',()=>Object.assign(Object.create({headerTableSize:100}),{enablePush:true}));
pack('custom-key-getter-reentry',api=>({customSettings:Object.defineProperty({},'20',{enumerable:true,get(){api.getDefaultSettings();return 30}})}));
const valid=NativeBuffer.from('0001000000640002000000010003000000c8000400000064000500004e20000600000064000800000000','hex');
unpack('unpack-empty',()=>new Uint8Array());unpack('unpack-buffer',()=>valid);unpack('unpack-u16-element-interpretation',()=>new Uint16Array([...valid]));unpack('unpack-float-element-interpretation',()=>new Float64Array([...valid]));unpack('unpack-subarray-offset',()=>new Uint8Array([9,...valid,8]).subarray(1,valid.length+1));
unpack('unpack-unknown-and-duplicate',()=>NativeBuffer.from('002000000001000100000002000100000003','hex'));
unpack('unpack-invalid-size',()=>valid.subarray(1));unpack('unpack-dataview',()=>new DataView(valid.buffer));unpack('unpack-object',()=>({length:0}));unpack('unpack-proxy',()=>new Proxy(valid,{}));unpack('unpack-bigint',()=>new BigUint64Array(6));
unpack('unpack-invalid-frame-no-validate',()=>NativeBuffer.from('000501000000','hex'));unpack('unpack-invalid-frame-validate',()=>NativeBuffer.from('000501000000','hex'),{validate:true});unpack('unpack-boolean-nonzero',()=>NativeBuffer.from('000200000064000800000064','hex'),{validate:true});
unpack('unpack-detached',()=>{const a=new Uint8Array(6);structuredClone(a.buffer,{transfer:[a.buffer]});return a});unpack('unpack-foreign-realm',()=>vm.runInNewContext('new Uint8Array([0,1,0,0,0,7])'));
cases.push(['warning-reentry',api=>{
 const saved=process.emitWarning,seen=[];
 process.emitWarning=function(message,...args){seen.push(String(message));api.getDefaultSettings();return undefined};
 try{return {packed:api.getPackedSettings({headerTableSize:17,maxHeaderSize:123}),warnings:seen}}finally{process.emitWarning=saved}
}]);
cases.push(['getter-order',api=>{
 const seen=[],settings={};
 for(const name of ['customSettings','headerTableSize','enablePush','initialWindowSize','maxFrameSize','maxConcurrentStreams','maxHeaderListSize','maxHeaderSize','enableConnectProtocol'])Object.defineProperty(settings,name,{enumerable:true,get(){seen.push(name);return name==='headerTableSize'?11:undefined}});
 return {packed:api.getPackedSettings(settings),seen};
}]);
const results=[];
for(const[name,fn]of cases){const expected=outcome(()=>fn(native)),actual=outcome(()=>fn(candidate));try{assert.deepEqual(actual,expected);results.push({name,status:'pass'})}catch(e){results.push({name,status:'fail',expected,actual,error:e.message})}}
function descriptorShape(api){return {constants:Object.getOwnPropertyDescriptors(api.constants),prototype:Object.getPrototypeOf(api.constants)===Object.prototype,extensible:Object.isExtensible(api.constants),module:Object.fromEntries(['constants','getDefaultSettings','getPackedSettings','getUnpackedSettings','sensitiveHeaders'].map(name=>{const d=Object.getOwnPropertyDescriptor(api,name);return[name,{enumerable:d.enumerable,writable:d.writable,configurable:d.configurable,name:typeof d.value==='function'?d.value.name:undefined,length:typeof d.value==='function'?d.value.length:undefined,symbol:typeof d.value==='symbol'?d.value.description:undefined}]}))}}
try{assert.deepEqual(descriptorShape(candidate),descriptorShape(native));results.push({name:'all-constants-and-implemented-export-descriptors',status:'pass'})}catch(e){results.push({name:'all-constants-and-implemented-export-descriptors',status:'fail',error:e.message})}
for(const[api,Buf,label]of[[native,NativeBuffer,'native'],[candidate,CandidateBuffer,'candidate']]){
 const original={};for(const name of ['readUInt16BE','readUInt32BE','writeUInt16BE','writeUInt32BE']){original[name]=Buf.prototype[name];Buf.prototype[name]=()=>{throw Error('public Buffer numeric method poisoned')}}
 try{assert.equal(NativeBuffer.from(api.getPackedSettings({headerTableSize:1})).toString('hex'),'000100000001');assert.equal(api.getUnpackedSettings(valid).headerTableSize,100);results.push({name:'private-buffer-numeric-owner:'+label,status:'pass'})}catch(e){results.push({name:'private-buffer-numeric-owner:'+label,status:'fail',error:e.message})}finally{Object.assign(Buf.prototype,original)}
}
const report={scope:'Actual candidate HTTP2 settings, Buffer and Error algorithms over explicit native memory/type/process boundaries; no candidate native HTTP2/session binding, no guest/four-host execution',constants:Reflect.ownKeys(candidate.constants).length,results,pass:results.filter(r=>r.status==='pass').length,fail:results.filter(r=>r.status==='fail').length,globalSetup:0,overallSuites:0};console.log(JSON.stringify(report));if(report.fail)process.exitCode=1;
