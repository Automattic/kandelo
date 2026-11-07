import type { GlBinding } from "./registry.js";
import { recordGlError } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";

/** Independent copied pixels outlive the native read, never its framebuffer or
 * guest address space. One capture is owned by one exact logical context. */
export type GlReadbackCapture = {
  token: number;
  bytes: Uint8Array<ArrayBuffer>;
  gl: WebGL2RenderingContext;
  context: GlBinding["contextId"];
  shadow: GlBinding["shadow"];
};
// This is a copied-storage resource budget, separate from the 64 KiB RPC cap.
export const READBACK_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

function pixelBytes(format: number, type: number): number {
  const channels = format === 0x1908 || format === 0x80e1 ? 4
    : format === 0x1907 ? 3 : format === 0x190a || format === 0x8227 ? 2
    : [0x1902,0x1903,0x1906,0x1909].includes(format) ? 1 : 0;
  if (!channels) return 0;
  if ([0x8033,0x8034,0x8363].includes(type)) return 2;
  if ([0x8368,0x84fa,0x8c3b].includes(type)) return 4;
  return channels * (type === 0x1401 ? 1
    : [0x1403,0x140b,0x8d61].includes(type) ? 2
    : [0x1405,0x1406].includes(type) ? 4 : 0);
}

/** BEGIN captures the complete original native read exactly once. CHUNK only
 * copies accepted independent bytes; RELEASE never repeats a native operation. */
export function runReadbackCapture(b: GlBinding, input: Uint8Array, out: Uint8Array,
    capture: (metadata: Uint8Array, bytes: Uint8Array<ArrayBuffer>) => number): number {
  if (input.length < 8) return -22;
  const v=new DataView(input.buffer,input.byteOffset,input.byteLength);
  const action=v.getUint32(0,true),token=v.getUint32(4,true);
  if (!token || action<1 || action>3 || input.length!==(action===1?36:action===2?16:8)) return -22;
  const count=action===2?v.getUint32(12,true):0;
  if (count>65520 || out.length!==(action===2?count+16:16)) return -22;
  return checkedQueryReply(b,out,count+8,payload=>{
    const result=new DataView(payload.buffer);
    const invalid=()=>{recordGlError(b,0x502);return -22;};
    result.setUint32(0,token,true);
    if (action===1) {
      if (token<=b.readbackCaptureSerial) return invalid();
      b.readbackCaptureSerial=token;b.readbackCapture=null;
      const total=v.getUint32(8,true),width=v.getInt32(20,true),height=v.getInt32(24,true);
      const bpp=pixelBytes(v.getUint32(28,true),v.getUint32(32,true));
      if (width<0 || height<0) {recordGlError(b,0x501);return -22;}
      const row=width*bpp,alignment=b.shadow.packAlignment;
      const stride=Math.ceil(row/alignment)*alignment;
      const required=height===0?0:(height-1)*stride+row;
      if (!bpp || !Number.isSafeInteger(required) || total!==required) return invalid();
      if (total>READBACK_CAPTURE_MAX_BYTES) {recordGlError(b,0x505);return -12;}
      const gl=b.gl!,context=b.contextId,shadow=b.shadow;
      const bytes=new Uint8Array(total);
      if (capture(input.subarray(12),bytes)<0) return -5;
      if (b.gl!==gl || b.contextId!==context || b.shadow!==shadow ||
          b.readbackCaptureSerial!==token || b.readbackCapture!==null) return invalid();
      b.readbackCapture={token,bytes,gl,context,shadow};
      result.setUint32(4,total,true);return 8;
    }
    const pending=b.readbackCapture;
    if (action===3) {
      if (pending && pending.token!==token) return invalid();
      if (pending && pending.token===token) b.readbackCapture=null;
      b.readbackCaptureSerial=Math.max(b.readbackCaptureSerial,token);
      return 8;
    }
    if (!pending || pending.token!==token) return invalid();
    if (pending.gl!==b.gl || pending.context!==b.contextId || pending.shadow!==b.shadow) {
      b.readbackCapture=null;return invalid();
    }
    const offset=v.getUint32(8,true);
    if (offset+count>pending.bytes.length) return invalid();
    result.setUint32(4,count,true);payload.set(pending.bytes.subarray(offset,offset+count),8);
    return count+8;
  });
}
