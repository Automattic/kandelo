// Runs only in a disposable Worker in browsers. This is a first-pass ownership
// and allocation experiment, not general concurrent mmap or retirement proof.
export async function runReuseChecks(M,growModule) {
 const PAGE=65536,group=new M.VirtualGroup(undefined,{maximumPages:1024,scratchBytes:PAGE});
 const reuse=typeof group.reuseStats==='function';let checks=0;const cases=[];
 const ok=(condition,label)=>{checks++;if(!condition)throw Error(label);};
 const throws=(fn,pattern,label)=>{let error;try{fn();}catch(e){error=e;}ok(error&&pattern.test(String(error)),label);};
 const root=()=>group.create(0,64),map=(m,page,pages=1)=>M.vmEnsureMapping(m,'mmap',page*PAGE,[0,pages*PAGE,3,0x32,-1,0]);
 const unmap=(m,page,pages=1)=>M.vmUnmap(m,page*PAGE,pages*PAGE),physical=(m,page)=>(m.table()[page]&-PAGE)>>>0;
 const read=(m,page=0)=>m.read(page*PAGE,1)[0],write=(m,page,v)=>m.write(page*PAGE,Uint8Array.of(v));
 const high=()=>new Uint32Array(group.memory.buffer,4096,3)[1];
 const free=address=>reuse&&group.reuseFree.some(b=>address/PAGE>=b.first&&address/PAGE<b.first+b.pages);
 const a=root();map(a,0,2);const before=high();let previous=physical(a,0);
 for(let i=0;i<64;i++) {a.write(0,new Uint8Array(2*PAGE).fill(37));unmap(a,0,2);map(a,0,2);ok(a.read(0,2*PAGE).every(v=>v===0),'reused mapping must zero all pages');if(reuse)ok(physical(a,0)===previous,'contiguous free extent should be reused');previous=physical(a,0);}
 const pumpGrowthPages=high()-before;ok(reuse?pumpGrowthPages===0:pumpGrowthPages===128,'bounded mapped churn allocation control');cases.push('64 map/unmap cycles: zero-fill and bounded high-water');

 const alias=root();map(alias,0);write(alias,0,45);const aliased=physical(alias,0);alias.table()[1]=alias.table()[0];new Uint32Array(group.memory.buffer,alias.root,1)[0]=2;
 unmap(alias,0);ok(read(alias,1)===45&&!free(aliased),'other VA alias pins private backing');unmap(alias,1);if(reuse)ok(free(aliased),'last VA alias releases backing');cases.push('private aliases pin backing until last mapping');

 const parent=root();map(parent,0);M.vmTrackAnonymous(parent,0,PAGE,3);write(parent,0,55);
 const child=group.create(parent.pages,64,true);ok(M.vmCopyFork(child.buffer,parent.buffer),'fork copy');const shared=physical(child,0);
 unmap(parent,0);ok(!free(shared),'child pins inherited shared page');map(parent,0);ok(physical(parent,0)!==shared,'replacing parent mapping cannot reuse child backing');write(child,0,56);ok(read(parent)===0&&read(child)===56,'shared child survives parent replacement');
 unmap(child,0);if(reuse)ok(free(shared),'last shared PTE releases backing');cases.push('fork-inherited shared mapping and MAP_FIXED replacement');

 const snapParent=root();map(snapParent,0,2);M.vmTrackAnonymous(snapParent,PAGE,PAGE,3);write(snapParent,0,61);write(snapParent,1,71);
 const privateSource=physical(snapParent,0),sharedSource=physical(snapParent,1),snapshot=M.vmForkSnapshot(snapParent.buffer,snapParent.buffer.byteLength);
 unmap(snapParent,0,2);ok(!free(sharedSource),'pending snapshot pins shared bytes after parent unmap');if(reuse)ok(free(privateSource),'snapshot private copy does not need original physical page');
 map(snapParent,0);write(snapParent,0,99);
 const snapChild=group.create(2,64,true);ok(M.vmCopyFork(snapChild.buffer,snapshot),'captured fork copy');ok(read(snapChild)===61&&read(snapChild,1)===71,'snapshot private bytes and live shared bytes preserved through reuse');
 if(reuse)ok(group.reuseStats().pendingSnapshots===0,'successful copy consumes its snapshot pin');
 unmap(snapChild,1);if(reuse)ok(free(sharedSource),'shared snapshot page recyclable after child unmap');cases.push('async fork snapshot: copied private bytes and live shared pins');

 const abandoned=root();map(abandoned,0);M.vmTrackAnonymous(abandoned,0,PAGE,3);const retained=physical(abandoned,0);M.vmForkSnapshot(abandoned.buffer,abandoned.buffer.byteLength);unmap(abandoned,0);
 if(reuse)ok(!free(retained)&&group.reuseStats().pendingSnapshots===1,'uncompleted snapshot intentionally retains backing');cases.push('uncompleted snapshot remains pinned without GC inference');

 const remap=root();map(remap,0,3);write(remap,0,81);write(remap,1,82);write(remap,2,83);const p0=physical(remap,0),p2=physical(remap,2);
 M.vmEnsureMapping(remap,'mremap',4*PAGE,[0,3*PAGE,2*PAGE]);ok(physical(remap,4)===p0&&read(remap,4)===81&&read(remap,5)===82,'moving shrink preserves retained bytes');if(reuse)ok(free(p2)&&!free(p0),'shrinking releases only discarded tail');
 M.vmCommitMapping(remap,4*PAGE,PAGE,0);ok(!free(p0),'PROT_NONE keeps backing mapped');throws(()=>read(remap,4),/permissions/,'PROT_NONE denies access');
 M.vmCommitMapping(remap,4*PAGE,PAGE,3);ok(read(remap,4)===81,'protection restoration retains payload');cases.push('mremap shrink and PROT_NONE lifetime');

 const chunk=root();map(chunk,0,16);unmap(chunk,0,16);const guest=root(),guestBefore=high();
 const instance=await WebAssembly.instantiate(growModule,{env:{memory:group.memory}});
 ok(instance.exports.vm_grow(3,guest.root)===0,'actual compiled guest allocator grows');ok(high()===guestBefore+3,'guest allocator remains monotonic');
 const guestPages=[0,1,2].map(p=>physical(guest,p));map(chunk,0,2);ok(!guestPages.includes(physical(chunk,0))&&read(guest)===0,'reused host extent cannot overlap guest allocation');
 throws(()=>map(chunk,64),/ceiling/,'invalid map fails');cases.push('actual C guest growth stays disjoint from host free extents');

 if(reuse) {
  const remote=new M.VirtualGroup(group.memory,{maximumPages:1024,scratchBytes:PAGE}),remoteHandle=new M.VirtualMemory(remote,chunk.root,chunk.scratch,false),entries=chunk.table().slice();
  throws(()=>M.vmUnmap(remoteHandle,0,PAGE),/owning kernel/,'remote realm cannot recycle');ok(chunk.table().every((v,i)=>v===entries[i]),'remote rejection precedes PTE mutation');
  const trash=root();map(trash,0);const old=trash.table()[0];unmap(trash,0);throws(()=>group.reclaimUnmapped([old]),/duplicate/,'double free rejected');
  cases.push('owner-only mutation and double-free negatives');
 }
 return{passed:true,scope:'Mapped-payload reuse only; roots, scratch and uncompleted snapshots remain pinned. Not full process retirement, concurrent remap or RSS proof.',reuse,checks,cases,pumpGrowthPages,allocatorHighWaterBytes:high()*PAGE,reuseStats:reuse?group.reuseStats():null};
}
