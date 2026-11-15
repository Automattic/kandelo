// Experimental adapter to the normal host's typed page/lease ownership code.
// Keep the original prototype and frozen bundles reproducible without this flag.
export function retirementSource(source, { backingModule, ownershipModule, accountingModule }) {
  const once = (before, after) => {
    if (source.split(before).length !== 2) throw Error('retirement source anchor mismatch: ' + before);
    source = source.replace(before, after);
  };
  const between = (start, end, replacement) => {
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('retirement method anchor mismatch');
    const at=source.indexOf(start), until=source.indexOf(end,at);
    if (until<at) throw Error('retirement method order');
    source=source.slice(0,at)+replacement+source.slice(until);
  };
  once('  return {roots,groups:backing.size,', `  // The allocator owns this backing even after its last process retires.
  if(allocationGroup)backing.add(allocationGroup);
  return {physicalAccounting:'allocator-owned-group-and-listed-roots',roots,groups:backing.size,`);
  once('this.reuseFree = [];', `this.pageOwnership = memory ? null : new CommonMemoryPageOwnership(
      () => new Uint32Array(this.memory.buffer,4096,3)[1]);
    this.nextIncarnation = 0;
    if(this.pageOwnership) {
      this.memoryAccountingSource={snapshot:()=>{
        const sample=this.pageOwnership.accountingSnapshot();
        return {...sample,pageSize:PAGE,backingBufferBytes:this.memory.buffer.byteLength,
          allocationExtentBytes:new Uint32Array(this.memory.buffer,4096,3)[1]*PAGE,
          maximumBytes:this.maximumPages*PAGE,runtimePages:[0,...sample.runtimePages],
          roots:sample.roots.map(root=>({...root,
            virtualBytes:new Uint32Array(this.memory.buffer,root.memory.root,1)[0]*PAGE}))};
      }};
      registerMemoryAccountingGroup(this.memoryAccountingSource);
    }`);
  between('  reuseStats() {', '  create(initial, maximum', `  get reuseFree() { return this.pageOwnership?.freeExtents() ?? []; }
  reuseStats() { return this.pageOwnership?.stats() ?? {rootsTracked:0,pendingSnapshots:0,freePages:0}; }
  reclaimUnmapped(entries) {
    if(!this.pageOwnership)throw Error('only the owning kernel realm may recycle mappings');
    this.pageOwnership.reclaimUnmapped([...entries].map(e => ((e&-PAGE)>>>0)/PAGE).filter(Boolean));
  }
  pinForkSnapshot(snapshot,entries) {
    if(!this.pageOwnership)throw Error('fork snapshot must belong to the owning kernel realm');
    this.pageOwnership.pin(snapshot,[...entries].filter(e=>e&4).map(e=>((e&-PAGE)>>>0)/PAGE).filter(Boolean));
    registerProcessForkSnapshot(snapshot,()=>this.pageOwnership.disposeSnapshot(snapshot));
  }
  finishForkSnapshot(snapshot) { disposeProcessForkSnapshot(snapshot); }
`);
  between('      if(this.reuseRoots && pages) {', '      const first=h[1], end=first+pages;', `      if(this.pageOwnership && pages) {
        const first=this.pageOwnership.take(pages,(first,count)=>new Uint8Array(this.memory.buffer,first*PAGE,count*PAGE).fill(0));
        if(first!==undefined)return first*PAGE;
      }
`);
  between('  create(initial, maximum', '\n}\nexport class VirtualMemory', `  create(initial, maximum, forkDestination=false) {
    integer(initial,'initial pages'); integer(maximum,'maximum pages');
    if(initial>maximum || maximum>65536)throw new RangeError('common-memory virtual ceiling');
    if(!this.pageOwnership)throw Error('only the owning kernel realm may create a root');
    if(this.nextIncarnation>=0xffffffff)throw new RangeError('common-memory generation exhausted');
    const reserved=[], staged=[]; let handle;
    const remember=(address,count,into)=>{for(let i=0;i<count;i++)into.push(address/PAGE+i);return address;};
    try {
      const rootPages=Math.ceil((HEADER+4*maximum)/PAGE);
      const root=remember(this.allocate(rootPages),rootPages,reserved);
      const scratchPages=this.scratchBytes/PAGE;
      const scratch=remember(this.allocate(scratchPages),scratchPages,reserved);
      new Uint32Array(this.memory.buffer,root,5).set([initial,maximum,this.scratchBytes,0,1]);
      nativeAtomics.store(new Uint32Array(this.memory.buffer,root+56,1),0,1);
      nativeAtomics.store(new Uint32Array(this.memory.buffer,root+60,1),0,++this.nextIncarnation);
      handle=new VirtualMemory(this,root,scratch,true);
      handle.forkDestination=forkDestination;
      this.reuseRoots.set(root,{root,maximum,rootPages,scratch,scratchPages});
      const owner=this.pageOwnership.trackRoot(handle,reserved,()=>{
        const pages=new Uint32Array(this.memory.buffer,root,1)[0];
        if(pages>maximum)throw Error('invalid tracked common-memory root');
        return [...new Uint32Array(this.memory.buffer,root+HEADER,pages)].map(e=>((e&-PAGE)>>>0)/PAGE).filter(Boolean);
      },()=>{
        nativeAtomics.store(new Uint32Array(this.memory.buffer,root+60,1),0,0);
        this.reuseRoots.delete(root);this.handles.delete(root);
      });
      registerProcessBacking(handle,{...owner,
        requestExecutionStop:()=>{
          handle.assertLive();
          nativeAtomics.store(new Uint32Array(this.memory.buffer,root+56,1),0,0);
        },
        prepareRejectedAllocation:()=>owner.prepareRetirement(handle.exposed?'forced':'quiescent'),
      });
      registerProcessMemoryAccounting(handle,this.memoryAccountingSource);
      if(initial&&!forkDestination) {
        const base=remember(this.allocate(initial),initial,staged),table=handle.table();
        for(let i=0;i<initial;i++)table[i]=base+i*PAGE|3;
        staged.length=0;
      }
      return handle;
    } catch(error) {
      if(handle)prepareProcessBackingRetirement(handle,'quiescent')?.();
      else this.pageOwnership.reclaimUnmapped(reserved);
      if(staged.length)this.pageOwnership.reclaimUnmapped(staged);
      throw error;
    }
  }`);
  once('this.cachedBuffer=null;', `this.cachedBuffer=null;
    this.incarnation=nativeAtomics.load(new Uint32Array(group.memory.buffer,root+60,1),0);
    if(!this.incarnation)throw Error('retired common-memory generation');`);
  once('  get pages() {', `  assertLive() {
    if(nativeAtomics.load(new Uint32Array(this.group.memory.buffer,this.root+60,1),0)!==this.incarnation)
      throw Error('retired common-memory generation');
    if(this.group.pageOwnership)this.group.pageOwnership.assertLive(this);
  }
  get pages() { this.assertLive();`);
  once('  get maximumPages() {', '  get maximumPages() { this.assertLive();');
  once('function encode(value,allowMemory) {\n  if(value instanceof VirtualMemory) {', 'function encode(value,allowMemory) {\n  if(value instanceof VirtualMemory) {\n    value.assertLive(); value.exposed=true;');
  once('if(value instanceof VirtualMemory) { if(memory', 'if(value instanceof VirtualMemory) { value.assertLive(); value.exposed=true; if(memory');
  once("WIRE = '__kandelo_common_memory_wire_v1'", "WIRE = '__kandelo_common_memory_wire_v2'");
  once('maximumPages:value.group.maximumPages,scratchBytes:value.group.scratchBytes', 'maximumPages:value.group.maximumPages,scratchBytes:value.group.scratchBytes,incarnation:value.incarnation');
  once('  if(value?.[WIRE]) {', `  if(value?.[WIRE]) {
    if(!Number.isInteger(value.incarnation)||value.incarnation<=0||
       nativeAtomics.load(new Uint32Array(value.memory.buffer,value.root+60,1),0)!==value.incarnation)
      throw Error('stale common-memory wire generation');`);
  between('export async function vmInstantiate(input,imports) {', '\nexport function vmConstruct', `function admitVirtualModule(module,memory) {
  const metadata=WebAssembly.Module.customSections(module,'kandelo.common-memory.prototype');
  if(!memory) { if(metadata.length)throw Error('virtualized program requires the common-memory host profile'); return; }
  memory.assertLive();
  if(metadata.length!==1)throw Error('untranslated program cannot use virtual process memory');
  const contract=JSON.parse(new TextDecoder().decode(metadata[0]));
  if(contract?.format!==2||contract.cooperativeStop!==1||!Number.isInteger(contract.initialPages)||!Number.isInteger(contract.maximumPages)||
     contract.initialPages<0||contract.maximumPages<contract.initialPages||contract.maximumPages>65536||
     contract.initialPages>memory.pages||memory.maximumPages>contract.maximumPages)
    throw Error('unsupported common-memory artifact contract');
  const exports=new Map(WebAssembly.Module.exports(module).map(e=>[e.name,e.kind]));
  if(exports.get('__vm_root')!=='global'||exports.get('__vm_scratch')!=='global'||exports.get('__vm_initialize')!=='function')
    throw Error('missing common-memory artifact bindings');
}
export async function vmInstantiate(input,imports) {
  const compiled=input instanceof WebAssembly.Module;
  const module=compiled?input:await WebAssembly.compile(snapshot(input));
  const mapped=importsFor(imports);
  admitVirtualModule(module,mapped.memory);
  const instance=bind(await WebAssembly.instantiate(module,mapped.imports),module,mapped.memory);
  return compiled?instance:{module,instance};
}`);
  once('return bind(new Ctor(args[0],mapped.imports),args[0],mapped.memory);', 'admitVirtualModule(args[0],mapped.memory); return bind(new Ctor(args[0],mapped.imports),args[0],mapped.memory);');
  return `import {registerProcessBacking,prepareProcessBackingRetirement,registerProcessForkSnapshot,disposeProcessForkSnapshot,rejectUnpublishedProcessBacking} from ${JSON.stringify(backingModule)};
import {CommonMemoryPageOwnership} from ${JSON.stringify(ownershipModule)};
import {registerMemoryAccountingGroup,registerProcessMemoryAccounting} from ${JSON.stringify(accountingModule)};
export {prepareProcessBackingRetirement,disposeProcessForkSnapshot,rejectUnpublishedProcessBacking};\n`+source;
}
