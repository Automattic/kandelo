export function runAffineCacheChecks(m, bytes) {
  let checks = 0;
  const check = (value, name) => { if (!value) throw Error(name); checks++; };
  const trap = fn => { let hit=false;try{fn();}catch(e){if(!(e instanceof WebAssembly.RuntimeError))throw e;hit=true;}check(hit,'expected trap'); };
  const PAGE=65536, group=new m.VirtualGroup(undefined,{maximumPages:1024,scratchBytes:PAGE});
  const memory=group.create(6,65536), module=new WebAssembly.Module(bytes);
  const instantiate=target=>m.vmConstruct(WebAssembly.Instance,module,{env:{memory:target}}).exports;
  const e=instantiate(memory),words=(p,n)=>m.vmConstruct(Uint32Array,memory.buffer,p,n);
  e.store32(64,11);check(e.load32(64)===11,'prefix data');
  check(new Uint32Array(group.memory.buffer,memory.root+28,1)[0]===6,'bound prefix descriptor');
  const oldPhysical=(memory.table()[0]&-PAGE)>>>0, replacement=group.allocate(1);
  new Uint32Array(group.memory.buffer,replacement+64,1)[0]=77;
  memory.table()[0]=replacement|3;
  // Expected stale access is a NEGATIVE publication control: a cache hit
  // really bypasses PTEs. Untracked PTE writes violate the admitted protocol.
  check(e.load32(64)===11,'negative control proves cached physical path');
  memory.invalidateMappings();check(e.load32(64)===77,'published remap refreshes');
  m.vmCommitMapping(memory,0,PAGE,1);trap(()=>e.store32(64,99));check(e.load32(64)===77,'read-only fallback');
  m.vmCommitMapping(memory,0,PAGE,3);
  m.vmTrackAnonymous(memory,PAGE,2*PAGE,3);e.store32(PAGE+64,123);
  check(e.load32(PAGE+64)===123,'shared window data');
  check(new Uint32Array(group.memory.buffer,memory.root+32,2).join(',')==='1,3','shared descriptor');
  const child=group.create(memory.pages,65536);m.vmCopyFork(child.buffer,memory.buffer);const ec=instantiate(child);
  check(ec.load32(64)===77,'child initially reads copied private data');ec.store32(64,88);
  check(e.load32(64)===77&&ec.load32(64)===88,'fresh child globals bind its own private base');
  ec.store32(PAGE+64,456);check(e.load32(PAGE+64)===456,'shared payload is not cached');
  memory.table()[4]=memory.table()[0];memory.invalidateMappings();check(e.load32(4*PAGE+64)===77,'private alias fallback');
  memory.table()[4]=(oldPhysical+4*PAGE)|3;memory.invalidateMappings();
  words(PAGE-8,4).set([1,2,3,4]);check(e.load_vector_byte(PAGE-8)===1,'split SIMD original path');
  m.vmCommitMapping(memory,PAGE,PAGE,1);trap(()=>e.store32(PAGE-2,0x12345678));
  check(Array.from(m.vmConstruct(Uint8Array,memory.buffer,PAGE-2,4)).join(',')==='0,0,3,0','denied split store preserves all bytes');
  m.vmCommitMapping(memory,PAGE,PAGE,3);
  memory.grow(1);check(e.grow(1)===7,'guest grow after host grow');check(e.load32(7*PAGE)===0,'grown page read');
  const header=new Uint32Array(group.memory.buffer,memory.root,16),pages=header[0];e.load32(64);
  header[0]=0;trap(()=>e.load32(64));header[0]=pages;check(e.load32(64)===77,'logical-size shrink and restore without epoch');
  m.vmCommitMapping(memory,3*PAGE,PAGE,0);trap(()=>e.load32(3*PAGE));m.vmCommitMapping(memory,3*PAGE,PAGE,3);
  m.vmUnmap(memory,3*PAGE,PAGE);trap(()=>e.load32(3*PAGE));
  m.vmEnsureMapping(memory,'mmap',3*PAGE,[0,PAGE,3]);check(e.load32(3*PAGE)===0,'MAP_FIXED replacement zero');e.store32(3*PAGE,55);
  m.vmEnsureMapping(memory,'mremap',4*PAGE,[3*PAGE,PAGE,PAGE]);check(e.load32(4*PAGE)===55,'mremap target');trap(()=>e.load32(3*PAGE));
  trap(()=>e.load8_max(1));check(e.load32_small(48)===77,'constant offset');
  check(e.float64(128,1.25)===1.25,'float values');check(e.atomic_add(4*PAGE,1)===55,'atomic original path');trap(()=>e.atomic_add(4*PAGE+1,1));
  header[4]=0xffffffff;memory.invalidateMappings();check(header[4]===0,'epoch wraps to disabled');
  memory.table()[0]=oldPhysical|3;check(e.load32(64)===11,'epoch-zero fallback reads live PTE');memory.invalidateMappings();check(header[4]===0,'disabled epoch stays disabled');
  const root=e.__vm_root.value;e.__vm_root.value=0;trap(()=>e.load32(64));e.__vm_root.value=root;
  return{passed:true,checks,scope:'Scalar window hits and exact fallback; explicit expected stale-data negative control for untracked PTE writes, then correct published remap. Permissions, alias/scatter/SIMD/atomic paths, size/growth, root/epoch/wrap, fork-private rebinding and live shared data. Not support for untracked/concurrent remaps or mixed header strategies.'};
}
