import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement, type NativeCall } from "./native-recovery.js";
import { vertexAttribute } from "./buffer-references.js";
import { maxVertexAttributes } from "./limits.js";
import type { GlBinding } from "./registry.js";
import type { GlVertexAttribute } from "./buffer-references.js";
import { allocateNativeBuffer, BUFFER_TRANSFER_BYTES, withBufferTransfer, retireBufferObjects } from "./buffer-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

const FIXED = 0x140c, FLOAT = 0x1406, ARRAY = 0x8892;
const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37;
function componentBytes(type: number): number {
  switch (type) {
    case 0x1400: case 0x1401: return 1;
    case 0x1402: case 0x1403: return 2;
    case FIXED: case FLOAT: return 4;
    default: return 0;
  }
}
function layoutKey(a: GlVertexAttribute): string { return `${a.type}:${a.size}:${a.stride}:${a.offset}`; }

/** Install every core format transactionally. Metadata capacity precedes native
 * pointer changes, including independent packed views for converted layouts. */
export function installVertexAttribute(b: GlBinding, index: number, a: GlVertexAttribute): boolean {
  const gl = b.gl!, width = componentBytes(a.type);
  if (!width) { recordGlError(b,0x500); return false; }
  if (a.size < 1 || a.size > 4 || a.stride < 0) { recordGlError(b,0x501); return false; }
  let limit = 0;
  if (!checkedGlCall(b, () => { limit = maxVertexAttributes(gl); })) return false;
  if (!limit) { recordGlError(b,0x502); return false; }
  if (index >= limit) { recordGlError(b,0x501); return false; }
  if (a.offset < 0 || a.offset % width || a.stride % width || (!a.buffer && a.offset !== 0)) { recordGlError(b,0x502); return false; }
  const array = b.shadow.arrayBuffer, old = vertexAttribute(b,index);
  const packed = a.type === FIXED || a.stride > 255;
  const store = a.buffer && b.bufferStores.get(a.buffer);
  if (a.buffer && !store) { recordGlError(b,0x502); return false; }
  const key = packed ? layoutKey(a) : "";
  const candidate = reserveNativeRetirement(b,[["deleteBuffer",null]]);
  if (!candidate) return false;
  const rollback = reserveNativeRetirement(b,[["deleteBuffer",null]]);
  if (!rollback) { retireNativeRetirement(candidate); return false; }
  let created = false, installed = false;
  let view = packed && store ? store.converted.get(key) : undefined;
  if (view && b.bufferRetirements.get(view.native)?.complete) {
    store!.converted.delete(key); b.bufferViewOwners.delete(view.native); b.bufferRetirements.delete(view.native); view = undefined;
  }
  try {
    let native = array;
    if (!a.buffer || (packed && !view)) {
      native = allocateNativeBuffer(b,candidate); if (!native) return false;
      if (a.buffer) { view = {native,valid:false}; created = true; }
    } else if (view) native = view.native;
    if (created) {
      store!.converted.set(key,view!); b.bufferViewOwners.set(view!.native,a.buffer!);
    }
    const oldPacked = old.type === FIXED || old.stride > 255 || old.view !== undefined;
    const oldNative = old.view ?? (old.buffer && (b.bufferStores.get(old.buffer)?.views.get(ARRAY)?.native ?? old.buffer));
    const type = old.type === FIXED ? FLOAT : old.type, normalized = old.type === FIXED ? false : old.normalized;
    const stride = oldPacked ? 0 : old.stride, offset = oldPacked ? 0 : old.offset;
    const inverse: NativeCall[] = oldNative ? [["bindBuffer",ARRAY,oldNative],["vertexAttribPointer",index,old.size,type,normalized,stride,offset]]
      : [["clearVertexAttribute",rollback,index,old.size,type,normalized,stride,offset]];
    // The caller owns an unpublished attribute candidate. Reserve its view
    // field too: adding it after pointer installation could still allocate.
    if (packed && view) a.view = view.native;
    const accepted = applyNativeChanges(b,[{apply: () => {
      if (!checkedGlCall(b, () => gl.bindBuffer(ARRAY,native))) return false;
      if (!a.buffer && !checkedGlCall(b, () => gl.bufferData(ARRAY,0,0x88e4))) return false;
      return checkedGlCall(b, () => gl.vertexAttribPointer(index,a.size,a.type === FIXED ? FLOAT : a.type,
        a.type === FIXED ? false : a.normalized,packed ? 0 : a.stride,packed ? 0 : a.offset));
    },restore:nativeInverse(b,inverse)}],{finalizer:nativeInverse(b,[["bindBuffer",ARRAY,array]])});
    if (!accepted) return false;
    if (a.buffer) transferNativeRetirement(candidate);
    installed = true; return true;
  } catch { recordGlError(b,0x505); return false; }
  finally {
    if (!installed && created && view) { store!.converted.delete(key); b.bufferViewOwners.delete(view.native); }
    if (!installed || !a.buffer) retireNativeRetirement(candidate);
    retireNativeRetirement(rollback);
  }
}

export function prepareConvertedVertexData(b: GlBinding, a: GlVertexAttribute): boolean {
  const store = a.buffer && b.bufferStores.get(a.buffer), view = store && store.converted.get(layoutKey(a));
  if (!store || !view || view.native !== a.view) { recordGlError(b,0x502); return false; }
  if (view.valid) return true;
  const element = componentBytes(a.type)*a.size, stride = a.stride || element;
  const count = store.size < a.offset+element ? 0 : Math.floor((store.size-a.offset-element)/stride)+1;
  // Limit both source spans (which may include stride gaps) and packed
  // output independently. A very large stride reads one element at a time.
  const perChunk = Math.min(Math.floor(BUFFER_TRANSFER_BYTES/element),
    Math.max(1,Math.floor((BUFFER_TRANSFER_BYTES-element)/stride)+1));
  let input: Uint8Array<ArrayBuffer>, output: Uint8Array<ArrayBuffer>;
  try {
    const vertices = Math.min(count,perChunk);
    input = new Uint8Array(vertices ? (vertices-1)*stride+element : 0);
    output = new Uint8Array(vertices*element);
  } catch { recordGlError(b,0x505); return false; }
  const gl = b.gl!;
  const accepted = withBufferTransfer(b,store.source,view.native,() => {
    if (!checkedGlCall(b, () => gl.bufferData(COPY_WRITE,count*element,0x88e4))) return false;
    for (let vertex=0; vertex<count; vertex+=perChunk) {
      const vertices = Math.min(perChunk,count-vertex);
      const source = input.subarray(0,(vertices-1)*stride+element);
      if (!checkedGlCall(b, () => gl.getBufferSubData(COPY_READ,a.offset+vertex*stride,source))) return false;
      const packed = output.subarray(0,vertices*element);
      const sourceView = new DataView(source.buffer,source.byteOffset,source.byteLength);
      const destination = new DataView(packed.buffer,packed.byteOffset,packed.byteLength);
      for (let i=0; i<vertices; i++) {
        if (a.type === FIXED) {
          for (let j=0; j<a.size; j++) destination.setFloat32(i*element+j*4,sourceView.getInt32(i*stride+j*4,true)/65536,true);
        } else packed.set(source.subarray(i*stride,i*stride+element),i*element);
      }
      if (!checkedGlCall(b, () => gl.bufferSubData(COPY_WRITE,vertex*element,packed))) return false;
    }
    return true;
  });
  if (accepted) view.valid = true;
  return accepted;
}

/** Layout changes and container retirement release unused converted stores;
 * disabled attributes and unbound VAOs still retain their own views. */
export function collectConvertedVertexData(b: GlBinding): void {
  const referenced = new Set<WebGLBuffer>();
  for (const owner of b.objects.members) for (const vao of owner.vertexArrays.values()) {
    for (const a of vao.attributes.values()) if (a.view) referenced.add(a.view);
  }
  for (const store of b.bufferStores.values()) for (const [key,view] of store.converted) {
    if (!referenced.has(view.native) && retireBufferObjects(b,view.native,[view.native])) {
      store.converted.delete(key); b.bufferViewOwners.delete(view.native); b.bufferRetirements.delete(view.native);
    }
  }
}
