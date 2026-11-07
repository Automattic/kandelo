import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";

/* ES 2.0 sections 2.8 and 2.8.1 place no alignment rule on a vertex
 * attribute offset or stride, nor on the offset of indices in an element
 * buffer. WebGL (1.0 section 6.4, inherited by WebGL 2) rejects each of
 * them with INVALID_OPERATION. This fake models exactly those WebGL rules,
 * so a passing draw proves the host adapted the layout rather than the fake
 * accepting it. */
const ARRAY = 0x8892, ELEMENT = 0x8893;
const BYTE = 0x1400, UBYTE = 0x1401, SHORT = 0x1402, USHORT = 0x1403, FLOAT = 0x1406, FIXED = 0x140c;
const WIDTH = new Map([[BYTE,1],[UBYTE,1],[SHORT,2],[USHORT,2],[0x1405,4],[FLOAT,4]]);
type Pointer = {buffer: object | null; size: number; type: number; normalized: boolean; stride: number; offset: number};

class WebGlRules {
  errors: number[] = [];
  contents = new Map<object, Uint8Array>();
  bindings = new Map<number, object | null>();
  pointers = new Map<number, Pointer>();
  enabled = new Set<number>();
  draws: {mode: number; vertices: Map<number, number[][]>; normalized: Map<number, boolean>}[] = [];
  getError() { return this.errors.shift() ?? 0; }
  isContextLost() { return false; }
  checkFramebufferStatus() { return 0x8cd5; }
  getParameter(pname: number) { return pname === 0x8869 ? 16 : this.bindings.get(pname) ?? null; }
  createBuffer() { const object = {}; this.contents.set(object,new Uint8Array()); return object; }
  deleteBuffer(object: object) {
    this.contents.delete(object);
    for (const [target,value] of this.bindings) if (value === object) this.bindings.set(target,null);
  }
  bindBuffer(target: number, object: object | null) { this.bindings.set(target,object); }
  bufferData(target: number, data: number | Uint8Array) {
    this.contents.set(this.bindings.get(target)!,typeof data === "number" ? new Uint8Array(data) : new Uint8Array(data));
  }
  bufferSubData(target: number, offset: number, data: Uint8Array) { this.contents.get(this.bindings.get(target)!)!.set(data,offset); }
  getBufferSubData(target: number, offset: number, out: Uint8Array) {
    out.set(this.contents.get(this.bindings.get(target)!)!.subarray(offset,offset+out.length));
  }
  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
    const width = WIDTH.get(type);
    if (!width) { this.errors.push(0x500); return; }
    if (index >= 16 || size < 1 || size > 4 || stride < 0 || stride > 255 || offset < 0) { this.errors.push(0x501); return; }
    const buffer = this.bindings.get(ARRAY) ?? null;
    if (stride % width || offset % width || (!buffer && offset !== 0)) { this.errors.push(0x502); return; }
    this.pointers.set(index,{buffer,size,type,normalized,stride,offset});
  }
  enableVertexAttribArray(index: number) { this.enabled.add(index); }
  disableVertexAttribArray(index: number) { this.enabled.delete(index); }
  private fetch(pointer: Pointer, vertex: number): number[] {
    const width = WIDTH.get(pointer.type)!, bytes = this.contents.get(pointer.buffer!)!;
    const at = pointer.offset+vertex*(pointer.stride || width*pointer.size);
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    return Array.from({length:pointer.size},(_,i) => {
      const p = at+i*width;
      switch (pointer.type) {
        case BYTE: return view.getInt8(p);
        case UBYTE: return view.getUint8(p);
        case SHORT: return view.getInt16(p,true);
        case USHORT: return view.getUint16(p,true);
        default: return view.getFloat32(p,true);
      }
    });
  }
  private record(mode: number, indices: number[]) {
    const vertices = new Map<number, number[][]>(), normalized = new Map<number, boolean>();
    for (const index of this.enabled) {
      const pointer = this.pointers.get(index)!;
      vertices.set(index,indices.map(vertex => this.fetch(pointer,vertex)));
      normalized.set(index,pointer.normalized);
    }
    this.draws.push({mode,vertices,normalized});
  }
  drawArrays(mode: number, first: number, count: number) {
    this.record(mode,Array.from({length:count},(_,i) => first+i));
  }
  drawElements(mode: number, count: number, type: number, offset: number) {
    const width = type === UBYTE ? 1 : type === USHORT ? 2 : 4;
    if (offset % width) { this.errors.push(0x502); return; }
    const bytes = this.contents.get(this.bindings.get(ELEMENT)!)!;
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    this.record(mode,Array.from({length:count},(_,i) =>
      width === 1 ? view.getUint8(offset+i) : width === 2 ? view.getUint16(offset+i*2,true) : view.getUint32(offset+i*4,true)));
  }
}

function setup() {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:4096});
  const b = registry.get(1)!, gl = new WebGlRules();
  b.gl = gl as unknown as WebGL2RenderingContext;
  // Model an installed executable; framebuffer validation without one is
  // covered by the program-link tests.
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
  return {b,gl,send,upload};
}

/** Write `values` for `vertices` vertices at an arbitrary byte layout. */
function layoutBytes(type: number, size: number, stride: number, offset: number, vertices: number[][]): Uint8Array {
  const width = type === FIXED ? 4 : WIDTH.get(type)!, step = stride || width*size;
  const bytes = new Uint8Array(offset+(vertices.length-1)*step+width*size+3).fill(0xa5);
  const view = new DataView(bytes.buffer);
  vertices.forEach((vertex,v) => vertex.forEach((value,i) => {
    const p = offset+v*step+i*width;
    switch (type) {
      case BYTE: view.setInt8(p,value); break;
      case UBYTE: view.setUint8(p,value); break;
      case SHORT: view.setInt16(p,value,true); break;
      case USHORT: view.setUint16(p,value,true); break;
      case FIXED: view.setInt32(p,value,true); break;
      default: view.setFloat32(p,value,true);
    }
  }));
  return bytes;
}

const layouts: {type: number; size: number; normalized: boolean; stride: number; offset: number; values: number[][]}[] = [
  {type:FLOAT,size:3,normalized:false,stride:13,offset:1,values:[[1.5,-2,3],[4,5.25,-6],[7,8,9.5]]},
  {type:FLOAT,size:2,normalized:false,stride:0,offset:2,values:[[0.5,1],[2,3],[-4,5]]},
  {type:SHORT,size:2,normalized:true,stride:5,offset:3,values:[[-32768,32767],[1,-1],[1000,-1000]]},
  {type:USHORT,size:3,normalized:false,stride:0,offset:1,values:[[1,2,3],[65535,0,7],[8,9,10]]},
  {type:BYTE,size:1,normalized:true,stride:1,offset:1,values:[[-128],[127],[-1]]},
  {type:UBYTE,size:4,normalized:true,stride:7,offset:3,values:[[0,255,1,2],[3,4,5,6],[7,8,9,10]]},
  {type:FIXED,size:4,normalized:false,stride:17,offset:2,values:[[65536,-32768,98304,0],[1,2,3,4],[-65536,0,0,65536]]},
  {type:FIXED,size:3,normalized:true,stride:14,offset:5,values:[[16384,-16384,65536],[0,0,0],[131072,-131072,8]]},
];

for (const layout of layouts) {
  it(`draws a buffer-backed ${layout.type.toString(16)} attribute at stride ${layout.stride}, offset ${layout.offset}`, () => {
    const {b,gl,send,upload} = setup();
    upload(ARRAY,71,layoutBytes(layout.type,layout.size,layout.stride,layout.offset,layout.values));
    send(O.OP_VERTEX_ATTRIB_POINTER,[2,layout.size,layout.type,layout.normalized ? 1 : 0,layout.stride,layout.offset]);
    send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[2]);
    send(O.OP_DRAW_ARRAYS,[0,0,3]);
    expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
    expect(gl.draws).toHaveLength(1);
    const expected = layout.type === FIXED ? layout.values.map(v => v.map(x => x/65536)) : layout.values;
    expect(gl.draws[0].vertices.get(2)).toEqual(expected);
    // FIXED converts to float before the GPU; every other type keeps its
    // logical normalization in the native pointer.
    expect(gl.draws[0].normalized.get(2)).toBe(layout.type === FIXED ? false : layout.normalized);
    // Logical GLES state is the guest's layout, not the packed native view.
    expect(b.vertexArrays.get(0)!.attributes.get(2)).toMatchObject({
      type:layout.type,size:layout.size,normalized:layout.normalized,stride:layout.stride,offset:layout.offset});
  });
}

it("repacks after the source buffer changes and starts drawing from a later vertex", () => {
  const {b,gl,send,upload} = setup();
  upload(ARRAY,71,layoutBytes(FLOAT,2,9,1,[[1,2],[3,4],[5,6]]));
  send(O.OP_VERTEX_ATTRIB_POINTER,[0,2,FLOAT,0,9,1]); send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
  send(O.OP_DRAW_ARRAYS,[0,1,2]);
  send(O.OP_BUFFER_SUB_DATA,[ARRAY,10,4],new Uint8Array(new Float32Array([30]).buffer));
  send(O.OP_DRAW_ARRAYS,[0,1,2]);
  expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
  expect(gl.draws.map(draw => draw.vertices.get(0))).toEqual([[[3,4],[5,6]],[[30,4],[5,6]]]);
});

it("draws unaligned short and byte index offsets from the element buffer", () => {
  const {b,gl,send,upload} = setup();
  upload(ARRAY,71,new Uint8Array(new Float32Array([10,11,12,13]).buffer));
  send(O.OP_VERTEX_ATTRIB_POINTER,[0,1,FLOAT,0,0,0]); send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
  const indices = new Uint8Array(9), view = new DataView(indices.buffer);
  [3,0,2].forEach((value,i) => view.setUint16(1+i*2,value,true));
  upload(ELEMENT,72,indices);
  send(O.OP_DRAW_ELEMENTS,[0,3,USHORT,1]);
  send(O.OP_DRAW_ELEMENTS,[0,2,UBYTE,3]);
  expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
  expect(gl.draws.map(draw => draw.vertices.get(0))).toEqual([[[13],[10],[12]],[[10],[10]]]);
  const query = new Uint8Array(8204);
  expect(runGlQuery(b,O.QOP_GET_INDEX_USAGE,new Uint8Array(new Uint32Array([USHORT,1,3]).buffer),query)).toBeGreaterThan(0);
  const words = new DataView(query.buffer);
  expect(words.getUint32(0,true)).toBe(0); expect(words.getUint32(4,true)).toBe(3);
  expect(query[8]).toBe(0b1101);
});

it("records a client attribute with an unaligned stride and restores it after a private client draw", () => {
  const {b,gl,send} = setup();
  // The encoder keeps client memory and its stride; the host only records
  // the logical layout until a draw supplies packed bytes.
  send(O.OP_VERTEX_ATTRIB_POINTER,[0,3,FLOAT,0,13,0]); send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
  expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toMatchObject({buffer:null,stride:13,offset:0});
  const packed = new Uint8Array(new Float32Array([1,2,3]).buffer);
  send(O.OP_DRAW_CLIENT_ARRAYS,[0,0,1,1,0,3,FLOAT,0,packed.length],packed);
  expect(b.errors).toEqual([]); expect(gl.errors).toEqual([]);
  expect(gl.draws.map(draw => draw.vertices.get(0))).toEqual([[[1,2,3]]]);
  expect(gl.pointers.get(0)).toMatchObject({buffer:null,stride:0,offset:0});
});
