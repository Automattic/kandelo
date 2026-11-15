// Private mapped-payload reuse experiment. The owning kernel Worker retains
// every root explicitly, including exited roots. It never infers retirement
// from a WeakRef, process-table removal, lease release or elapsed time.
//
// Only pages removed at successful mapping boundaries become candidates.
// Other roots and pending asynchronous fork snapshots pin their backing.
// This assumes the prototype's one Worker/process, stopped during remapping;
// guest memory.grow still uses the disjoint monotonic C allocator.
export function reuseUnmappedSource(source) {
  const once=(before,after)=>{
    if(source.split(before).length!==2)throw Error('unmapped reuse anchor mismatch: '+before);
    source=source.replace(before,after);
  };
  once('this.handles = new Map();',`this.handles = new Map();
    this.reuseRoots = memory ? null : new Map();
    this.reusePins = new Map();
    this.reuseFree = [];
    this.reuseCounters = {sweeps:0,candidates:0,reclaimedPages:0,reusedPages:0,rootHeldPages:0,snapshotHeldPages:0};`);
  once('const first=h[1], end=first+pages;',`if(this.reuseRoots && pages) {
        const index=this.reuseFree.findIndex(block=>block.pages>=pages);
        if(index!==-1) {
          const block=this.reuseFree[index], first=block.first;
          // Clear the whole extent before any PTE, root or scratch publication.
          new Uint8Array(this.memory.buffer,first*PAGE,pages*PAGE).fill(0);
          block.first+=pages;block.pages-=pages;
          if(!block.pages)this.reuseFree.splice(index,1);
          this.reuseCounters.reusedPages+=pages;
          return first*PAGE;
        }
      }
      const first=h[1], end=first+pages;`);
  once('const handle=new VirtualMemory(this,root,scratch,true);',`const handle=new VirtualMemory(this,root,scratch,true);
    if(!this.reuseRoots)throw Error('only the owning kernel realm may create a reuse root');
    this.reuseRoots.set(root,{root,maximum,rootPages:Math.ceil((HEADER+4*maximum)/PAGE),scratch,scratchPages:this.scratchBytes/PAGE});`);
  once('  create(initial, maximum',`  reuseStats() {
    return {...this.reuseCounters,rootsTracked:this.reuseRoots?.size??0,
      pendingSnapshots:this.reusePins.size,freePages:this.reuseFree.reduce((n,b)=>n+b.pages,0)};
  }
  reclaimUnmapped(entries) {
    if(!this.reuseRoots)throw Error('only the owning kernel realm may recycle mappings');
    const candidates=new Set([...entries].map(e=>(e&-PAGE)>>>0).filter(Boolean));
    if(!candidates.size)return;
    const live=new Set([0]), pinned=new Set();
    for(const record of this.reuseRoots.values()) {
      for(let i=0;i<record.rootPages;i++)live.add(record.root+i*PAGE);
      for(let i=0;i<record.scratchPages;i++)live.add(record.scratch+i*PAGE);
      const pages=new Uint32Array(this.memory.buffer,record.root,1)[0];
      if(pages>record.maximum)throw Error('invalid tracked reuse root');
      // A peer can publish monotonic growth concurrently. Newly grown pages
      // cannot name an old unmapped candidate; all remapping is serialized in
      // this kernel realm. Mapping payloads remain live, never snapshotted.
      const table=new Uint32Array(this.memory.buffer,record.root+HEADER,pages);
      for(const entry of table)if(entry&-PAGE)live.add((entry&-PAGE)>>>0);
    }
    for(const pages of this.reusePins.values())for(const physical of pages)pinned.add(physical);
    this.reuseCounters.sweeps++;this.reuseCounters.candidates+=candidates.size;
    const eligible=[];
    for(const physical of candidates) {
      if(live.has(physical))this.reuseCounters.rootHeldPages++;
      else if(pinned.has(physical))this.reuseCounters.snapshotHeldPages++;
      else eligible.push(physical/PAGE);
    }
    // Preflight every candidate before changing the free list. Double release
    // is an integrity error, never permission to allocate overlapping pages.
    const high=new Uint32Array(this.memory.buffer,4096,3)[1];
    for(const first of eligible) {
      if(first<=0 || first>=high)throw Error('unallocated reuse candidate');
      if(this.reuseFree.some(b=>first>=b.first&&first<b.first+b.pages))throw Error('duplicate reuse candidate');
    }
    const blocks=[...this.reuseFree,...eligible.map(first=>({first,pages:1}))].sort((a,b)=>a.first-b.first);
    const merged=[];
    for(const block of blocks) {
      const prior=merged.at(-1);
      if(prior&&prior.first+prior.pages===block.first)prior.pages+=block.pages;
      else merged.push({...block});
    }
    this.reuseFree=merged;this.reuseCounters.reclaimedPages+=eligible.length;
  }
  pinForkSnapshot(snapshot,entries) {
    if(!this.reuseRoots)throw Error('fork snapshot must belong to the owning kernel realm');
    this.reusePins.set(snapshot,new Set([...entries].filter(e=>e&4).map(e=>(e&-PAGE)>>>0).filter(Boolean)));
  }
  finishForkSnapshot(snapshot) {
    const pins=this.reusePins.get(snapshot);
    if(!pins)throw Error('fork snapshot pin already consumed');
    this.reusePins.delete(snapshot);
    // Successful copy has already published the child's PTEs. Abandoned or
    // failed snapshots intentionally stay pinned until explicit cancellation
    // ownership is implemented; this prototype never guesses their lifetime.
    this.reclaimUnmapped([...pins]);
  }
  create(initial, maximum`);
  once('    this.privatePages=new Map();','    this.privatePages=new Map();\n    memory.group.pinForkSnapshot(this,this.entries);');
  once('  dst.fresh=false;','  if(captured)dst.group.finishForkSnapshot(source);\n  dst.fresh=false;');
  once("  const next=mappingPages(memory,address,kind==='mmap'?args[1]:args[2]);",`  const next=mappingPages(memory,address,kind==='mmap'?args[1]:args[2]);
  const discarded=[...memory.table().slice(next.first,next.first+next.count)];`);
  once('  mappingTrace(memory,kind,[address,...args]);',"  if(!memory.group.reuseRoots)throw Error('mapping mutation requires owning kernel realm');\n  mappingTrace(memory,kind,[address,...args]);");
  once("  mappingTrace(memory,'unmap',[address,length]);","  if(!memory.group.reuseRoots)throw Error('mapping mutation requires owning kernel realm');\n  mappingTrace(memory,'unmap',[address,length]);");
  once("  mappingTrace(memory,'protect',[address,length,protection]);","  if(!memory.group.reuseRoots)throw Error('mapping mutation requires owning kernel realm');\n  mappingTrace(memory,'protect',[address,length,protection]);");
  once('    entries=memory.table().slice(old.first,old.first+Math.min(old.count,next.count));','    discarded.push(...memory.table().slice(old.first,old.first+old.count));\n    entries=memory.table().slice(old.first,old.first+Math.min(old.count,next.count));');
  once("  for(let i=0;i<next.count;i++) table[next.first+i]=i<preserved?entries[i]:(physical+(i-preserved)*PAGE)|(kind==='mmap'?3:flags);",`  for(let i=0;i<next.count;i++) table[next.first+i]=i<preserved?entries[i]:(physical+(i-preserved)*PAGE)|(kind==='mmap'?3:flags);
  memory.group.reclaimUnmapped(discarded);`);
  once('  memory.table().fill(0,first,first+count);',`  const discarded=memory.table().slice(first,first+count);
  memory.table().fill(0,first,first+count);
  memory.group.reclaimUnmapped(discarded);`);
  once('    physicalMaximumBytes:', '    unmappedReuse:[...backing].map(g=>g.reuseStats()),\n    physicalMaximumBytes:');
  return source;
}
