import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";
import { imageTextureOperation, type GlTextureView } from "./image-storage.js";
import { prepareTextureOperation } from "./texture-bindings.js";
import { setExpandedLevel } from "./luminance-float.js";
import * as O from "./ops.js";

// One context owns at most this many detached compressed bytes. Exceeding
// custody is a visible OUT_OF_MEMORY, never a successful truncated upload.
export const COMPRESSED_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
export type GlCompressedUpload = {
  token: number; op: number; metadata: number[]; bytes: Uint8Array<ArrayBuffer>; cursor: number;
  gl: GlBinding["gl"]; context: GlBinding["contextId"]; objects: GlBinding["objects"];
  shadow: GlBinding["shadow"]; unit: number; object: WebGLTexture;
  view: GlTextureView | undefined; revision: number;
};
function selected(b: GlBinding, target: number): WebGLTexture | undefined {
  const base = target === 0x0de1 ? 0x0de1 : 0x8513;
  return (base === 0x0de1 ? b.shadow.textureUnits : b.shadow.cubeTextureUnits)[b.shadow.activeTexture]
    ?? b.shadow.defaultTextures.get(base);
}
function unchanged(b: GlBinding, upload: GlCompressedUpload): boolean {
  return b.gl === upload.gl && b.contextId === upload.context && b.objects === upload.objects
    && b.shadow === upload.shadow && b.shadow.activeTexture === upload.unit
    && selected(b,upload.metadata[0]) === upload.object
    && b.textureViews.get(upload.object) === upload.view
    && (b.imageRevisions.get(upload.object) ?? 0) === upload.revision;
}
export function interruptCompressedUpload(b: GlBinding): boolean {
  if (!b.compressedUpload) return false;
  b.compressedUpload = null; recordGlError(b,0x502); return true;
}
/** BEGIN admits custody, not native format/storage acceptance. CHUNK copies
 * opaque bytes without decoding or band updates; COMMIT consumes the owner
 * before the one original native call, including on a post-effect exception. */
export function runCompressedUpload(b: GlBinding, input: Uint8Array, out: Uint8Array): number {
  if (input.byteLength < 12 || input.byteLength > 65536 || out.byteLength !== 12) return -22;
  const v = new DataView(input.buffer,input.byteOffset,input.byteLength);
  const action=v.getUint32(0,true), token=v.getUint32(4,true), arg=v.getUint32(8,true);
  if (!token || action<1 || action>4 || (action===1 ? input.byteLength!==52
      : action===2 ? input.byteLength===12 : input.byteLength!==12 || arg!==0)) return -22;
  if (action===1 && ((arg!==O.OP_COMPRESSED_TEX_IMAGE_2D && arg!==O.OP_COMPRESSED_TEX_SUB_IMAGE_2D)
      || v.getUint32(48,true)>1
      || (arg===O.OP_COMPRESSED_TEX_IMAGE_2D ? v.getInt32(24,true)!==0 || v.getInt32(28,true)!==0
        : v.getInt32(40,true)!==0))) return -22;
  // Drop custody even if allocating the tiny checked reply then fails.
  // A stale token must not cancel a newer owner, including after lost ACKs.
  const staleAbort=action===4 && !!b.compressedUpload && token<b.compressedUpload.token;
  if (action===4 && !staleAbort) {
    b.compressedUpload=null; b.compressedUploadSerial=Math.max(b.compressedUploadSerial,token);
  }
  return checkedQueryReply(b,out,4,payload=>{
    const invalid=()=>{recordGlError(b,0x502);return -22;};
    const reply=()=>{new DataView(payload.buffer).setUint32(0,token,true);return 4;};
    if (action===4) return staleAbort ? invalid() : reply();
    if (action===1) {
      if (token<=b.compressedUploadSerial) return invalid();
      interruptCompressedUpload(b); b.compressedUploadSerial=token;
      const target=v.getUint32(12,true), level=v.getInt32(16,true), format=v.getUint32(20,true);
      const x=v.getInt32(24,true),y=v.getInt32(28,true),width=v.getInt32(32,true),height=v.getInt32(36,true);
      const border=v.getInt32(40,true),size=v.getInt32(44,true),present=v.getUint32(48,true);
      if (size<0 || width<0 || height<0 || (arg===O.OP_COMPRESSED_TEX_IMAGE_2D ? border!==0 : x<0 || y<0)) {
        recordGlError(b,0x501);return -22;
      }
      // The WebGL backend's actual enabled-format vector is authoritative;
      // do not manufacture an empty vector or enable an extension here.
      let formats: Uint32Array | number[] | null = null;
      if (!checkedGlCall(b,()=>{formats=b.gl!.getParameter(0x86a3);})) return -5;
      if (!formats || (!ArrayBuffer.isView(formats) && !Array.isArray(formats))) {recordGlError(b,0x502);return -5;}
      if (!Array.from(formats as ArrayLike<number>).includes(format)) {recordGlError(b,0x500);return -22;}
      // No blanket negative-level rule: an admitted extension may define one.
      if (!prepareTextureOperation(b,target,true)) return -22;
      if (size>0 && !present) {recordGlError(b,0x501);return -22;}
      if (size>COMPRESSED_UPLOAD_MAX_BYTES) {recordGlError(b,0x505);return -12;}
      const object=selected(b,target)!;
      let bytes: Uint8Array<ArrayBuffer>;
      try {bytes=new Uint8Array(size);} catch {recordGlError(b,0x505);return -12;}
      b.compressedUpload={token,op:arg,metadata:[target,level,format,x,y,width,height,border],bytes,cursor:0,
        gl:b.gl,context:b.contextId,objects:b.objects,shadow:b.shadow,unit:b.shadow.activeTexture,object,
        view:b.textureViews.get(object),revision:b.imageRevisions.get(object)??0};
      return reply();
    }
    const upload=b.compressedUpload;
    if (!upload || token!==upload.token) return invalid();
    if (!unchanged(b,upload)) {b.compressedUpload=null;return invalid();}
    if (action===2) {
      const length=input.byteLength-12;
      if (arg!==upload.cursor || length>upload.bytes.byteLength-upload.cursor) {b.compressedUpload=null;return invalid();}
      upload.bytes.set(input.subarray(12),upload.cursor);upload.cursor+=length;
      return reply();
    }
    b.compressedUpload=null;
    if (upload.cursor!==upload.bytes.byteLength) return invalid();
    const [target,level,format,x,y,width,height,border]=upload.metadata;
    const image=upload.op===O.OP_COMPRESSED_TEX_IMAGE_2D;
    const accepted=imageTextureOperation(b,target,image,()=>{
      if (image) b.gl!.compressedTexImage2D(target,level,format,width,height,border,upload.bytes);
      else b.gl!.compressedTexSubImage2D(target,level,x,y,width,height,format,upload.bytes);
    },level!==0);
    // A compressed level is never an expanded luminance/alpha float level.
    if (accepted && image) setExpandedLevel(upload.object,target,level,null);
    return accepted ? reply() : -5;
  });
}
