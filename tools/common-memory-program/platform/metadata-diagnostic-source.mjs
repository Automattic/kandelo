// Private diagnostic counters; never use this profile for latency claims.
export function metadataDiagnosticSource(source) {
  const once=(before,after)=>{
    if(source.split(before).length!==2)throw Error('metadata diagnostic anchor mismatch: '+before);
    source=source.replace(before,after);
  };
  once('return {roots,groups:backing.size,virtualBytes,nativeLinearBytes,',
    'return {metadata:__cmMetadataSnapshot(),roots,groups:backing.size,virtualBytes,nativeLinearBytes,');
  once('const spans=[], table=this.table(), physicalLength=this.group.memory.buffer.byteLength;',
    '__cmMetadataCount("spans",length); __cmMetadataCount(rights===1?"spanRead":rights===2?"spanWrite":"spanOther",length);\n    const spans=[], table=this.table(), physicalLength=this.group.memory.buffer.byteLength;');
  once('return spans;\n  }\n  read(offset,length,limit)',
    '__cmMetadataCount("resolvedSpans",spans.length);\n    return spans;\n  }\n  read(offset,length,limit)');
  once('read(offset,length,limit) {\n    const spans=',
    'read(offset,length,limit) {\n    __cmMetadataCount("bulkRead");\n    const spans=');
  once('write(offset,bytes,limit) {\n    const spans=',
    'write(offset,bytes,limit) {\n    __cmMetadataCount("bulkWrite");\n    const spans=');
  once('const at=this.byteOffset+offset, memory=this.buffer.memory;',
    'const at=this.byteOffset+offset, memory=this.buffer.memory;\n    __cmMetadataCount("dataView:"+name,width);');
  once('const memory=this.buffer.memory, at=this.byteOffset+index*this.BYTES_PER_ELEMENT;',
    'const memory=this.buffer.memory, at=this.byteOffset+index*this.BYTES_PER_ELEMENT;\n    __cmMetadataCount(write?"typedWrite":"typedRead");');
  return `const __cmMetadataCounts=Object.create(null);
function __cmMetadataCount(kind,units=0){const row=__cmMetadataCounts[kind]??={calls:0,units:0};row.calls++;row.units+=units;}
function __cmMetadataSnapshot(){return {version:1,scope:"This JS realm's adapter method attempts and span resolutions; not CPU, Wasm guest access counts or a syscall census",counts:Object.fromEntries(Object.entries(__cmMetadataCounts).map(([key,row])=>[key,{...row}]))};}
export const vmMetadataStats=()=>__cmMetadataSnapshot();
`+source;
}
