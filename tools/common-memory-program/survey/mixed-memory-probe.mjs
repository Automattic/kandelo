// Only disposable Workers call this fixture. No kernel imports or handles.
import {ProgramGroup,PAGE,READ,WRITE} from '../runtime.mjs';
export function runMixedMemoryProbe(bytes) {
 const setupStart=performance.now(),N=32768,BANK=N*4,TABLE=BANK*2,TAG_TABLE=BANK*3,XOR=0x5a5a5a5a;
 const singleModule=new WebAssembly.Module(bytes.single),dualModule=new WebAssembly.Module(bytes.dual),vmModule=new WebAssembly.Module(bytes.translated);
 const makeMemory=()=>new WebAssembly.Memory({initial:8,maximum:16,shared:true});
 const singleMemory=makeMemory(),privateMemory=makeMemory(),sharedMemory=makeMemory(),childPrivate=makeMemory();
 const single=new WebAssembly.Instance(singleModule,{env:{memory:singleMemory}}).exports;
 const instantiateDual=(p,s)=>new WebAssembly.Instance(dualModule,{env:{private:p,shared:s}}).exports;
 const dual=instantiateDual(privateMemory,sharedMemory),child=instantiateDual(childPrivate,sharedMemory),alias=instantiateDual(childPrivate,childPrivate);
 const group=new ProgramGroup({initialPages:64,maximumPages:128,scratchBytes:PAGE}),ctx=group.create(vmModule);
 for(let i=2;i<4;i++)group.map(ctx,i*PAGE,(group.table(ctx)[i]&-PAGE)>>>0,{shared:true});
 let checks=0;
 const check=(v,n)=>{if(!v)throw Error(n);checks++;};
 const trap=fn=>{let caught=false;try{fn();}catch(e){if(!(e instanceof WebAssembly.RuntimeError))throw e;caught=true;}check(caught,'bounds/rights trap');};
 // Synthetic private byte copy, not the SDK/kernel fork mechanism.
 dual.store(16,17);dual.store(0x80000010,101);
 new Uint32Array(privateMemory.buffer,BANK,2).set([16,0x80000010]);
 new Uint8Array(childPrivate.buffer).set(new Uint8Array(privateMemory.buffer));
 check(child.load(child.raw(BANK))===17&&child.load(child.raw(BANK+4))===101,'copied pointer values keep bank meaning');
 child.store(child.raw(BANK),99);check(dual.load(16)===17,'private isolation');
 child.store(child.raw(BANK+4),202);check(dual.load(0x80000010)===202,'live shared payload');
 alias.store(20,55);check(alias.load(0x80000014)===55,'legal aliased imports remain live');
 dual.store(3,0x12345678);check(dual.load(3)===0x12345678,'unaligned ordinary scalar form');
 trap(()=>dual.load(8*PAGE));trap(()=>dual.load(0x80000000+8*PAGE));trap(()=>dual.load(0xffffffff));
 ctx.exports.store(16,17);ctx.exports.store(BANK+16,101);const vmChild=group.create(vmModule,ctx);
 vmChild.exports.store(16,99);check(ctx.exports.load(16)===17,'VM private-copy control');
 vmChild.exports.store(BANK+16,202);check(ctx.exports.load(BANK+16)===202,'VM shared-copy control');
 const physical0=(group.table(ctx)[0]&-PAGE)>>>0,physical2=(group.table(ctx)[2]&-PAGE)>>>0;
 group.map(ctx,0,physical2,{shared:true});check(ctx.exports.load(16)===202,'VM alias control');group.map(ctx,0,physical0);
 group.map(ctx,BANK,physical2,{shared:true,rights:READ});trap(()=>ctx.exports.store(BANK+16,88));check(ctx.exports.load(BANK+16)===202,'denied write preserves data');group.map(ctx,BANK,physical2,{shared:true,rights:READ|WRITE});
 // A distinct high bit makes an ignored/shared-to-private tag observable even
 // if lower-word permutations happen to have equal aggregate sums.
 const privateWords=Uint32Array.from({length:N},(_,i)=>(i*31^0x12345)&65535),sharedWords=Uint32Array.from({length:N},(_,i)=>65536+((i*17^0x54321)&65535));
 const patterns=['private','shared','alternating','clustered256','shuffled50','shuffled1','shuffled99'];
 const records=[],samples=[],firstInvocations=[];const iterations=8388608;
 const vmWords=(va,n)=>new Uint32Array(group.memory.buffer,group.physical(ctx,va,READ),n);
 const reset=()=>{new Uint32Array(singleMemory.buffer,0,N).set(privateWords);new Uint32Array(singleMemory.buffer,BANK,N).set(sharedWords);new Uint32Array(privateMemory.buffer,0,N).set(privateWords);new Uint32Array(sharedMemory.buffer,0,N).set(sharedWords);vmWords(0,N).set(privateWords);vmWords(BANK,N).set(sharedWords);};
 const contents=()=>{for(const[actual,want]of [[new Uint32Array(singleMemory.buffer,0,N),privateWords],[new Uint32Array(singleMemory.buffer,BANK,N),sharedWords],[new Uint32Array(privateMemory.buffer,0,N),privateWords],[new Uint32Array(sharedMemory.buffer,0,N),sharedWords],[vmWords(0,N),privateWords],[vmWords(BANK,N),sharedWords]])for(let i=0;i<N;i++)if(actual[i]!==want[i])throw Error('post-write contents '+i);checks++;};
 let minimumTimerStepMs=Infinity,last=performance.now();for(let i=0;i<10000;i++){const now=performance.now();if(now>last)minimumTimerStepMs=Math.min(minimumTimerStepMs,now-last);last=now;}
 const setupMs=performance.now()-setupStart;
 for(const pattern of patterns){
  reset();const banks=new Uint8Array(N);let random=0x6d2b79f5;const next=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return random>>>0;};
  for(let i=0;i<N;i++)banks[i]=pattern==='private'?0:pattern==='shared'?1:pattern==='alternating'?i&1:pattern==='clustered256'?(i>>>8)&1:i<(pattern==='shuffled50'?N/2:pattern==='shuffled1'?328:N-328)?1:0;
  if(pattern.startsWith('shuffled'))for(let i=N-1;i>0;i--){const j=next()%(i+1),v=banks[i];banks[i]=banks[j];banks[j]=v;}
  const pointers=new Uint32Array(N),tagged=new Uint32Array(N);let readSum=0n,writePairSum=0n,uniformFirstTagSum=0n,sharedCount=0,transitions=0;
  for(let i=0;i<N;i++){const j=(i*4051+17)&(N-1),bank=banks[i],value=(bank?sharedWords:privateWords)[j];pointers[i]=bank*BANK+j*4;tagged[i]=(bank?0x80000000:0)+j*4;readSum+=BigInt(value);writePairSum+=BigInt(value)+BigInt((value^XOR)>>>0);uniformFirstTagSum+=BigInt((banks[0]?sharedWords:privateWords)[j]);sharedCount+=bank;if(i&&bank!==banks[i-1])transitions++;}
  if(sharedCount&&sharedCount<N)check(readSum!==uniformFirstTagSum,'negative control rejects one tag for the whole loop');
  new Uint32Array(singleMemory.buffer,TABLE,N).set(pointers);new Uint32Array(singleMemory.buffer,TAG_TABLE,N).set(tagged);new Uint32Array(privateMemory.buffer,BANK,N).set(tagged);vmWords(TABLE,N).set(pointers);
  const cases={
   'native-read':n=>single.read(n,TABLE),'flat-tagged-read':n=>single.tagged_read(n,TAG_TABLE),'dual-tagged-read':n=>dual.read(n,BANK),'pte-small-read':n=>ctx.exports.read(n,TABLE),
   'native-write':n=>single.write(n,TABLE),'flat-tagged-write':n=>single.tagged_write(n,TAG_TABLE),'dual-tagged-write':n=>dual.write(n,BANK),'pte-small-write':n=>ctx.exports.write(n,TABLE)};
  const verify=(name,sum,n)=>{if(n%N||n/N%2)throw Error('fixture requires even complete cycles');const want=name.endsWith('-write')?writePairSum*BigInt(n/N/2):readSum*BigInt(n/N);if(sum!==want)throw Error('checksum '+pattern+' '+name);};
  for(const[name,fn]of Object.entries(cases)){const at=performance.now(),sum=fn(iterations);firstInvocations.push({pattern,name,elapsedMs:performance.now()-at});verify(name,sum,iterations);for(let k=0;k<3;k++)verify(name,fn(N*2),N*2);}
  contents();
  for(let cohort=0;cohort<2;cohort++)for(let round=0;round<7;round++){
   const order=Object.keys(cases);if(cohort)order.reverse();for(const name of order){const at=performance.now(),sum=cases[name](iterations),elapsedMs=performance.now()-at;verify(name,sum,iterations);samples.push({pattern,cohort,round,name,elapsedMs,checksum:sum.toString()});}
  }
  contents();records.push({pattern,entries:N,sharedCount,transitions,readSum:readSum.toString(),writePairSum:writePairSum.toString()});
 }
 return{passed:true,checks,iterations,records,samples,firstInvocations,minimumTimerStepMs,setupMs,
  reservationBytes:(4*16+128)*PAGE,scope:'Synthetic aligned memory32 gather streams: each pointer and payload loaded inside loop. Ordinary/flat-tagged/two-memory/PTE-small controls have equal logical values and stream order. XOR read-modify-writes restore contents after even full cycles; checksums and all payload bytes checked. Private/shared meaning is a high-bit pointer ABI with 2GiB per bank, not real SDK/PHP/mmap/fork/pthreads support. Two memory imports may alias; private copy is synthetic. One disposable Worker per host, reverse cohorts within each fixed-order pattern, not independent parents or application/CPU-attribution evidence. No kernel imports or escaping guest memory.'};
}
