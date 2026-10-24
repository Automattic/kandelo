import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";

const ARRAY = 0x8892, ELEMENT = 0x8893;
class BufferGl {
  errors: number[] = [];
  alive = new Set<object>();
  bindings = new Map<number, object | null>();
  classes = new Map<object, number>();
  contents = new Map<object, Uint8Array>();
  failCreate = false;
  failBind = false;
  failTransfer = false;
  fault: string | null = null;
  attributes = new Map<number, {buffer: object | null; size: number; type: number; normalized: boolean; stride: number; offset: number}>();
  reject(label: string) { if (this.fault !== label) return false; this.fault = null; this.errors.push(0x502); return true; }
  getError() { return this.errors.shift() ?? 0; }
  createBuffer() { if (this.failCreate) return null; const object = {}; this.alive.add(object); return object; }
  deleteBuffer(object: object) {
    if (this.reject("delete")) return;
    this.alive.delete(object);
    for (const [target,value] of this.bindings) if (value === object) this.bindings.set(target,null);
    for (const value of this.attributes.values()) if (value.buffer === object) value.buffer = null;
  }
  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
    if (this.reject(`pointer:${index}`)) return;
    this.attributes.set(index,{buffer:this.bindings.get(ARRAY) ?? null,size,type,normalized,stride,offset});
  }
  getParameter(target: number) { return this.bindings.get(target) ?? null; }
  bindBuffer(target: number, object: object | null) {
    if (this.reject(`bind:${target}`)) return;
    if (this.failBind) { this.failBind = false; this.errors.push(0x502); return; }
    if (object && (target === ARRAY || target === ELEMENT)) {
      const old = this.classes.get(object);
      if (old && old !== target) { this.errors.push(0x502); return; }
      this.classes.set(object, target);
    }
    this.bindings.set(target, object);
  }
  bufferData(target: number, size: number) {
    if (this.failTransfer) { this.failTransfer = false; this.errors.push(0x505); return; }
    this.contents.set(this.bindings.get(target)!, new Uint8Array(size));
  }
  bufferSubData(target: number, offset: number, bytes: Uint8Array) { this.contents.get(this.bindings.get(target)!)!.set(bytes, offset); }
  getBufferSubData(target: number, offset: number, out: Uint8Array) { out.set(this.contents.get(this.bindings.get(target)!)!.subarray(offset, offset + out.length)); }
}
function setup() {
  const registry = new GlContextRegistry(); registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 64 });
  const b = registry.get(1)!, gl = new BufferGl(); b.gl = gl as unknown as WebGL2RenderingContext;
  b.cmdbufView = new Uint8Array(64);
  const query = (target: number, name: number) => {
    const out = new Uint8Array(12);
    expect(runGlQuery(b, O.QOP_BIND_BUFFER, new Uint8Array(new Uint32Array([target, name]).buffer), out)).toBe(12);
    const words = new Uint32Array(out.buffer); expect(words[2]).toBe(0x47514c33);
    return [...words.slice(0, 2)];
  };
  return { b, gl, query };
}
for (const target of [ARRAY, ELEMENT]) {
  it(`acknowledges buffer realization, rebinding and zero for target ${target}`, () => {
    const { b, gl, query } = setup();
    expect(query(target, 17)).toEqual([0, 1]); const object = b.buffers.get(17)!;
    expect(query(target, 17)).toEqual([0, 1]); expect(gl.alive.size).toBe(1);
    expect(query(target, 0)).toEqual([0, 1]); expect(gl.bindings.get(target)).toBeNull();
    expect(b.buffers.get(17)).toBe(object);
  });
  it(`preserves buffer target ${target} across rejected creation, bind and accepted retry`, () => {
    const { b, gl, query } = setup(); query(target, 17); const old = b.buffers.get(17)!;
    gl.failCreate = true; expect(query(target, 18)).toEqual([1, 0]); gl.failCreate = false;
    gl.failBind = true; expect(query(target, 18)).toEqual([1, 0]);
    expect(b.buffers.has(18)).toBe(false); expect(b.bufferStores.size).toBe(1); expect(b.bufferViewOwners.size).toBe(1);
    expect(gl.bindings.get(target)).toBe(old); expect(gl.alive.size).toBe(1);
    gl.failBind = true; expect(query(target, 0)).toEqual([1, 0]); expect(gl.bindings.get(target)).toBe(old);
    expect(query(target, 18)).toEqual([0, 1]); expect(gl.bindings.get(target)).toBe(b.buffers.get(18));
    expect(b.errors).toEqual([0x505, 0x502]);
  });
  it(`reserves every buffer metadata map before native target ${target} selection`, () => {
    for (const mapName of ["buffers", "bufferStores", "bufferViewOwners"] as const) {
      const { b, gl, query } = setup(); query(target, 17); const old = b.buffers.get(17)!;
      const map = b[mapName], set = map.set;
      map.set = () => { throw new RangeError("allocation failed"); };
      try { expect(query(target, 18)).toEqual([1, 0]); } finally { map.set = set; }
      expect(gl.bindings.get(target)).toBe(old); expect(gl.alive.size).toBe(1);
      expect(b.buffers.has(18)).toBe(false); expect(b.bufferStores.size).toBe(1); expect(b.bufferViewOwners.size).toBe(1);
      expect(b.errors).toEqual([0x505]);
    }
  });
  it(`uses the same rejection transaction for queued buffer target ${target}`, () => {
    const { b, gl, query } = setup(); query(target, 17); const old = b.buffers.get(17)!; gl.failBind = true;
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, O.OP_BIND_BUFFER, true); view.setUint16(2, 8, true);
    view.setUint32(4, target, true); view.setUint32(8, 18, true);
    expect(decodeAndDispatch(b, 0, 12)).toBe(0); expect(b.buffers.has(18)).toBe(false);
    expect(gl.bindings.get(target)).toBe(old); expect(gl.alive.size).toBe(1);
  });
}
it("rolls back a new cross-class view after failed transfer and accepts later synchronization", () => {
  const { b, gl, query } = setup(); query(ARRAY, 17); query(ELEMENT, 18);
  const source = b.buffers.get(17)!, old = b.buffers.get(18)!, store = b.bufferStores.get(source)!;
  store.size = 4; gl.contents.set(source, new Uint8Array([1, 2, 3, 4]));
  gl.failTransfer = true; expect(query(ELEMENT, 17)).toEqual([1, 0]);
  expect(gl.bindings.get(ELEMENT)).toBe(old); expect(store.views.has(ELEMENT)).toBe(false);
  expect(b.bufferViewOwners.size).toBe(2); expect(gl.alive.size).toBe(2);
  expect(query(ELEMENT, 17)).toEqual([0, 1]); const view = store.views.get(ELEMENT)!;
  expect(view.native).not.toBe(source); expect(gl.contents.get(view.native)).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(b.vertexArrays.get(0)!.element).toBe(source); expect(b.shadow.arrayBuffer).toBe(source);
});
it("validates buffer query spans and targets before native effects", () => {
  const { b, gl, query } = setup();
  for (const [inputSize, outputSize] of [[0, 12], [4, 12], [12, 12], [8, 0], [8, 8], [8, 16]]) {
    const out = new Uint8Array(outputSize).fill(0xa5);
    expect(runGlQuery(b, O.QOP_BIND_BUFFER, new Uint8Array(inputSize), out)).toBe(-22);
    expect([...out]).toEqual(Array(outputSize).fill(0xa5));
  }
  expect(query(0xdead, 17)).toEqual([1, 0]); expect(gl.alive.size).toBe(0); expect(b.errors).toEqual([0x500]);
});
it("reserves new native-view maps before classifying a cross-target buffer", () => {
  for (const mapName of ["views", "owners"] as const) {
    const { b, gl, query } = setup(); query(ARRAY, 17); query(ELEMENT, 18);
    const object = b.buffers.get(17)!, old = b.buffers.get(18)!, store = b.bufferStores.get(object)!;
    const map = mapName === "views" ? store.views : b.bufferViewOwners, set = map.set;
    map.set = () => { throw new RangeError("allocation failed"); };
    try { expect(query(ELEMENT, 17)).toEqual([1, 0]); } finally { map.set = set; }
    expect(gl.bindings.get(ELEMENT)).toBe(old); expect(store.views.has(ELEMENT)).toBe(false);
    expect(b.bufferViewOwners.size).toBe(2); expect(gl.alive.size).toBe(2);
    expect(query(ELEMENT, 17)).toEqual([0, 1]); expect(store.views.has(ELEMENT)).toBe(true);
  }
});

function deletionSetup(converted = false) {
  const fixture = setup(), {b,gl,query} = fixture;
  const send = (op: number, words: number[]) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0,op,true); view.setUint16(2,words.length*4,true);
    words.forEach((word,index) => view.setUint32(4+index*4,word,true));
    expect(decodeAndDispatch(b,0,4+words.length*4)).toBe(0);
  };
  query(ARRAY,17); send(O.OP_BUFFER_DATA,[ARRAY,64,0x88e4]);
  send(O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,8,4]);
  send(O.OP_VERTEX_ATTRIB_POINTER,[1,2,converted ? 0x140c : 0x1406,0,16,8]);
  query(ELEMENT,17);
  const old = b.buffers.get(17)!, store = b.bufferStores.get(old)!;
  const pointers = new Map([...gl.attributes].map(([index,value]) => [index,{...value}]));
  const oldArray = gl.bindings.get(ARRAY), oldElement = gl.bindings.get(ELEMENT), nativeCount = gl.alive.size;
  const remove = (name = 17) => {
    const out = new Uint8Array(12);
    expect(runGlQuery(b,O.QOP_DELETE_BUFFER,new Uint8Array(new Uint32Array([name]).buffer),out)).toBe(12);
    const words = new Uint32Array(out.buffer); expect(words[2]).toBe(0x47514c33); return [...words.slice(0,2)];
  };
  const preserved = () => {
    expect(b.buffers.get(17)).toBe(old); expect(b.bufferStores.get(old)).toBe(store); expect(b.retiredBuffers.size).toBe(0);
    expect(b.shadow.arrayBuffer).toBe(oldArray); expect(b.vertexArrays.get(0)!.element).toBe(old);
    expect(gl.bindings.get(ARRAY)).toBe(oldArray); expect(gl.bindings.get(ELEMENT)).toBe(oldElement);
    expect(gl.attributes).toEqual(pointers); expect(gl.alive.size).toBe(nativeCount);
    expect([...b.vertexArrays.get(0)!.attributes.values()].every(a => a.buffer === old)).toBe(true);
  };
  return {...fixture,send,remove,preserved,old,store};
}
for (const converted of [false,true]) {
  for (const fault of ["create","pointer:1",`bind:${ELEMENT}`,"delete"]) {
    it(`restores deletion attributes and both selectors after ${fault} rejection (converted: ${converted})`, () => {
      const {gl,b,remove,preserved} = deletionSetup(converted);
      if (fault === "create") gl.failCreate = true; else gl.fault = fault;
      expect(remove()).toEqual([1,0]); preserved();
      gl.failCreate = false; expect(remove()).toEqual([0,1]);
      expect(b.buffers.has(17)).toBe(false); expect(b.retiredBuffers.size).toBe(0); expect(gl.alive.size).toBe(0);
      expect(gl.bindings.get(ARRAY)).toBeNull(); expect(gl.bindings.get(ELEMENT)).toBeNull();
      expect([...gl.attributes.values()].every(a => a.buffer === null)).toBe(true);
      expect([...b.vertexArrays.get(0)!.attributes.values()].every(a => a.buffer === null && !a.view)).toBe(true);
    });
  }
}
it("restores an attribute even if the failing pointer wrapper already changed it", () => {
  const {gl,remove,preserved} = deletionSetup();
  const pointer = gl.vertexAttribPointer.bind(gl); let rejected = false;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    pointer(...args); if (args[0] === 1 && !rejected) { rejected = true; gl.errors.push(0x502); }
  };
  expect(remove()).toEqual([1,0]); preserved(); expect(rejected).toBe(true); expect(remove()).toEqual([0,1]);
});
it("prepares all deletion metadata before native allocation or attribute changes", () => {
  for (const mapName of ["buffers","retiredBuffers","attributes"] as const) {
    const {b,remove,preserved} = deletionSetup();
    const selected = mapName === "attributes" ? b.vertexArrays.get(0)!.attributes : b[mapName];
    const OriginalMap = globalThis.Map;
    let rc: number, out = new Uint8Array(12);
    globalThis.Map = class extends OriginalMap {
      constructor(entries?: any) { if (entries === selected) throw new RangeError("allocation failed"); super(entries); }
    } as MapConstructor;
    try { rc = runGlQuery(b,O.QOP_DELETE_BUFFER,new Uint8Array(new Uint32Array([17]).buffer),out); }
    finally { globalThis.Map = OriginalMap; }
    expect(rc!).toBe(12); expect([...new Uint32Array(out.buffer)]).toEqual([1,0,0x47514c33]); preserved();
    expect(remove()).toEqual([0,1]);
  }
});
it("keeps the queued multi-name deletion on the same reversible transaction", () => {
  const {b,gl,send,query,old,store} = deletionSetup();
  query(ELEMENT,18); const second = b.buffers.get(18)!, element = gl.bindings.get(ELEMENT);
  const pointers = new Map([...gl.attributes].map(([index,value]) => [index,{...value}]));
  gl.fault = `bind:${ELEMENT}`; send(O.OP_DELETE_BUFFERS,[3,17,18,17]);
  expect(b.buffers.get(17)).toBe(old); expect(b.buffers.get(18)).toBe(second);
  expect(b.bufferStores.get(old)).toBe(store); expect(gl.bindings.get(ELEMENT)).toBe(element); expect(gl.attributes).toEqual(pointers);
  send(O.OP_DELETE_BUFFERS,[3,17,18,17]); expect(b.buffers.size).toBe(0); expect(gl.alive.size).toBe(0);
});
it("validates deletion spans and accepts absent or zero names without mutation", () => {
  const {b,gl} = setup();
  for (const [inputSize,outputSize] of [[0,12],[8,12],[4,0],[4,8],[4,16]]) {
    const out = new Uint8Array(outputSize).fill(0xa5);
    expect(runGlQuery(b,O.QOP_DELETE_BUFFER,new Uint8Array(inputSize),out)).toBe(-22);
    expect([...out]).toEqual(Array(outputSize).fill(0xa5));
  }
  for (const name of [0,17]) {
    const out = new Uint8Array(12);
    expect(runGlQuery(b,O.QOP_DELETE_BUFFER,new Uint8Array(new Uint32Array([name]).buffer),out)).toBe(12);
    expect([...new Uint32Array(out.buffer)]).toEqual([0,1,0x47514c33]);
  }
  expect(gl.alive.size).toBe(0); expect(gl.bindings.size).toBe(0); expect(b.errors).toEqual([]);
});
