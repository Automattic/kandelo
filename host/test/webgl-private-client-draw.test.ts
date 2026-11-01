import { afterEach, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { drawPrivateClientArrays, validPrivateClientDraw } from "../src/webgl/private-client-draw.js";
import { hasNativeRepair, NativeGlFault, repairNativeState, setNativeGlFaultReporter } from "../src/webgl/native-recovery.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";

const ARRAY = 0x8892, ELEMENT = 0x8893, FLOAT = 0x1406, FIXED = 0x140c;
type Pointer = {buffer: object|null; size: number; type: number; normalized: boolean; stride: number; offset: number};
type Fault = {method: string; nth: number; after?: boolean; throws?: boolean};
class Gl {
  errors: number[] = [];
  errorReads = 0;
  pointerSources: (object|null)[] = [];
  buffers = new Map<object,Uint8Array>();
  alive = new Set<object>();
  array: object|null = null;
  element: object|null = null;
  attributes = new Map<number,Pointer>();
  counts = new Map<string,number>();
  draws: {first: number; count: number; attributes: Map<number,Pointer>; bytes: Map<object,Uint8Array>}[] = [];
  fault?: Fault;
  blockRestore = false;
  blockAfterDraw = false;
  postCreateCheckThrows = false;
  method(name: string, operation: () => void) {
    const n = (this.counts.get(name) ?? 0)+1; this.counts.set(name,n);
    const reject = this.fault?.method === name && this.fault.nth === n;
    const fault = reject ? this.fault : undefined;
    if (reject) this.fault = undefined;
    if (!reject || fault?.after) operation();
    if (reject) {
      // Creation must return its handle before a post-effect validation can
      // fail. A mock that hides that handle by throwing inside createBuffer
      // cannot test the caller's ownership of a returned native object.
      if (name === "createBuffer" && fault?.after && fault.throws) this.postCreateCheckThrows = true;
      else if (fault?.throws) throw new Error("native rejection");
      else this.errors.push(0x502);
    }
  }
  getError() {
    this.errorReads++;
    if (this.postCreateCheckThrows) { this.postCreateCheckThrows = false; throw new Error("post-create check"); }
    return this.errors.shift() ?? 0;
  }
  isContextLost() { return false; }
  createBuffer() {
    let result: object|null = null;
    this.method("createBuffer",() => { result = {}; this.alive.add(result); });
    return result;
  }
  deleteBuffer(buffer: object) {
    this.method("deleteBuffer",() => {
      this.alive.delete(buffer); this.buffers.delete(buffer);
      for (const pointer of this.attributes.values()) if (pointer.buffer === buffer) pointer.buffer = null;
      if (this.array === buffer) this.array = null;
      if (this.element === buffer) this.element = null;
    });
  }
  bindBuffer(target: number, buffer: object|null) {
    this.method("bindBuffer",() => {
      if (this.blockRestore && target === ARRAY && buffer === null) { this.errors.push(0x502); return; }
      if (target === ARRAY) this.array = buffer;
      else if (target === ELEMENT) this.element = buffer;
      else throw new Error("Unexpected target");
    });
  }
  bufferData(target: number, input: number|Uint8Array) {
    this.method("bufferData",() => {
      if (target !== ARRAY || !this.array) throw new Error("Missing upload selection");
      this.buffers.set(this.array,typeof input === "number" ? new Uint8Array(input) : input.slice());
    });
  }
  bufferSubData(target: number, offset: number, input: Uint8Array) {
    this.method("bufferSubData",() => {
      if (target !== ARRAY || !this.array) throw new Error("Missing upload selection");
      this.buffers.get(this.array)!.set(input,offset);
    });
  }
  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
    this.pointerSources.push(this.array);
    this.method("vertexAttribPointer",() => {
      if (!this.array && offset !== 0) { this.errors.push(0x502); return; }
      this.attributes.set(index,{buffer:this.array,size,type,normalized,stride,offset});
    });
  }
  drawArrays(_mode: number, first: number, count: number) {
    this.method("drawArrays",() => {
      this.draws.push({first,count,attributes:new Map([...this.attributes].map(([i,a]) => [i,{...a}])),
        bytes:new Map([...this.buffers].map(([b,bytes]) => [b,bytes.slice()]))});
      if (this.blockAfterDraw) this.blockRestore = true;
    });
  }
}
function payload(options: {first?: number; count?: number; type?: number; size?: number; bytes?: Uint8Array; indices?: number[]} = {}) {
  const {first=0,count=6,type=FLOAT,size=2,indices=[0]} = options;
  const width = type === 0x1400 || type === 0x1401 ? 1 : type === 0x1402 || type === 0x1403 ? 2 : 4;
  const bytes = options.bytes ?? new Uint8Array(count*size*width).fill(0x42);
  const out = new Uint8Array(16+indices.length*(20+bytes.length)), v = new DataView(out.buffer);
  [4,first,count,indices.length].forEach((value,i) => v.setUint32(i*4,value,true));
  let p = 16;
  for (const index of indices) {
    [index,size,type,0,bytes.length].forEach((value,i) => v.setUint32(p+i*4,value,true));
    out.set(bytes,p+20); p += 20+bytes.length;
  }
  return v;
}
function fixture(type = FLOAT, size = 2, stride = 0, offset = 0) {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:1024});
  const b = registry.get(1)!, gl = new Gl(); b.gl = gl as unknown as WebGL2RenderingContext;
  // These vertex/buffer controls model a valid installed executable. Missing-
  // program framebuffer validation has separate controls below.
  b.shadow.currentProgram = b.currentProgram = {} as WebGLProgram;
  const array = gl.createBuffer()!, element = gl.createBuffer()!;
  gl.array = array; gl.element = element; b.shadow.arrayBuffer = array;
  b.buffers.set(17,array); b.buffers.set(18,element);
  const vao = b.vertexArrays.get(0)!; vao.element = element;
  vao.attributes.set(0,{buffer:null,enabled:true,size,type,normalized:false,stride,offset});
  gl.attributes.set(0,{buffer:null,size,type:type === FIXED ? FLOAT : type,normalized:false,
    stride:type === FIXED || stride > 255 ? 0 : stride,offset:0});
  const attributes = vao.attributes, oldNative = {...gl.attributes.get(0)!};
  gl.counts.clear(); gl.errorReads = 0;
  const restored = () => {
    expect(vao.attributes).toBe(attributes); expect(vao.attributes.get(0)).toEqual({buffer:null,enabled:true,size,type,normalized:false,stride,offset});
    expect(gl.attributes.get(0)).toEqual(oldNative); expect(gl.array).toBe(array); expect(gl.element).toBe(element);
    expect(b.shadow.arrayBuffer).toBe(array); expect(vao.element).toBe(element);
    expect([...b.buffers]).toEqual([[17,array],[18,element]]);
    expect(b.bufferStores.size).toBe(0); expect(b.bufferViewOwners.size).toBe(0);
    expect(b.retiredBuffers.size).toBe(0); expect(b.bufferRetirements.size).toBe(0);
    // The context's private stream buffer, if created, lives with the context.
    expect(gl.alive).toEqual(new Set([array,element,...(b.clientArrayStream ? [b.clientArrayStream] : [])]));
    expect(hasNativeRepair(b.gl!)).toBe(false);
  };
  return {b,gl,vao,array,element,restored};
}

it("draws packed client vertices without public buffer names and restores exact logical/native layout",() => {
  const {b,gl,restored} = fixture(FLOAT,2,16,4), input = payload();
  expect(validPrivateClientDraw(input)).toBe(true);
  expect(drawPrivateClientArrays(b,input)).toEqual({attempted:true,accepted:true,restored:true});
  expect(gl.draws).toHaveLength(1); const draw = gl.draws[0], pointer = draw.attributes.get(0)!;
  expect(pointer).toMatchObject({size:2,type:FLOAT,stride:0,offset:0});
  expect(pointer.buffer).not.toBeNull(); expect(draw.bytes.get(pointer.buffer!)).toEqual(new Uint8Array(48).fill(0x42));
  expect(pointer.buffer).toBe(b.clientArrayStream);
  expect(gl.counts.get("createBuffer")).toBe(1); expect(gl.counts.get("deleteBuffer") ?? 0).toBe(0);
  expect(b.errors).toEqual([]); restored();
  // Later draws reuse the stream buffer: no creation, deletion or retirement.
  expect(drawPrivateClientArrays(b,input)).toEqual({attempted:true,accepted:true,restored:true});
  expect(gl.counts.get("createBuffer")).toBe(1); expect(gl.counts.get("deleteBuffer") ?? 0).toBe(0);
  expect(gl.draws[1].bytes.get(b.clientArrayStream!)).toEqual(new Uint8Array(48).fill(0x42)); restored();
});
it("deletes the stream buffer with the context",() => {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:1024});
  const b = registry.get(1)!, gl = new Gl();
  // Context teardown also releases programs and other state this model omits.
  b.gl = new Proxy(gl,{get:(target,key) => Reflect.get(target,key) ?? (() => null)}) as unknown as WebGL2RenderingContext;
  b.shadow.currentProgram = b.currentProgram = {} as WebGLProgram;
  b.vertexArrays.get(0)!.attributes.set(0,{buffer:null,enabled:true,size:2,type:FLOAT,normalized:false,stride:0,offset:0});
  expect(drawPrivateClientArrays(b,payload()).accepted).toBe(true);
  const stream = b.clientArrayStream!;
  expect(gl.alive.has(stream)).toBe(true);
  registry.destroyContext(1);
  expect(gl.alive.has(stream)).toBe(false); expect(b.clientArrayStream).toBeNull();
});
for (const first of [0,3]) {
  for (const pending of [false,true]) {
    it(`checks each private step once with one clean entry (first=${first}, pending=${pending})`,() => {
      const {b,gl,restored} = fixture();
      if (pending) gl.errors.push(0x500,0x505);
      expect(drawPrivateClientArrays(b,payload({first}))).toEqual({attempted:true,accepted:true,restored:true});
      // Stream creation (first draw only) is a checked call; then the stream
      // bind, the upload and pointer group, the draw and the restoration
      // group are each checked once: entry drain, post-bind, post-group,
      // post-draw, restoration drain and post-check.
      expect(gl.errorReads).toBe(2+6+(pending ? 2 : 0));
      expect(gl.counts.get("bufferData")).toBe(1);
      expect(gl.counts.get("bufferSubData") ?? 0).toBe(first === 0 ? 0 : 1);
      expect(gl.draws).toHaveLength(1);
      expect(b.errors).toEqual(pending ? [0x500,0x505] : []); restored();
      gl.errorReads = 0;
      expect(drawPrivateClientArrays(b,payload({first}))).toEqual({attempted:true,accepted:true,restored:true});
      expect(gl.errorReads).toBe(6); expect(gl.draws).toHaveLength(2); restored();
    });
  }
}
it("uploads a nonzero first without reading or changing the unused prefix",() => {
  const {b,gl,restored} = fixture();
  expect(drawPrivateClientArrays(b,payload({first:3,count:2})).accepted).toBe(true);
  const draw = gl.draws[0], data = draw.bytes.get(draw.attributes.get(0)!.buffer!)!;
  expect(data).toEqual(new Uint8Array([...new Uint8Array(24),...new Uint8Array(16).fill(0x42)]));
  expect(draw.first).toBe(3); expect(draw.count).toBe(2); restored();
});
it("converts packed FIXED directly and restores its native null FLOAT representation",() => {
  const {b,gl,restored} = fixture(FIXED,2,260,4);
  const values = new Int32Array([-2147483648,-65536,1,65536,2147483647,0]);
  expect(drawPrivateClientArrays(b,payload({type:FIXED,count:3,bytes:new Uint8Array(values.buffer)})).accepted).toBe(true);
  const draw = gl.draws[0], data = draw.bytes.get(draw.attributes.get(0)!.buffer!)!;
  expect([...new Float32Array(data.buffer)]).toEqual([...Float32Array.from(values,n => n/65536)]);
  expect(draw.attributes.get(0)!.type).toBe(FLOAT); expect(draw.attributes.get(0)!.normalized).toBe(false); restored();
});
it("supports unaligned packed byte descriptors and multiple client attributes",() => {
  const {b,gl,vao,restored} = fixture(0x1401,1);
  vao.attributes.set(3,{...vao.attributes.get(0)!}); gl.attributes.set(3,{...gl.attributes.get(0)!});
  const bytes = new Uint8Array([1,2,3]);
  expect(drawPrivateClientArrays(b,payload({type:0x1401,size:1,count:3,indices:[0,3],bytes})).accepted).toBe(true);
  // Both attributes live in the stream buffer, in separate aligned regions.
  const [first,second] = [gl.draws[0].attributes.get(0)!,gl.draws[0].attributes.get(3)!];
  expect(first.buffer).toBe(second.buffer); expect([first.offset,second.offset]).toEqual([0,4]);
  expect([...gl.draws[0].bytes.get(first.buffer!)!]).toEqual([1,2,3,0,1,2,3,0]);
  expect(gl.counts.get("deleteBuffer") ?? 0).toBe(0); restored();
});

for (const [field,value] of [[0,7],[4,0xffffffff],[8,0],[8,0xffffffff],[12,0],[12,17],[16,16],[20,0],[24,0xdead],[28,2],[32,1]] as const) {
  it(`rejects malformed descriptor ${field}/${value} before native allocation`,() => {
    const {b,gl,restored} = fixture(), input = payload(); input.setUint32(field,value,true);
    expect(validPrivateClientDraw(input)).toBe(false);
    expect(drawPrivateClientArrays(b,input).attempted).toBe(false); expect(gl.counts.size).toBe(0); restored();
  });
}
it("rejects truncated/trailing/over-u16 payloads and duplicate attribute indices",() => {
  for (const size of [0,15,35,83,85,65536]) {
    const bytes = new Uint8Array(size), original = payload();
    bytes.set(new Uint8Array(original.buffer).subarray(0,size)); expect(validPrivateClientDraw(new DataView(bytes.buffer))).toBe(false);
  }
  expect(validPrivateClientDraw(payload({indices:[0,0]}))).toBe(false);
  expect(validPrivateClientDraw(payload({first:0x7fffffff}))).toBe(false);
});
it("rejects mismatched/missing client definitions, named VAOs and an open legacy savepoint",() => {
  for (const kind of ["disabled","type","size","normalized","view","buffer","missing","named","legacy"]) {
    const {b,gl,vao,restored} = fixture(), old = {...vao.attributes.get(0)!};
    switch (kind) {
      case "disabled": vao.attributes.get(0)!.enabled = false; break;
      case "type": vao.attributes.get(0)!.type = FIXED; break;
      case "size": vao.attributes.get(0)!.size = 3; break;
      case "normalized": vao.attributes.get(0)!.normalized = true; break;
      case "view": vao.attributes.get(0)!.view = {}; break;
      case "buffer": vao.attributes.get(0)!.buffer = {}; break;
      case "missing": vao.attributes.set(2,{...old}); break;
      case "named": b.vertexArrayId = 1; break;
      case "legacy": b.savedClientArrayBuffer = null; break;
    }
    expect(drawPrivateClientArrays(b,payload()).attempted).toBe(false); expect(gl.counts.size).toBe(0);
    vao.attributes.clear(); vao.attributes.set(0,old); b.vertexArrayId = 0; b.savedClientArrayBuffer = undefined; restored();
  }
});

for (const method of ["createBuffer","bindBuffer","bufferData","bufferSubData","vertexAttribPointer","drawArrays"]) {
  for (const after of [false,true]) for (const throws of [false,true]) {
    it(`retains/restores owners after ${method} ${after ? "post" : "pre"}-effect ${throws ? "throw" : "error"}${method === "createBuffer" && after && throws ? " at returned-handle validation" : ""}`,() => {
      const {b,gl,restored} = fixture(); gl.fault = {method,nth:1,after,throws};
      gl.errors.push(0x500,0x505);
      const result = drawPrivateClientArrays(b,payload({first:method === "bufferSubData" ? 3 : 0}));
      expect(result.accepted).toBe(false); expect(result.attempted).toBe(method === "drawArrays");
      expect(gl.draws.length).toBe(method === "drawArrays" && after ? 1 : 0);
      if (method === "createBuffer" || method === "bindBuffer") expect(gl.counts.get("bufferData") ?? 0).toBe(0);
      if (method === "createBuffer" || method === "bindBuffer") expect(gl.counts.get("bufferSubData") ?? 0).toBe(0);
      // Inverse pointer restoration uses ARRAY=null. No private pointer may be
      // attempted without the stream bound (a failed stream creation or bind);
      // pointers set beside a failed upload in its checked group are undone.
      if (method === "createBuffer" || method === "bindBuffer") {
        expect(gl.pointerSources.filter(source => source !== null)).toHaveLength(0);
      }
      expect(repairNativeState(b.gl!)).toBe(true);
      expect(b.errors).toEqual([0x500,0x505,0x502]); restored();
    });
  }
}
afterEach(() => setNativeGlFaultReporter(null));
function collectFaults(): Error[] {
  const reported: Error[] = [];
  setNativeGlFaultReporter(fault => reported.push(fault));
  return reported;
}
it("makes a refused restoration after an accepted draw a fatal fault without replaying the draw",() => {
  const {b,gl} = fixture(), reported = collectFaults(); gl.blockAfterDraw = true;
  // drawPrivateClientArrays' catch turns the thrown fault into a result; the
  // fault is reported first, which is what latches the fatal shutdown.
  try { drawPrivateClientArrays(b,payload()); } catch (error) { expect(error).toBe(reported[0]); }
  expect(reported).toHaveLength(1); expect(reported[0]).toBeInstanceOf(NativeGlFault);
  expect(reported[0].message).toMatch(/live renderer refused to restore native state after a rejected change/);
  expect(gl.draws).toHaveLength(1);
});
it("deletes nothing per draw, so no buffer cleanup can be left pending",() => {
  const {b,gl,restored} = fixture(); gl.fault = {method:"deleteBuffer",nth:1};
  for (let i = 0; i < 3; i++)
    expect(drawPrivateClientArrays(b,payload())).toEqual({attempted:true,accepted:true,restored:true});
  expect(gl.counts.get("deleteBuffer") ?? 0).toBe(0); expect(gl.counts.get("createBuffer")).toBe(1);
  expect(hasNativeRepair(b.gl!)).toBe(false); expect(gl.draws).toHaveLength(3); restored();
});
it("prepares mixed VBO attributes without changing their bytes or native definitions",() => {
  const {b,gl,vao,array,restored} = fixture();
  const native = {buffer:array,size:2,type:FLOAT,normalized:false,stride:0,offset:0};
  vao.attributes.set(1,{...native,enabled:true}); gl.attributes.set(1,{...native});
  const bytes = new Uint8Array(48).fill(0x33); gl.buffers.set(array,bytes);
  b.bufferStores.set(array,{views:new Map([[ARRAY,{native:array,valid:true}]]),converted:new Map(),source:array,size:48,usage:0x88e4});
  b.bufferViewOwners.set(array,array);
  expect(drawPrivateClientArrays(b,payload()).accepted).toBe(true);
  expect(gl.draws[0].attributes.get(1)).toEqual(native); expect(gl.attributes.get(1)).toEqual(native);
  expect(gl.buffers.get(array)).toBe(bytes); expect(gl.draws[0].bytes.get(array)).toEqual(bytes);
  b.bufferStores.clear(); b.bufferViewOwners.clear(); restored();
});
it("undoes a prior private pointer when the second attribute's pointer fails",() => {
  const {b,gl,vao,restored} = fixture();
  vao.attributes.set(3,{...vao.attributes.get(0)!}); gl.attributes.set(3,{...gl.attributes.get(0)!});
  gl.fault = {method:"vertexAttribPointer",nth:2,after:true};
  expect(drawPrivateClientArrays(b,payload({indices:[0,3]})).attempted).toBe(false);
  expect(gl.attributes.get(0)!.buffer).toBeNull(); expect(gl.attributes.get(3)!.buffer).toBeNull();
  expect(gl.counts.get("deleteBuffer") ?? 0).toBe(0); expect(b.errors).toEqual([0x502]); restored();
});
it("accepts the exact u16 payload bound and all sixteen client attribute slots",() => {
  {
    const {b,gl,restored} = fixture(0x1401,1), input = payload({type:0x1401,size:1,count:65499});
    expect(input.byteLength).toBe(65535); expect(validPrivateClientDraw(input)).toBe(true);
    expect(drawPrivateClientArrays(b,input).accepted).toBe(true); expect(gl.draws).toHaveLength(1); restored();
  }
  const {b,gl,vao,restored} = fixture(), indices = Array.from({length:16},(_,i) => i);
  for (let i = 1; i < 16; i++) { vao.attributes.set(i,{...vao.attributes.get(0)!}); gl.attributes.set(i,{...gl.attributes.get(0)!}); }
  expect(drawPrivateClientArrays(b,payload({count:1,indices})).accepted).toBe(true);
  expect(gl.counts.get("createBuffer")).toBe(1); expect(gl.counts.get("deleteBuffer") ?? 0).toBe(0);
  expect(new Set(indices.map(i => gl.draws[0].attributes.get(i)!.offset)).size).toBe(16); restored();
});
it("dispatches one validated private record through the ordinary storage boundary",() => {
  const {b,gl,restored} = fixture(), data = payload(), bytes = new Uint8Array(data.byteLength+4), view = new DataView(bytes.buffer);
  view.setUint16(0,O.OP_DRAW_CLIENT_ARRAYS,true); view.setUint16(2,data.byteLength,true); bytes.set(new Uint8Array(data.buffer),4); b.cmdbufView = bytes;
  const calls: string[] = [];
  expect(decodeAndDispatch(b,0,bytes.length,{before:() => {calls.push("before");return true;},after:() => {calls.push("after");return true;}})).toBe(0);
  expect(calls).toEqual(["before","after"]); expect(gl.draws).toHaveLength(1); expect(b.errors).toEqual([]); restored();
});
it("rejects a malformed trailing private record before an earlier command mutates state",() => {
  const {b,gl,restored} = fixture(), bytes = new Uint8Array(12+20), view = new DataView(bytes.buffer);
  view.setUint16(0,O.OP_BIND_BUFFER,true); view.setUint16(2,8,true); view.setUint32(4,ARRAY,true); view.setUint32(8,17,true);
  view.setUint16(12,O.OP_DRAW_CLIENT_ARRAYS,true); view.setUint16(14,16,true); b.cmdbufView = bytes;
  expect(decodeAndDispatch(b,0,bytes.length)).toBe(-22); expect(gl.counts.size).toBe(0); restored();
});

for (const fault of ["incomplete", "native-error", "throw"]) it(`refuses private client allocation after no-program framebuffer ${fault}`, () => {
  const {b,gl,restored} = fixture(); b.shadow.currentProgram = b.currentProgram = null;
  const checked: number[] = [];
  Object.assign(gl,{checkFramebufferStatus(target: number) {
    checked.push(target);
    if(fault === "throw") throw Error("framebuffer unavailable");
    if(fault === "native-error") gl.errors.push(0x505);
    return 0x8cd7;
  }});
  b.errors.push(0x501); gl.errors.push(0x500);
  expect(drawPrivateClientArrays(b,payload())).toEqual({attempted:false,accepted:false,restored:false});
  expect(checked).toEqual([0x8ca9]); expect(gl.counts.size).toBe(0); expect(gl.draws).toHaveLength(0);
  expect(b.errors).toEqual([0x501,0x500,fault === "incomplete" ? 0x506 : fault === "native-error" ? 0x505 : 0x502]);
  restored();
});
