'use strict';
// Current production factories/actual bootstrap style installation over native
// stream/color/TTY/argv/Error/V8 lazy DATA boundaries, not guest acceptance.
const assert=require('node:assert/strict'),native=require('node:util'),vm=require('node:vm');
assert.equal(process.version,'v26.13.0');
const create=require('./node-util-algorithms.cjs').create;
const rows=[];const error=fn=>{try{return {value:fn()};}catch(e){return{name:e.name,code:e.code,message:e.message};}};
function compare(name,fn){const expected=fn(native),actual=fn(create());assert.deepEqual(actual,expected,name);rows.push({name,result:actual});}
const descriptor=(target,key)=>{const d=Object.getOwnPropertyDescriptor(target,key);return d&&{keys:Object.keys(d),writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,valueType:typeof d.value,name:d.value?.name,length:d.value?.length};};
const mode=process.argv[2]||'ordinary';
if(mode==='stdio'){
 compare('genuine current stdout color policy',api=>({tty:process.stdout.isTTY===true,depth:process.stdout.getColorDepth?.(),forced:process.env.FORCE_COLOR??null,style:api.styleText(['red','bold'],'colored'),hex:api.styleText('#a1B','colored'),disabled:api.styleText('red','colored',{validateStream:false})}));
}else{
 for(const key of ['parseArgs','diff']){
  compare(key+' native data descriptor',api=>descriptor(api,key));
  compare(key+' inherited get retains actual holder',api=>{const child=Object.create(api);const value=child[key];return{childOwn:Object.hasOwn(child,key),same:value===api[key],descriptor:descriptor(api,key)};});
  compare(key+' inherited assignment',api=>{const child=Object.create(api);child[key]=19;return{childOwn:Object.hasOwn(child,key),childValue:child[key],parentType:typeof api[key]};});
  // Each native operation gets its own actual native DATA holder as below;
  // never mutate the canonical native util namespace used by other controls.
 }
 const referenceCreate=()=>{
  const {defineNativeLazyDataProperty}=require(process.env.NODE_UTIL_LAZY_REFERENCE_BINDING);
  const target={};for(const name of ['inspect','debounce','throttle','styleText'])Object.defineProperty(target,name,Object.getOwnPropertyDescriptor(native,name));for(const key of ['parseArgs','diff'])defineNativeLazyDataProperty(target,key,(id,name)=>native[name],null,7);return target;
 };
 for(const op of ['seal','freeze','preventExtensions']){
  for(const key of ['parseArgs','diff']){
   const observe=target=>{Object[op](target);const before={sealed:Object.isSealed(target),frozen:Object.isFrozen(target),keys:Object.keys(target).filter(k=>k===key)};const value=Reflect.get(target,key);return{before,name:value.name,after:descriptor(target,key)};};
   const expected=observe(referenceCreate()),actual=observe(create());assert.deepEqual(actual,expected,op+' '+key);rows.push({name:op+' '+key,result:actual});
  }
 }
 compare('parseArgs real argv and immutable eval option',api=>api.parseArgs({strict:false,tokens:true}));
 compare('parseArgs full tokens negative/multiple/default semantics',api=>api.parseArgs({args:['--no-color','--color','-v','-v','--name=x','--','-tail'],options:{color:{type:'boolean',default:true},verbose:{type:'boolean',short:'v',multiple:true},name:{type:'string'}},allowNegative:true,allowPositionals:true,tokens:true}));
 compare('styleText exact ANSI cache/nesting/hex algorithms',api=>[['red','bold'],['dim','bold'],['underline','red'],'none','#a1B','#A1b2C3'].map(format=>api.styleText(format,'a\u001b[22mb\u001b[39mc',{validateStream:false})));
 compare('styleText invalid options/format/text and error order',api=>[[undefined,'x'],['red',null],['missing','x'],['#ab','x'],['red','x',null],['red','x',false],['red','x',{validateStream:3}],['red','x',{stream:{}}],[[Symbol('style')],'x'],[1,'x'],[{},'x'],['red',Symbol('text')]].map(args=>error(()=>api.styleText(...args))));
 compare('styleText real Writable color-depth and no-color policy',api=>{const {Writable}=require('node:stream');const sink=new Writable({write(c,e,cb){cb();}});const out=[];try{for(const enabled of [false,true])for(const depth of [1,4,8,24]){sink.isTTY=enabled;sink.getColorDepth=()=>depth;out.push([enabled,depth,api.styleText(['red','bold'],'value',{stream:sink}),api.styleText('#abc','value',{stream:sink})]);}}finally{sink.destroy();}return out;});
 compare('styleText actual Web stream admission',api=>{const {ReadableStream,WritableStream}=require('node:stream/web');return[new ReadableStream({start(c){c.close();}}),new WritableStream()].map(stream=>api.styleText('red','value',{stream}));});
 compare('styleText callable metadata/descriptor',api=>descriptor(api,'styleText'));
 for(const [key,args] of [['parseArgs',[{args:['--x=one'],strict:false}]],['diff',['abc','adc']]]){
  const api=create(),expected=native[key](...args),foreign=vm.runInNewContext('target[key](...args)',{target:api,key,args});assert.deepEqual(foreign,expected);rows.push({name:key+' genuine foreign realm holder use',result:foreign});
 }
}
console.log(JSON.stringify({mode,rows}));
