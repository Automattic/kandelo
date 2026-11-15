export async function runAccessCountMechanism(m,bytes,report) {
  let checks=0;const ok=(v,label)=>{if(!v)throw Error(label);checks++;};
  const group=new m.VirtualGroup(undefined,{maximumPages:1024,scratchBytes:65536});
  const a=group.create(2,65536),mod=new WebAssembly.Module(bytes),instance=m.vmConstruct(WebAssembly.Instance,mod,{env:{memory:a}}),e=instance.exports;
  const snap=memory=>new Map(m.vmAccessCounts([[1,memory]]).records[0].values.map(([k,v])=>[k,BigInt(v)]));
  const before=snap(a);e.store32(100,42);ok(e.load32(100)===42,'ordinary access');
  const physical=group.allocate(1);a.table()[1]=physical|3;
  e.store32(65534,0x12345678);ok(e.load32(65534)===0x12345678,'scattered access');
  const old=m.vmConstruct(Uint8Array,a.buffer).slice(65534,65536);a.table()[1]=physical|1;
  let trapped=false;try{e.store32(65534,99);}catch{trapped=true;}ok(trapped,'denied split store traps');ok([...m.vmConstruct(Uint8Array,a.buffer).slice(65534,65536)].join()===Array.from(old).join(),'denied prefix unchanged');a.table()[1]=physical|3;
  const after=snap(a),storeSlot=report.categoryNames.indexOf('I32Store'),loadSlot=report.categoryNames.indexOf('I32Load');
  ok(after.get(storeSlot)-(before.get(storeSlot)??0n)===3n,'three attempted stores');ok(after.get(loadSlot)-(before.get(loadSlot)??0n)===2n,'two loads');
  const ex=WebAssembly.Module.exports(mod);const functionSlots=Array.from(after).filter(([k])=>k>=256);ok(functionSlots.reduce((n,[,v])=>n+v,0n)===5n,'per-function accounting');
  const ptr=new Uint32Array(group.memory.buffer,a.root+56,1)[0],words=new BigUint64Array(group.memory.buffer,ptr,65792);Atomics.store(words,loadSlot,0x100000000n);e.load32(100);ok(snap(a).get(loadSlot)===0x100000001n,'64-bit count preserves high bits');
  a.table()[1]|=4;const b=group.create(2,65536);m.vmCopyFork(b.buffer,a.buffer);ok(snap(b).size===0,'fork starts fresh independent counters');const eb=m.vmConstruct(WebAssembly.Instance,mod,{env:{memory:b}}).exports;
  eb.store32(100,77);ok(e.load32(100)===42&&eb.load32(100)===77,'fork private data remains private');eb.store32(65536,123);ok(e.load32(65536)===123,'fork shared data remains live');ok(snap(b).get(storeSlot)===2n,'child operations count on child root');
  const h=new Uint32Array(group.memory.buffer,b.root+56,2),magic=h[1];h[1]=0;trapped=false;try{eb.load32(100);}catch{trapped=true;}h[1]=magic;ok(trapped,'missing diagnostic host fails loudly');
  return {passed:true,checks,scope:'Counter accounting, 64-bit values, scatter/permissions, independent fork counters and ordinary private/shared memory semantics; not timing.'};
}
