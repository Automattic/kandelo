import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";

export type GlShaderSourceUpload = {
  name: number;
  shader: WebGLShader;
  token: number;
  bytes: Uint8Array<ArrayBuffer>;
  cursor: number;
};

function shaderObject(b: GlBinding, name: number): WebGLShader | null {
  const shader = b.shaders.get(name);
  if (shader) return shader;
  recordGlError(b,b.programs.has(name) ? 0x502 : 0x501); return null;
}

/** Both inline and chunked uploads own their bytes independently of guest
 * memory. Decode/driver failure must leave the prior source intact. */
export function installShaderSource(b: GlBinding, shader: WebGLShader, bytes: Uint8Array<ArrayBuffer>): boolean {
  let source: string;
  try { source = new TextDecoder().decode(bytes); }
  catch { recordGlError(b,0x505); return false; }
  const prior = b.shaderSources.get(shader);
  try { b.shaderSources.set(shader,bytes); }
  catch { recordGlError(b,0x505); return false; }
  if (!checkedGlCall(b, () => b.gl!.shaderSource(shader,source))) {
    if (prior) b.shaderSources.set(shader,prior); else b.shaderSources.delete(shader);
    return false;
  }
  return true;
}

/** Tokens are monotonically chosen by the context's C encoder. An abort
 * after a lost acknowledgement is idempotent, but cannot cancel a newer
 * transaction. Pending bytes remain context-owned until explicit cleanup. */
export function runShaderSourceUpload(b: GlBinding, input: Uint8Array, out: Uint8Array): number {
  if (input.length < 16 || input.length > 65536 || out.length < 12) return -22;
  const v = new DataView(input.buffer,input.byteOffset,input.length);
  const action = v.getUint32(0,true), name = v.getUint32(4,true);
  const token = v.getUint32(8,true), arg = v.getUint32(12,true);
  if (action < 1 || action > 4 || !token || (action !== 2 && input.length !== 16)
      || (action >= 3 && arg !== 0) || (action === 2 && input.length === 16)) return -22;
  return checkedQueryReply(b,out,4,payload => {
    const invalid = () => { recordGlError(b,0x502); return -22; };
    if (action === 1) {
      const shader = shaderObject(b,name);
      if (!shader) return -22;
      if (token <= b.shaderUploadSerial) return invalid();
      b.shaderUploadSerial = token;
      // A new valid call replaces an upload whose acknowledgement was lost.
      b.shaderUpload = null;
      let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = new Uint8Array(arg); }
      catch { recordGlError(b,0x505); return -12; }
      b.shaderUpload = {name,shader,token,bytes,cursor:0};
    } else {
      const upload = b.shaderUpload;
      if (action === 4) {
        if (upload && (upload.token > token || (upload.token === token && upload.name !== name))) return invalid();
        b.shaderUpload = null;
        // Retire the token even if BEGIN was not observed: a late BEGIN
        // cannot recreate an already-cancelled owner after a lost reply.
        b.shaderUploadSerial = Math.max(b.shaderUploadSerial,token);
        new DataView(payload.buffer).setUint32(0,token,true); return 4;
      }
      if (!upload || upload.token !== token || upload.name !== name) return invalid();
      {
        if (b.shaders.get(name) !== upload.shader) { b.shaderUpload = null; return invalid(); }
        if (action === 2) {
          const bytes = input.subarray(16);
          if (arg !== upload.cursor || arg+bytes.length > upload.bytes.length) { b.shaderUpload = null; return invalid(); }
          upload.bytes.set(bytes,arg); upload.cursor += bytes.length;
        } else {
          b.shaderUpload = null;
          if (upload.cursor !== upload.bytes.length) return invalid();
          if (!installShaderSource(b,upload.shader,upload.bytes)) return -5;
        }
      }
    }
    new DataView(payload.buffer).setUint32(0,token,true); return 4;
  });
}
