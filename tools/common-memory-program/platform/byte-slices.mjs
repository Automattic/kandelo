// VM-05 private-profile experiment. The realm boots with standard intrinsics.
// Afterwards, observable lookups/conversions run normally and modified
// iteration/memory primitives fall back to the existing from(subarray) path.
export function installByteSlices({VirtualTypedView,VirtualBuffer,VirtualMemory},diagnostics=false) {
 const apply=Reflect.apply,descriptor=Object.getOwnPropertyDescriptor,prototype=Object.getPrototypeOf;
 const iterator=Symbol.iterator;
 const own=Object.prototype.hasOwnProperty,realm=globalThis;
 const get=WeakMap.prototype.get,set=WeakMap.prototype.set;
 const views=new WeakMap(),buffers=new WeakMap(),memories=new WeakMap(),groups=new WeakMap(),backings=new WeakMap();
 const lookup=(map,key)=>apply(get,map,[key]),save=(map,key,value)=>apply(set,map,[key,value]);
 const has=(object,key)=>apply(own,object,[key]);
 const dataIs=(object,key,value)=>{const d=descriptor(object,key);return !!d&&has(d,'value')&&d.value===value;};
 const data=(object,key)=>{const d=descriptor(object,key);return d&&has(d,'value')?d:null;};
 const absent=(object,key)=>descriptor(object,key)===undefined;
 const vp=VirtualTypedView.prototype,mp=VirtualMemory.prototype,bp=VirtualBuffer.prototype;
 const U8=Uint8Array,I8=Int8Array,C8=Uint8ClampedArray,U32=Uint32Array;
 const typed=prototype(U8.prototype),from=prototype(U8).from;
 const nativeBuffer=descriptor(WebAssembly.Memory.prototype,'buffer').get;
 const wasmPrototype=WebAssembly.Memory.prototype;
 const typedBuffer=descriptor(typed,'buffer').get;
 const read=mp.read,subarray=vp.subarray;
 const checks=[];
 function remember(object,key) {checks[checks.length]={object,key,expected:descriptor(object,key)};}
 function sameProperty({object,key,expected}) {
  const actual=descriptor(object,key);
  if(!actual||!expected)return actual===expected;
  const isData=has(expected,'value');
  if(has(actual,'value')!==isData||actual.enumerable!==expected.enumerable||actual.configurable!==expected.configurable)return false;
  return isData?actual.value===expected.value&&actual.writable===expected.writable:
   actual.get===expected.get&&actual.set===expected.set;
 }
 for(const key of ['Uint8Array','Uint32Array','Number','String','Math'])remember(realm,key);
 for(const key of ['isSafeInteger','isInteger'])remember(Number,key);
 remember(Reflect,'get');remember(realm,'Reflect');
 remember(Math,'floor');remember(Math,'min');
 for(const key of ['at','push',Symbol.iterator])remember(Array.prototype,key);
 const arrayIterator=prototype([][Symbol.iterator]());remember(arrayIterator,'next');
 for(const key of ['element','values',Symbol.iterator])remember(vp,key);
 for(const key of ['spans','table','maximumPages'])remember(mp,key);
 remember(wasmPrototype,'buffer');remember(typed,'set');
 remember(U8.prototype,'set');remember(vp.values,'prototype');
 const generator=vp.values.prototype,generatorPrototype=prototype(generator);
 for(const key of ['next','return']){remember(generator,key);remember(generatorPrototype,key);}
 const counters=diagnostics?{bulk:0,fallback:0}:null;
 const fieldKeys=['constructor','buffer','byteOffset','length','byteLength','BYTES_PER_ELEMENT'];
 const viewHooks=['element','values',iterator],memoryHooks=['spans','table','maximumPages'];
 function pristine(Ctor,method,sub,calledSubarray) {
  const state=lookup(views,sub);
  if(!state||method!==from||calledSubarray!==subarray||state.kind!==(Ctor===U8?1:Ctor===I8?2:Ctor===C8?3:0)||state.width!==1||state.length<256||
    (Ctor!==U8&&Ctor!==I8&&Ctor!==C8))return null;
  if(prototype(state.target)!==vp)return null;
  const bufferProperty=data(state.target,'buffer');if(!bufferProperty)return null;
  const bufferObject=bufferProperty.value,buffer=lookup(buffers,bufferObject);
  if(!buffer||buffer!==state.bufferToken||!buffer.memoryToken||prototype(bufferObject)!==bp||
    !dataIs(bufferObject,'byteLength',buffer.length))return null;
  for(let i=0;i<fieldKeys.length;i++) {
   const key=fieldKeys[i];
   const want=key==='constructor'?Ctor:key==='buffer'?bufferObject:key==='byteOffset'?state.offset:
    key==='BYTES_PER_ELEMENT'?1:state.length;
   if(!dataIs(state.target,key,want))return null;
  }
  for(let i=0;i<viewHooks.length;i++)if(!absent(state.target,viewHooks[i]))return null;
  const memoryProperty=data(bufferObject,'memory');if(!memoryProperty)return null;
  const memoryObject=memoryProperty.value,memory=lookup(memories,memoryObject);
  if(!memory||memory!==buffer.memoryToken||!memory.groupToken||prototype(memoryObject)!==mp||
    !dataIs(memoryObject,'root',memory.root))return null;
  for(let i=0;i<memoryHooks.length;i++)if(!absent(memoryObject,memoryHooks[i]))return null;
  const groupProperty=data(memoryObject,'group');if(!groupProperty)return null;
  const groupObject=groupProperty.value,group=lookup(groups,groupObject);
  if(!group||group!==memory.groupToken)return null;
  const backingProperty=data(groupObject,'memory');if(!backingProperty)return null;
  const backing=backingProperty.value;
  if(!group.backingToken||lookup(backings,backing)!==group.backingToken)return null;
  // Intrinsic brand check runs before inspecting a possibly user-proxied
  // supplied backing. It invokes no user getter or Proxy trap.
  try {apply(nativeBuffer,backing,[]);}catch{return null;}
  if(prototype(backing)!==wasmPrototype||!absent(backing,'buffer')||
    prototype(U8.prototype)!==typed||prototype(generator)!==generatorPrototype)return null;
  for(let i=0;i<checks.length;i++)if(!sameProperty(checks[i]))return null;
  return {state,buffer,memory:memoryObject};
 }
 const previous=descriptor(vp,'slice');
 const implementation={slice(start,end) {
  // Preserve the original reference/call order, including non-callable from
  // values and all subarray argument-conversion and constructor side effects.
  const Ctor=this.constructor,method=Ctor.from,calledSubarray=this.subarray;
  const sub=apply(calledSubarray,this,[start,end]);
  const admitted=pristine(Ctor,method,sub,calledSubarray);
  if(!admitted){if(counters)counters.fallback++;return apply(method,Ctor,[sub]);}
  const {state,buffer,memory}=admitted;
  if(counters)counters.bulk++;
  // Call the captured read body, not a public read override the old slice
  // never used. Its dynamic spans/table/primitives were checked above.
  const bytes=apply(read,memory,[state.offset,state.length,buffer.length]);
  return Ctor===U8?bytes:new Ctor(apply(typedBuffer,bytes,[]));
 }}.slice;
 Object.defineProperty(vp,'slice',{...previous,value:implementation});
 return {
  // Tokens contain no original backing/buffer/memory references. Replacing a
  // configurable public field must not pin the old address space via brands.
  view:(proxy,target,Ctor,buffer,offset,length,width)=>save(views,proxy,{target,
   kind:Ctor===U8?1:Ctor===I8?2:Ctor===C8?3:0,bufferToken:lookup(buffers,buffer),offset,length,width}),
  buffer:(target,memory,length)=>save(buffers,target,{memoryToken:lookup(memories,memory),length}),
  memory:(target,group,root)=>save(memories,target,{groupToken:lookup(groups,group),root}),
  group:(target,memory)=>{let token=lookup(backings,memory);if(!token){token={};save(backings,memory,token);}save(groups,target,{backingToken:token});},
  stats:()=>counters?{...counters}:null,
 };
}
