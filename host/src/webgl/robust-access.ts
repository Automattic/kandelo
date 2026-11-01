/**
 * Robust buffer access (EXT_robustness section 2.8, KHR_robustness section
 * 10.3.1.1rob) for contexts created with EGL_CONTEXT_OPENGL_ROBUST_ACCESS.
 *
 * In such a context a vertex index outside an enabled attribute's buffer
 * gives that attribute undefined values and "cannot result in application
 * failure"; it is not an error. WebGL 1.0 section 6.6 (kept by WebGL 2.0)
 * instead lets the draw raise INVALID_OPERATION and draw nothing, and the
 * browsers do. So a robust context never lets WebGL see an out-of-range
 * fetch: before each draw the host compares the highest vertex index the draw
 * reads with every enabled buffer-backed attribute's native storage, and an
 * attribute that would read past the end draws from a private copy of that
 * storage padded with zeros (WebGL zero-fills new stores). In-range values
 * are the guest's, out-of-range values are zero, as the extensions allow.
 * Only the attributes that need it are substituted, for that draw only.
 *
 * The padded copy is a converted view of the buffer store, so it is retired
 * with the store and invalidated by every write to it (buffer-storage.ts).
 * It is rebuilt only when invalid or too small, never per draw. Contexts
 * without robust access pay one flag test per draw.
 */
import type { GlBinding } from "./registry.js";
import type { GlVertexAttribute } from "./buffer-references.js";
import { activeVertexArray } from "./buffer-references.js";
import { allocateNativeBuffer, withBufferTransfer } from "./buffer-storage.js";
import { packedVertexLayout } from "./vertex-data.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { nativeInverse, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement,
  type NativeCall, type NativeChange } from "./native-recovery.js";

const ARRAY = 0x8892, COPY_READ = 0x8f36, COPY_WRITE = 0x8f37, FIXED = 0x140c, FLOAT = 0x1406;
// Native buffer offsets and sizes travel as GLintptr/GLsizeiptr; a larger
// padded store cannot be created and is reported as OUT_OF_MEMORY.
const MAX_PADDED_BYTES = 0x7fffffff;

function componentBytes(type: number): number {
  switch (type) {
    case 0x1400: case 0x1401: return 1;
    case 0x1402: case 0x1403: return 2;
    case FIXED: case FLOAT: return 4;
    default: return 0;
  }
}

/** Capacity of each padded view, keyed by the view record itself. */
const capacities = new WeakMap<object, number>();

type NativeLayout = { source: WebGLBuffer; bytes: number; offset: number; stride: number; element: number; key: string };

/** The storage WebGL actually fetches this attribute from: the store's
 * vertex view, or the packed converted view (vertex-data.ts). */
function nativeLayout(b: GlBinding, a: GlVertexAttribute): NativeLayout | null {
  const store = a.buffer && b.bufferStores.get(a.buffer);
  if (!store) return null;
  const element = componentBytes(a.type)*a.size;
  if (!element) return null;
  if (a.view !== undefined || packedVertexLayout(a)) {
    if (!a.view) return null;
    const stride = a.stride || element;
    const count = store.size < a.offset+element ? 0 : Math.floor((store.size-a.offset-element)/stride)+1;
    return { source: a.view, bytes: count*element, offset: 0, stride: element, element,
      key: `robust:${a.type}:${a.size}:${a.stride}:${a.offset}` };
  }
  const source = store.views.get(ARRAY)?.native;
  if (!source) return null;
  return { source, bytes: store.size, offset: a.offset, stride: a.stride || element, element, key: "robust" };
}

/** A zero-padded copy of `layout.source` holding at least `required` bytes,
 * reused while the store is unchanged. Null after a recorded error. */
function paddedView(b: GlBinding, a: GlVertexAttribute, layout: NativeLayout, required: number): WebGLBuffer | null {
  const store = b.bufferStores.get(a.buffer!)!, gl = b.gl!;
  let view = store.converted.get(layout.key);
  if (view && b.bufferRetirements.get(view.native)?.complete) {
    store.converted.delete(layout.key); b.bufferViewOwners.delete(view.native); b.bufferRetirements.delete(view.native);
    view = undefined;
  }
  if (view && view.valid && (capacities.get(view) ?? 0) >= required) return view.native;
  const capacity = Math.max(required, view ? capacities.get(view) ?? 0 : 0);
  if (capacity > MAX_PADDED_BYTES) { recordGlError(b,0x505); return null; }
  let created = false;
  if (!view) {
    const candidate = reserveNativeRetirement(b,[["deleteBuffer",null]]);
    if (!candidate) return null;
    try {
      const native = allocateNativeBuffer(b,candidate);
      if (!native) return null;
      view = {native,valid:false};
      store.converted.set(layout.key,view); b.bufferViewOwners.set(native,a.buffer!);
      transferNativeRetirement(candidate); created = true;
    } catch { recordGlError(b,0x505); return null; }
    finally { if (!created) retireNativeRetirement(candidate); }
  }
  const padded = view;
  padded.valid = false;
  const copied = withBufferTransfer(b,layout.source,padded.native,() =>
    checkedGlCall(b, () => gl.bufferData(COPY_WRITE,capacity,0x88e4)) &&
    (layout.bytes === 0 || checkedGlCall(b, () => gl.copyBufferSubData(COPY_READ,COPY_WRITE,0,0,layout.bytes))));
  if (!copied) return null;
  capacities.set(padded,capacity);
  padded.valid = true;
  return padded.native;
}

export type RobustDraw = { changes: NativeChange[]; finalizer: NativeCall[][] };

/** Private pointer substitutions for one draw reading vertices 0..maxVertex.
 * Undefined when every fetch is already in range; null after a recorded
 * error (the draw is not issued). */
export function robustVertexDraw(b: GlBinding, maxVertex: number): RobustDraw | null | undefined {
  const gl = b.gl!;
  let result: RobustDraw | undefined;
  for (const [index,a] of activeVertexArray(b).attributes) {
    if (!a.enabled || !a.buffer) continue;
    const layout = nativeLayout(b,a);
    if (!layout) continue;
    const required = layout.offset+maxVertex*layout.stride+layout.element;
    if (required <= layout.bytes) continue;
    const padded = paddedView(b,a,layout,required);
    if (!padded) return null;
    const packed = layout.source === a.view;
    const type = a.type === FIXED ? FLOAT : a.type, normalized = a.type === FIXED ? false : a.normalized;
    const stride = packed ? 0 : a.stride, offset = packed ? 0 : a.offset;
    const restore: NativeCall[] = [["bindBuffer",ARRAY,layout.source],
      ["vertexAttribPointer",index,a.size,type,normalized,stride,offset]];
    result ??= { changes: [], finalizer: [] };
    result.changes.push({ apply: () => checkedGlCall(b, () => {
      gl.bindBuffer(ARRAY,padded);
      gl.vertexAttribPointer(index,a.size,type,normalized,stride,offset);
    }), restore: nativeInverse(b,restore) });
    result.finalizer.push(restore);
  }
  if (result) result.finalizer.push([["bindBuffer",ARRAY,b.shadow.arrayBuffer]]);
  return result;
}
