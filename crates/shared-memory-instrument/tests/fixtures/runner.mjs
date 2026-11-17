import * as G from '../../../../host/src/generated/program-extensions.ts';
import {MemoryGroupPagePool} from '../../../../host/src/memory-group-pool.ts';
// Run only in a disposable Worker; return copied results, never guest storage.
export async function check(bytes,spawnPeer,phase=()=>{},terminateBeforeGrowth=true) {
  const checks=[];
  function check(name, condition) {if(!condition)throw Error(name);checks.push(name);}
  function trap(name,fn){let trapped=false;try{fn();}catch(e){trapped=e instanceof WebAssembly.RuntimeError;}check(name,trapped);}
  const P=65536,root=P,scratch=2*P;
  function replica(memory,address,root) {
    const control=new Uint32Array(memory.buffer,address,G.MEMORY_GROUP_REPLICA_BYTES/4);
    control.fill(0);control[G.MEMORY_GROUP_REPLICA_RUN/4]=1;
    control[G.MEMORY_GROUP_REPLICA_ROOT/4]=root;
    control[G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET/4]=G.MEMORY_GROUP_REPLICA_MAGIC;
    return address;
  }
  const memory=new WebAssembly.Memory({initial:64,maximum:128,shared:true});
  const pool=MemoryGroupPagePool.initialize(memory,128);
  const reserved=pool.allocateContiguous(15);check('host reserves initial root/scratch/payload pages',reserved.first===1);
  const u32=new Uint32Array(memory.buffer),u8=new Uint8Array(memory.buffer);
  const {instance}=await WebAssembly.instantiate(bytes,{'kandelo.memory-group.v3':{memory}});
  const e=instance.exports;
  let ordinaryAccepted=false;
  try {const {instance:ordinaryInstance}=await WebAssembly.instantiate(bytes,{env:{memory}});ordinaryAccepted=ordinaryInstance!==undefined;}catch{}
  check('ordinary env.memory import is refused',!ordinaryAccepted);
  u32[root/4]=2;u32[root/4+1]=32;u32[root/4+2]=P;u32[root/4+14]=1;
  const pte=root/4+16;u32[pte]=4*P|3;u32[pte+1]=6*P|3;
  e.__vm_root.value=root;e.__vm_scratch.value=scratch;e.__vm_replica.value=replica(memory,5*P,root);e.__vm_initialize(1);
  check('active C data initialized once',e.initialized()===0x2468ace);
  e.write32(60000,0x12345678);check('scalar write uses translated storage',u32[(4*P+60000)/4]===0x12345678);
  check('scalar read returns stored value',e.read32(60000)===0x12345678);
  e.write32(P-2,0x12345678);check('split scalar touches both physical pages',u8[5*P-2]===0x78&&u8[6*P]===0x34);
  check('split scalar read preserves bytes',e.read32(P-2)===0x12345678);
  e.write64(P-3,0x1234567812345678n);check('split i64 preserves payload',e.read64(P-3)===0x1234567812345678n);
  e.fill(60000,0xab,32);check('bulk fill uses guest pointers',u8[4*P+60000]===0xab&&u8[4*P+60031]===0xab);
  for(let i=0;i<32;i++)u8[4*P+61000+i]=i+1;
  e.copy(P-10,61000,32);check('scatter copy stages source before writes',Array.from({length:32},(_,i)=>e.read32(P-10+i)&255).every((v,i)=>v===i+1));
  e.simd_copy(P-7,61000);check('SIMD split load/store retains bytes',Array.from({length:16},(_,i)=>e.read32(P-7+i)&255).every((v,i)=>v===i+1));
  e.write32(62000,7);check('atomic RMW returns previous value',e.atomic_add(62000,3)===7&&e.read32(62000)===10);
  trap('unaligned atomics trap',()=>e.atomic_add(62001,1));
  check('wait32 mismatch remains nonblocking',e.wait32(62000,9,-1n)===1);
  check('wait32 timeout retires its queue node',e.wait32(62000,10,0n)===2&&u32[4112/4+4]===0);
  e.write64(62008,23n);check('wait64 mismatch remains nonblocking',e.wait64(62008,22n,-1n)===1);
  check('wait64 timeout retires its queue node',e.wait64(62008,23n,0n)===2&&u32[4112/4+4]===0);
  check('notify reports actual waiters',e.notify(62000,10)===0);
  const nativeWord=new Int32Array(memory.buffer,4*P+62000,1);
  const nativeWait=Atomics.waitAsync(nativeWord,0,10,5000);
  check('native channel observer parks on the physical payload',nativeWait.async===true);
  check('C notify excludes native observers from its guest waiter count',e.notify(62000,1)===0);
  check('C notify wakes the native channel observer',await nativeWait.value==='ok');
  check('worker wait translates a virtual word before comparing',e.__vm_worker_wait32(62000,9,-1n,root,5*P)===1);
  check('worker wait timeout retires its replica queue node',e.__vm_worker_wait32(62000,10,0n,root,5*P)===2&&u32[4112/4+4]===0);
  trap('worker wait rejects an unaligned virtual word',()=>e.__vm_worker_wait32(62001,10,0n,root,5*P));
  u32[pte+1]=6*P|1;const before=u8[5*P-1];trap('split write preflights all permissions',()=>e.write32(P-1,0));check('failed split write is atomic with respect to preflight',u8[5*P-1]===before);u32[pte+1]=6*P|3;
  u32[pte+1]=u32[pte];e.write32(P+60000,99);check('shared alias observes same backing without copying',e.read32(60000)===99);u32[pte+1]=6*P|3;
  e.set_initialized(0x13579bdf);
  const second=(await WebAssembly.instantiate(bytes,{'kandelo.memory-group.v3':{memory}})).instance.exports;
  second.__vm_root.value=root;second.__vm_scratch.value=3*P;second.__vm_replica.value=replica(memory,5*P+64,root);second.__vm_initialize(2);
  check('thread attach does not replay initial data',e.initialized()===0x13579bdf&&second.initialized()===0x13579bdf&&second.read32(60000)===99);
  trap('fresh initialization cannot repeat',()=>e.__vm_initialize(1));
  Atomics.store(u32,(5*P+64+G.MEMORY_GROUP_REPLICA_RUN)/4,0);
  trap('one replica stop escapes before a source store',()=>second.write32(60000,123));
  check('stopping one replica preserves its same-root peer',e.read32(60000)===99);
  Atomics.store(u32,(5*P+64+G.MEMORY_GROUP_REPLICA_RUN)/4,1); // Fixture restart only; no old Worker or wait exists.
  check('logical memory.size is virtualized',e.size()===2);
  check('memory.grow installs new virtual pages',e.grow(1)===2&&e.size()===3&&u32[pte+2]===(16*P|3));
  check('new logical pages start zero',e.read32(2*P)===0);
  u8.fill(0xef,8*P,9*P);pool.releaseRetiredPages([8]);
  check('C grow reuses a host-released page',e.grow(1)===3&&u32[pte+3]===(8*P|3));
  check('C grow zeroes reused physical bytes',e.read32(3*P)===0);
  const hostPage=pool.allocateContiguous(1);check('host allocation sees C page ownership',hostPage.first===17);
  u8.fill(0xea,17*P,18*P);pool.releaseRetiredPages([17]);
  let plateau=true;
  for(let i=0;i<256;i++) {
    if(e.grow(1)!==4||u32[pte+4] !== (17*P|3)||e.read32(4*P)!==0)plateau=false;
    e.write32(4*P,0xffffffff);u32[pte+4]=0;Atomics.store(u32,root/4,4);
    // Synthetic fixture retirement after synchronous calls, with no live user
    // of that page. This is not evidence for the normal lifecycle fences.
    pool.releaseRetiredPages([17]);
  }
  check('256 C grow/retire cycles reuse the same zeroed page',plateau);
  check('physical extent plateaus instead of growing per cycle',pool.snapshot().highWaterPages===18&&pool.snapshot().physicalExtentPages===64);
  check('limit refusal leaves virtual size unchanged',(e.grow(32)>>>0)===0xffffffff&&e.size()===4);
  trap('out-of-bounds addresses trap',()=>e.read32(4*P));
  if(typeof spawnPeer!=='function')throw Error('Real peer Worker factory is required');
  const barrier=new SharedArrayBuffer(8),flags=new Int32Array(barrier),peers=[];
  try {
    for(let i=0;i<4;i++) {
      const rootPage=pool.allocateContiguous(1),scratchPage=pool.allocateContiguous(1),payload=pool.allocateContiguous(2);
      const peerRoot=rootPage.first*P,peerPte=peerRoot/4+16;
      u32[peerRoot/4]=2;u32[peerRoot/4+1]=32;u32[peerRoot/4+2]=P;u32[peerRoot/4+14]=1;
      u32[peerPte]=payload.first*P|3;u32[peerPte+1]=(payload.first+1)*P|3;
      peers.push(spawnPeer({bytes,memory,root:peerRoot,scratch:scratchPage.first*P,replica:replica(memory,5*P+(i+2)*64,peerRoot),barrier,cycles:128,identity:i+1,maximumPages:128}));
    }
    phase('peers-constructing');await Promise.all(peers.map(peer=>peer.ready));phase('peers-ready');Atomics.store(flags,0,1);Atomics.notify(flags,0,4);phase('barrier-released');
    let hostOk=true;
    for(let i=0;i<512;i++) {
      const extent=pool.allocateContiguous(1);
      if(!extent){hostOk=false;break;}
      if(u32[extent.first*P/4]!==0)hostOk=false;
      u32[extent.first*P/4]=0xabcdef;pool.releaseRetiredPages([extent.first]);
    }
    phase('host-allocation-loop-finished');const results=await Promise.all(peers.map(peer=>peer.done));phase('peers-finished');
    check('four real C Workers complete 512 grow/retire cycles',results.every(result=>result.passed&&result.cycles===128));
    check('host allocation reuses zeroed pages during C growth',hostOk);
    check('concurrent growth retains only roots and live mappings',pool.snapshot().allocatedPages===33);
    check('concurrent C and host allocation keep a bounded physical extent',pool.snapshot().physicalExtentPages===64&&pool.snapshot().highWaterPages<=64);
  if(terminateBeforeGrowth){phase('peer-stop-begin');await Promise.all(peers.map(peer=>peer.stop()));phase('peer-stop-ended');}
  phase('reserve-existing-begin');const temporary=[];
  while(pool.snapshot().allocatedPages<64)temporary.push(pool.allocateContiguous(1).first);
  phase('reserve-existing-ended');phase('physical-grow-before');check('C grow extends physical storage when reusable pages are exhausted',e.grow(1)===4&&memory.buffer.byteLength===65*P);
  phase('physical-grow-returned');check('C grow publishes zeroed storage to another attached instance',second.size()===5&&second.read32(4*P)===0);
  check('host pool refreshes views after C physical growth',pool.snapshot().physicalExtentPages===65&&pool.snapshot().highWaterPages===65);
  const grown=u32[pte+4]>>>16;u32[pte+4]=0;Atomics.store(u32,root/4,4);pool.releaseRetiredPages([grown,...temporary]);
  }finally{phase('final-peer-stop-begin');await Promise.all(peers.map(peer=>peer.stop()));phase('final-peer-stop-ended');}
  phase('limited-memory-begin');const limitedMemory=new WebAssembly.Memory({initial:2,maximum:5,shared:true});
  const limitedPool=MemoryGroupPagePool.initialize(limitedMemory,8);limitedPool.allocateContiguous(4);
  phase('limited-pool-ready');const limitedWords=new Uint32Array(limitedMemory.buffer);limitedWords[root/4]=2;limitedWords[root/4+1]=32;limitedWords[root/4+2]=P;limitedWords[root/4+14]=1;
  limitedWords[pte]=4*P|3;limitedWords[pte+1]=4*P|3;
  const limited=(await WebAssembly.instantiate(bytes,{'kandelo.memory-group.v3':{memory:limitedMemory}})).instance.exports;
  phase('limited-instance-ready');limited.__vm_root.value=root;limited.__vm_scratch.value=2*P+64;limited.__vm_replica.value=replica(limitedMemory,2*P,root);limited.__vm_initialize(1);
  phase('limited-initialized');const refusedBefore=JSON.stringify(limitedPool.snapshot());
  check('C physical grow failure preserves logical size',(limited.grow(1)>>>0)===0xffffffff&&limited.size()===2);
  phase('limited-grow-returned');check('C physical grow failure preserves pool state and releases locks',JSON.stringify(limitedPool.snapshot())===refusedBefore&&limitedWords[root/4+13]===0&&limitedWords[pte+2]===0);
  u32[root/4+14]=0;trap('stop escapes before source function work',()=>e.write32(60000,1));
  check('stopped instance did not modify guest storage',u32[(4*P+60000)/4]===99);
  phase('fixture-finished');return {checks,scope:'C translation and page-pool mechanisms with synthetic retirement; no normal grouped launch, lifecycle-fence or sustained desktop claim'};
}
