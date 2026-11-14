// Private prototype counters use independent physical pages, never a guest VA.
// Only this diagnostic host profile reserves the two final root-header words.
export function accessDiagnosticSource(source) {
  const once=(before,after)=>{if(source.split(before).length!==2)throw Error(`diagnostic source anchor mismatch: ${before}`);source=source.replace(before,after);};
  once('const handle=new VirtualMemory(this,root,scratch,true);',`const diagnosticBase=this.allocate(9);
    new Uint32Array(this.memory.buffer,root+56,2).set([diagnosticBase,0x4b564d31]);
    const handle=new VirtualMemory(this,root,scratch,true);`);
  once('if(contract.initialPages>memory.pages)',`if(contract.accessDiagnostics) {
      const diagnostic=contract.accessDiagnostics;
      const header=new Uint32Array(memory.group.memory.buffer,memory.root+56,2);
      if(diagnostic.version!==1||diagnostic.magic!==0x4b564d31||diagnostic.slots!==65792||diagnostic.functionBase!==256||header[1]!==diagnostic.magic||!header[0])throw Error('incompatible access diagnostics');
    }
    if(contract.initialPages>memory.pages)`);
  return source+`
export function vmAccessCounts(processes) {
  const records=[];
  for(const [pid,memory] of processes) {
    if(!(memory instanceof VirtualMemory))continue;
    const header=new Uint32Array(memory.group.memory.buffer,memory.root+56,2);
    if(header[1]!==0x4b564d31||!header[0])throw Error('missing access diagnostic allocation');
    const words=new BigUint64Array(memory.group.memory.buffer,header[0],65792),values=[];
    for(let slot=0;slot<words.length;slot++) {
      const count=nativeAtomics.load(words,slot);
      if(count)values.push([slot,count.toString()]);
    }
    records.push({pid,root:memory.root,values});
  }
  return {version:1,records};
}
`;
}
