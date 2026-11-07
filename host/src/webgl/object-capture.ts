import { guestUniformType } from "./external-texture.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";
import * as O from "./ops.js";
import { attributeAliasLayout, type GlReflectedAttribute } from "./attribute-aliasing.js";
import { programGuestName } from "./essl3-translation.js";

/** Independent query bytes survive changes to shared program/shader objects.
 * They carry no native object or guest-memory lifetime beyond capture. */
export type GlObjectCapture = {
  token: number;
  bytes: Uint8Array<ArrayBuffer>;
  gl: WebGL2RenderingContext;
  context: GlBinding["contextId"];
  shadow: GlBinding["shadow"];
};
export const OBJECT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

type ObjectValue = { header: number[]; bytes: Uint8Array; unit: number };
function captureValue(b: GlBinding, op: number, name: number, index: number): ObjectValue | number {
  const gl=b.gl!;
  const fail=(error:number)=>{recordGlError(b,error);return -22;};
  if (op===O.QOP_GET_SHADER_SOURCE || op===O.QOP_GET_SHADER_INFO_LOG) {
    const shader=b.shaders.get(name);
    if (!shader) return fail(b.programs.has(name)?0x502:0x501);
    if(op===O.QOP_GET_SHADER_SOURCE) {
      const bytes=b.shaderSources.get(shader)??new Uint8Array();
      return {header:[bytes.length],bytes,unit:1};
    }
    let log="";
    if(!checkedGlCall(b,()=>{log=gl.getShaderInfoLog(shader)??"";}))return -5;
    const bytes=new TextEncoder().encode(log);return {header:[bytes.length],bytes,unit:1};
  }
  if(![O.QOP_GET_PROGRAM_INFO_LOG,O.QOP_GET_ACTIVE_ATTRIB,O.QOP_GET_ACTIVE_UNIFORM_INFO,O.QOP_GET_ATTACHED_SHADERS].includes(op))return fail(0x500);
  const program=b.programs.get(name);
  if(!program)return fail(b.shaders.has(name)?0x502:0x501);
  if(op===O.QOP_GET_PROGRAM_INFO_LOG) {
    let log="";
    if(!checkedGlCall(b,()=>{log=gl.getProgramInfoLog(program)??"";}))return -5;
    const bytes=new TextEncoder().encode(log);return {header:[bytes.length],bytes,unit:1};
  }
  if(op===O.QOP_GET_ATTACHED_SHADERS) {
    const names=b.programShaders.get(name)??new Set<number>();
    const bytes=new Uint8Array(names.size*4),v=new DataView(bytes.buffer);let offset=0;
    for(const name of names){v.setUint32(offset,name,true);offset+=4;}
    return {header:[names.size],bytes,unit:4};
  }
  const uniform=op===O.QOP_GET_ACTIVE_UNIFORM_INFO;
  // Aliasing executables reflect the guest's declared attributes.
  const aliased=uniform?undefined:attributeAliasLayout(program)?.attributes;
  let count=0,info:GlReflectedAttribute|null=null;
  if(!checkedGlCall(b,()=>{count=aliased?aliased.length:Number(gl.getProgramParameter(program,uniform?0x8b86:0x8b89));}))return -5;
  if(index>=count)return fail(0x501);
  if(!checkedGlCall(b,()=>{info=aliased?aliased[index]:uniform?gl.getActiveUniform(program,index):gl.getActiveAttrib(program,index);}))return -5;
  if(!info)return fail(0x502);
  // Aliasing layouts hold guest names; translated programs are mapped back.
  const active=info as GlReflectedAttribute,guestName=aliased?active.name:programGuestName(program,active.name);
  const bytes=new TextEncoder().encode(guestName);
  // samplerExternalOES compiles as sampler2D (external-texture.ts).
  return {header:[bytes.length,active.size,uniform?guestUniformType(program,guestName,active.type):active.type],bytes,unit:1};
}

/** BEGIN reads one original value. CHUNK never re-queries mutable objects.
 * Even a metadata-only caller validates and captures the original query once. */
export function runObjectCapture(b:GlBinding,input:Uint8Array,out:Uint8Array):number {
  if(input.length<8)return -22;
  const v=new DataView(input.buffer,input.byteOffset,input.length);
  const action=v.getUint32(0,true),token=v.getUint32(4,true);
  if(!token || action<1 || action>3 || input.length!==(action===1?24:action===2?16:8))return -22;
  const count=action===2?v.getUint32(12,true):0;
  if(count>65520 || out.length!==count+16)return -22;
  return checkedQueryReply(b,out,count+8,payload=>{
    const result=new DataView(payload.buffer);
    const invalid=()=>{recordGlError(b,0x502);return -22;};
    result.setUint32(0,token,true);
    if(action===1) {
      if(token<=b.objectCaptureSerial)return invalid();
      b.objectCaptureSerial=token;b.objectCapture=null;
      const gl=b.gl!,context=b.contextId,shadow=b.shadow;
      const value=captureValue(b,v.getUint32(8,true),v.getUint32(12,true),v.getUint32(16,true));
      if(typeof value==='number')return value;
      const size=value.header.length*4+Math.min(value.header[0],v.getUint32(20,true))*value.unit;
      if(size>OBJECT_CAPTURE_MAX_BYTES){recordGlError(b,0x505);return -12;}
      const bytes=new Uint8Array(size),header=new DataView(bytes.buffer);
      value.header.forEach((n,i)=>header.setUint32(i*4,n,true));
      bytes.set(value.bytes.subarray(0,size-value.header.length*4),value.header.length*4);
      // A native callback cannot publish bytes under a replacement context or
      // steal a newer reentrant capture's ownership.
      if(b.gl!==gl || b.contextId!==context || b.shadow!==shadow || b.objectCaptureSerial!==token || b.objectCapture!==null)return invalid();
      b.objectCapture={token,bytes,gl,context,shadow};result.setUint32(4,size,true);return 8;
    }
    const pending=b.objectCapture;
    if(action===3) {
      if(pending && pending.token!==token)return invalid();
      if(pending)b.objectCapture=null;
      b.objectCaptureSerial=Math.max(b.objectCaptureSerial,token);return 8;
    }
    if(!pending || pending.token!==token)return invalid();
    if(pending.gl!==b.gl || pending.context!==b.contextId || pending.shadow!==b.shadow){b.objectCapture=null;return invalid();}
    const offset=v.getUint32(8,true);
    if(offset+count>pending.bytes.length)return invalid();
    result.setUint32(4,count,true);payload.set(pending.bytes.subarray(offset,offset+count),8);return count+8;
  });
}
