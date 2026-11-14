import {runAccessCountMechanism} from './access-count-mechanism.mjs';
export async function runOriginSitesMechanism(m,bytes,report) {
  const base=await runAccessCountMechanism(m,bytes,report);
  let checks=base.checks;const ok=(v,label)=>{if(!v)throw Error(label);checks++;};
  const group=new m.VirtualGroup(undefined,{maximumPages:1024,scratchBytes:65536});
  const a=group.create(2,65536),mod=new WebAssembly.Module(bytes);
  const e=m.vmConstruct(WebAssembly.Instance,mod,{env:{memory:a}}).exports;
  const snap=memory=>new Map(m.vmAccessCounts([[1,memory]]).records[0].values.map(([k,v])=>[k,BigInt(v)]));
  for(let i=0;i<4;i++)e.store32(100+4*i,i+1);
  const before=snap(a);
  ok(e.frame()===7,'frame stores and reloads');
  ok(e.invariant(100,4)===4,'invariant loop reads live data');
  ok(e.stride(100,4)===10,'strided loop result');
  const after=snap(a),delta=slot=>(after.get(slot)??0n)-(before.get(slot)??0n);
  for(const [i,expected]of [3,3,2,4,4,8,11].entries())ok(delta(208+i)===BigInt(expected),`candidate class ${i}`);
  const categories=Array.from(after).filter(([s])=>s<192).reduce((n,[s])=>n+delta(s),0n);
  const functions=Array.from(after).filter(([s])=>s>=256).reduce((n,[s])=>n+delta(s),0n);
  ok(categories===11n&&functions===11n,'custom overlapping counters excluded from dispatch totals');
  const b=group.create(2,65536);m.vmCopyFork(b.buffer,a.buffer);
  ok(snap(b).size===0,'fork candidate counters start empty');
  const eb=m.vmConstruct(WebAssembly.Instance,mod,{env:{memory:b}}).exports;
  ok(eb.frame()===7,'child frame result');ok(snap(b).get(214)===3n,'child candidate counts independent');
  ok(snap(a).get(214)===11n,'child leaves parent counts unchanged');
  a.table()[0]&=~3;let trapped=false;try{e.frame();}catch{trapped=true;}
  ok(trapped,'candidate load denied by unchanged permission checks');
  ok(snap(a).get(214)===12n,'candidate attempts count trapping access');
  return {passed:true,checks,classes:report.originSites,scope:'Exact overlapping site counters, fork independence and denied candidate access; existing 13 scatter/permissions/64-bit/fork accounting checks also pass. Not latency.'};
}
