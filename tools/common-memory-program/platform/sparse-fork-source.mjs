// Private prototype: allocate only the private payload copied by a committed
// fork. No existing physical extent is reclaimed or reused.
export function sparseForkSource(source) {
 const once=(before,after)=>{if(source.split(before).length!==2)throw Error('sparse fork anchor mismatch: '+before);source=source.replace(before,after);};
 once('create(initial, maximum) {','create(initial, maximum, forkDestination=false) {');
 once('const handle=new VirtualMemory(this,root,scratch,true);','const handle=new VirtualMemory(this,root,scratch,true);\n    handle.forkDestination=forkDestination;');
 once('if (initial) {','if (initial && !forkDestination) {');
 once('export function vmCreateProcessMemory(descriptor,enabled=false) {','export function vmCreateProcessMemory(descriptor,enabled=false,forkDestination=false) {');
 once('allocationGroup.create(descriptor.initial,descriptor.maximum)','allocationGroup.create(descriptor.initial,descriptor.maximum,forkDestination)');
 once('maximum:request.maximumPages,shared:true},true)','maximum:request.maximumPages,shared:true},true,request.commonMemoryFork===true)');
 once('dst.invalidateMappings();\n  for(let i=0;i<entries.length;i++) {',`const sparse=dst.forkDestination===true;
  const uniquePrivate=sparse?new Set([...entries].filter(e=>e&&!(e&4)).map(e=>(e&-PAGE)>>>0)).size:0;
  let nextPrivate=uniquePrivate?dst.group.allocate(uniquePrivate):0;
  dst.invalidateMappings();
  for(let i=0;i<entries.length;i++) {`);
 once('target=(dst.table()[i]&-PAGE)>>>0;',`target=sparse?nextPrivate:(dst.table()[i]&-PAGE)>>>0;
      if(sparse)nextPrivate+=PAGE;`);
 once('dst.fresh=false;','dst.fresh=false;\n  dst.forkDestination=false;');
 return source;
}
