/** Execute one draw from journal-owned buffer generations. Ordinary VAO and
 * buffer metadata stay public and mutable; only native fetch sources are
 * substituted for this command, then restored before another context runs. */
import type {GlBinding} from "./registry.js";
import {activeVertexArray} from "./buffer-references.js";
import {packedVertexLayout} from "./vertex-data.js";
import {prepareImageDraw} from "./image-storage.js";
import {requireGlesFramebufferComplete} from "./image-sizes.js";
import {validateDrawFramebufferWithoutProgram} from "./framebuffer.js";
import {issueGlesDraw,sequentialVertices} from "./draw-state.js";
import {checkedGlCall,recordGlError} from "./program-objects.js";
import {applyNativeChanges,nativeInverse,rethrowNativeGlFault,type NativeCall} from "./native-recovery.js";
const ARRAY=0x8892,HEADER=20,ROW=32;
function width(type:number):number {
  return type===0x1400||type===0x1401?1:type===0x1402||type===0x1403?2:type===0x1406?4:0;
}
/** journal, mode, first, count, rows; sorted rows contain attribute index,
 * cell, token, size, type, normalized, stride and offset. Whole-record shape
 * validation never resolves a name or borrows a native handle. */
export function validBufferSnapshotDraw(v:DataView):boolean {
  if(v.byteLength<HEADER || !v.getUint32(0,true) || v.getUint32(4,true)>6 ||
    v.getInt32(8,true)<0 || v.getInt32(12,true)<=0)return false;
  const n=v.getUint32(16,true);if(!n || n>16 || v.byteLength!==HEADER+n*ROW)return false;
  let previous=-1;
  for(let p=HEADER;p<v.byteLength;p+=ROW){
    const index=v.getUint32(p,true),size=v.getUint32(p+12,true),w=width(v.getUint32(p+16,true));
    const stride=v.getUint32(p+24,true),offset=v.getUint32(p+28,true);
    if(index<=previous || index>=16 || v.getUint32(p+4,true)>=32 || !v.getUint32(p+8,true) ||
      size<1 || size>4 || !w || v.getUint32(p+20,true)>1 || stride>255 || stride%w || offset>0x7fffffff || offset%w)return false;
    previous=index;
  }
  return true;
}
export function drawBufferSnapshots(b:GlBinding,v:DataView):boolean {
  try{
    const journal=b.programJournal,gl=b.gl;
    if(!gl || !validBufferSnapshotDraw(v) || journal?.id!==v.getUint32(0,true) || b.savedClientArrayBuffer!==undefined){recordGlError(b,0x502);return false;}
    const view=journal.bufferDrawExecutionView(),vao=activeVertexArray(b),n=v.getUint32(16,true);
    let enabled=0;for(const a of vao.attributes.values())if(a.enabled)enabled++;
    if(!view || enabled!==n){recordGlError(b,0x502);return false;}
    const first=v.getInt32(8,true),count=v.getInt32(12,true),mode=v.getUint32(4,true);
    const apply:NativeCall[]=[],restore:NativeCall[]=[];
    for(let p=HEADER;p<v.byteLength;p+=ROW){
      const index=v.getUint32(p,true),a=vao.attributes.get(index),size=v.getUint32(p+12,true),type=v.getUint32(p+16,true);
      const normalized=!!v.getUint32(p+20,true),stride=v.getUint32(p+24,true),offset=v.getUint32(p+28,true);
      if(!a?.enabled || !a.buffer || a.view || packedVertexLayout(a) || a.size!==size || a.type!==type ||
        a.normalized!==normalized || a.stride!==stride || a.offset!==offset){recordGlError(b,0x502);return false;}
      const required=offset+(first+count-1)*(stride||size*width(type))+size*width(type);
      const source=journal.resolveBufferSnapshot(v.getUint32(p+4,true),v.getUint32(p+8,true),a.buffer,required);
      if(!source){recordGlError(b,0x502);return false;}
      const original=b.bufferStores.get(a.buffer)?.views.get(ARRAY)?.native??a.buffer;
      apply.push(["bindBuffer",ARRAY,source],["vertexAttribPointer",index,size,type,normalized,stride,offset]);
      restore.push(["bindBuffer",ARRAY,original],["vertexAttribPointer",index,size,type,normalized,stride,offset]);
    }
    restore.push(["bindBuffer",ARRAY,b.shadow.arrayBuffer]);
    if(!requireGlesFramebufferComplete(b) || !validateDrawFramebufferWithoutProgram(b) || !prepareImageDraw(b))return false;
    // Every fetch was checked against the retained store. The cold execution
    // view keeps shader/stencil/image emulations and the original reset owner,
    // while excluding robust padding derived from a peer's replacement store.
    const calls=()=>{for(const [method,...args]of apply)if(!checkedGlCall(b,()=>Reflect.apply(gl[method] as (...a:unknown[])=>void,gl,args)))return false;return true;};
    return applyNativeChanges(b,[{apply:calls,restore:nativeInverse(b,restore)},
      {apply:()=>issueGlesDraw(view,{mode,observed:false,maxVertex:first+count-1,
        issue:()=>gl.drawArrays(mode,first,count),vertices:()=>sequentialVertices(first,count)}),restore:nativeInverse(b)}],
      {finalizer:nativeInverse(b,restore)});
  }catch(error){rethrowNativeGlFault(error);recordGlError(b,0x505);return false;}
}
