// Applied to a private source copy only; default memory.mjs stays byte-identical.
export function byteSliceSource(source,{diagnostics=false}={}) {
 function replace(before,after) {
  if(source.split(before).length!==2)throw Error('byte-slice source anchor mismatch: '+before);
  source=source.replace(before,after);
 }
 replace('groups.set(this.memory, this);','groups.set(this.memory, this);\n    __byteSlices.group(this,this.memory);');
 replace('group.handles.set(root,new WeakRef(this));','group.handles.set(root,new WeakRef(this));\n    __byteSlices.memory(this,group,root);');
 replace('constructor(memory,length) { this.memory=memory; this.byteLength=length; }',
  'constructor(memory,length) { this.memory=memory; this.byteLength=length; __byteSlices.buffer(this,memory,length); }');
 replace('return new Proxy(this,{','const __byteProxy = new Proxy(this,{');
 replace('    });\n  }\n  element(index,value,write=false)',
  '    });\n    __byteSlices.view(__byteProxy,this,Ctor,buffer,offset,length,width);\n    return __byteProxy;\n  }\n  element(index,value,write=false)');
 if(diagnostics)replace('return {roots,groups:backing.size,virtualBytes,nativeLinearBytes,',
  'return {byteSlices:__byteSlices.stats(),roots,groups:backing.size,virtualBytes,nativeLinearBytes,');
 return 'import {installByteSlices} from "./byte-slices.mjs";\n'+source+
  `\nconst __byteSlices=installByteSlices({VirtualTypedView,VirtualBuffer,VirtualMemory},${diagnostics});\n`+
  (diagnostics?'export const vmByteSliceStats=()=>__byteSlices.stats();\n':'');
}
