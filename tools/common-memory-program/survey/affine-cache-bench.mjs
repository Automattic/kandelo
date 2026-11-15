import { ProgramGroup, PAGE } from '../runtime.mjs';
export function runAffineCacheBench(bytes) {
  const started=performance.now(),modes=['baseline','small','affine','affine-small'];
  const modules=Object.fromEntries(modes.map(mode=>[mode,new WebAssembly.Module(bytes[mode])]));
  const group=new ProgramGroup({initialPages:128,maximumPages:256,scratchBytes:PAGE});
  const contexts={},privateWords=Uint32Array.from({length:32768},(_,i)=>(i*31^0x12345)&65535),sharedWords=Uint32Array.from({length:32768},(_,i)=>(i*17^0x54321)&65535);
  for(const mode of modes)for(const bank of ['private','shared']){
    const ctx=group.create(modules[mode]);group.write(ctx,0,new Uint8Array((bank==='shared'?sharedWords:privateWords).buffer));
    if(bank==='shared')for(let i=0;i<2;i++)group.map(ctx,i*PAGE,(group.table(ctx)[i]&-PAGE)>>>0,{shared:true});
    contexts[mode+'-'+bank]=ctx;
  }
  const ordinary=new WebAssembly.Instance(new WebAssembly.Module(bytes.native),{env:{memory:group.memory}}).exports;
  const nativeBases=Object.fromEntries(['private','shared'].map(bank=>[bank,(group.table(contexts['baseline-'+bank])[0]&-PAGE)>>>0]));
  const cases={};for(const bank of ['private','shared'])cases['native-'+bank]=n=>ordinary.sum(n,nativeBases[bank]);
  for(const mode of modes)for(const bank of ['private','shared'])cases[mode+'-'+bank]=n=>contexts[mode+'-'+bank].exports.sum(n,0);
  const expected=(words,n)=>{let all=0n,tail=0n;for(let i=0;i<words.length;i++){all+=BigInt(words[i]);if(i<n%words.length)tail+=BigInt(words[i]);}return all*BigInt(Math.floor(n/words.length))+tail;};
  const iterations=16000000,wants={private:expected(privateWords,iterations),shared:expected(sharedWords,iterations)};
  const verify=(name,sum)=>{if(sum!==wants[name.endsWith('-shared')?'shared':'private'])throw Error('checksum '+name);};
  const setupMs=performance.now()-started,firstInvocations=[];
  for(const[name,fn]of Object.entries(cases)){const at=performance.now(),sum=fn(iterations);firstInvocations.push({name,elapsedMs:performance.now()-at});verify(name,sum);for(let i=0;i<5;i++)fn(100000);}
  let minimumTimerStepMs=Infinity,last=performance.now();for(let i=0;i<10000;i++){const now=performance.now();if(now>last)minimumTimerStepMs=Math.min(minimumTimerStepMs,now-last);last=now;}
  const samples=[];for(let cohort=0;cohort<2;cohort++)for(let round=0;round<7;round++){
    const order=Object.keys(cases);if(cohort)order.reverse();for(const name of order){const at=performance.now(),sum=cases[name](iterations),elapsedMs=performance.now()-at;verify(name,sum);samples.push({cohort,round,name,elapsedMs,checksum:sum.toString()});}
  }
  return{passed:true,iterations,setupMs,firstInvocations,minimumTimerStepMs:Number.isFinite(minimumTimerStepMs)?minimumTimerStepMs:null,samples,scope:'Synthetic pinned128KiB varying-address scalar reads; private and shared windows; actual epoch/pages/range checks inside every access. Ordinary control binds the same physical Memory and baseline data. One Worker/host, reversed orders, not independent parents or PHP speedups.'};
}
