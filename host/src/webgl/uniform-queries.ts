import { isKernelExportFailure } from "../kernel-entry-gate.js";
import type { GlUniformLookupBytes } from "./uniform-lookup-bytes.js";
import type { GlUniformMetadata, GlUniformLocationRecord, GlObjectGroup } from "./object-group.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError, programLinkGeneration } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";

export class GlUniformLookup {
  cursor=0;
  constructor(readonly program: number, readonly executable: WebGLProgram,
      readonly generation: number, readonly token: number,
      private storage: GlUniformLookupBytes) {}
  get bytes(): Uint8Array<ArrayBuffer> { return this.storage.bytes; }
  release(): void { this.storage.release(); }
}
export function replaceUniformLookup(b: GlBinding, next: GlUniformLookup | null): void {
  if(b.uniformLookup===next) return;
  b.uniformLookup?.release();b.uniformLookup=next;
}


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

/** One reserved index/record. Commit changes existing state only; cancellation
 * can reclaim an index which has never become public. */
export class GlUniformLocationReservation {
  private closed=false;
  constructor(private objects: GlObjectGroup, readonly index: number,
      private record: GlUniformLocationRecord | null) {}
  publish(): boolean {
    if(this.closed) return false;
    const record=this.record;
    if(record) {
      if(record.state==="reserved") record.state="published";
      this.objects.nextUniformLoc=Math.max(this.objects.nextUniformLoc,this.index);
    }
    this.close();return true;
  }
  cancel(): void { if(!this.closed)this.close(); }
  private close(): void {
    const record=this.record;
    if(record) {
      if(record.references<=0) throw new Error("Uniform location reservation lost");
      record.references--;
      if(!record.references && record.state!=="published" && this.objects.uniformLocationRecords.get(this.index)===record)
        this.objects.uniformLocationRecords.delete(this.index);
    }
    this.record=null;this.closed=true;
  }
}

/** Resolve against an already retained exact native link generation. */
export function reserveUniformLocation(b: GlBinding, name: number, text: string,
    program: WebGLProgram): GlUniformLocationReservation | null {
  // GLSL names are identifiers plus field/array selectors. Inactive or
  // reserved names return -1 without importing WebGL-only name errors.
  if (text.startsWith("gl_") || !/^[A-Za-z_][A-Za-z_0-9]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(text)) return new GlUniformLocationReservation(b.objects,-1,null);
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
    if (!found) return new GlUniformLocationReservation(b.objects,-1,null);
  }
  let native: WebGLUniformLocation | null = null;
  if (!checkedGlCall(b,() => { native = b.gl!.getUniformLocation(program,nativeText); })) return null;
  if (!native) return new GlUniformLocationReservation(b.objects,-1,null);
  try {
    const metadata=reflectedUniform(b,program,nativeText);
    if (!metadata) return null;
    const canonical = nativeText.replace(/\[0\]$/,"");
    for (const [index,known] of b.uniformLocationRecords) {
      if (known.state !== "invalid" && known.canonical === canonical && known.program === name && known.metadata.executable === program) {
        if(known.references>=Number.MAX_SAFE_INTEGER) {recordGlError(b,0x505);return null;}
        const result=new GlUniformLocationReservation(b.objects,index,known);
        known.references++;return result;
      }
    }
    let index=b.nextUniformLoc+1;
    while(b.uniformLocationRecords.has(index)) index++;
    if(index>0x7fffffff) {recordGlError(b,0x505);return null;}
    const record:GlUniformLocationRecord={program:name,canonical,native,metadata,state:"reserved",references:1};
    const result=new GlUniformLocationReservation(b.objects,index,record);
    b.uniformLocationRecords.set(index,record);
    return result;
  } catch (error) { if(isKernelExportFailure(error)) throw error; recordGlError(b,0x505); return null; }
}

/** Immediate queries share the same reservation/publication authority. */
export function uniformLocation(b: GlBinding, name: number, text: string): number | null {
  const program=validProgram(b,name);
  if(!program) return null;
  const reservation=reserveUniformLocation(b,name,text,program);
  if(!reservation) return null;
  reservation.publish();return reservation.index;
}

/** Context-owned lookup bytes retain an exact executable/link-generation
 * snapshot between bounded requests, independently of the live name. */
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
      const executable=validProgram(b,program);
      if (!executable) return -22;
      b.uniformLookupSerial = token;
      replaceUniformLookup(b,null);
      if (action === 0) {
        const found = uniformLocation(b,program,new TextDecoder().decode(new Uint8Array(input.subarray(16))));
        if (found === null) return -22;
        location = found;
      } else {
        const storage=b.uniformLookupBudget.allocate(arg);
        if(!storage) {recordGlError(b,0x505);return -12;}
        try { b.uniformLookup=new GlUniformLookup(program,executable,programLinkGeneration(b,executable).value,token,storage); }
        catch (error) { if(isKernelExportFailure(error)) throw error; storage.release();recordGlError(b,0x505);return -12; }
      }
    } else {
      const pending = b.uniformLookup;
      if (action === 4) {
        if (pending && (pending.token > token || (pending.token === token && pending.program !== program))) return invalid();
        replaceUniformLookup(b,null);
        b.uniformLookupSerial = Math.max(b.uniformLookupSerial,token);
      } else {
        if (!pending || pending.token !== token || pending.program !== program) return invalid();
        if (action === 2) {
          if (arg !== pending.cursor || input.length-16 > pending.bytes.length-pending.cursor) { replaceUniformLookup(b,null); return invalid(); }
          pending.bytes.set(input.subarray(16),arg); pending.cursor+=input.length-16;
        } else {
          if (pending.cursor !== pending.bytes.length) {replaceUniformLookup(b,null);return invalid();}
          const executable=validProgram(b,program);
          if(!executable) {replaceUniformLookup(b,null);return -22;}
          if(executable!==pending.executable || programLinkGeneration(b,executable).value!==pending.generation) {replaceUniformLookup(b,null);return invalid();}
          const text=new TextDecoder().decode(pending.bytes);
          replaceUniformLookup(b,null);
          const found = uniformLocation(b,program,text);
          if (found === null) return -22;
          location = found;
        }
      }
    }
    result.setUint32(0,token,true); result.setInt32(4,location,true); return 8;
  });
}
