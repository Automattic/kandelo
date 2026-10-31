import type { GlBinding } from "./registry.js";
import { activeVertexArray } from "./buffer-references.js";
import { allocateNativeBuffer, prepareBufferDraw } from "./buffer-storage.js";
import { prepareImageDraw } from "./image-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { INLINE_DRAW_HEADER_BYTES, INLINE_DRAW_ATTRIBUTE_BYTES, INLINE_DRAW_MAX_BYTES, INLINE_DRAW_MAX_ATTRIBUTES } from "./ops.js";
import {
  applyNativeChanges, nativeInverse, repairNativeState,
  reserveNativeRetirement, retireNativeRetirement,
  type NativeCall, type NativeChange, type NativeRetirement,
} from "./native-recovery.js";

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
  try { return parseDraw(v) !== null; } catch { return false; }
}

/** Consume one admitted draw exactly once. A false acceptance/restoration result
 * is an error report, never permission to replay pixels after native submission.
 * Logical VAO definitions and all public buffer maps remain unchanged. */
export function drawPrivateClientArrays(b: GlBinding, v: DataView): PrivateClientDrawResult {
  const result = {attempted:false,accepted:false,restored:false};
  let retirements: (NativeRetirement | null)[] = [];
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
    if (!repairNativeState(gl) || !prepareBufferDraw(b,false) || !prepareImageDraw(b)) return result;

    // Copy only the referenced packed elements. These bounded private bytes are
    // never retained by a repair, native retirement, persistent realm or cache.
    const uploads = draw.attributes.map(a => {
      const bytes = new Uint8Array(v.buffer,v.byteOffset+a.dataOffset,a.byteLength).slice();
      if (a.type === FIXED) {
        const input = new DataView(bytes.buffer), output = new DataView(bytes.buffer);
        for (let i = 0; i < bytes.length; i += 4) output.setFloat32(i,input.getInt32(i,true)/65536,true);
      }
      return bytes;
    });
    // Reserve the dense owner slots before acquiring retirement tickets, so a
    // later array growth cannot strand an already registered empty ticket.
    retirements = new Array<NativeRetirement | null>(draw.attributes.length).fill(null);
    for (let i = 0; i < draw.attributes.length; i++) {
      const retirement = reserveNativeRetirement(b,[["deleteBuffer",null]]);
      if (!retirement) return result;
      retirements[i] = retirement;
    }
    const pointers: NativeCall[][] = draw.attributes.map(a => {
      const old = vao.attributes.get(a.index)!;
      return [["bindBuffer",ARRAY,null],
        ["vertexAttribPointer",a.index,old.size,old.type === FIXED ? FLOAT : old.type,
          old.type === FIXED ? false : old.normalized,
          old.type === FIXED || old.stride > 255 ? 0 : old.stride,0]];
    });
    const restoreArray: NativeCall[] = [["bindBuffer",ARRAY,b.shadow.arrayBuffer]];
    const completion = {submitted:false,complete:false};
    const changes: NativeChange[] = draw.attributes.map((a,i) => ({
      apply: () => {
        const temporary = allocateNativeBuffer(b,retirements[i]!);
        if (!temporary || !checkedGlCall(b,() => gl.bindBuffer(ARRAY,temporary))) return false;
        if (draw.first === 0) {
          if (!checkedGlCall(b,() => gl.bufferData(ARRAY,uploads[i],STREAM_DRAW))) return false;
        } else {
          if (!checkedGlCall(b,() => gl.bufferData(ARRAY,(draw.first+draw.count)*a.elementBytes,STREAM_DRAW)) ||
              !checkedGlCall(b,() => gl.bufferSubData(ARRAY,draw.first*a.elementBytes,uploads[i]))) return false;
        }
        return checkedGlCall(b,() => gl.vertexAttribPointer(a.index,a.size,a.type === FIXED ? FLOAT : a.type,
          a.type === FIXED ? false : a.normalized,0,0));
      },
      restore:nativeInverse(b,pointers[i]),
    }));
    changes.push({apply:() => {
      result.accepted = checkedGlCall(b,() => {
        result.attempted = true;
        gl.drawArrays(draw.mode,draw.first,draw.count);
      });
      return result.accepted;
    },restore:nativeInverse(b)});
    // Success must undo the private overrides too. On failure the same exact
    // inverses remain journalled; cleanup cannot delete their backing early.
    applyNativeChanges(b,changes,{completion,
      finalizer:nativeInverse(b,...pointers.slice().reverse(),restoreArray)});
    result.restored = completion.complete;
    return result;
  } catch { recordGlError(b,0x505); return result; }
  finally {
    for (const retirement of retirements) if (retirement) retireNativeRetirement(retirement);
  }
}
