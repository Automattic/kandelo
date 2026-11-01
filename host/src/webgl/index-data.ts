import { validateDrawFramebufferWithoutProgram } from "./framebuffer.js";
import { applyNativeChanges, batchedNativeInverse, nativeInverse, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement } from "./native-recovery.js";
import type { GlBinding } from "./registry.js";
import { activeVertexArray } from "./buffer-references.js";
import { allocateNativeBuffer, BUFFER_TRANSFER_BYTES, prepareBufferDraw, withBufferTransfer, type GlBufferStore } from "./buffer-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { issueGlesDraw } from "./draw-state.js";
import { requireGlesFramebufferComplete } from "./image-sizes.js";

const BYTE = 0x1401, SHORT = 0x1403, INT = 0x1405;
const ELEMENT = 0x8893, COPY_READ = 0x8f36, COPY_WRITE = 0x8f37;

/** An element buffer's indices of one type and byte phase (offset % width)
 * as WebGL 2 can draw them. WebGL 2 always enables fixed-index primitive
 * restart, so a stored 0xFF (byte) or 0xFFFF (short) index, an ordinary
 * vertex in GLES 2, would restart the primitive; and WebGL requires the
 * offset to be a multiple of the index size, which GLES 2 does not
 * (section 2.8). `direct`: the stored indices need neither change, so the
 * buffer is drawn as is. Otherwise `native` holds every index from the
 * phase on, widened to the next type, so no restart value can occur.
 * Derived once per buffer contents: any data change invalidates it
 * (buffer-storage.ts), so draws neither read back nor convert indices. */
export type GlIndexForm = { valid: boolean; direct: boolean; native: WebGLBuffer | null };

function indexForm(b: GlBinding, store: GlBufferStore, type: number, phase: number, previous: WebGLBuffer): GlIndexForm | null {
  const key = `${type}:${phase}`;
  let form = store.indexForms?.get(key);
  if (form?.valid) return form;
  const gl = b.gl!, width = type === BYTE ? 1 : 2, promotedWidth = width*2;
  const restart = type === BYTE ? 0xff : 0xffff;
  const total = Math.max(0, Math.floor((store.size-phase)/width));
  const perChunk = Math.floor(BUFFER_TRANSFER_BYTES/promotedWidth);
  let input: Uint8Array<ArrayBuffer>, output: Uint8Array<ArrayBuffer>;
  try {
    input = new Uint8Array(Math.min(Math.max(total,1),perChunk)*width);
    output = new Uint8Array(Math.min(Math.max(total,1),perChunk)*promotedWidth);
    if (!form) { form = { valid: false, direct: false, native: null }; (store.indexForms ??= new Map()).set(key, form); }
  } catch { recordGlError(b,0x505); return null; }
  const entry = form;
  // Pass one reads the indices and looks for a restart value.
  let direct = phase === 0;
  if (direct && !withBufferTransfer(b,store.source,store.source,() => {
    for (let first=0; first<total && direct; first+=perChunk) {
      const source = input.subarray(0,Math.min(perChunk,total-first)*width);
      if (!checkedGlCall(b, () => gl.getBufferSubData(COPY_READ,phase+first*width,source))) return false;
      const read = new DataView(source.buffer,source.byteOffset,source.byteLength);
      for (let i=0; i<source.length/width && direct; i++)
        if ((type === BYTE ? read.getUint8(i) : read.getUint16(i*2,true)) === restart) direct = false;
    }
    return true;
  })) return null;
  if (direct) { entry.direct = true; entry.valid = true; return entry; }
  // Pass two widens every index from the phase on into the form's buffer.
  if (!entry.native) {
    const retirement = reserveNativeRetirement(b,[["deleteBuffer",null]]); if (!retirement) return null;
    const native = allocateNativeBuffer(b,retirement);
    if (!native) { retireNativeRetirement(retirement); return null; }
    transferNativeRetirement(retirement); entry.native = native;
  }
  const target = entry.native;
  const accepted = applyNativeChanges(b,[{apply: () => {
    // Classify as index data before using copy targets; the logical VAO
    // element binding is restored by the finalizer.
    if (!checkedGlCall(b, () => gl.bindBuffer(ELEMENT,target))) return false;
    return withBufferTransfer(b,store.source,target,() => {
      if (!checkedGlCall(b, () => gl.bufferData(COPY_WRITE,Math.max(total,1)*promotedWidth,0x88e4))) return false;
      for (let first=0; first<total; first+=perChunk) {
        const indices = Math.min(perChunk,total-first);
        const source = input.subarray(0,indices*width), destination = output.subarray(0,indices*promotedWidth);
        if (!checkedGlCall(b, () => gl.getBufferSubData(COPY_READ,phase+first*width,source))) return false;
        const read = new DataView(source.buffer,source.byteOffset,source.byteLength);
        const write = new DataView(destination.buffer,destination.byteOffset,destination.byteLength);
        for (let i=0; i<indices; i++) {
          if (type === BYTE) write.setUint16(i*2,read.getUint8(i),true);
          else write.setUint32(i*4,read.getUint16(i*2,true),true);
        }
        if (!checkedGlCall(b, () => gl.bufferSubData(COPY_WRITE,first*promotedWidth,destination))) return false;
      }
      return true;
    });
  },restore:nativeInverse(b)}],{finalizer:nativeInverse(b,[["bindBuffer",ELEMENT,previous]])});
  if (!accepted) return null;
  entry.direct = false; entry.valid = true;
  return entry;
}

/** GLES2's maximum byte/short indices are vertices: draw them through the
 * buffer's derived index form (GlIndexForm). */
export function drawGlesElements(b: GlBinding, mode: number, count: number, type: number, offset: number): void {
  const gl = b.gl!;
  if (mode > 6 || (type !== BYTE && type !== SHORT)) { recordGlError(b,0x500); return; }
  if (count < 0) { recordGlError(b,0x501); return; }
  const width = type === BYTE ? 1 : 2, promotedWidth = width*2;
  if (!requireGlesFramebufferComplete(b) || !validateDrawFramebufferWithoutProgram(b)) return;
  // ES 2.0 section 2.8 has no index-offset alignment rule; WebGL 1.0 section
  // 6.4 does. An empty draw reads no index, so validate it at the aligned
  // offset.
  if (count === 0) { issueGlesDraw(b,{mode,empty:true,issue:() => gl.drawElements(mode,0,type,offset - offset % width),vertices:() => null}); return; }
  const object = activeVertexArray(b).element, store = object && b.bufferStores.get(object);
  const previous = store?.views.get(ELEMENT)?.native;
  if (!store || !previous || offset < 0 || offset+count*width > store.size) { recordGlError(b,0x502); return; }
  if (!prepareBufferDraw(b,true)) return;
  const phase = offset % width, form = indexForm(b,store,type,phase,previous);
  if (!form) return;
  if (form.direct) {
    // The bound element buffer as stored: no restart value, aligned offset.
    issueGlesDraw(b,{mode,observed:false,issue:() => gl.drawElements(mode,count,type,offset),
      vertices:() => {
        const indices = type === BYTE ? new Uint8Array(count) : new Uint16Array(count);
        gl.getBufferSubData(ELEMENT,offset,indices);
        return indices;
      }});
    return;
  }
  const widened = form.native!, at = (offset-phase)/width*promotedWidth;
  applyNativeChanges(b,[{apply: () => checkedGlCall(b, () => gl.bindBuffer(ELEMENT,widened)) &&
    issueGlesDraw(b,{mode,cleanEntry:true,issue:() => gl.drawElements(mode,count,type === BYTE ? SHORT : INT,at),
      vertices:() => {
        // Face passes read this draw's widened indices.
        const promoted = type === BYTE ? new Uint16Array(count) : new Uint32Array(count);
        gl.getBufferSubData(ELEMENT,at,promoted);
        return promoted;
      }}),
  restore:nativeInverse(b)}],{finalizer:batchedNativeInverse(b,[["bindBuffer",ELEMENT,previous]])});
}
