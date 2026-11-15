// Experimental host-side virtual buffers. These are deliberately not native
// ArrayBuffers. The profile compiler adapts consumers; an unadapted consumer
// must fail rather than silently read the physical group at a guest offset.
const PAGE = 65536, HEADER = 64, WIRE = '__kandelo_common_memory_wire_v1';
const typed = [Uint8Array, Int8Array, Uint8ClampedArray, Uint16Array, Int16Array,
  Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
const nativeAtomics = Atomics;
const nativeMemoryBuffer=Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer').get;
const nativeArrayByteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const nativeSharedByteLength=Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,'byteLength').get;
const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const virtualMethods=new Map();
for(const prototype of [DataView.prototype,typedPrototype]) {
  for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) {
    if(typeof descriptor.value==='function') virtualMethods.set(descriptor.value,name);
    if(typeof descriptor.get==='function') virtualMethods.set(descriptor.get,name);
  }
}
let allocationGroup;
const groups = new WeakMap();
export function vmGroupStats(memories) {
  const backing=new Set(),privatePages=new Set(),sharedPages=new Set();
  let virtualBytes=0,nativeLinearBytes=0,roots=0;
  for(const memory of new Set(memories)) {
    if(memory instanceof VirtualMemory) {
      roots++;virtualBytes+=memory.pages*PAGE;backing.add(memory.group);
      for(const entry of memory.table().subarray(0,memory.pages)) {
        const physical=(entry&-PAGE)>>>0;
        if(physical) (entry&4?sharedPages:privatePages).add(physical);
      }
    } else if(memory instanceof WebAssembly.Memory) nativeLinearBytes+=memory.buffer.byteLength;
  }
  return {roots,groups:backing.size,virtualBytes,nativeLinearBytes,
    physicalBufferBytes:[...backing].reduce((n,g)=>n+g.memory.buffer.byteLength,0),
    physicalAllocatedBytes:[...backing].reduce((n,g)=>n+new Uint32Array(g.memory.buffer,4096,3)[1]*PAGE,0),
    physicalMaximumBytes:[...backing].reduce((n,g)=>n+g.maximumPages*PAGE,0),
    privatePteBytes:privatePages.size*PAGE,sharedPteBytes:sharedPages.size*PAGE};
}
function mappingTrace(memory,operation,args) {
  if(typeof process!=='undefined' && process.env.KANDELO_VM_MAPPING_TRACE==='1')
    console.error('virtual mapping',memory.root,operation,JSON.stringify(args));
}

function integer(n, label) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`virtual ${label}: ${n}`);
  return n;
}
function relative(n, length, defaultValue) {
  if (n === undefined) return defaultValue;
  n = Math.trunc(Number(n)) || 0;
  return n < 0 ? Math.max(length+n,0) : Math.min(n,length);
}
function numericKey(key) {
  if(typeof key!=='string') return null;
  const n=Number(key);
  if(key!=='-0' && String(n)!==key) return null;
  return {index:n,valid:Number.isInteger(n) && n>=0 && key!=='-0'};
}
export class VirtualGroup {
  constructor(memory, { maximumPages = 8192, scratchBytes = 8*1024*1024 } = {}) {
    this.memory = memory ?? new WebAssembly.Memory({ initial: 1024, maximum: maximumPages, shared: true });
    this.maximumPages = maximumPages;
    this.scratchBytes = scratchBytes;
    this.handles = new Map();
    if (!memory) new Uint32Array(this.memory.buffer, 4096, 3).set([0,1,maximumPages]);
    groups.set(this.memory, this);
  }
  allocate(pages) {
    integer(pages, 'allocation');
    const h = new Int32Array(this.memory.buffer,4096,3);
    if (nativeAtomics.compareExchange(h,0,0,1)) throw Error('common-memory allocator busy');
    try {
      const first=h[1], end=first+pages;
      if (end > h[2]) throw new RangeError('common-memory physical capacity');
      const size=this.memory.buffer.byteLength/PAGE;
      if (end>size) this.memory.grow(end-size);
      h[1]=end;
      return first*PAGE;
    } finally { nativeAtomics.store(h,0,0); }
  }
  create(initial, maximum) {
    integer(initial,'initial pages'); integer(maximum,'maximum pages');
    if (initial>maximum || maximum>65536) throw new RangeError('common-memory virtual ceiling');
    const root=this.allocate(Math.ceil((HEADER+4*maximum)/PAGE));
    const scratch=this.allocate(this.scratchBytes/PAGE);
    // Reserved word4 enables epoch-aware mapping caches. Zero means disabled,
    // including legacy roots and roots whose epoch has wrapped.
    new Uint32Array(this.memory.buffer,root,5).set([initial,maximum,this.scratchBytes,0,1]);
    const handle=new VirtualMemory(this,root,scratch,true);
    if (initial) {
      const base=this.allocate(initial);
      const table=handle.table();
      for(let i=0;i<initial;i++) table[i]=base+i*PAGE|3;
    }
    return handle;
  }
}
export class VirtualMemory {
  constructor(group,root,scratch,fresh) {
    this.group=group; this.root=root; this.scratch=scratch; this.fresh=fresh;
    this.cachedBuffer=null;
    group.handles.set(root,new WeakRef(this));
  }
  get pages() { return new Uint32Array(this.group.memory.buffer,this.root,1)[0]; }
  get maximumPages() { return new Uint32Array(this.group.memory.buffer,this.root+4,1)[0]; }
  table() { return new Uint32Array(this.group.memory.buffer,this.root+HEADER,this.maximumPages); }
  invalidateMappings() {
    const epoch=new Uint32Array(this.group.memory.buffer,this.root+16,1);
    if(epoch[0]) epoch[0]=(epoch[0]+1)>>>0;
  }
  get buffer() {
    const size=this.pages*PAGE;
    if (!this.cachedBuffer || this.cachedBuffer.byteLength!==size) this.cachedBuffer=new VirtualBuffer(this,size);
    return this.cachedBuffer;
  }
  grow(delta) {
    integer(delta,'growth'); const old=this.pages;
    if(delta>this.maximumPages-old) throw new RangeError('virtual memory maximum');
    if (!delta) return old;
    const base=this.group.allocate(delta), table=this.table();
    this.invalidateMappings();
    for(let i=0;i<delta;i++) table[old+i]=base+i*PAGE|3;
    new Uint32Array(this.group.memory.buffer,this.root,1)[0]=old+delta;
    return old;
  }
  spans(offset,length,rights,limit=this.pages*PAGE) {
    integer(offset,'offset'); integer(length,'length');
    if(offset>limit || length>limit-offset) throw new RangeError('virtual memory bounds');
    const spans=[], table=this.table(), physicalLength=this.group.memory.buffer.byteLength;
    for(let at=offset,end=offset+length;at<end;) {
      const entry=table[Math.floor(at/PAGE)];
      if((entry&rights)!==rights || !(entry&-PAGE)) throw new RangeError(`virtual memory permissions at ${at}`);
      const physical=((entry&-PAGE)>>>0)+at%PAGE, count=Math.min(PAGE-at%PAGE,end-at);
      if (physical>physicalLength-count) throw new RangeError('invalid physical page');
      const last=spans.at(-1);
      if(last && last.physical+last.length===physical) last.length+=count;
      else spans.push({ physical,length:count });
      at+=count;
    }
    return spans;
  }
  read(offset,length,limit) {
    const spans=this.spans(offset,length,1,limit), out=new Uint8Array(length);
    let at=0;
    for(const span of spans) { out.set(new Uint8Array(this.group.memory.buffer,span.physical,span.length),at); at+=span.length; }
    return out;
  }
  write(offset,bytes,limit) {
    const spans=this.spans(offset,bytes.byteLength,2,limit);
    // Snapshot before writing to preserve aliases/overlap across disjoint VAs.
    const copy=bytes.slice(); let at=0;
    for(const span of spans) { new Uint8Array(this.group.memory.buffer,span.physical,span.length).set(copy.subarray(at,at+span.length)); at+=span.length; }
  }
}
export class VirtualBuffer {
  constructor(memory,length) { this.memory=memory; this.byteLength=length; }
  get maxByteLength() { return this.memory.maximumPages*PAGE; }
  get growable() { return false; }
  slice(start,end) {
    start=relative(start,this.byteLength,0); end=relative(end,this.byteLength,this.byteLength);
    return this.memory.read(start,Math.max(end-start,0),this.byteLength).buffer;
  }
  [Symbol.iterator]() { throw Error('unadapted virtual buffer consumer'); }
  get length() { throw Error('unadapted virtual buffer consumer'); }
}

class VirtualDataView {
  constructor(buffer,offset=0,length=buffer.byteLength-offset) {
    integer(offset,'view offset'); integer(length,'view length');
    if(offset>buffer.byteLength || length>buffer.byteLength-offset) throw new RangeError('virtual DataView bounds');
    this.buffer=buffer; this.byteOffset=offset; this.byteLength=length;
  }
}
for(const name of Object.getOwnPropertyNames(DataView.prototype)) {
  const match=/^(get|set)(?:Big)?(?:U?Int|Uint|Int|Float)(8|16|32|64)$/.exec(name);
  if(!match || typeof DataView.prototype[name]!=='function') continue;
  const width=Number(match[2])/8, write=match[1]==='set';
  VirtualDataView.prototype[name]=function(offset,...args) {
    integer(offset,'DataView offset');
    if(offset>this.byteLength-width) throw new RangeError('virtual DataView bounds');
    const at=this.byteOffset+offset, memory=this.buffer.memory;
    const spans=memory.spans(at,width,write?2:1,this.buffer.byteLength);
    if(spans.length===1) return DataView.prototype[name].call(new DataView(memory.group.memory.buffer,spans[0].physical,width),0,...args);
    const copy=write?new Uint8Array(width):memory.read(at,width,this.buffer.byteLength);
    const result=DataView.prototype[name].call(new DataView(copy.buffer),0,...args);
    if(write) memory.write(at,copy,this.buffer.byteLength);
    return result;
  };
}

class VirtualTypedView {
  constructor(Ctor,buffer,offset=0,length) {
    const width=Ctor.BYTES_PER_ELEMENT;
    integer(offset,'typed view offset');
    if(offset%width || offset>buffer.byteLength) throw new RangeError('virtual typed-array alignment/bounds');
    if(length===undefined) {
      if((buffer.byteLength-offset)%width) throw new RangeError('virtual typed-array length');
      length=(buffer.byteLength-offset)/width;
    }
    integer(length,'typed view length');
    if(length>(buffer.byteLength-offset)/width) throw new RangeError('virtual typed-array bounds');
    for(const [name,value] of Object.entries({constructor:Ctor,buffer,byteOffset:offset,length,byteLength:length*width,BYTES_PER_ELEMENT:width}))
      Object.defineProperty(this,name,{value,configurable:true});
    return new Proxy(this,{
      get(target,key,receiver) {
        const numeric=numericKey(key);
        if(numeric) return numeric.valid?target.element(numeric.index):undefined;
        return Reflect.get(target,key,receiver);
      },
      set(target,key,value,receiver) {
        const numeric=numericKey(key);
        if(numeric) {
          if(numeric.valid) target.element(numeric.index,value,true); return true;
        }
        return Reflect.set(target,key,value,receiver);
      },
      has(target,key) {
        const numeric=numericKey(key);
        return numeric?numeric.valid && numeric.index<target.length:Reflect.has(target,key);
      },
      getOwnPropertyDescriptor(target,key) {
        const numeric=numericKey(key);
        if(numeric) return numeric.valid && numeric.index<target.length?
          {value:target.element(numeric.index),writable:true,enumerable:true,configurable:true}:undefined;
        return Reflect.getOwnPropertyDescriptor(target,key);
      },
      ownKeys(target) {return [...Array.from({length:target.length},(_,i)=>String(i)),...Reflect.ownKeys(target)];},
    });
  }
  element(index,value,write=false) {
    if(index>=this.length) return undefined;
    const memory=this.buffer.memory, at=this.byteOffset+index*this.BYTES_PER_ELEMENT;
    const spans=memory.spans(at,this.BYTES_PER_ELEMENT,write?2:1,this.buffer.byteLength);
    if(spans.length!==1) throw Error('aligned typed element crossed a page');
    const view=new this.constructor(memory.group.memory.buffer,spans[0].physical,1);
    if(write) view[0]=value; else return view[0];
  }
  subarray(start,end) {
    start=relative(start,this.length,0); end=relative(end,this.length,this.length);
    return new VirtualTypedView(this.constructor,this.buffer,this.byteOffset+start*this.BYTES_PER_ELEMENT,Math.max(end-start,0));
  }
  slice(start,end) { return this.constructor.from(this.subarray(start,end)); }
  set(source,offset=0) {
    integer(offset,'set offset');
    const copy=this.constructor.from(source);
    if(offset>this.length || copy.length>this.length-offset) throw new RangeError('virtual set bounds');
    this.buffer.memory.write(this.byteOffset+offset*this.BYTES_PER_ELEMENT,new Uint8Array(copy.buffer,copy.byteOffset,copy.byteLength),this.buffer.byteLength);
  }
  fill(value,start,end) {
    start=relative(start,this.length,0); end=relative(end,this.length,this.length);
    const count=Math.max(end-start,0), chunk=new this.constructor(Math.min(count,65536)); chunk.fill(value);
    // Validate the complete destination before any store.
    this.buffer.memory.spans(this.byteOffset+start*this.BYTES_PER_ELEMENT,count*this.BYTES_PER_ELEMENT,2,this.buffer.byteLength);
    for(let at=0;at<count;at+=chunk.length) this.set(chunk.subarray(0,Math.min(chunk.length,count-at)),start+at);
    return this;
  }
  copyWithin(target,start,end) {
    target=relative(target,this.length,0); start=relative(start,this.length,0); end=relative(end,this.length,this.length);
    const count=Math.min(Math.max(end-start,0),this.length-target);
    this.set(this.slice(start,start+count),target); return this;
  }
  *values() { for(let i=0;i<this.length;i++) yield this[i]; }
  *keys() { for(let i=0;i<this.length;i++) yield i; }
  *entries() { for(let i=0;i<this.length;i++) yield [i,this[i]]; }
  [Symbol.iterator]() { return this.values(); }
  get [Symbol.toStringTag]() { return this.constructor.name; }
  reverse() { const copy=this.slice(); copy.reverse(); this.set(copy); return this; }
  sort(compare) { const copy=this.slice(); copy.sort(compare); this.set(copy); return this; }
  toString() { return this.join(','); }
}
for(const name of ['every','some','forEach','find','findIndex','findLast','findLastIndex','includes','indexOf','lastIndexOf','join','reduce','reduceRight','at']) {
  VirtualTypedView.prototype[name]=function(...args) { return Array.prototype[name].apply(this,args); };
}
for(const name of ['map','filter']) {
  VirtualTypedView.prototype[name]=function(...args) { return this.constructor.from(Array.prototype[name].apply(this,args)); };
}

export function vmCreateProcessMemory(descriptor,enabled=false) {
  if(!enabled) return new WebAssembly.Memory(descriptor);
  if(descriptor.address==='i64') throw Error('common-memory profile currently requires memory32');
  allocationGroup ??=new VirtualGroup();
  return allocationGroup.create(descriptor.initial,descriptor.maximum);
}
export function vmAllocateBrowser(factory,request) {
  if(!request.commonMemoryPrototype) return factory.allocate(request);
  if(request.ptrWidth!==4) throw Error('common-memory profile currently requires memory32');
  // The kernel worker is a disposable realm and is the group's sole owner.
  // No backing or guest view is returned to the persistent browser page.
  return Promise.resolve(vmCreateProcessMemory({initial:request.initialPages,maximum:request.maximumPages,shared:true},true));
}
class VirtualForkSnapshot {
  constructor(source) {
    const memory=source.memory;
    this.group=memory.group;this.byteLength=source.byteLength;
    this.entries=memory.table().slice(0,this.byteLength/PAGE);
    this.privatePages=new Map();
    for(const entry of this.entries) {
      const physical=(entry&-PAGE)>>>0;
      if(physical && !(entry&4) && !this.privatePages.has(physical))
        this.privatePages.set(physical,new Uint8Array(memory.group.memory.buffer,physical,PAGE).slice());
    }
  }
}
export function vmForkSnapshot(source,length) {
  return source instanceof VirtualBuffer?new VirtualForkSnapshot(source):new ArrayBuffer(length);
}
export function vmCopyFork(destination,source) {
  // The browser allocator's asynchronous path captures before its first await.
  // Its ordinary subsequent copy call is already fulfilled by this immutable
  // private-page snapshot; shared entries intentionally retain live backing.
  if(destination instanceof VirtualForkSnapshot && source instanceof VirtualBuffer) return true;
  const captured=source instanceof VirtualForkSnapshot;
  if(!(destination instanceof VirtualBuffer) || !(source instanceof VirtualBuffer || captured)) return false;
  if(destination.byteLength!==source.byteLength) throw Error('fork virtual-size mismatch');
  const dst=destination.memory, src=source.memory, copies=new Map();
  if(dst.group.memory!==(captured?source.group.memory:src.group.memory)) throw Error('fork escaped its common-memory group');
  const entries=captured?source.entries:src.table().subarray(0,src.pages);
  dst.invalidateMappings();
  for(let i=0;i<entries.length;i++) {
    const entry=entries[i];
    if(!entry) { dst.table()[i]=0; continue; }
    if(entry&4) { dst.table()[i]=entry; continue; }
    const physical=(entry&-PAGE)>>>0;
    let target=copies.get(physical);
    if(target===undefined) {
      target=(dst.table()[i]&-PAGE)>>>0;
      new Uint8Array(dst.group.memory.buffer,target,PAGE).set(captured?source.privatePages.get(physical):new Uint8Array(src.group.memory.buffer,physical,PAGE));
      copies.set(physical,target);
    }
    dst.table()[i]=target|(entry&65535);
  }
  dst.fresh=false;
  return true;
}
export function vmTrackAnonymous(memory,address,length,protection) {
  if(!(memory instanceof VirtualMemory)) return false;
  if(address%PAGE || length<0) throw Error('unaligned shared mapping');
  const table=memory.table(), end=Math.ceil((address+length)/PAGE);
  memory.spans(address,length,0);
  const rights=((protection&1)?1:0)|((protection&2)?2:0);
  memory.invalidateMappings();
  for(let i=address/PAGE;i<end;i++) table[i]=(table[i]&-PAGE)|rights|4;
  return true;
}
function mappingPages(memory,address,length) {
  integer(address,'mapping address'); integer(length,'mapping length');
  if(address%PAGE) throw new RangeError('unaligned virtual mapping');
  const first=address/PAGE, count=Math.ceil(length/PAGE);
  if(first>memory.maximumPages || count>memory.maximumPages-first) throw new RangeError('virtual mapping ceiling');
  return {first,count};
}
// Invoked only after successful kernel VMA updates, while this process's sole
// Worker is at its syscall boundary. Physical extents are never reused here.
// Allocate replacements before publishing any PTE so a child's MAP_FIXED cannot
// zero a peer's inherited shared payload. Remaps retain the physical pages.
export function vmEnsureMapping(memory,kind,address,args) {
  if(!(memory instanceof VirtualMemory)) return false;
  mappingTrace(memory,kind,[address,...args]);
  if(kind==='brk') {
    const pages=Math.ceil(address/PAGE);
    if(pages>memory.pages) memory.grow(pages-memory.pages);
    return true;
  }
  const next=mappingPages(memory,address,kind==='mmap'?args[1]:args[2]);
  let entries;
  let old;
  if(kind==='mremap') {
    old=mappingPages(memory,args[0],args[1]);
    if(!old.count) throw new Error('zero-length virtual mremap is not supported');
    if(old.first+old.count>memory.pages) throw new RangeError('mremap source bounds');
    if(memory.table().slice(old.first,old.first+old.count).some(entry=>!(entry&-PAGE)))
      throw new Error('mremap has unmapped source pages');
    entries=memory.table().slice(old.first,old.first+Math.min(old.count,next.count));
  }
  const preserved=entries?.length??0, added=next.count-preserved;
  const physical=added?memory.group.allocate(added):0;
  memory.invalidateMappings();
  // Mapping capacity is not a guest memory.grow: unallocated gaps stay holes.
  if(next.first+next.count>memory.pages)
    new Uint32Array(memory.group.memory.buffer,memory.root,1)[0]=next.first+next.count;
  const table=memory.table();
  const flags=entries?.[0]&65535;
  if(old) table.fill(0,old.first,old.first+old.count);
  for(let i=0;i<next.count;i++) table[next.first+i]=i<preserved?entries[i]:(physical+(i-preserved)*PAGE)|(kind==='mmap'?3:flags);
  return true;
}
export function vmCommitMapping(memory,address,length,protection) {
  if(!(memory instanceof VirtualMemory)) return false;
  mappingTrace(memory,'protect',[address,length,protection]);
  const {first,count}=mappingPages(memory,address,length), table=memory.table();
  const rights=((protection&1)?1:0)|((protection&2)?2:0);
  // Preflight before changing any page, including PROT_NONE transitions.
  for(let i=first;i<first+count;i++) if(!(table[i]&-PAGE)) throw new Error('protection has unmapped pages');
  memory.invalidateMappings();
  for(let i=first;i<first+count;i++) table[i]=(table[i]&~3)|rights;
  return true;
}
export function vmUnmap(memory,address,length) {
  if(!(memory instanceof VirtualMemory)) return false;
  mappingTrace(memory,'unmap',[address,length]);
  const {first,count}=mappingPages(memory,address,length);
  memory.invalidateMappings();
  memory.table().fill(0,first,first+count);
  return true;
}
export const vmAtomics=new Proxy(nativeAtomics,{
  get(target,name) {
    const fn=target[name];
    if(typeof fn!=='function') return fn;
    return (view,index,...args) => {
      if(!(view instanceof VirtualTypedView)) return fn.call(target,view,index,...args);
      integer(index,'atomic index'); if(index>=view.length) throw new RangeError('virtual atomic bounds');
      const memory=view.buffer.memory, width=view.BYTES_PER_ELEMENT;
      const rights=['load','wait','waitAsync','notify'].includes(name)?1:name==='store'?2:3;
      const spans=memory.spans(view.byteOffset+index*width,width,rights,view.buffer.byteLength);
      if(spans.length!==1) throw Error('atomic element crossed pages');
      return fn.call(target,new view.constructor(memory.group.memory.buffer,spans[0].physical,1),0,...args);
    };
  },
});
export function vmIsSharedBuffer(value) { return value instanceof VirtualBuffer || value instanceof SharedArrayBuffer; }
export function vmIsView(value) { return value instanceof VirtualTypedView || value instanceof VirtualDataView || ArrayBuffer.isView(value); }
export function vmIsMemory(value) { return value instanceof VirtualMemory || value instanceof WebAssembly.Memory; }
export function vmIsVirtualMemory(value) { return value instanceof VirtualMemory; }
export function vmIsVirtualBuffer(value) { return value instanceof VirtualBuffer; }
export function vmProgram(bytes) {
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  let at=8;
  const read=()=>{let n=0,shift=0,b;do{if(at>=data.length || shift>28) throw Error('invalid Wasm section length'); b=data[at++]; n+=(b&127)*2**shift; shift+=7;}while(b&128);return n;};
  while(at<data.length) {
    const id=data[at++], length=read(), end=at+length;
    if(end>data.length) throw Error('invalid Wasm section bounds');
    if(id===0) {const nameLength=read();if(new TextDecoder().decode(data.subarray(at,at+nameLength))==='kandelo.common-memory.prototype') return true;}
    at=end;
  }
  return false;
}
export function vmInstanceOf(value,Ctor) {
  if(value instanceof VirtualTypedView && value.constructor===Ctor) return true;
  if(value instanceof VirtualDataView && Ctor===DataView) return true;
  return value instanceof Ctor;
}
export function vmApply(fn,receiver,args) {
  if(fn===nativeMemoryBuffer && receiver instanceof VirtualMemory) return receiver.buffer;
  if((fn===nativeArrayByteLength || fn===nativeSharedByteLength) && receiver instanceof VirtualBuffer) return receiver.byteLength;
  if(receiver instanceof VirtualTypedView || receiver instanceof VirtualDataView) {
    const name=virtualMethods.get(fn);
    if(name) {
      const value=receiver[name];
      return typeof value==='function'?Reflect.apply(value,receiver,args):value;
    }
  }
  return Reflect.apply(fn,receiver,args);
}
export function vmCall(fn,receiver,...args) { return vmApply(fn,receiver,args); }
export function vmReflectConstruct(Ctor,args,newTarget) {
  if(newTarget!==undefined && newTarget!==Ctor) return Reflect.construct(Ctor,args,newTarget);
  return vmConstruct(Ctor,...args);
}
function snapshot(value) {
  if(value instanceof VirtualTypedView) return value.slice();
  if(value instanceof VirtualBuffer) return value.slice();
  if(value instanceof VirtualDataView) return value.buffer.memory.read(value.byteOffset,value.byteLength,value.buffer.byteLength);
  return value;
}
export function vmBufferFrom(...args) { return Buffer.from(snapshot(args[0]),...args.slice(1)); }
export function vmCompile(bytes) { return WebAssembly.compile(snapshot(bytes)); }
function importsFor(imports={}) {
  let memory;
  const result=Object.fromEntries(Object.entries(imports).map(([namespace,values]) => [namespace,
    Object.fromEntries(Object.entries(values).map(([name,value]) => {
      if(value instanceof VirtualMemory) { if(memory && memory!==value) throw Error('multiple virtual memories'); memory=value; return [name,value.group.memory]; }
      return [name,value];
    })),
  ]));
  return { imports:result,memory };
}
function bind(instance,module,memory) {
  const metadata=WebAssembly.Module.customSections(module,'kandelo.common-memory.prototype');
  if(memory) {
    if(metadata.length!==1 || !instance.exports.__vm_root || !instance.exports.__vm_initialize) throw Error('untranslated program cannot use virtual process memory');
    const contract=JSON.parse(new TextDecoder().decode(metadata[0]));
    if(contract.initialPages>memory.pages) throw Error('virtual process allocation is smaller than source memory');
    instance.exports.__vm_root.value=memory.root;
    instance.exports.__vm_scratch.value=memory.scratch;
    instance.exports.__vm_initialize(memory.fresh?1:0);
  } else if(metadata.length) throw Error('virtualized program requires the common-memory host profile');
  return instance;
}
export async function vmInstantiate(input,imports) {
  const mapped=importsFor(imports);
  if(input instanceof WebAssembly.Module) return bind(await WebAssembly.instantiate(input,mapped.imports),input,mapped.memory);
  const result=await WebAssembly.instantiate(snapshot(input),mapped.imports);
  bind(result.instance,result.module,mapped.memory); return result;
}
export function vmConstruct(Ctor,...args) {
  if(typed.includes(Ctor) && args[0] instanceof VirtualBuffer) return new VirtualTypedView(Ctor,...args);
  if(Ctor===DataView && args[0] instanceof VirtualBuffer) return new VirtualDataView(...args);
  if(Ctor===WebAssembly.Instance) { const mapped=importsFor(args[1]); return bind(new Ctor(args[0],mapped.imports),args[0],mapped.memory); }
  if(Ctor===TextDecoder) {
    const decoder=new Ctor(...args);
    return new Proxy(decoder,{get(target,key){ if(key==='decode') return (bytes,options)=>target.decode(snapshot(bytes),options); const value=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value; }});
  }
  if(Ctor===TextEncoder) {
    const encoder=new Ctor(...args);
    return new Proxy(encoder,{get(target,key){ if(key==='encodeInto') return (text,dst)=>{
      if(!(dst instanceof VirtualTypedView)) return target.encodeInto(text,dst);
      const output=new Uint8Array(dst.length), result=target.encodeInto(text,output); dst.set(output.subarray(0,result.written)); return result;
    }; const value=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value; }});
  }
  return Reflect.construct(Ctor,args);
}
function encode(value,allowMemory) {
  if(value instanceof VirtualMemory) {
    if(!allowMemory) throw Error('virtual process memory cannot cross a persistent/public message edge');
    return {[WIRE]:true,memory:value.group.memory,root:value.root,scratch:value.scratch,fresh:value.fresh,
      maximumPages:value.group.maximumPages,scratchBytes:value.group.scratchBytes};
  }
  if(value instanceof VirtualBuffer || value instanceof VirtualTypedView || value instanceof VirtualDataView) return snapshot(value);
  if(Array.isArray(value)) return value.map(v=>encode(v,allowMemory));
  if(value && Object.getPrototypeOf(value)===Object.prototype) return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v,allowMemory)]));
  return value;
}
export function vmPostMessage(port,message,...rest) {
  const allowed=['centralized_init','centralized_thread_init'].includes(message?.type);
  return port.postMessage(encode(message,allowed),...rest);
}
export function vmDecodeMessage(value) {
  if(value?.[WIRE]) {
    const group=groups.get(value.memory)??new VirtualGroup(value.memory,value);
    return group.handles.get(value.root)?.deref()??new VirtualMemory(group,value.root,value.scratch,value.fresh);
  }
  if(Array.isArray(value)) return value.map(vmDecodeMessage);
  if(value && Object.getPrototypeOf(value)===Object.prototype) return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,vmDecodeMessage(v)]));
  return value;
}

// Private TS05 adapter: current PTE permissions and physical bounds first.
export function vmClockOutput(memory,pointer){
 if(!Number.isSafeInteger(pointer)||pointer<=0||pointer>0xfffffff0)return;
 try{
  if(memory instanceof VirtualMemory)return memory.spans(pointer,16,2).map(s=>new DataView(memory.group.memory.buffer,s.physical,s.length));
  const buffer=Reflect.apply(nativeMemoryBuffer,memory,[]);if(pointer>buffer.byteLength-16)return;
  return[new DataView(buffer,pointer,16)];
 }catch(e){if(e instanceof RangeError)return;throw e;}
}
