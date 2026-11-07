'use strict';
const fs=require('node:fs'),vm=require('node:vm');
const mode=process.argv[2],file=process.argv[3],fast=process.argv[4]==='fast';
const NativeDecoder=globalThis.TextDecoder;let Decoder=NativeDecoder;
if(mode!=='native'){
 const source=fs.readFileSync(file,'utf8'),a=source.indexOf('function _nodeBufferSourceBytes('),b=source.indexOf('// Some JavaScript engine parsers',a);
 if(a<0||b<a)throw Error('Missing exact production decoder selection');
 const nativeDecoder=new NativeDecoder('utf-8',{ignoreBOM:true});
 const context=vm.createContext({TextDecoder:undefined,_nodeNative:fast?{decodeUtf8(bytes){return nativeDecoder.decode(bytes)}}:{},_bufferIsUtf8:require('node:buffer').isUtf8});
 Decoder=vm.runInContext(source.slice(a,b)+';TextDecoder;',context);
}
const bytes=value=>new Uint8Array(value),empty=()=>bytes([]),bomB=()=>bytes([239,187,191,66]);
function thrown(fn){try{return{value:fn()}}catch(error){return{error:{name:error.name,code:error.code,message:error.message}}}}
function sequence(name,{clear=true,outerStream=true,ignoreBOM=false,throws=false,nestedFatal=false,prior=true,singleFlush=false}={}){
 const d=new Decoder('utf-8',{fatal:true,ignoreBOM});
 if(prior)d.decode(bytes([65]),{stream:true});else d.decode(empty(),{stream:true});
 let getterCalls=0,innerErrors=[];const original=Object.freeze({original:name});let sameThrown=false;
 let result;
 try{result={value:d.decode(bytes([255]),{get stream(){
  getterCalls++;
  if(nestedFatal)innerErrors.push(thrown(()=>d.decode(bytes([255]),{stream:true})));
  if(clear){d.decode();if(!singleFlush)d.decode(empty(),{stream:true});}
  else d.decode(bytes([65]),{stream:true});
  if(throws)throw original;
  return outerStream;
 }})};}catch(error){sameThrown=error===original;result={error:throws?'original':{name:error.name,code:error.code,message:error.message}};}
 return{name,getterCalls,result,sameThrown,innerErrors,recovery:thrown(()=>d.decode(bomB(),{stream:true})),flush:thrown(()=>d.decode())};
}
const rows=[
 sequence('getter-clears-bom-new-regression'),
 sequence('single-inner-flush-deferred-reset-gap',{singleFlush:true}),
 sequence('getter-clears-bom-nonstream-policy',{outerStream:false}),
 sequence('getter-clears-bom-ignoreBOM-policy',{ignoreBOM:true}),
 sequence('getter-throws-preserves-original-and-inner-state',{throws:true}),
 sequence('getter-clears-after-nested-fatal',{nestedFatal:true}),
 sequence('getter-establishes-bom-preexisting-baseline-gap',{clear:false,prior:false}),
 sequence('getter-establishes-then-throws-original',{clear:false,throws:true,prior:false}),
];
{const d=new Decoder('utf-8',{fatal:true});const start=d.decode(bytes([65]),{stream:true}),failure=thrown(()=>d.decode(bytes([255]),{stream:true})),recovery=d.decode(bomB(),{stream:true});rows.push({name:'ordinary-existing-fatal-stream-policy',start,failure,recovery});}
console.log(JSON.stringify(rows));
