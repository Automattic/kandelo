import type { GlBinding } from "./registry.js";
import type { GlVertexAttribute } from "./buffer-references.js";
import { allocateNativeBuffer, BUFFER_TRANSFER_BYTES, withBufferTransfer } from "./buffer-storage.js";
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

/** Keep GLES format/offset/stride in the logical VAO. Native pointers use a
 * stable packed buffer for fixed-point data or strides beyond WebGL's limit. */
export function setConvertedVertexAttribute(b: GlBinding, index: number, a: GlVertexAttribute): boolean {
  const gl = b.gl!, width = componentBytes(a.type);
  if (!width) { recordGlError(b,0x500); return false; }
  if (a.size < 1 || a.size > 4 || a.stride < 0) { recordGlError(b,0x501); return false; }
  if (a.offset < 0 || a.offset % width || a.stride % width) { recordGlError(b,0x502); return false; }
  const store = a.buffer && b.bufferStores.get(a.buffer);
  if (!store) { recordGlError(b,0x502); return false; }
  const key = layoutKey(a);
  let view = store.converted.get(key);
  const created = !view;
  if (!view) {
    const native = allocateNativeBuffer(b); if (!native) return false;
    view = {native,valid:false};
  }
  let accepted = false, restored = false;
  try {
    if (checkedGlCall(b, () => gl.bindBuffer(ARRAY,view!.native))) {
      accepted = checkedGlCall(b, () => gl.vertexAttribPointer(index,a.size,
        a.type === FIXED ? FLOAT : a.type,a.type === FIXED ? false : a.normalized,0,0));
    }
  } finally { restored = checkedGlCall(b, () => gl.bindBuffer(ARRAY,b.shadow.arrayBuffer)); }
  if (!accepted || !restored) {
    if (created) gl.deleteBuffer(view.native);
    return false;
  }
  if (created) { store.converted.set(key,view); b.bufferViewOwners.set(view.native,a.buffer!); }
  a.view = view.native;
  return true;
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
    if (!referenced.has(view.native) && checkedGlCall(b, () => b.gl!.deleteBuffer(view.native))) {
      store.converted.delete(key); b.bufferViewOwners.delete(view.native);
    }
  }
}
