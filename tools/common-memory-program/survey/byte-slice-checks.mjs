import {ProgramGroup,PAGE} from '../runtime.mjs';
const must=(ok,message)=>{if(!ok)throw Error(message);};
const define=Object.defineProperty,desc=Object.getOwnPropertyDescriptor,apply=Reflect.apply;
const nativeFrom=Uint8Array.from;
function state(api) {
 const owner=new ProgramGroup({initialPages:128,maximumPages:128,scratchBytes:PAGE});
 const group=new api.VirtualGroup(owner.memory,{maximumPages:128,scratchBytes:PAGE});
 const memory=group.create(4,16),view=api.vmConstruct(Uint8Array,memory.buffer,128,2048);
 const bytes=new Uint8Array(4*PAGE);for(let i=0;i<bytes.length;i++)bytes[i]=(i*17+Math.floor(i/PAGE)*97)&255;
 memory.write(0,bytes,memory.buffer.byteLength);
 return {api,owner,group,memory,view};
}
function outcome(action) {
 try {const value=action();return {value};}catch(error){return {error:{name:error.name,message:error.message}};}
}
function plain(result) {
 if(result.error)return result;
 const value=result.value;
 return {value:ArrayBuffer.isView(value)?{type:value.constructor.name,values:Array.from(value)}:value};
}
export function runByteSliceChecks(baseline,candidate) {
 const states=[state(baseline),state(candidate)],checks=[],results=[];
 function pair(name,action,{bulk}={}) {
  const before=candidate.vmByteSliceStats();
  const left=plain(outcome(()=>action(states[0]))),right=plain(outcome(()=>action(states[1])));
  must(JSON.stringify(left)===JSON.stringify(right),name+' baseline/candidate mismatch');
  const after=candidate.vmByteSliceStats();
  if(bulk!==undefined)must((after.bulk-before.bulk>0)===bulk,name+' wrong branch');
  checks.push(name);results.push({name,error:right.error??null,bulk:after.bulk-before.bulk,fallback:after.fallback-before.fallback});
 }
 for(const Ctor of [Uint8Array,Int8Array,Uint8ClampedArray]) {
  pair(Ctor.name+' whole',s=>s.api.vmConstruct(Ctor,s.memory.buffer,128,2048).slice(),{bulk:true});
  pair(Ctor.name+' negative/clipped',s=>s.api.vmConstruct(Ctor,s.memory.buffer,128,2048).slice(-1024,99999),{bulk:true});
  pair(Ctor.name+' small',s=>s.api.vmConstruct(Ctor,s.memory.buffer,128,2048).slice(1,17),{bulk:false});
  pair(Ctor.name+' empty',s=>s.api.vmConstruct(Ctor,s.memory.buffer,128,2048).slice(100,1),{bulk:false});
 }
 pair('independent output',s=>{
  const out=s.view.slice(0,512),old=out[0],source=s.view[0];
  s.view[0]=source^255;must(out[0]===old,'copy aliases source');out[1]^=255;
  must(s.view[1]!==out[1],'source aliases copy');s.view[0]=source;
  must(!(out.buffer instanceof SharedArrayBuffer),'output retains shared backing');return true;
 },{bulk:true});
 pair('wide typed fallback',s=>s.api.vmConstruct(Uint16Array,s.memory.buffer,128,1024).slice(0,512),{bulk:false});
 pair('contiguous cross-page',s=>s.api.vmConstruct(Uint8Array,s.memory.buffer,PAGE-128,512).slice(),{bulk:true});
 for(const s of states){const physical=s.group.allocate(1);s.memory.table()[1]=physical|3;s.memory.write(PAGE,new Uint8Array(PAGE).fill(73),4*PAGE);}
 pair('scattered cross-page',s=>s.api.vmConstruct(Uint8Array,s.memory.buffer,PAGE-128,512).slice(),{bulk:true});
 for(const s of states)s.memory.table()[2]=s.memory.table()[0];
 pair('aliased backing pages',s=>s.api.vmConstruct(Uint8Array,s.memory.buffer,2*PAGE+128,512).slice(),{bulk:true});
 for(const s of states)s.api.vmCommitMapping(s.memory,PAGE,PAGE,0);
 pair('denied later page',s=>s.api.vmConstruct(Uint8Array,s.memory.buffer,PAGE-128,512).slice(),{bulk:true});
 for(const s of states)s.api.vmCommitMapping(s.memory,PAGE,PAGE,3);
 pair('stale view after growth',s=>{const old=s.memory.buffer;s.memory.grow(1);return s.api.vmConstruct(Uint8Array,old,old.byteLength-512,512).slice();},{bulk:true});
 pair('constructor/from/argument lookup order',s=>{
  const events=[],log=x=>{events[events.length]=x;};
  const original=desc(Uint8Array,'from');define(Uint8Array,'from',{configurable:true,get(){log('from');return nativeFrom;}});
  define(s.view,'constructor',{configurable:true,get(){log('constructor');return Uint8Array;}});
  let result;
  try {result=s.view.slice({valueOf(){log('start');return 0;}},{valueOf(){log('end');return 512;}});}
  finally{original?define(Uint8Array,'from',original):delete Uint8Array.from;define(s.view,'constructor',{value:Uint8Array,configurable:true});}
  return {events,values:Array.from(result)};
 },{bulk:true});
 function hook(name,install,{bulk=false}={}) {
  pair(name,s=>{
   const events=[],log=x=>{events[events.length]=x;};
   const restore=install(s,log);let result;
   try {result=outcome(()=>s.view.slice(0,512));}finally{restore();}
   must(events.length>0,name+' hook was not observed');return {events,result:plain(result)};
  },{bulk});
 }
 function replace(object,key,value) {const old=desc(object,key);define(object,key,{value,writable:true,configurable:true});return ()=>old?define(object,key,old):delete object[key];}
 hook('custom from receiver',(_s,log)=>replace(Uint8Array,'from',function(view){log(this===Uint8Array?'from receiver':'wrong receiver');return apply(nativeFrom,this,[view]);}));
 hook('custom subarray', (s,log)=>{const original=s.view.subarray;return replace(s.view,'subarray',function(...args){log('subarray');return apply(original,this,args);});});
 hook('custom iterator',(s,log)=>{const p=Object.getPrototypeOf(s.view),original=p[Symbol.iterator];return replace(p,Symbol.iterator,function(){log('iterator');return apply(original,this,[]);});});
 hook('custom values',(s,log)=>{const p=Object.getPrototypeOf(s.view),original=p.values;return replace(p,'values',function(){log('values');return apply(original,this,[]);});});
 hook('custom element',(s,log)=>{const p=Object.getPrototypeOf(s.view),original=p.element;return replace(p,'element',function(...args){log('element');return apply(original,this,args);});});
 hook('custom span method',(s,log)=>{const original=s.memory.spans;return replace(s.memory,'spans',function(...args){log('spans');return apply(original,this,args);});});
 hook('custom Reflect.get',(_s,log)=>{const original=Reflect.get;return replace(Reflect,'get',function(...args){log('Reflect.get');return apply(original,this,args);});});
 hook('custom Number.isInteger',(_s,log)=>{const original=Number.isInteger;return replace(Number,'isInteger',function(value){log('isInteger');return original(value);});});
 hook('custom Array.at',(_s,log)=>{const original=Array.prototype.at;return replace(Array.prototype,'at',function(...args){log('at');return apply(original,this,args);});});
 hook('custom generator next',(s,log)=>{const p=Object.getPrototypeOf(Object.getPrototypeOf(s.view).values.prototype),original=p.next;return replace(p,'next',function(...args){log('next');return apply(original,this,args);});});
 hook('custom array iterator',(_s,log)=>{const original=Array.prototype[Symbol.iterator];return replace(Array.prototype,Symbol.iterator,function(...args){log('array iterator');return apply(original,this,args);});});
 hook('custom memory group getter',(s,log)=>{const old=desc(s.memory,'group'),group=s.memory.group;define(s.memory,'group',{configurable:true,get(){log('group');return group;}});return ()=>define(s.memory,'group',old);});
 hook('custom global Number',(_s,log)=>{const original=Number;return replace(globalThis,'Number',new Proxy(original,{apply(target,receiver,args){log('Number');return apply(target,receiver,args);}}));});
 hook('custom Math.floor',(_s,log)=>{const original=Math.floor;return replace(Math,'floor',function(value){log('floor');return original(value);});});
 hook('custom backing buffer getter',(s,log)=>{
  const backing=s.group.memory,get=desc(WebAssembly.Memory.prototype,'buffer').get;
  define(backing,'buffer',{configurable:true,get(){log('buffer');return apply(get,this,[]);}});return ()=>delete backing.buffer;
 });
 pair('public read override remains unused',s=>{
  const restore=replace(s.memory,'read',()=>{throw Error('old slice never calls a read override');});
  try{return s.view.slice(0,512);}finally{restore();}
 },{bulk:true});
 pair('global byte constructor override remains unused',s=>{
  const original=Uint8Array;let calls=0;
  const restore=replace(globalThis,'Uint8Array',new Proxy(original,{construct(target,args,newTarget){calls++;return Reflect.construct(target,args,newTarget);}}));
  let result;try{result=s.view.slice(0,512);}finally{restore();}must(calls===0,'slice added global constructor calls');return result;
 },{bulk:false});
 pair('public native set override remains unused',s=>{
  const p=Object.getPrototypeOf(Uint8Array.prototype),restore=replace(p,'set',()=>{throw Error('old slice never uses public set');});
  try{return s.view.slice(0,512);}finally{restore();}
 },{bulk:false});
 pair('unrelated Symbol lookup remains unused',s=>{
  let gets=0;const restore=replace(globalThis,'Symbol',new Proxy(Symbol,{get(target,key,receiver){gets++;return Reflect.get(target,key,receiver);}}));
  let result;try{result=s.view.slice(0,512);}finally{restore();}must(gets===0,'guard added Symbol lookups');return result;
 },{bulk:true});
 pair('source length getter count',s=>{
  const old=desc(s.view,'length');let gets=0;define(s.view,'length',{configurable:true,get(){gets++;return 2048;}});
  let result;try{result=s.view.slice(0,512);}finally{define(s.view,'length',old);}must(gets===3,'source length lookup order changed');return result;
 },{bulk:true});
 pair('constructor changes during conversion',s=>{
  const old=desc(s.view,'constructor');let current=Uint8Array;define(s.view,'constructor',{configurable:true,get(){return current;}});
  try{return s.view.slice({valueOf(){current=Int8Array;return 0;}},512);}finally{define(s.view,'constructor',old);}
 },{bulk:false});
 pair('span hook installed during conversion',s=>{
  const original=s.memory.spans;let calls=0;
  try {const result=s.view.slice(0,{valueOf(){define(s.memory,'spans',{configurable:true,value:function(...args){calls++;return apply(original,this,args);}});return 512;}});
   must(calls===512,'span callback was skipped or added');return result;
  }finally{delete s.memory.spans;}
 },{bulk:false});
 pair('non-callable from still evaluates subarray',s=>{
  const events=[],restore=replace(Uint8Array,'from',null),old=s.view.subarray;
  const restoreSub=replace(s.view,'subarray',function(...args){events[events.length]='subarray';return apply(old,this,args);});
  let r;try{r=outcome(()=>s.view.slice(0,512));}finally{restoreSub();restore();}
  must(r.error?.name==='TypeError','noncallable from did not throw');return {events,errorName:r.error.name};
 },{bulk:false});
 pair('slice remains a nonconstructible method',s=>{
  const method=s.view.slice,old=desc(method,'from');let calls=0;
  define(method,'from',{configurable:true,get(){calls++;return undefined;}});
  let result;try{result=outcome(()=>Reflect.construct(method,[]));}finally{old?define(method,'from',old):delete method.from;}
  must(result.error?.name==='TypeError'&&calls===0&&!Object.hasOwn(method,'prototype'),'slice constructor surface changed');
  return {errorName:result.error.name,calls};
 },{bulk:false});
 return {passed:true,checks,results,maximumReservationBytes:2*128*PAGE,diagnostics:candidate.vmByteSliceStats(),
  scope:'Worker-owned byte-snapshot mechanism; diagnostics enabled; no performance claim'};
}
