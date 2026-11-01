import type { GlBinding } from "./registry.js";
import { validateDrawFramebufferWithoutProgram } from "./framebuffer.js";
import { activeVertexArray } from "./buffer-references.js";
import { prepareBufferDraw } from "./buffer-storage.js";
import { prepareImageDraw } from "./image-storage.js";
import { packedVertexLayout } from "./vertex-data.js";
import { checkedGlCall, checkedGlGroup, recordGlError } from "./program-objects.js";
import { issueGlesDraw, sequentialVertices } from "./draw-state.js";
import { requireGlesFramebufferComplete } from "./image-sizes.js";
import { INLINE_DRAW_HEADER_BYTES, INLINE_DRAW_ATTRIBUTE_BYTES, INLINE_DRAW_MAX_BYTES, INLINE_DRAW_MAX_ATTRIBUTES } from "./ops.js";
import {
  applyNativeChanges, batchedNativeInverse, nativeInverse, repairNativeState,
  reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement,
  type NativeCall, type NativeChange, rethrowNativeGlFault } from "./native-recovery.js";

const ARRAY = 0x8892, FLOAT = 0x1406, FIXED = 0x140c;
const STREAM_DRAW = 0x88e0;
type Attribute = {
  index: number; size: number; type: number; normalized: boolean;
  elementBytes: number; byteLength: number; dataOffset: number;
};
type Draw = {mode: number; first: number; count: number; attributes: Attribute[]};
export type PrivateClientDrawResult = {attempted: boolean; accepted: boolean; restored: boolean};

function componentBytes(type: number): number {
  switch (type) {
    case 0x1400: case 0x1401: return 1;
    case 0x1402: case 0x1403: return 2;
    case FLOAT: case FIXED: return 4;
    default: return 0;
  }
}

/** Inline OP_DRAW_CLIENT_ARRAYS payload:
 * mode, first, count, attributeCount; then sorted attributes containing
 * index, size, type, normalized, packedByteLength and bytes. Source strides
 * belong to the encoder's packing, not the temporary native pointer layout.
 * No address, public buffer name, partial-upload token or persistent guest view.
 * Positive draws that exceed u16 retain the existing encoder path. */
function parseDraw(v: DataView): Draw | null {
  if (v.byteLength < INLINE_DRAW_HEADER_BYTES || v.byteLength > INLINE_DRAW_MAX_BYTES) return null;
  const mode = v.getUint32(0,true), first = v.getInt32(4,true), count = v.getInt32(8,true);
  const n = v.getUint32(12,true);
  if (mode > 6 || first < 0 || count <= 0 || n === 0 || n > INLINE_DRAW_MAX_ATTRIBUTES) return null;
  const attributes: Attribute[] = [];
  let p = INLINE_DRAW_HEADER_BYTES, previous = -1;
  for (let i = 0; i < n; i++) {
    if (p+INLINE_DRAW_ATTRIBUTE_BYTES > v.byteLength) return null;
    const index = v.getUint32(p,true), size = v.getUint32(p+4,true), type = v.getUint32(p+8,true);
    const normalized = v.getUint32(p+12,true);
    const byteLength = v.getUint32(p+16,true), width = componentBytes(type), elementBytes = size*width;
    if (index <= previous || index >= INLINE_DRAW_MAX_ATTRIBUTES || size < 1 || size > 4 || !width || normalized > 1 ||
        byteLength !== count*elementBytes ||
        (first+count)*elementBytes > 0x7fffffff || p+INLINE_DRAW_ATTRIBUTE_BYTES+byteLength > v.byteLength) return null;
    attributes.push({index,size,type,normalized:normalized === 1,elementBytes,byteLength,dataOffset:p+INLINE_DRAW_ATTRIBUTE_BYTES});
    previous = index; p += INLINE_DRAW_ATTRIBUTE_BYTES+byteLength;
  }
  return p === v.byteLength ? {mode,first,count,attributes} : null;
}

/** Whole-record shape validation precedes any native effect. */
export function validPrivateClientDraw(v: DataView): boolean {
  try { return parseDraw(v) !== null; } catch (caught) { rethrowNativeGlFault(caught); return false; }
}

/** Consume one admitted draw exactly once. A false acceptance/restoration result
 * is an error report, never permission to replay pixels after native submission.
 * Logical VAO definitions and all public buffer maps remain unchanged. */
export function drawPrivateClientArrays(b: GlBinding, v: DataView): PrivateClientDrawResult {
  const result = {attempted:false,accepted:false,restored:false};
  try {
    const draw = parseDraw(v), gl = b.gl;
    if (!draw || !gl || b.vertexArrayId !== 0 || b.savedClientArrayBuffer !== undefined) {
      recordGlError(b,0x502); return result;
    }
    const vao = activeVertexArray(b);
    let clients = 0;
    for (const a of vao.attributes.values()) if (a.enabled && a.buffer === null) clients++;
    if (clients !== draw.attributes.length) { recordGlError(b,0x502); return result; }
    for (const a of draw.attributes) {
      const logical = vao.attributes.get(a.index);
      if (!logical?.enabled || logical.buffer !== null || logical.view ||
          logical.size !== a.size || logical.type !== a.type || logical.normalized !== a.normalized) {
        recordGlError(b,0x502); return result;
      }
    }
    if (!requireGlesFramebufferComplete(b) || !validateDrawFramebufferWithoutProgram(b)) return result;
    if (!repairNativeState(gl) || !prepareBufferDraw(b,false) || !prepareImageDraw(b)) return result;

    // One persistent stream buffer per context holds every client
    // attribute of a draw, each in its own 4-byte-aligned region, so a draw
    // needs no buffer creation or deletion. Its contents are replaced (and
    // the old storage orphaned) by each draw's upload.
    const stream = clientArrayStream(b);
    if (!stream) return result;
    const regions: number[] = [];
    let total = 0;
    for (const a of draw.attributes) { regions.push(total); total += Math.ceil((draw.first+draw.count)*a.elementBytes/4)*4; }
    // Copy only the referenced packed elements. These bounded private bytes are
    // never retained by a repair, native retirement, persistent realm or cache.
    const packed = (a: Attribute, into: Uint8Array, at: number) => {
      into.set(new Uint8Array(v.buffer,v.byteOffset+a.dataOffset,a.byteLength),at);
      if (a.type === FIXED) {
        const view = new DataView(into.buffer,into.byteOffset+at,a.byteLength);
        for (let i = 0; i < a.byteLength; i += 4) view.setFloat32(i,view.getInt32(i,true)/65536,true);
      }
    };
    const upload: (() => void)[] = [];
    if (draw.first === 0) {
      const bytes = new Uint8Array(total);
      draw.attributes.forEach((a,i) => packed(a,bytes,regions[i]));
      upload.push(() => gl.bufferData(ARRAY,bytes,STREAM_DRAW));
    } else {
      // A nonzero first leaves each region's prefix unread: size the store
      // without staging it, then write only the referenced elements.
      upload.push(() => gl.bufferData(ARRAY,total,STREAM_DRAW));
      draw.attributes.forEach((a,i) => {
        const bytes = new Uint8Array(a.byteLength);
        packed(a,bytes,0);
        upload.push(() => gl.bufferSubData(ARRAY,regions[i]+draw.first*a.elementBytes,bytes));
      });
    }
    draw.attributes.forEach((a,i) => upload.push(() => gl.vertexAttribPointer(a.index,a.size,a.type === FIXED ? FLOAT : a.type,
      a.type === FIXED ? false : a.normalized,0,regions[i])));
    // The logical client-array pointers (no buffer) and ARRAY binding.
    const restore: NativeCall[] = [["bindBuffer",ARRAY,null],
      ...draw.attributes.map(a => {
        const old = vao.attributes.get(a.index)!;
        return ["vertexAttribPointer",a.index,old.size,old.type === FIXED ? FLOAT : old.type,
          old.type === FIXED ? false : old.normalized,packedVertexLayout(old) ? 0 : old.stride,0] as NativeCall;
      }),
      ["bindBuffer",ARRAY,b.shadow.arrayBuffer]];
    const completion = {submitted:false,complete:false};
    // The stream bind is checked on its own: uploads after a failed bind
    // would write the guest's ARRAY_BUFFER. Uploads and pointer calls then
    // form one checked group; the draw has its own check, so its error
    // reaches the guest as the draw's; the restoration is one checked group.
    // A failed step or restoration stays journalled and fences the context
    // until repaired.
    const changes: NativeChange[] = [
      {apply:() => checkedGlCall(b,() => gl.bindBuffer(ARRAY,stream)) && checkedGlGroup(b,upload,true),
        restore:batchedNativeInverse(b,restore)},
      {apply:() => {
        result.accepted = issueGlesDraw(b,{mode:draw.mode,cleanEntry:true,issue:() => {
          result.attempted = true;
          gl.drawArrays(draw.mode,draw.first,draw.count);
        },vertices:() => sequentialVertices(draw.first,draw.count),maxVertex:draw.first+draw.count-1});
        return result.accepted;
      },restore:nativeInverse(b)},
    ];
    applyNativeChanges(b,changes,{completion,finalizer:batchedNativeInverse(b,restore)});
    result.restored = completion.complete;
    return result;
  } catch (caught) { rethrowNativeGlFault(caught); recordGlError(b,0x505); return result; }
}

/** The context's client-array stream buffer, created on first use and
 * deleted with the context (registry.ts). */
function clientArrayStream(b: GlBinding): WebGLBuffer | null {
  if (b.clientArrayStream) return b.clientArrayStream;
  // A handle returned by a rejected creation is still deleted (and retried).
  const candidate = reserveNativeRetirement(b,[["deleteBuffer",null]]);
  if (!candidate) return null;
  let stream: WebGLBuffer | null = null;
  const created = checkedGlCall(b, () => { stream = b.gl!.createBuffer(); candidate.calls[0][1] = stream; });
  if (created && !stream) recordGlError(b,0x505);
  if (!created || !stream) { retireNativeRetirement(candidate); return null; }
  transferNativeRetirement(candidate);
  return b.clientArrayStream = stream;
}
