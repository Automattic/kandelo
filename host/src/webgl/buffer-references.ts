import { collectConvertedVertexData } from "./vertex-data.js";
import { canonicalBuffer, destroyBufferStorage } from "./buffer-storage.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

export type GlVertexAttribute = {
  buffer: WebGLBuffer | null; enabled: boolean; view?: WebGLBuffer;
  size: number; type: number; normalized: boolean; stride: number; offset: number;
};
export type GlVertexArray = { element: WebGLBuffer | null; attributes: Map<number, GlVertexAttribute> };

export function defaultVertexArray(): GlVertexArray { return {element:null,attributes:new Map()}; }
export function activeVertexArray(b: GlBinding): GlVertexArray {
  let state = b.vertexArrays.get(b.vertexArrayId);
  if (!state) { state = defaultVertexArray(); b.vertexArrays.set(b.vertexArrayId,state); }
  return state;
}
export function vertexAttribute(b: GlBinding, index: number): GlVertexAttribute {
  return activeVertexArray(b).attributes.get(index)
    ?? {buffer:null,enabled:false,size:4,type:0x1406,normalized:false,stride:0,offset:0};
}

/** WebGL rejects nonzero attribute offsets without a buffer. A private,
 * empty buffer preserves the offset while deletion clears these active-VAO bindings,
 * without deleting the real object still used by another VAO or context. */
export function clearNativeAttributeBuffers(b: GlBinding, attributes: [number,GlVertexAttribute][],
    restoreArray: WebGLBuffer | null): boolean {
  const gl = b.gl!;
  let temporary: WebGLBuffer | null = null;
  const accepted = checkedGlCall(b, () => {
    temporary = gl.createBuffer();
    if (!temporary) return;
    try {
      gl.bindBuffer(0x8892,temporary); gl.bufferData(0x8892,0,0x88e4);
      for (const [index,a] of attributes) {
        const packed = a.type === 0x140c || a.stride > 255 || a.view !== undefined;
        gl.vertexAttribPointer(index,a.size,a.type === 0x140c ? 0x1406 : a.type,
          a.type === 0x140c ? false : a.normalized,packed ? 0 : a.stride,packed ? 0 : a.offset);
      }
    } finally {
      gl.deleteBuffer(temporary);
      gl.bindBuffer(0x8892,restoreArray);
    }
  });
  if (!temporary) recordGlError(b,0x505);
  return accepted && temporary !== null;
}

export function deleteBufferNames(b: GlBinding, names: number[]): void {
  if (!b.gl) return;
  const objects = new Map<WebGLBuffer,number>();
  for (const name of names) { const object = b.buffers.get(name); if (object) objects.set(object,name); }
  if (!objects.size) return;
  const vao = activeVertexArray(b);
  const attributes = [...vao.attributes].filter(([,a]) => a.buffer !== null && objects.has(a.buffer));
  const array = b.shadow.arrayBuffer && objects.has(canonicalBuffer(b,b.shadow.arrayBuffer)) ? null : b.shadow.arrayBuffer;
  if (attributes.length && !clearNativeAttributeBuffers(b,attributes,array)) return;
  if (!checkedGlCall(b, () => {
    if (array !== b.shadow.arrayBuffer) b.gl!.bindBuffer(0x8892,null);
    if (vao.element && objects.has(vao.element)) b.gl!.bindBuffer(0x8893,null);
  })) return;
  b.shadow.arrayBuffer = array;
  if (vao.element && objects.has(vao.element)) vao.element = null;
  for (const [,a] of attributes) { a.buffer = null; delete a.view; }
  for (const [object,name] of objects) { b.buffers.delete(name); b.retiredBuffers.set(object,name); }
}

/** Driver staging saves an identity before any temporary rebind. */
export function beginClientArray(b: GlBinding): void {
  if (b.savedClientArrayBuffer !== undefined) { recordGlError(b,0x502); return; }
  b.savedClientArrayBuffer = b.shadow.arrayBuffer;
}
export function endClientArray(b: GlBinding): void {
  const saved = b.savedClientArrayBuffer;
  if (saved === undefined) { recordGlError(b,0x502); return; }
  // Restore the existing, already-classified native ARRAY view. Synchronizing
  // storage here could allocate while restoring hidden state; normal data and
  // draw operations synchronize views before using their contents.
  if (!checkedGlCall(b, () => b.gl!.bindBuffer(0x8892,saved))) return;
  b.shadow.arrayBuffer = saved;
  b.savedClientArrayBuffer = undefined;
}

export function collectRetiredBuffers(b: GlBinding): void {
  if (!b.gl) return;
  collectConvertedVertexData(b);
  for (const [object] of b.retiredBuffers) {
    let referenced = false;
    for (const owner of b.objects.members) {
      const saved = owner.savedClientArrayBuffer;
      if (saved != null && canonicalBuffer(owner,saved) === object) { referenced = true; break; }
      if (owner.shadow.arrayBuffer !== null && canonicalBuffer(owner,owner.shadow.arrayBuffer) === object) { referenced = true; break; }
      for (const vao of owner.vertexArrays.values()) {
        if (vao.element === object || [...vao.attributes.values()].some(a => a.buffer === object)) {
          referenced = true; break;
        }
      }
      if (referenced) break;
    }
    if (!referenced && destroyBufferStorage(b,object)) b.retiredBuffers.delete(object);
  }
}
