import {ProgramGroup,PAGE,READ} from './runtime.mjs';
export function runAccessForms(module,groupOptions={}) {
  const equal=(a,b)=>{if(!Object.is(a,b))throw Error(`access result ${a} != ${b}`);};
  const trap=fn=>{try{fn();}catch(error){if(error instanceof WebAssembly.RuntimeError)return;throw error;}throw Error('expected trap');};
  const group=new ProgramGroup(groupOptions),a=group.create(module),e=a.exports;
  group.map(a,PAGE,group.alloc(1));
  e.i32_store(PAGE-6,0x12345678);equal(e.i32_load(PAGE-6),0x12345678);
  e.i64_store(PAGE-10,0x1234567890abcdefn);equal(e.i64_load(PAGE-10),0x1234567890abcdefn);
  equal(e.f32_roundtrip(PAGE-3,1.25),1.25);equal(e.f64_roundtrip(PAGE-6,Math.PI),Math.PI);
  group.write(a,PAGE-8,Uint8Array.from({length:20},(_,i)=>100+i));equal(e.simd(PAGE-13),107);
  equal(e.lane3(PAGE-1),108);equal(e.lane4(PAGE-1),0);
  e.store_lane(PAGE-4);equal(group.read(a,PAGE-1,2).join(','),'120,86');
  e.atomic_store(64,5n);equal(e.atomic_add(64,3n),5n);equal(e.atomic_cmp(64,8n,10n),8n);
  equal(e.atomic_load(64),10n);equal(e.atomic_wait(64,10n,0n),2);equal(e.atomic_notify(64,1),0);
  trap(()=>e.atomic_load(65));trap(()=>e.overflow(1));
  const before=group.read(a,PAGE-2,2);
  group.map(a,PAGE,group.table(a)[1]&-PAGE,{rights:READ});
  trap(()=>e.i32_store(PAGE-6,0));equal(group.read(a,PAGE-2,2).join(','),before.join(','));
  return {passed:true,checks:['nonzero offsets and scattered numeric loads/stores','SIMD and distinct lane immediates','64-bit atomic result/signature/timeout/alignment','overflow and denied-store prefix atomicity']};
}
