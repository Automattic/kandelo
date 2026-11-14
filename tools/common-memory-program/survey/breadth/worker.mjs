// Exploratory Node-only first screen. A disposable worker owns every memory.
import {workerData,parentPort} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {ProgramGroup} from '../../runtime.mjs';
const {root}=workerData,read=n=>readFileSync(root+'/'+n);
const dual=new WebAssembly.Module(read('dual.wasm')),single=new WebAssembly.Module(read('single.wasm')),vm=new WebAssembly.Module(read('single-vm.wasm'));
const p=new WebAssembly.Memory({initial:2,maximum:4,shared:true}),s=new WebAssembly.Memory({initial:2,maximum:4,shared:true});
const ordinary=new WebAssembly.Instance(dual,{env:{private:p,shared:s}}).exports;
const group=new ProgramGroup(),ctx=group.create(vm),physical=new WebAssembly.Instance(single,{env:{memory:group.memory}}).exports;
const privateWords=Uint32Array.from({length:32768},(_,i)=>(i*31^0x12345)&65535),sharedWords=Uint32Array.from({length:32768},(_,i)=>(i*17^0x54321)&65535);
new Uint32Array(p.buffer).set(privateWords);new Uint32Array(s.buffer).set(sharedWords);group.write(ctx,0,new Uint8Array(privateWords.buffer));
const cases={
 'native-private':n=>ordinary.private(n,0),
 'pte-per-access':n=>ctx.exports.sum(n,0),
 'guarded-contiguous-span':n=>{const base=ctx.exports.__vm_host_span(0,131072,1,ctx.root);return base?physical.sum(n,base):ctx.exports.sum(n,0);},
 'two-memory-private':n=>ordinary.tagged(n,0),
 'two-memory-shared':n=>ordinary.tagged(n,0x80000000),
 'native-shared':n=>ordinary.shared(n,0),
};
const expected=(words,n)=>{let sum=0n;for(let i=0;i<n;i++)sum+=BigInt(words[i&32767]);return sum;};
const iterations=1000000,privateExpected=expected(privateWords,iterations),sharedExpected=expected(sharedWords,iterations);
for(const [name,fn]of Object.entries(cases)){
 const want=name.includes('shared')?sharedExpected:privateExpected;
 if(fn(iterations)!==want)throw Error('incorrect result '+name);
 for(let i=0;i<5;i++)fn(100000);
}
// Guard cost is inside the timed function. Prefix/split/permission fallback
// semantics outside this pinned read-only workload are not benchmarked here.
let guardChecks=0;
const second=group.table(ctx)[1],scatter=group.alloc(1);
new Uint8Array(group.memory.buffer,scatter,65536).set(new Uint8Array(group.memory.buffer,second&-65536,65536));
group.map(ctx,65536,scatter);
if(ctx.exports.__vm_host_span(0,131072,1,ctx.root)!==0)throw Error('scatter guard did not miss');guardChecks++;
if(cases['guarded-contiguous-span'](iterations)!==privateExpected)throw Error('scatter fallback incorrect');guardChecks++;
group.map(ctx,65536,second&-65536);
if(!ctx.exports.__vm_host_span(0,131072,1,ctx.root))throw Error('contiguous guard did not hit');guardChecks++;
const samples=[];
for(let cohort=0;cohort<2;cohort++)for(let round=0;round<7;round++){
 const order=cohort?Object.keys(cases).reverse():Object.keys(cases);
 for(const name of order){const start=performance.now(),sum=cases[name](iterations),elapsedMs=performance.now()-start;const want=name.includes('shared')?sharedExpected:privateExpected;if(sum!==want)throw Error('measured result '+name);samples.push({cohort,round,name,elapsedMs,checksum:sum.toString()});}
}
parentPort.postMessage({passed:true,guardChecks,iterations,samples,scope:'Exploratory synthetic Node first screen of a pinned, fully mapped, read-only128KiB arena with varying addresses and no calls/fork/mapping changes inside the loop. Guarded-span timing includes the real VM span validation and an extra JS/Wasm call. Multi-memory uses an explicit high-bit pointer tag and native bank bounds, not the existing PHP ABI or general mmap permissions. Not PHP speedups, compiler-proof coverage, browser results or a quiet-machine claim.'});
