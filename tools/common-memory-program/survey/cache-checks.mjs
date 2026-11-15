import {ProgramGroup,PAGE} from '../runtime.mjs';
import {VirtualGroup,vmConstruct,vmCopyFork,vmEnsureMapping,vmCommitMapping,vmUnmap,vmTrackAnonymous} from '../platform/memory.mjs';
const must=(ok,message)=>{if(!ok)throw Error(message);};
const trap=fn=>{try{fn();}catch(error){if(error instanceof WebAssembly.RuntimeError)return;throw error;}throw Error('expected mapping trap');};

// These checks execute actual translated instructions after warming the
// mapping being changed. Host-only view checks cannot expose a stale guest
// translation cache. No payload is copied into the cache.
export function runCacheCoherency(canary,access) {
  const cached=JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(access,'kandelo.common-memory.prototype')[0])).mappingCache;
  const group=new VirtualGroup(undefined,{maximumPages:1024,scratchBytes:PAGE});
  const a=group.create(2,16), e=vmConstruct(WebAssembly.Instance,access,{env:{memory:a}}).exports;
  const header=m=>new Uint32Array(group.memory.buffer,m.root,16);
  e.i32_store(128,11);must(e.i32_load(128)===11,'initial load');
  e.atomic_store(64,7n);must(e.atomic_load(64)===7n,'atomic warm');
  if(cached)must([5,8].some(i=>header(a)[i]===header(a)[4]),'cache was not populated');
  vmCommitMapping(a,0,PAGE,1);
  trap(()=>e.atomic_add(64,1n));must(e.atomic_load(64)===7n,'denied atomic changed data');
  trap(()=>e.i32_store(128,99));must(e.i32_load(128)===11,'denied write changed data');
  vmCommitMapping(a,0,PAGE,0);trap(()=>e.i32_load(128));
  vmCommitMapping(a,0,PAGE,2);e.i32_store(128,7);trap(()=>e.i32_load(128));
  vmCommitMapping(a,0,PAGE,3);must(e.i32_load(128)===7,'rights upgrade');
  e.i32_store(PAGE+128,101);vmTrackAnonymous(a,PAGE,PAGE,1);trap(()=>e.i32_store(PAGE+128,103));
  vmTrackAnonymous(a,PAGE,PAGE,3);
  const b=group.create(2,16),child=vmConstruct(WebAssembly.Instance,access,{env:{memory:b}}).exports;
  must(child.i32_load(PAGE+128)===0,'destination cache warm before fork copy');
  vmCopyFork(b.buffer,a.buffer);
  must(child.i32_load(128)===7,'child copied private state');
  child.i32_store(128,8);must(e.i32_load(128)===7,'child private cache used parent mapping');
  must(child.i32_load(PAGE+128)===101,'shared cache warm');
  e.i32_store(PAGE+128,102);must(child.i32_load(PAGE+128)===102,'shared cache retained stale payload');
  vmEnsureMapping(b,'mmap',PAGE,[0,PAGE,3,0x32,-1,0]);
  must(child.i32_load(PAGE+128)===0&&e.i32_load(PAGE+128)===102,'MAP_FIXED backing detachment');
  child.i32_store(PAGE+128,44);
  vmEnsureMapping(b,'mremap',6*PAGE,[PAGE,PAGE,2*PAGE]);
  trap(()=>child.i32_load(PAGE+128));
  must(child.i32_load(6*PAGE+128)===44&&child.i32_load(7*PAGE+128)===0,'mremap contents/tail');
  vmUnmap(b,6*PAGE,PAGE);trap(()=>child.i32_load(6*PAGE+128));
  trap(()=>child.i32_load(5*PAGE+128));
  const epoch=header(b)[4];b.grow(1);must(header(b)[4]===epoch+1,'host growth did not advance epoch');
  must(child.i32_load(8*PAGE+128)===0,'host growth zero fill');
  header(b)[4]=0xffffffff;child.i32_store(128,55);must(child.i32_load(128)===55,'wrap cache warm');
  vmCommitMapping(b,0,PAGE,1);must(header(b)[4]===0,'epoch wrap must disable cache');
  trap(()=>child.i32_store(128,56));
  vmEnsureMapping(b,'mmap',0,[0,PAGE,3,0x32,-1,0]);
  must(header(b)[4]===0&&child.i32_load(128)===0,'disabled cache resurrected stale mapping');
  // A legacy root has epoch zero. The new helpers must remain correct with
  // caching disabled, even if a legacy host changes a PTE without an epoch.
  const legacy=group.create(2,16);header(legacy)[4]=0;
  const le=vmConstruct(WebAssembly.Instance,access,{env:{memory:legacy}}).exports;
  le.i32_store(128,99);must(le.i32_load(128)===99,'legacy warm');
  legacy.table()[0]=group.allocate(1)|3;
  must(le.i32_load(128)===0,'legacy cache must remain disabled');

  const standalone=new ProgramGroup({initialPages:16,maximumPages:128,scratchBytes:PAGE});
  const c=standalone.create(canary), ce=c.exports;
  const root=new Uint32Array(standalone.memory.buffer,c.root,16);
  ce.store32(128,17);must(ce.load32(128)===17,'guest growth warm');
  const before=root[4];must(ce.grow(1)===2,'guest growth result');
  if(cached)must(root[4]===before+1,'guest growth did not advance epoch');
  const after=root[4];ce.grow(0);ce.grow(0xffffffff);
  must(root[4]===after,'zero/failed guest growth changed epoch');
  must(ce.load32(2*PAGE)===0,'guest growth zero fill');
  if(cached) {
    root[4]=0xffffffff;ce.load32(128);ce.grow(1);
    must(root[4]===0,'guest growth wrap did not disable cache');
    standalone.map(c,0,standalone.alloc(1));
    must(root[4]===0&&ce.load32(128)===0,'guest wrap resurrected a cache entry');
  }
  return {passed:true,cacheEnabled:!!cached,checks:['warmed read/write permission changes','PROT_NONE/write-only','fork private mappings and live shared payload',
    'MAP_FIXED detachment','mremap old fault, preserved bytes and zero tail','unmap and holes','host/guest growth','epoch wrap permanent disable','legacy root cache bypass']};
}
