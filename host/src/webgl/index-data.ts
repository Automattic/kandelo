import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement } from "./native-recovery.js";
import type { GlBinding } from "./registry.js";
import { activeVertexArray } from "./buffer-references.js";
import { allocateNativeBuffer, BUFFER_TRANSFER_BYTES, prepareBufferDraw, withBufferTransfer } from "./buffer-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

const BYTE = 0x1401, SHORT = 0x1403, INT = 0x1405;
const ELEMENT = 0x8893, COPY_READ = 0x8f36, COPY_WRITE = 0x8f37;

/** GLES2's maximum byte/short indices are vertices. WebGL2 always enables
 * fixed-index restart, so widen values without changing the primitive stream. */
export function drawGlesElements(b: GlBinding, mode: number, count: number, type: number, offset: number): void {
  const gl = b.gl!;
  if (mode > 6 || (type !== BYTE && type !== SHORT)) { recordGlError(b,0x500); return; }
  if (count < 0) { recordGlError(b,0x501); return; }
  const width = type === BYTE ? 1 : 2, promotedWidth = width*2;
  if (offset % width) { recordGlError(b,0x502); return; }
  if (count === 0) { checkedGlCall(b, () => gl.drawElements(mode,0,type,offset)); return; }
  const object = activeVertexArray(b).element, store = object && b.bufferStores.get(object);
  const previous = store?.views.get(ELEMENT)?.native;
  if (!store || !previous || offset < 0 || offset+count*width > store.size) { recordGlError(b,0x502); return; }
  if (!prepareBufferDraw(b,true)) return;
  const perChunk = Math.floor(BUFFER_TRANSFER_BYTES/promotedWidth);
  let input: Uint8Array<ArrayBuffer>, output: Uint8Array<ArrayBuffer>;
  try {
    input = new Uint8Array(Math.min(count,perChunk)*width);
    output = new Uint8Array(Math.min(count,perChunk)*promotedWidth);
  } catch { recordGlError(b,0x505); return; }
  const retirement = reserveNativeRetirement(b,[["deleteBuffer",null]]); if (!retirement) return;
  const temporary = allocateNativeBuffer(b,retirement);
  if (!temporary) { retireNativeRetirement(retirement); return; }
  try {
    applyNativeChanges(b,[{apply: () => {
      // Classify as index data before using copy targets; logical VAO state
      // continues to own the original buffer throughout this private draw.
      if (!checkedGlCall(b, () => gl.bindBuffer(ELEMENT,temporary))) return false;
      if (!withBufferTransfer(b,store.source,temporary,() => {
        if (!checkedGlCall(b, () => gl.bufferData(COPY_WRITE,count*promotedWidth,0x88e0))) return false;
        for (let first=0; first<count; first+=perChunk) {
          const indices = Math.min(perChunk,count-first);
          const source = input.subarray(0,indices*width), destination = output.subarray(0,indices*promotedWidth);
          if (!checkedGlCall(b, () => gl.getBufferSubData(COPY_READ,offset+first*width,source))) return false;
          const read = new DataView(source.buffer,source.byteOffset,source.byteLength);
          const write = new DataView(destination.buffer,destination.byteOffset,destination.byteLength);
          for (let i=0; i<indices; i++) {
            if (type === BYTE) write.setUint16(i*2,read.getUint8(i),true);
            else write.setUint32(i*4,read.getUint16(i*2,true),true);
          }
          if (!checkedGlCall(b, () => gl.bufferSubData(COPY_WRITE,first*promotedWidth,destination))) return false;
        }
        return true;
      })) return false;
      return checkedGlCall(b, () => gl.drawElements(mode,count,type === BYTE ? SHORT : INT,0));
    },restore:nativeInverse(b)}],{finalizer:nativeInverse(b,[["bindBuffer",ELEMENT,previous]])});
  } finally { retireNativeRetirement(retirement); }
}
