import { isKernelExportFailure } from "../kernel-entry-gate.js";
import type { GlUniformLookupBytes } from "./uniform-lookup-bytes.js";
import type { GlBinding } from "./registry.js";
import { recordGlError, programLinkGeneration, linkedProgramForQuery } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";
import { rethrowNativeGlFault } from "./native-recovery.js";
import { uniformLayout } from "./uniform-layout.js";

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


/** ES 2.0 section 2.10.4 against the program's latest successful link,
 * numbered per program (uniform-layout.ts). GLSL names are identifiers plus
 * field/array selectors; inactive, `gl_`-prefixed or malformed names are -1
 * without importing WebGL-only name errors. Array indices may carry leading
 * zeros. Null when the program cannot be queried (error recorded). */
export function uniformLocation(b: GlBinding, name: number, text: string): number | null {
  const program=linkedProgramForQuery(b,name);
  if(!program) return null;
  if (text.startsWith("gl_") || !/^[A-Za-z_][A-Za-z_0-9]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(text)) return -1;
  const layout=uniformLayout(b,program);
  if(!layout) return null;
  const location=layout.locate(text.replace(/\[0*(\d+)\]/g,"[$1]"));
  if(location<0) return -1;
  // Only a name past WebGL's lookup limit reaches the engine here; its
  // refusal is the real boundary and stays visible, as for attributes.
  const native=layout.native(b,location);
  if(native===false) return null;
  return native ? location : -1;
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
      const executable=linkedProgramForQuery(b,program);
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
        catch (error) { rethrowNativeGlFault(error); if(isKernelExportFailure(error)) throw error; storage.release();recordGlError(b,0x505);return -12; }
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
          const executable=linkedProgramForQuery(b,program);
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
