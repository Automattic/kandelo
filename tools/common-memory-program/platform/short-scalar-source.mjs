// Private-profile TS-03 experiment. No physical address is cached across calls.
export function shortScalarSource(source,{mode='dataview'}={}) {
 if(!['dataview','typed','both'].includes(mode))throw Error('invalid short scalar mode');
 const once=(before,after)=>{if(source.split(before).length!==2)throw Error('short scalar source anchor mismatch: '+before);source=source.replace(before,after);};
 const helper=`
const __cmOriginalSpans=VirtualMemory.prototype.spans;
const __cmOriginalTable=VirtualMemory.prototype.table;
function __cmSinglePhysical(memory,at,width,rights,limit) {
  // An overridden resolver still owns its observable calls and semantics.
  if(memory.spans!==__cmOriginalSpans || memory.table!==__cmOriginalTable) return null;
  integer(at,'offset'); integer(width,'length');
  if(width!==1 && width!==2 && width!==4 && width!==8) return null;
  if(at>limit || width>limit-at) throw new RangeError('virtual memory bounds');
  if(at%PAGE+width>PAGE) return null;
  const table=memory.table(), physicalLength=memory.group.memory.buffer.byteLength;
  const entry=table[Math.floor(at/PAGE)];
  if((entry&rights)!==rights || !(entry&-PAGE)) throw new RangeError(\`virtual memory permissions at \${at}\`);
  const physical=((entry&-PAGE)>>>0)+at%PAGE;
  if(physical>physicalLength-width) throw new RangeError('invalid physical page');
  return physical;
}
`;
 once('class VirtualDataView {',helper+'\nclass VirtualDataView {');
 if(mode!=='typed')once('const at=this.byteOffset+offset, memory=this.buffer.memory;',
  `const at=this.byteOffset+offset, memory=this.buffer.memory;
    const physical=__cmSinglePhysical(memory,at,width,write?2:1,this.buffer.byteLength);
    if(physical!==null) return DataView.prototype[name].call(new DataView(memory.group.memory.buffer,physical,width),0,...args);`);
 if(mode!=='dataview')once('const memory=this.buffer.memory, at=this.byteOffset+index*this.BYTES_PER_ELEMENT;',
  `const memory=this.buffer.memory, at=this.byteOffset+index*this.BYTES_PER_ELEMENT;
    const physical=__cmSinglePhysical(memory,at,this.BYTES_PER_ELEMENT,write?2:1,this.buffer.byteLength);
    if(physical!==null) {
      const view=new this.constructor(memory.group.memory.buffer,physical,1);
      if(write) view[0]=value; else return view[0];
      return;
    }`);
 return source;
}
