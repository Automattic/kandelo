import {ProgramGroup,PAGE,READ} from '../runtime.mjs';
const must=(ok,message)=>{if(!ok)throw Error(message);};
const trap=fn=>{try{fn();}catch(error){if(error instanceof WebAssembly.RuntimeError)return;throw error;}throw Error('expected bounds/permission trap');};
export function runBounds(module) {
  const group=new ProgramGroup({initialPages:16,maximumPages:128,scratchBytes:PAGE});
  const ctx=group.create(module),e=ctx.exports;
  const rootPages=new Uint32Array(group.memory.buffer,ctx.root,1);
  must(rootPages[0]===2,'expected initial two-page virtual limit');
  e.store32(2*PAGE-4,0x12345678);
  // A deliberately valid PTE beyond the current limit must not bypass VA
  // bounds, including the split-store fallback. Metadata mutation is a
  // diagnostic negative control, not a permitted guest mapping operation.
  group.table(ctx)[2]=group.alloc(1)|3;
  trap(()=>e.load8(2*PAGE));trap(()=>e.load32_small(2*PAGE-16));
  trap(()=>e.store32(2*PAGE-2,0));
  must(e.load16(2*PAGE-2)===0x1234,'small-limit split store changed prefix');
  rootPages[0]=0;trap(()=>e.load8(0));rootPages[0]=2;
  group.table(ctx)[2]=0;
  // A sparse 4GiB virtual address space, with only a few actual payload pages.
  rootPages[0]=65536;
  group.map(ctx,65535*PAGE,group.alloc(1));
  e.store32(0xfffffffc,0x12345678);
  must(e.load32(0xfffffffc)===0x12345678,'endpoint exactly4GiB');
  must(e.load32_small(0xffffffec)===0x12345678,'small offset exactly4GiB');
  must(e.load8_max(0)===0x12,'maximum offset last byte');
  trap(()=>e.load8_max(1));trap(()=>e.load32(0xfffffffd));trap(()=>e.load32(0xffffffff));
  trap(()=>e.load32_small(0xfffffff0));trap(()=>e.store32_small(0xfffffff0,0));
  trap(()=>e.store32(0xfffffffd,0));
  must(e.load32(0xfffffffc)===0x12345678,'denied endpoint store changed bytes');
  e.store8(0xffffffff,0xfe);must(e.load8(0xffffffff)===254&&e.load8s(0xffffffff)===-2,'narrow signed load');
  e.store16(0xfffffffe,0xfffe);must(e.load16(0xfffffffe)===65534&&e.load16s(0xfffffffe)===-2,'16bit signed load');
  e.store32(0xfffffffc,-2);must(e.load64_32u(0xfffffffc)===4294967294n&&e.load64_32s(0xfffffffc)===-2n,'i64 narrow load');
  e.store64(0xfffffff8,0x1234567890abcdefn);must(e.load64(0xfffffff8)===0x1234567890abcdefn,'i64 endpoint');
  must(e.float32(0xfffffffc,1.25)===1.25&&e.float64(0xfffffff8,Math.PI)===Math.PI,'floating endpoints');
  must(Object.is(e.float64(0xfffffff8,-0),-0),'negative zero');
  trap(()=>e.load64(0xfffffff9));trap(()=>e.store64(0xfffffff9,0n));
  // Cross-page access must preflight the complete store and use scatter fallback.
  group.map(ctx,PAGE,group.alloc(1));
  e.store32(PAGE-2,0x456789ab);must(e.load32(PAGE-2)===0x456789ab,'zero offset scatter');
  e.store32_small(PAGE-18,0x12345678);must(e.load32_small(PAGE-18)===0x12345678,'small offset scatter');
  const before=group.read(ctx,PAGE-2,2);
  group.map(ctx,PAGE,group.table(ctx)[1]&-PAGE,{rights:READ});
  trap(()=>e.store32(PAGE-2,0));trap(()=>e.store32_small(PAGE-18,0));
  must(group.read(ctx,PAGE-2,2).join(',')===before.join(','),'split denied store changed prefix');
  group.map(ctx,65535*PAGE,group.table(ctx)[65535]&-PAGE,{rights:READ});
  trap(()=>e.store8(0xffffffff,0));trap(()=>e.store32(0xfffffffc,0));
  trap(()=>e.load32(2*PAGE));
  return {passed:true,checks:['small/zero virtual limits despite valid PTE','sparse4GiB exact endpoint','small and maximum constant offsets','overflow without pointer wrap',
    'signed/unsigned narrow loads and i64','floating and negative zero','split/scatter fallback and denied prefix','permission checks and unmapped holes']};
}
