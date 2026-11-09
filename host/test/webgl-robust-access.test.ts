import { describe, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";

/* EXT_robustness/KHR_robustness section 2.8 (10.3.1.1rob): in a robust
 * buffer access context, vertex indices outside an enabled attribute's
 * buffer give that attribute undefined values (zero or values from within
 * the buffer) and are not an error. WebGL 1.0 section 6.6 (kept by WebGL 2)
 * lets the same draw raise INVALID_OPERATION and draw nothing. This fake
 * models that WebGL rule, so a robust draw that reaches the fake proves the
 * host kept every native fetch in range. */
const ARRAY = 0x8892, ELEMENT = 0x8893, COPY_READ = 0x8f36, COPY_WRITE = 0x8f37;
const UBYTE = 0x1401, USHORT = 0x1403, FLOAT = 0x1406, FIXED = 0x140c;
const WIDTH = new Map([[0x1400,1],[UBYTE,1],[0x1402,2],[USHORT,2],[0x1405,4],[FLOAT,4]]);
type Pointer = {buffer: object | null; size: number; type: number; normalized: boolean; stride: number; offset: number};

class WebGlRules {
  errors: number[] = [];
  contents = new Map<object, Uint8Array>();
  bindings = new Map<number, object | null>();
  pointers = new Map<number, Pointer>();
  enabled = new Set<number>();
  created = 0; copies = 0; reads = 0;
  draws: Map<number, number[][]>[] = [];
  getError() { return this.errors.shift() ?? 0; }
  isContextLost() { return false; }
  checkFramebufferStatus() { return 0x8cd5; }
  getParameter(pname: number) { return pname === 0x8869 ? 16 : this.bindings.get(pname) ?? null; }
  createBuffer() { const object = {}; this.created++; this.contents.set(object,new Uint8Array()); return object; }
  deleteBuffer(object: object) {
    this.contents.delete(object);
    for (const [target,value] of this.bindings) if (value === object) this.bindings.set(target,null);
  }
  bindBuffer(target: number, object: object | null) { this.bindings.set(target,object); }
  bufferData(target: number, data: number | ArrayBufferView) {
    // WebGL initializes a sized store to zero and copies a view's bytes.
    this.contents.set(this.bindings.get(target)!,typeof data === "number" ? new Uint8Array(data)
      : new Uint8Array(data.buffer,data.byteOffset,data.byteLength).slice());
  }
  bufferSubData(target: number, offset: number, data: Uint8Array) { this.contents.get(this.bindings.get(target)!)!.set(data,offset); }
  getBufferSubData(target: number, offset: number, out: Uint8Array) {
    this.reads++;
    const bytes = this.contents.get(this.bindings.get(target)!)!;
    if (offset+out.length > bytes.length) { this.errors.push(0x501); return; }
    out.set(bytes.subarray(offset,offset+out.length));
  }
  copyBufferSubData(read: number, write: number, readOffset: number, writeOffset: number, size: number) {
    const from = this.contents.get(this.bindings.get(read)!)!, to = this.contents.get(this.bindings.get(write)!)!;
    if (readOffset+size > from.length || writeOffset+size > to.length) { this.errors.push(0x501); return; }
    to.set(from.subarray(readOffset,readOffset+size),writeOffset); this.copies++;
  }
  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
    if (!WIDTH.get(type)) { this.errors.push(0x500); return; }
    this.pointers.set(index,{buffer:this.bindings.get(ARRAY) ?? null,size,type,normalized,stride,offset});
  }
  enableVertexAttribArray(index: number) { this.enabled.add(index); }
  disableVertexAttribArray(index: number) { this.enabled.delete(index); }
  private fetch(pointer: Pointer, vertex: number): number[] {
    const width = WIDTH.get(pointer.type)!, bytes = this.contents.get(pointer.buffer!)!;
    const at = pointer.offset+vertex*(pointer.stride || width*pointer.size);
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    return Array.from({length:pointer.size},(_,i) => pointer.type === FLOAT ? view.getFloat32(at+i*4,true) : view.getUint8(at+i));
  }
  private record(indices: number[]) {
    // WebGL 1.0 section 6.6: an out-of-range fetch may be INVALID_OPERATION.
    const last = Math.max(...indices);
    for (const index of this.enabled) {
      const p = this.pointers.get(index)!, element = WIDTH.get(p.type)!*p.size;
      if (!p.buffer || p.offset+last*(p.stride || element)+element > this.contents.get(p.buffer)!.length) {
        this.errors.push(0x502); return;
      }
    }
    const vertices = new Map<number, number[][]>();
    for (const index of this.enabled) vertices.set(index,indices.map(vertex => this.fetch(this.pointers.get(index)!,vertex)));
    this.draws.push(vertices);
  }
  drawArrays(_mode: number, first: number, count: number) { this.record(Array.from({length:count},(_,i) => first+i)); }
  drawElements(_mode: number, count: number, type: number, offset: number) {
    const width = type === UBYTE ? 1 : type === USHORT ? 2 : 4;
    const bytes = this.contents.get(this.bindings.get(ELEMENT)!)!;
    if (offset+count*width > bytes.length) { this.errors.push(0x502); return; }
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    this.record(Array.from({length:count},(_,i) =>
      width === 1 ? view.getUint8(offset+i) : width === 2 ? view.getUint16(offset+i*2,true) : view.getUint32(offset+i*4,true)));
  }
}

function setup(robust: boolean) {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:4096});
  const b = registry.get(1)!, gl = new WebGlRules();
  b.gl = gl as unknown as WebGL2RenderingContext;
  b.robustAccess = robust;
  b.shadow.currentProgram = b.currentProgram = {} as WebGLProgram;
  const send = (op: number, words: number[], bytes = new Uint8Array(), tail: number[] = []) => {
    const length = words.length*4+bytes.length+tail.length*4, record = new Uint8Array(4+length), v = new DataView(record.buffer);
    v.setUint16(0,op,true); v.setUint16(2,length,true);
    words.forEach((word,i) => v.setUint32(4+i*4,word,true));
    record.set(bytes,4+words.length*4);
    tail.forEach((word,i) => v.setUint32(4+words.length*4+bytes.length+i*4,word,true));
    b.cmdbufView = record; expect(decodeAndDispatch(b,0,record.length)).toBe(0);
  };
  const upload = (target: number, name: number, bytes: Uint8Array) => {
    send(O.OP_BIND_BUFFER,[target,name]); send(O.OP_BUFFER_DATA,[target,bytes.length],bytes,[0x88e4]);
  };
  const floats = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);
  const pointer = (index: number, size: number, type: number, stride = 0, offset = 0) => {
    send(O.OP_VERTEX_ATTRIB_POINTER,[index,size,type,0,stride,offset]); send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[index]);
  };
  return {b,gl,send,upload,floats,pointer};
}

describe("robust buffer access (EXT/KHR_robustness section 2.8)", () => {
  it("a non-robust context keeps WebGL's out-of-range rejection", () => {
    const {b,gl,send,upload,floats,pointer} = setup(false);
    upload(ARRAY,71,floats([1,2,3,4])); pointer(0,2,FLOAT);
    send(O.OP_DRAW_ARRAYS,[0,0,4]);
    expect(gl.draws).toHaveLength(0);
    // A plain draw leaves the native error pending for the next drain.
    const out = new Uint8Array(4);
    expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
    expect(new DataView(out.buffer).getUint32(0,true)).toBe(0x502);
  });

  it("draws past the end of a vertex buffer with zero values and no error", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([1,2,3,4])); pointer(0,2,FLOAT);
    const guest = gl.pointers.get(0)!.buffer;
    send(O.OP_DRAW_ARRAYS,[0,0,4]);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws.map(draw => draw.get(0))).toEqual([[[1,2],[3,4],[0,0],[0,0]]]);
    // The substitute is private to the draw: native and logical state return.
    expect(gl.pointers.get(0)).toMatchObject({buffer:guest,stride:0,offset:0});
    expect(gl.bindings.get(ARRAY)).toBe(guest);
    expect(b.vertexArrays.get(0)!.attributes.get(0)).toMatchObject({size:2,stride:0,offset:0});
  });

  it("an in-range draw uses the guest buffer with no copy", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([1,2,3,4])); pointer(0,2,FLOAT);
    const created = gl.created;
    send(O.OP_DRAW_ARRAYS,[0,0,2]);
    expect(b.errors).toEqual([]);
    expect(gl.created).toBe(created); expect(gl.copies).toBe(0);
    expect(gl.draws.map(draw => draw.get(0))).toEqual([[[1,2],[3,4]]]);
  });

  it("keeps the padded copy until the buffer changes or a draw needs more", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([1,2,3,4])); pointer(0,2,FLOAT);
    send(O.OP_DRAW_ARRAYS,[0,0,4]);
    const created = gl.created, copies = gl.copies;
    send(O.OP_DRAW_ARRAYS,[0,1,3]);
    expect(gl.created).toBe(created); expect(gl.copies).toBe(copies);
    send(O.OP_BUFFER_SUB_DATA,[ARRAY,0,8],floats([5,6]));
    send(O.OP_DRAW_ARRAYS,[0,0,3]);
    expect(gl.copies).toBe(copies+1);
    send(O.OP_DRAW_ARRAYS,[0,0,9]);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws.map(draw => draw.get(0))).toEqual([
      [[1,2],[3,4],[0,0],[0,0]], [[3,4],[0,0],[0,0]], [[5,6],[3,4],[0,0]],
      [[5,6],[3,4],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0]],
    ]);
  });

  it("substitutes only the attributes a draw would read out of range", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([1,2,3])); pointer(0,1,FLOAT);
    upload(ARRAY,72,floats([10,20,30,40,50])); pointer(1,1,FLOAT);
    const wide = gl.pointers.get(1)!.buffer;
    send(O.OP_DRAW_ARRAYS,[0,1,4]);
    expect(b.errors).toEqual([]);
    expect(gl.draws[0].get(0)).toEqual([[2],[3],[0],[0]]);
    expect(gl.draws[0].get(1)).toEqual([[20],[30],[40],[50]]);
    expect(gl.pointers.get(1)!.buffer).toBe(wide);
  });

  it("indexed draws: out-of-range indices and a short index buffer are not errors", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([1,2,3,4])); pointer(0,2,FLOAT);
    upload(ELEMENT,72,new Uint8Array(new Uint16Array([0,5,1]).buffer));
    send(O.OP_DRAW_ELEMENTS,[0,3,USHORT,0]);
    // Four indices from a three-index buffer: the missing one reads as zero.
    send(O.OP_DRAW_ELEMENTS,[0,4,USHORT,0]);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws.map(draw => draw.get(0))).toEqual([
      [[1,2],[0,0],[3,4]], [[1,2],[0,0],[3,4],[1,2]],
    ]);
  });

  it("takes an indexed draw's highest vertex from the cached index range, not a readback", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([1,2,3,4])); pointer(0,2,FLOAT);
    upload(ELEMENT,72,new Uint8Array(new Uint16Array([0,1,1]).buffer));
    send(O.OP_DRAW_ELEMENTS,[0,3,USHORT,0]);
    const reads = gl.reads;
    send(O.OP_DRAW_ELEMENTS,[0,3,USHORT,0]);
    send(O.OP_DRAW_ELEMENTS,[0,2,USHORT,2]);
    expect(gl.reads).toBe(reads);
    // A write to the element buffer invalidates the range with its forms.
    send(O.OP_BUFFER_SUB_DATA,[ELEMENT,2,2],new Uint8Array(new Uint16Array([3]).buffer));
    send(O.OP_DRAW_ELEMENTS,[0,3,USHORT,0]);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws.map(draw => draw.get(0))).toEqual([
      [[1,2],[3,4],[3,4]], [[1,2],[3,4],[3,4]], [[3,4],[3,4]], [[1,2],[0,0],[3,4]],
    ]);
  });

  it("pads a buffer-backed attribute drawn alongside streamed client arrays", () => {
    const {b,gl,send,upload,floats,pointer} = setup(true);
    upload(ARRAY,71,floats([7,8])); pointer(1,1,FLOAT);
    send(O.OP_BIND_BUFFER,[ARRAY,0]);
    send(O.OP_VERTEX_ATTRIB_POINTER,[0,1,FLOAT,0,0,0]); send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
    const packed = floats([1,2,3]);
    send(O.OP_DRAW_CLIENT_ARRAYS,[0,0,3,1,0,1,FLOAT,0,packed.length],packed);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws.map(draw => [draw.get(0),draw.get(1)])).toEqual([[[[1],[2],[3]],[[7],[8],[0]]]]);
  });

  it("pads the private converted view of a FIXED attribute", () => {
    const {b,gl,send,upload,pointer} = setup(true);
    upload(ARRAY,71,new Uint8Array(new Int32Array([65536,131072]).buffer)); pointer(0,1,FIXED);
    send(O.OP_DRAW_ARRAYS,[0,0,3]);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws.map(draw => draw.get(0))).toEqual([[[1],[2],[0]]]);
  });
});

describe("robust access context creation (GlContextAttrs.flags)", () => {
  it("marks only CONTEXT_FLAG_ROBUST_ACCESS contexts and rejects unknown flags", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const kernel = createWasmPosixKernelTestHarness({
      io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
      instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
    });
    const env = (kernel.testAuthority.buildImportObject(memory) as { env: Record<string, (...args: any[]) => any> }).env;
    const gl = new Proxy({ isContextLost: () => false, getError: () => 0, getExtension: () => null, getParameter: () => null },
      { get: (target, key) => Reflect.get(target, key) ?? (String(key).startsWith("create") ? () => ({}) : () => null) });
    const canvas = { width: 4, height: 4, getContext: () => gl };
    const create = (session: number, context: number, flags: number) => {
      kernel.gl.bind({ displayFileId: 1n, pid: 7, sessionId: session, cmdbufAddr: 0, cmdbufLen: 0 });
      kernel.gl.attachCanvas(7, canvas as unknown as OffscreenCanvas);
      new Uint32Array(memory.buffer, 256, 4).set([2, 0, flags, 0]);
      return env.host_gl_create_context(7, context, 256, 16, session) as number;
    };
    expect(create(11, 21, 2)).toBe(-22);
    expect(create(12, 22, 1)).toBe(0);
    expect(kernel.gl.get(7, 12)!.robustAccess).toBe(true);
    expect(create(13, 23, 0)).toBe(0);
    expect(kernel.gl.get(7, 13)!.robustAccess).toBe(false);
    env.host_gl_destroy_context(7, 22);
    expect(kernel.gl.get(7, 12)!.robustAccess).toBe(false);
  });
});
