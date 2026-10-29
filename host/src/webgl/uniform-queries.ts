import type { GlUniformMetadata } from "./object-group.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";

export type GlUniformLookup = { program: number; token: number; bytes: Uint8Array<ArrayBuffer>; cursor: number };

function validProgram(b: GlBinding, name: number): WebGLProgram | null {
  const program = b.programs.get(name);
  if (!program) { recordGlError(b,b.shaders.has(name) ? 0x502 : 0x501); return null; }
  let linked = false;
  if (!checkedGlCall(b,() => { linked = !!b.gl!.getProgramParameter(program,0x8b82); })) return null;
  if (!linked) { recordGlError(b,0x502); return null; }
  return program;
}

/** Structs/struct arrays are reduced by native reflection to fundamental
 * fields. Only a final array selector denotes the remaining uniform array;
 * an earlier selector is part of that field's exact identity (ES2 2.10.4). */
function reflectedUniform(b: GlBinding, program: WebGLProgram, text: string): GlUniformMetadata | null {
  let count = 0;
  if (!checkedGlCall(b,()=>{count=Number(b.gl!.getProgramParameter(program,0x8b86));})) return null;
  for(let index=0;index<count;index++) {
    let info: WebGLActiveInfo | null = null;
    if(!checkedGlCall(b,()=>{info=b.gl!.getActiveUniform(program,index);})) return null;
    if(!info) continue;
    const {name,type,size}=info as WebGLActiveInfo;
    const array=name.endsWith("[0]");
    if(array) {
      const base=name.slice(0,-3), match=/^(.*)\[(\d+)\]$/.exec(text);
      const element=text===base?0:match?.[1]===base?Number(match[2]):-1;
      if(Number.isSafeInteger(element) && element>=0 && element<size)
        return {executable:program,type,array:true,remaining:size-element};
    } else if(name===text) return {executable:program,type,array:false,remaining:1};
  }
  // A non-null native location without reflection cannot be safely assigned
  // a setter signature. Do not publish a partially described location.
  recordGlError(b,0x502); return null;
}

/** Names denote locations for one successful link, including array aliases.
 * Public indices are never recycled, even after a relink or final deletion. */
export function uniformLocation(b: GlBinding, name: number, text: string): number | null {
  const program = validProgram(b,name);
  if (!program) return null;
  // GLSL names are identifiers plus field/array selectors. Inactive or
  // reserved names return -1 without importing WebGL-only name errors.
  if (text.startsWith("gl_") || !/^[A-Za-z_][A-Za-z_0-9]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(text)) return -1;
  const nativeText = text.replace(/\[0*(\d+)\]/g,"[$1]");
  // WebGL limits lookup strings to 256 characters. A root absent from
  // actual reflection is certainly inactive, regardless of its length.
  // Active paths exceeding that limit still need shader-name translation.
  if (nativeText.length > 256) {
    const root = nativeText.split(/[.\[]/,1)[0];
    let count = 0, found = false;
    if (!checkedGlCall(b,() => { count=Number(b.gl!.getProgramParameter(program,0x8b86)); })) return null;
    for (let index=0;index<count;index++) {
      let info: WebGLActiveInfo | null = null;
      if (!checkedGlCall(b,() => { info=b.gl!.getActiveUniform(program,index); })) return null;
      if (info && (info as WebGLActiveInfo).name.split(/[.\[]/,1)[0] === root) { found=true;break; }
    }
    if (!found) return -1;
  }
  let native: WebGLUniformLocation | null = null;
  if (!checkedGlCall(b,() => { native = b.gl!.getUniformLocation(program,nativeText); })) return null;
  if (!native) return -1;
  try {
    const metadata=reflectedUniform(b,program,nativeText);
    if (!metadata) return null;
    const canonical = nativeText.replace(/\[0\]$/,"");
    for (const [index,known] of b.uniformLocationNames) {
      if (known === canonical && b.uniformLocationPrograms.get(index) === name && b.uniformMetadata.get(index)?.executable === program && b.uniformLocations.has(index)) return index;
    }
    if (b.nextUniformLoc >= 0x7fffffff) { recordGlError(b,0x505); return null; }
    const index = b.nextUniformLoc+1;
    try {
      b.uniformLocations.set(index,native);
      b.uniformLocationPrograms.set(index,name);
      b.uniformLocationNames.set(index,canonical);
      b.uniformMetadata.set(index,metadata);
    } catch(error) {
      b.uniformLocations.delete(index); b.uniformLocationPrograms.delete(index); b.uniformLocationNames.delete(index); b.uniformMetadata.delete(index); throw error;
    }
    b.nextUniformLoc = index;
    return index;
  } catch { recordGlError(b,0x505); return null; }
}

/** Context-owned lookup bytes can span bounded requests. Commit resolves the
 * then-live shared program; pending name storage never enters the group. */
export function runUniformLookup(b: GlBinding, input: Uint8Array, out: Uint8Array): number {
  if (input.length < 16 || input.length > 65536 || out.length < 16) return -22;
  const v = new DataView(input.buffer,input.byteOffset,input.length);
  const action=v.getUint32(0,true), program=v.getUint32(4,true), token=v.getUint32(8,true), arg=v.getUint32(12,true);
  if (action > 4 || !token || ((action === 1 || action >= 3) && input.length !== 16)
      || (action >= 3 && arg !== 0) || (action === 2 && input.length === 16)
      || (action === 0 && arg !== input.length-16)) return -22;
  return checkedQueryReply(b,out,8,payload => {
    const result = new DataView(payload.buffer);
    const invalid = () => { recordGlError(b,0x502); return -22; };
    let location = -1;
    if (action === 0 || action === 1) {
      if (token <= b.uniformLookupSerial) return invalid();
      if (!validProgram(b,program)) return -22;
      b.uniformLookupSerial = token;
      b.uniformLookup = null;
      if (action === 0) {
        const found = uniformLocation(b,program,new TextDecoder().decode(new Uint8Array(input.subarray(16))));
        if (found === null) return -22;
        location = found;
      } else {
        let bytes: Uint8Array<ArrayBuffer>;
        try { bytes = new Uint8Array(arg); } catch { recordGlError(b,0x505); return -12; }
        b.uniformLookup = {program,token,bytes,cursor:0};
      }
    } else {
      const pending = b.uniformLookup;
      if (action === 4) {
        if (pending && (pending.token > token || (pending.token === token && pending.program !== program))) return invalid();
        b.uniformLookup = null;
        b.uniformLookupSerial = Math.max(b.uniformLookupSerial,token);
      } else {
        if (!pending || pending.token !== token || pending.program !== program) return invalid();
        if (action === 2) {
          if (arg !== pending.cursor || input.length-16 > pending.bytes.length-pending.cursor) { b.uniformLookup=null; return invalid(); }
          pending.bytes.set(input.subarray(16),arg); pending.cursor+=input.length-16;
        } else {
          b.uniformLookup = null;
          if (pending.cursor !== pending.bytes.length) return invalid();
          const found = uniformLocation(b,program,new TextDecoder().decode(pending.bytes));
          if (found === null) return -22;
          location = found;
        }
      }
    }
    result.setUint32(0,token,true); result.setInt32(4,location,true); return 8;
  });
}
