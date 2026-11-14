import {ProgramGroup,PAGE,READ} from '../runtime.mjs';
export function runAtomicFusion(module,nativeModule) {
 const group=new ProgramGroup(),a=group.create(module),nativeMemory=new WebAssembly.Memory({initial:2,maximum:2,shared:true});
 const native=new WebAssembly.Instance(nativeModule,{env:{memory:nativeMemory}}).exports,ordinary=new Uint8Array(nativeMemory.buffer);
 let checks=0;const equal=(x,y,label)=>{if(!Object.is(x,y))throw Error(`${label}: ${x} != ${y}`);checks++;};
 const trap=(fn,label)=>{let threw=false;try{fn();}catch(error){if(!(error instanceof WebAssembly.RuntimeError))throw error;threw=true;}equal(threw,true,label);};
 const forms=WebAssembly.Module.exports(nativeModule).filter(x=>x.kind==='function').map(x=>x.name);
 for(const name of forms) {
  const [kind,bitsText,action,offsetText]=name.split('_'),width=Number(bitsText)/8,offset=Number(offsetText),value=kind==='i64'?3n:3,value2=kind==='i64'?5n:5;
  for(const effective of [64,PAGE-width,PAGE,PAGE*2-width]) {
   const base=effective-offset;if(base<0)continue;
   const pattern=Uint8Array.from({length:width},(_,i)=>i+1);ordinary.set(pattern,effective);group.write(a,effective,pattern);
   equal(a.exports[name](base,value,value2),native[name](base,value,value2),name+' result');
   equal([...group.read(a,effective,width)].join(),[...ordinary.slice(effective,effective+width)].join(),name+' bytes');
  }
  const beyond=2*PAGE-offset;trap(()=>native[name](beyond,value,value2),name+' native bounds');trap(()=>a.exports[name](beyond,value,value2),name+' virtual bounds');
  if(width>1){trap(()=>native[name](65-offset,value,value2),name+' native alignment');trap(()=>a.exports[name](65-offset,value,value2),name+' virtual alignment');}
  trap(()=>a.exports[name](0xffffffff,value,value2),name+' offset/endpoint overflow');
  if(action==='store'||action==='add'||action==='cmp') {
   const physical=group.table(a)[0]&-PAGE,before=group.read(a,64,width).join();group.map(a,0,physical,{rights:READ});trap(()=>a.exports[name](64-offset,value,value2),name+' write permission');equal(group.read(a,64,width).join(),before,name+' denied unchanged');group.map(a,0,physical);
  }
 }
 const pages=new Uint32Array(group.memory.buffer,a.root,1);pages[0]=65536;
 group.map(a,65535*PAGE,group.alloc(1));
 a.exports.i64_64_store_16(0xffffffe8,42n);equal(a.exports.i64_64_load_16(0xffffffe8),42n,'exact4GiB atomic endpoint');
 a.exports.i32_8_store_16(0xffffffef,123);equal(a.exports.i32_8_load_16(0xffffffef),123,'last byte atomic endpoint');
 trap(()=>a.exports.i32_8_load_16(0xfffffff0),'atomic offset addition wrap');
 trap(()=>a.exports.i64_64_load_16(0xffffffe9),'atomic misaligned endpoint');
 trap(()=>a.exports.i64_64_load_0(3*PAGE),'atomic unmapped hole');
 const endpointBefore=a.exports.i64_64_load_16(0xffffffe8),last=group.table(a)[65535]&-PAGE;group.map(a,65535*PAGE,last,{rights:READ});trap(()=>a.exports.i64_64_store_16(0xffffffe8,9n),'atomic read-only last page');equal(a.exports.i64_64_load_16(0xffffffe8),endpointBefore,'denied atomic endpoint unchanged');
 return {passed:true,checks,forms:forms.length,scope:'Differential native/VM atomic widths, offsets, boundary/alignment/bounds/permissions/results and byte effects. Not timing.'};
}
