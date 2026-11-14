import {ProgramGroup,PAGE,READ} from '../runtime.mjs';
export function runRegional(module,{guardCounters=false}={}) {
 let checks=0;const equal=(a,b,label)=>{if(!Object.is(a,b))throw Error(`${label}: ${a} != ${b}`);checks++;};
 const trap=(fn,label)=>{try{fn();}catch(e){if(!(e instanceof WebAssembly.RuntimeError))throw e;checks++;return String(e);}throw Error(label+' did not trap');};
 const group=new ProgramGroup({initialPages:64,maximumPages:1024,scratchBytes:PAGE});let a;let callbacks=0;
 a=group.create(module,undefined,{remap:p=>{const page=Math.floor(p/PAGE)*PAGE;group.map(a,page,group.alloc(1));group.write(a,p,new Uint8Array(new Uint32Array([10,20,30,40]).buffer));callbacks++;}});
 const e=a.exports,write=(p,values)=>group.write(a,p,new Uint8Array(new Uint32Array(values).buffer)),read=(p,n)=>Array.from(new Uint32Array(group.read(a,p,n*4).buffer));
 write(64,[1,2,3,4]);equal(e.sum4(64),10,'contiguous guarded sum');equal(e.outer_value(64),110,'outer operand values preserved');
 equal(e.pointer_values(128,0x12345678),0x12345678,'stored pointers remain canonical');equal(read(128,2).join(','),'305419896,305419896','pointer bytes canonical');
 group.map(a,PAGE,group.alloc(1));write(PAGE-8,[1,2,3,4]);equal(e.sum4(PAGE-8),10,'scatter miss follows translated fallback');
 e.prefix(PAGE-8);equal(read(PAGE-8,4).join(','),'1,2,3,4','scatter store fallback');
 group.map(a,PAGE,group.table(a)[1]&-PAGE,{rights:READ});write(PAGE-12,[8,8,8]);
 trap(()=>e.prefix(PAGE-8),'denied prefix');equal(read(PAGE-8,2).join(','),'1,2','original writes before later fault remain visible');
 equal(read(PAGE,2).join(','),'3,4','denied page unchanged');
 const error=trap(()=>e.trap_order(PAGE-12),'division before denied later store');equal(/zero/i.test(error),true,'earlier arithmetic trap preserved');equal(read(PAGE-12,2).join(','),'1,2','writes before division preserved');
 group.map(a,PAGE,group.table(a)[1]&-PAGE);equal(e.call_boundary(64),100,'mapping callback gets a fresh physical span');equal(callbacks,1,'one original callback');
 e.branches(256,1);equal(read(256,4).join(','),'11,12,13,14','then region');e.branches(256,0);equal(read(256,4).join(','),'21,22,23,24','else region');
 e.base_mutate(512);equal(read(512,2).join(','),'1,2','old base');equal(read(PAGE+512,2).join(','),'3,4','changed base');
 const root=e.__vm_root.value;e.__vm_root.value=0;trap(()=>e.prefix(64),'zero root');e.__vm_root.value=root;
 const outcomes={hits:new Uint32Array(group.memory.buffer,a.root+24,1)[0],misses:new Uint32Array(group.memory.buffer,a.root+28,1)[0]};
 if(guardCounters){equal(outcomes.hits>0,true,'actual successful guards observed');equal(outcomes.misses>0,true,'actual guard misses observed');}
 return{passed:true,checks,outcomes,scope:'Guard hit/scatter miss, original write/fault order, arithmetic trap order, canonical pointer values, call/remap boundary, structured branches, base mutation and outer operand stack.'};
}
