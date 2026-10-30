import { applyNativeChanges, nativeOwner, nativeInverse, reserveNativeRetirement, retireNativeRetirement, type NativeChange } from "./native-recovery.js";
import { collectConvertedVertexData } from "./vertex-data.js";
import { allocateNativeBuffer, canonicalBuffer, destroyBufferStorage } from "./buffer-storage.js";
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

/** Deletion changes native VAO state as well as names. Stage the complete
 * metadata replacement and reversible native steps before touching either. */
export function deleteBufferNames(b: GlBinding, names: number[]): boolean {
  if (!b.gl) return false;
  const gl = b.gl;
  const owner = nativeOwner(b), oldArray = b.shadow.arrayBuffer;
  let temporary: WebGLBuffer | null = null;
  const temporaryOwner = reserveNativeRetirement(b,[["deleteBuffer",null]]);
  if (!temporaryOwner) return false;
  try {
    let buffers: GlBinding["buffers"], retired: GlBinding["retiredBuffers"];
    let vao: GlVertexArray, nextAttributes: GlVertexArray["attributes"];
    let nextArray: WebGLBuffer | null, nextElement: WebGLBuffer | null;
    let attributes: [number, GlVertexAttribute][];
    let changes: NativeChange[];
    try {
      const objects = new Map<WebGLBuffer, number>();
      for (const name of names) { const object = name ? b.buffers.get(name) : undefined; if (object) objects.set(object, name); }
      if (!objects.size) return true;
      vao = activeVertexArray(b);
      attributes = [...vao.attributes].filter(([,a]) => a.buffer !== null && objects.has(a.buffer));
      nextArray = b.shadow.arrayBuffer && objects.has(canonicalBuffer(b,b.shadow.arrayBuffer)) ? null : b.shadow.arrayBuffer;
      nextElement = vao.element && objects.has(vao.element) ? null : vao.element;
      buffers = new Map(b.buffers); retired = new Map(b.retiredBuffers);
      for (const [object,name] of objects) { buffers.delete(name); retired.set(object,name); }
      nextAttributes = new Map(vao.attributes);
      changes = [];
      if (attributes.length) {
        changes.push({apply: () => checkedGlCall(b, () => gl.bindBuffer(0x8892,temporary)),
          restore: nativeInverse(owner, [["bindBuffer",0x8892,oldArray]])});
        changes.push({apply: () => checkedGlCall(b, () => gl.bufferData(0x8892,0,0x88e4)), restore: nativeInverse(owner)});
        for (const [index,a] of attributes) {
          const cleared = {...a,buffer:null}; delete cleared.view; nextAttributes.set(index,cleared);
          const packed = a.type === 0x140c || a.stride > 255 || a.view !== undefined;
          const type = a.type === 0x140c ? 0x1406 : a.type;
          const normalized = a.type === 0x140c ? false : a.normalized;
          const stride = packed ? 0 : a.stride, offset = packed ? 0 : a.offset;
          const native = a.view ?? b.bufferStores.get(a.buffer!)?.views.get(0x8892)?.native ?? a.buffer;
          changes.push({apply: () => checkedGlCall(b, () => gl.vertexAttribPointer(index,a.size,type,normalized,stride,offset)),
            restore: nativeInverse(owner, [["bindBuffer",0x8892,native],["vertexAttribPointer",index,a.size,type,normalized,stride,offset]])});
        }
      }
      if (attributes.length || nextArray !== b.shadow.arrayBuffer)
        changes.push({apply: () => checkedGlCall(b, () => gl.bindBuffer(0x8892,nextArray)),
          restore: nativeInverse(owner, [["bindBuffer",0x8892,oldArray]])});
      if (nextElement !== vao.element) {
        const oldElement = vao.element && (b.bufferStores.get(vao.element)?.views.get(0x8893)?.native ?? vao.element);
        changes.push({apply: () => checkedGlCall(b, () => gl.bindBuffer(0x8893,null)),
          restore: nativeInverse(owner, [["bindBuffer",0x8893,oldElement]])});
      }
      if (attributes.length) changes.push({apply: () => {
        const released = checkedGlCall(b, () => gl.deleteBuffer(temporary));
        if (released) temporaryOwner.calls[0][1] = null;
        return released;
      }, restore: nativeInverse(owner)});
    } catch { recordGlError(b,0x505); return false; }
    if (attributes.length && !(temporary = allocateNativeBuffer(b,temporaryOwner))) return false;
    if (!applyNativeChanges(b, changes)) return false;
    b.buffers = buffers; b.retiredBuffers = retired;
    b.shadow.arrayBuffer = nextArray; vao.element = nextElement; vao.attributes = nextAttributes;
    return true;
  } finally { retireNativeRetirement(temporaryOwner); }
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
