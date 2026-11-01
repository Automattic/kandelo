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
    // Model native WebGL validation independently of GLES adaptation.
    if (index >= 16 || size < 1 || size > 4 || stride < 0 || stride > 255 || offset < 0) { this.errors.push(0x501); return; }
    const widths = new Map([[0x1400,1],[0x1401,1],[0x1402,2],[0x1403,2],[0x1404,4],[0x1405,4],[0x1406,4],[0x140b,2]]);
    const width = widths.get(type); if (!width) {this.errors.push(0x500);return;}
    const buffer = this.bindings.get(ARRAY);
    if ((buffer ? !this.alive.has(buffer) : offset !== 0) || stride % width || offset % width) {this.errors.push(0x502);return;}
    this.attributes.set(index,{buffer:this.bindings.get(ARRAY) ?? null,size,type,normalized,stride,offset});
  }
  getParameter(target: number) { return target === 0x8869 ? 16 : this.bindings.get(target) ?? null; }
  bindBuffer(target: number, object: object | null) {
    if (this.reject(`bind:${target}`)) return;
    if (object && !this.alive.has(object)) {this.errors.push(0x502);return;}
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
  return { b, gl, query, registry };
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
  for (const fault of [`bind:${ARRAY}`,"pointer:0","pointer:1",`bind:${ELEMENT}`]) {
    it(`restores deletion attributes and both selectors after ${fault} rejection (converted: ${converted})`, () => {
      const {gl,b,remove,preserved} = deletionSetup(converted);
      gl.fault = fault;
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
for (const converted of [false,true]) it(`clears deleted attributes without allocating, initializing or deleting a temporary (converted: ${converted})`, () => {
  const {b,gl,remove,old,store} = deletionSetup(converted);
  let creates = 0, data = 0;
  const deleted: object[] = [], destroy = gl.deleteBuffer.bind(gl);
  gl.createBuffer = () => {creates++; throw new Error("null clearing must not allocate");};
  gl.bufferData = () => {data++; throw new Error("null clearing must not initialize storage");};
  gl.deleteBuffer = object => {deleted.push(object);destroy(object);};
  const expected = new Set([old,...[...store.views.values()].map(view => view.native)]);
  for (const view of store.converted.values()) expected.add(view.native);
  expect(remove()).toEqual([0,1]);
  expect(creates).toBe(0); expect(data).toBe(0);
  expect(new Set(deleted)).toEqual(expected); expect(deleted.length).toBe(expected.size);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toMatchObject({buffer:null,size:2,stride:8,offset:4});
  expect(gl.attributes.get(0)).toMatchObject({buffer:null,size:2,stride:8,offset:0});
  expect(b.vertexArrays.get(0)!.attributes.get(1)).toMatchObject({buffer:null,type:converted?0x140c:0x1406,stride:16,offset:8});
  expect(gl.alive.size).toBe(0);
});

for (const fault of ["error","throw"] as const) it(`restores deletion after an ARRAY null bind changes state then reports ${fault}`, () => {
  const {b,gl,remove,preserved} = deletionSetup();
  const bind = gl.bindBuffer.bind(gl); let rejected = false;
  gl.bindBuffer = (target,object) => {
    bind(target,object);
    if (!rejected && target === ARRAY && object === null) {
      rejected = true;
      if (fault === "throw") throw new Error("bind changed state before throwing");
      gl.errors.push(0x502);
    }
  };
  expect(remove()).toEqual([1,0]); preserved();
  expect(b.errors).toContain(0x502);
  expect(remove()).toEqual([0,1]); expect(gl.alive.size).toBe(0);
});

for (const converted of [false,true]) it(`commits logical deletion while failed physical cleanup stays owned and fences later work (converted: ${converted})`, () => {
  const {b,gl,remove,old,store} = deletionSetup(converted);
  const destroy = gl.deleteBuffer.bind(gl), deleted: object[] = [];
  let block = true;
  gl.deleteBuffer = object => {
    if (block) {gl.errors.push(0x505);return;}
    deleted.push(object);destroy(object);
  };
  const count = gl.alive.size;
  expect(remove()).toEqual([0,1]);
  expect(b.buffers.has(17)).toBe(false); expect(b.retiredBuffers.get(old)).toBe(17);
  expect(b.bufferStores.get(old)).toBe(store);
  expect([...b.vertexArrays.get(0)!.attributes.values()].every(a => a.buffer === null && !a.view)).toBe(true);
  expect([...gl.attributes.values()].every(a => a.buffer === null)).toBe(true);
  expect(gl.bindings.get(ARRAY)).toBeNull(); expect(gl.bindings.get(ELEMENT)).toBeNull();
  expect(gl.alive.size).toBe(count);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  // Physical receipts retry independently of the already committed name change.
  // A later admitted delete query collects the completed logical tombstone.
  expect(remove()).toEqual([0,1]);
  expect(gl.alive.size).toBe(0); expect(b.retiredBuffers.size).toBe(0);
  expect(new Set(deleted).size).toBe(count); expect(deleted.length).toBe(count);
});

it("prepares all deletion metadata before native attribute changes", () => {
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

for (const converted of [false,true]) it(`retains failed attribute restoration and fences dependent work (converted: ${converted})`, () => {
  const {b,gl,remove,preserved,old} = deletionSetup(converted);
  const pointer = gl.vertexAttribPointer.bind(gl); let rejected = false, block = true;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    if (!rejected && args[0] === 1) { rejected = true; gl.errors.push(0x502); return; }
    if (rejected && block) { gl.errors.push(0x502); return; }
    pointer(...args);
  };
  expect(remove()).toEqual([1,0]);
  expect(b.buffers.get(17)).toBe(old);
  expect([...b.vertexArrays.get(0)!.attributes.values()].every(a => a.buffer === old)).toBe(true);
  // The first pointer was cleared before the second failed; it stays native
  // null while the journal fences work, rather than retaining a scratch BO.
  expect(gl.attributes.get(0)!.buffer).toBeNull();
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  preserved();
  expect(remove()).toEqual([0,1]); expect(gl.alive.size).toBe(0);
});

for (const target of [ARRAY,ELEMENT]) it(`retains failed buffer binding restoration and candidate cleanup (target ${target})`, () => {
  const {b,gl,query} = setup(); query(target,17); const old = b.buffers.get(17)!;
  const bind = gl.bindBuffer.bind(gl), destroy = gl.deleteBuffer.bind(gl);
  let rejected = false, block = true, blockCleanup = true;
  gl.bindBuffer = (selected,object) => {
    if (!rejected && selected === target && object !== old) { rejected = true; gl.errors.push(0x502); return; }
    if (rejected && block && selected === target && object === old) { gl.errors.push(0x502); return; }
    bind(selected,object);
  };
  gl.deleteBuffer = object => { if (blockCleanup && object !== old) { gl.errors.push(0x505); return; } destroy(object); };
  expect(query(target,18)).toEqual([1,0]);
  expect(b.buffers.has(18)).toBe(false); expect(b.buffers.get(17)).toBe(old);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect(gl.bindings.get(target)).toBe(old);
  expect(gl.alive.size).toBe(2);
  blockCleanup = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.alive.size).toBe(1); expect(gl.bindings.get(target)).toBe(old);
  expect(query(target,18)).toEqual([0,1]);
});

it("retains nested copy-selector restoration before the outer buffer binding can commit", () => {
  const {b,gl,query} = setup(); query(ARRAY,17); query(ELEMENT,18);
  const source = b.buffers.get(17)!, previous = b.buffers.get(18)!;
  b.bufferStores.get(source)!.size = 4; gl.contents.set(source,new Uint8Array([1,2,3,4]));
  const read = gl.createBuffer(), write = gl.createBuffer();
  gl.bindBuffer(0x8f36,read); gl.bindBuffer(0x8f37,write);
  const bind = gl.bindBuffer.bind(gl); let block = true;
  gl.bindBuffer = (target,object) => {
    if (block && target === 0x8f37 && object === write) { gl.errors.push(0x502); return; }
    bind(target,object);
  };
  expect(query(ELEMENT,17)).toEqual([1,0]);
  expect(b.bufferStores.get(source)!.views.has(ELEMENT)).toBe(false);
  expect(b.vertexArrays.get(0)!.element).toBe(previous);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.bindings.get(ELEMENT)).toBe(previous);
  expect(gl.bindings.get(0x8f36)).toBe(read); expect(gl.bindings.get(0x8f37)).toBe(write);
  expect(query(ELEMENT,17)).toEqual([0,1]);
  const view = b.bufferStores.get(source)!.views.get(ELEMENT)!;
  expect(gl.contents.get(view.native)).toEqual(new Uint8Array([1,2,3,4]));
});

it("retires an allocated buffer candidate if VAO bookkeeping throws before publication", () => {
  const {b,gl,query} = setup(); b.vertexArrays.delete(0);
  const OriginalMap = globalThis.Map;
  globalThis.Map = class extends OriginalMap { constructor(entries?: any) { super(entries); if (entries === undefined) throw new RangeError("VAO allocation failed"); } } as MapConstructor;
  try { expect(query(ELEMENT,17)).toEqual([1,0]); }
  finally { globalThis.Map = OriginalMap; }
  expect(gl.alive.size).toBe(0); expect(b.buffers.size).toBe(0); expect(b.bufferStores.size).toBe(0);
  expect(b.errors).toContain(0x505);
  expect(query(ELEMENT,17)).toEqual([0,1]); expect(gl.alive.size).toBe(1);
});

function pointerSetup() {
  const fixture = setup();
  const {b,gl,query} = fixture;
  const submit = (records: [number,number[]][]) => {
    const bytes: number[] = [];
    for (const [op,words] of records) {
      const record = new Uint8Array(4+words.length*4), v = new DataView(record.buffer);
      v.setUint16(0,op,true); v.setUint16(2,words.length*4,true);
      words.forEach((word,i) => v.setUint32(4+i*4,word,true)); bytes.push(...record);
    }
    b.cmdbufView = new Uint8Array(bytes); return decodeAndDispatch(b,0,bytes.length);
  };
  query(ARRAY,17); const object = b.buffers.get(17)!;
  b.bufferStores.get(object)!.size = 16;
  gl.contents.set(object,new Uint8Array(new Int32Array([65536,0,0,65536]).buffer));
  return {...fixture,submit,object};
}

it("restores an interrupted capture before the next query without another END record", () => {
  const {b,gl,submit,object} = pointerSetup();
  Object.assign(gl,{clearColor(){throw new Error("submission interrupted");}});
  expect(submit([[O.OP_BEGIN_CLIENT_ARRAY,[]],[O.OP_BIND_BUFFER,[ARRAY,18]],[O.OP_CLEAR_COLOR,[0,0,0,0x3f800000]],[O.OP_END_CLIENT_ARRAY,[]]])).toBe(-5);
  expect(b.shadow.arrayBuffer).toBe(object); expect(gl.bindings.get(ARRAY)).toBe(object);
  expect(b.savedClientArrayBuffer).toBeUndefined(); expect(b.clientArrayEndRequested).toBe(false);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),new Uint8Array(4))).toBe(4);
});

it("keeps a restore request when ticket reservation fails and retries it on admission", () => {
  const {b,gl,submit,object} = pointerSetup();
  expect(submit([[O.OP_BEGIN_CLIENT_ARRAY,[]],[O.OP_BIND_BUFFER,[ARRAY,18]]])).toBe(0);
  const temporary = b.shadow.arrayBuffer;
  const set = WeakMap.prototype.set; let rc = 0;
  WeakMap.prototype.set = () => {throw new RangeError("ticket reservation failed");};
  try { rc = submit([[O.OP_END_CLIENT_ARRAY,[]]]); } finally { WeakMap.prototype.set = set; }
  expect(rc).toBe(-5); expect(b.shadow.arrayBuffer).toBe(temporary);
  expect(b.savedClientArrayBuffer).toBe(object); expect(b.clientArrayEndRequested).toBe(true);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),new Uint8Array(4))).toBe(4);
  expect(b.shadow.arrayBuffer).toBe(object); expect(gl.bindings.get(ARRAY)).toBe(object);
  expect(b.savedClientArrayBuffer).toBeUndefined();
});

for (const converted of [false,true]) it(`restores a partially applied pointer and ARRAY selection before accepting later work (converted: ${converted})`, () => {
  const {b,gl,submit,object} = pointerSetup();
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,8,0]]])).toBe(0);
  const accepted = b.vertexArrays.get(0)!.attributes.get(0)!;
  const native = {...gl.attributes.get(0)!}, count = gl.alive.size;
  const pointer = gl.vertexAttribPointer.bind(gl); let rejected = false, block = true;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    if (!rejected && args[1] === 3) { pointer(...args); rejected = true; gl.errors.push(0x502); return; }
    if (rejected && block && args[1] === 2) { gl.errors.push(0x502); return; }
    pointer(...args);
  };
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,3,converted?0x140c:0x1406,0,0,0]]])).toBe(-5);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toBe(accepted);
  expect(gl.attributes.get(0)!.size).toBe(3);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.attributes.get(0)).toEqual(native); expect(gl.bindings.get(ARRAY)).toBe(object);
  expect(gl.alive.size).toBe(count); expect(b.bufferStores.get(object)!.converted.size).toBe(0);
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,3,converted?0x140c:0x1406,0,0,0]]])).toBe(0);
  expect(b.vertexArrays.get(0)!.attributes.get(0)!.size).toBe(3);
});

it("restores an initially null attribute without allocating scratch storage", () => {
  const {b,gl,submit,object} = pointerSetup();
  const pointer = gl.vertexAttribPointer.bind(gl);
  let rejected = false, blockRestore = true;
  gl.failCreate = true;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    if (rejected && blockRestore && args[1] === 4) { gl.errors.push(0x502); return; }
    pointer(...args);
    if (!rejected) { rejected = true; gl.errors.push(0x502); }
  };
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]]])).toBe(-5);
  expect(b.vertexArrays.get(0)!.attributes.has(0)).toBe(false);
  expect(gl.attributes.get(0)).toMatchObject({buffer:object,size:2});
  expect(gl.alive.size).toBe(1);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  blockRestore = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.attributes.get(0)).toEqual({buffer:null,size:4,type:0x1406,normalized:false,stride:0,offset:0});
  expect(gl.bindings.get(ARRAY)).toBe(object);
  expect(gl.alive.size).toBe(1);
});

it("does not restore a null pointer until its inverse ARRAY null bind accepts", () => {
  const {b,gl,submit,object} = pointerSetup();
  const pointer = gl.vertexAttribPointer.bind(gl), bind = gl.bindBuffer.bind(gl);
  let rejected = false, block = true, pointerCalls = 0;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    pointerCalls++; pointer(...args);
    if (!rejected) {rejected = true; gl.errors.push(0x502);}
  };
  gl.bindBuffer = (target,value) => {
    if (rejected && block && target === ARRAY && value === null) {gl.errors.push(0x502);return;}
    bind(target,value);
  };
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]]])).toBe(-5);
  expect(pointerCalls).toBe(1);
  expect(b.vertexArrays.get(0)!.attributes.has(0)).toBe(false);
  expect(gl.attributes.get(0)).toMatchObject({buffer:object,size:2});
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect(pointerCalls).toBe(1); expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(pointerCalls).toBe(2); expect(gl.attributes.get(0)!.buffer).toBeNull();
  expect(gl.bindings.get(ARRAY)).toBe(object); expect(gl.alive.size).toBe(1);
});

it("restores a deleted logical-null offset after a failed replacement while preserving another ARRAY binding", () => {
  const {b,gl,query,submit} = pointerSetup();
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,8,4]]])).toBe(0);
  const deleted = new Uint8Array(12);
  expect(runGlQuery(b,O.QOP_DELETE_BUFFER,new Uint8Array(new Uint32Array([17]).buffer),deleted)).toBe(12);
  expect([...new Uint32Array(deleted.buffer)]).toEqual([0,1,0x47514c33]);
  const logicalNull = b.vertexArrays.get(0)!.attributes.get(0)!;
  expect(logicalNull).toMatchObject({buffer:null,size:2,stride:8,offset:4});
  expect(gl.attributes.get(0)).toMatchObject({buffer:null,size:2,stride:8,offset:0});
  expect(query(ARRAY,18)).toEqual([0,1]);
  const replacement = b.buffers.get(18)!;
  const pointer = gl.vertexAttribPointer.bind(gl);
  let rejected = false, blockRestore = true;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    if (rejected && blockRestore && gl.bindings.get(ARRAY) === null) {gl.errors.push(0x502);return;}
    pointer(...args);
    if (!rejected) {rejected = true;gl.errors.push(0x502);}
  };
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,3,0x1406,0,12,0]]])).toBe(-5);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toBe(logicalNull);
  expect(gl.attributes.get(0)).toMatchObject({buffer:replacement,size:3});
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  blockRestore = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(new DataView(out.buffer).getUint32(0,true)).toBe(0x502);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toBe(logicalNull);
  expect(logicalNull).toMatchObject({buffer:null,size:2,stride:8,offset:4});
  expect(gl.attributes.get(0)).toMatchObject({buffer:null,size:2,stride:8,offset:0});
  expect(b.shadow.arrayBuffer).toBe(replacement); expect(gl.bindings.get(ARRAY)).toBe(replacement);
  expect(gl.alive.size).toBe(1);
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,8,4]]])).toBe(0);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toMatchObject({buffer:replacement,offset:4});
  expect(gl.attributes.get(0)).toMatchObject({buffer:replacement,offset:4});
});

for (const type of [0x1406,0x140c]) it(`installs a logical null attribute without any native buffer allocation (type ${type})`, () => {
  const {b,gl,query,submit} = pointerSetup();
  expect(query(ARRAY,0)).toEqual([0,1]);
  const count = gl.alive.size;
  let allocations = 0, initializations = 0, deletions = 0;
  gl.createBuffer = () => {allocations++; throw new Error("unexpected null attribute allocation");};
  gl.bufferData = () => {initializations++; throw new Error("unexpected null attribute storage");};
  gl.deleteBuffer = () => {deletions++; throw new Error("unexpected null attribute cleanup");};
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,type,1,8,0]]])).toBe(0);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toEqual({buffer:null,enabled:false,size:2,type,normalized:true,stride:8,offset:0});
  expect(gl.attributes.get(0)).toEqual({buffer:null,size:2,type:0x1406,normalized:type===0x140c?false:true,stride:type===0x140c?0:8,offset:0});
  expect(gl.bindings.get(ARRAY)).toBeNull(); expect(gl.alive.size).toBe(count);
  expect([allocations,initializations,deletions]).toEqual([0,0,0]);
});

for (const fault of ["error","throw"] as const) it(`restores a bound attribute when null pointer clearing changes state then reports ${fault}`, () => {
  const {b,gl,query,submit,object} = pointerSetup();
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,8,4]]])).toBe(0);
  const accepted = b.vertexArrays.get(0)!.attributes.get(0), before = {...gl.attributes.get(0)!};
  expect(query(ARRAY,0)).toEqual([0,1]);
  const pointer = gl.vertexAttribPointer.bind(gl); let rejected = false;
  gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => {
    pointer(...args);
    if (!rejected && gl.bindings.get(ARRAY) === null) {
      rejected = true;
      if (fault === "throw") throw new Error("pointer cleared before throwing");
      gl.errors.push(0x502);
    }
  };
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,3,0x1406,0,12,0]]])).toBe(0);
  expect(rejected).toBe(true);
  expect(b.vertexArrays.get(0)!.attributes.get(0)).toBe(accepted);
  expect(gl.attributes.get(0)).toEqual(before); expect(before.buffer).toBe(object);
  expect(gl.bindings.get(ARRAY)).toBeNull();
  expect(b.errors).toContain(0x502); expect(gl.alive.size).toBe(1);
});

it("reserves attribute and converted-view metadata before native pointer effects", () => {
  for (const selected of ["attribute","converted","owner","view"] as const) {
    const {b,gl,submit,object} = pointerSetup();
    const count = gl.alive.size, pointer = gl.vertexAttribPointer.bind(gl); let changes = 0;
    gl.vertexAttribPointer = (...args: Parameters<typeof pointer>) => { changes++; pointer(...args); };
    const map = selected === "attribute" || selected === "view" ? b.vertexArrays.get(0)!.attributes : selected === "converted" ? b.bufferStores.get(object)!.converted : b.bufferViewOwners;
    const OriginalMap = globalThis.Map, set = map.set, prototypeSet = Map.prototype.set;
    if (selected === "attribute") globalThis.Map = class extends OriginalMap { constructor(entries?: any) {if(entries===map) throw new RangeError("attribute map failed");super(entries);} } as MapConstructor;
    else if (selected === "view") Map.prototype.set = function(key: any,value: any) {
      if (typeof key === "number" && value && typeof value === "object" && "size" in value && "type" in value && "buffer" in value)
        Object.defineProperty(value,"view",{configurable:true,set(){throw new RangeError("view field reservation failed");}});
      return prototypeSet.call(this,key,value);
    };
    else map.set = () => {throw new RangeError("converted metadata failed");};
    try { expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x140c,0,0,0]]])).toBe(0); }
    finally { globalThis.Map = OriginalMap; Map.prototype.set = prototypeSet; map.set = set; }
    expect(changes).toBe(0); expect(gl.alive.size).toBe(count);
    expect(b.vertexArrays.get(0)!.attributes.size).toBe(0); expect(b.bufferStores.get(object)!.converted.size).toBe(0);
    expect(b.errors).toContain(0x505);
  }
});

it("rejects invalid vertex formats and native-limit indices before allocation or inverse registration", () => {
  for (const [words,error] of [ [[16,2,0x1406,0,0,0],0x501], [[0,5,0x1406,0,0,0],0x501],
      [[0,2,0x1404,0,0,0],0x500], [[0,2,0x1406,0,0,2],0x502], [[0,2,0x1406,0,0xffffffff,0],0x501] ] as const) {
    const {b,gl,submit} = pointerSetup(); const count = gl.alive.size;
    expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[...words]]])).toBe(0);
    expect(gl.attributes.size).toBe(0); expect(gl.alive.size).toBe(count); expect(b.errors).toEqual([error]);
    expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),new Uint8Array(4))).toBe(4);
  }
});

for (const type of [0x1401,0x1403]) it(`retains promoted-index restoration and cleanup without replaying the draw (type ${type})`, () => {
  const {b,gl,query} = setup(); query(ELEMENT,17); const object = b.buffers.get(17)!;
  const bytes = type === 0x1401 ? new Uint8Array([255,1,2]) : new Uint8Array(new Uint16Array([65535,1,2]).buffer);
  b.bufferStores.get(object)!.size = bytes.length; gl.contents.set(object,bytes.slice());
  let draws = 0, block = true, blockCleanup = true;
  Object.assign(gl,{drawElements(){draws++;}});
  const bind = gl.bindBuffer.bind(gl), destroy = gl.deleteBuffer.bind(gl);
  gl.bindBuffer = (target,value) => { if (draws && block && target===ELEMENT && value===object) {gl.errors.push(0x502);return;}bind(target,value); };
  gl.deleteBuffer = value => {if(blockCleanup && value!==object){gl.errors.push(0x505);return;}destroy(value);};
  const data = new Uint8Array(20), view = new DataView(data.buffer);
  view.setUint16(0,O.OP_DRAW_ELEMENTS,true);view.setUint16(2,16,true);
  [0,3,type,0].forEach((word,i)=>view.setUint32(4+i*4,word,true)); b.cmdbufView=data;
  expect(decodeAndDispatch(b,0,20)).toBe(-5); expect(draws).toBe(1);
  expect(b.vertexArrays.get(0)!.element).toBe(object); expect(gl.bindings.get(ELEMENT)).not.toBe(object);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect(gl.bindings.get(ELEMENT)).toBe(object); expect(draws).toBe(1);
  blockCleanup = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(draws).toBe(1); expect(gl.alive.size).toBe(1); expect(gl.contents.get(object)).toEqual(bytes);
});

it("recreates a converted cache view after pending cleanup completed on a query", () => {
  const {b,gl,submit,object} = pointerSetup();
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x140c,0,0,0]]])).toBe(0);
  const old = b.vertexArrays.get(0)!.attributes.get(0)!.view!, destroy = gl.deleteBuffer.bind(gl);
  let block = true;
  gl.deleteBuffer = value => {if(value===old && block){gl.errors.push(0x505);return;}destroy(value);};
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]]])).toBe(0);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  block = false; expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.alive.has(old)).toBe(false);
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x140c,0,0,0]]])).toBe(0);
  const fresh = b.vertexArrays.get(0)!.attributes.get(0)!.view!;
  expect(fresh).not.toBe(old); expect(gl.alive.has(fresh)).toBe(true);
  let enabled = false, draws = 0;
  Object.assign(gl,{enableVertexAttribArray(index: number){ if(index===0) enabled = true; },drawArrays(){draws++;}});
  expect(submit([[O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]],[O.OP_DRAW_ARRAYS,[0,0,1]]])).toBe(0);
  expect(enabled).toBe(true); expect(draws).toBe(1);
  expect([...new Float32Array(gl.contents.get(fresh)!.buffer)]).toEqual([1,0,0,1]);
  expect(b.bufferStores.get(object)!.converted.size).toBe(1);
});

it("shares converted cleanup with final buffer retirement and never repeats accepted deletion", () => {
  const {b,gl,submit,object,registry} = pointerSetup();
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x140c,0,0,0]]])).toBe(0);
  const converted = b.vertexArrays.get(0)!.attributes.get(0)!.view!, destroy = gl.deleteBuffer.bind(gl);
  const deleted: object[] = []; let block = true;
  gl.deleteBuffer = value => {if(value===converted && block){gl.errors.push(0x505);return;}deleted.push(value);destroy(value);};
  expect(submit([[O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]]])).toBe(0);
  // The source namespace is still alive. Teardown, unlike an admitted GL
  // command, must retain final cleanup while the converted child is pending.
  registry.destroyContext(1);
  expect(b.gl).toBeNull();
  expect(deleted.filter(value=>value===object)).toHaveLength(1);
  registry.bind({pid:2,cmdbufAddr:0,cmdbufLen:0});
  const next = registry.get(2)!; next.gl = gl as unknown as WebGL2RenderingContext; next.contextId = 2;
  block = false;
  const out = new Uint8Array(4);
  expect(runGlQuery(next,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect([...out]).toEqual([0,0,0,0]);
  expect(deleted.filter(value=>value===object)).toHaveLength(1);
  expect(deleted.filter(value=>value===converted)).toHaveLength(1);
  expect(gl.alive.size).toBe(0); expect(b.bufferStores.has(object)).toBe(false);
});

it("completes a rejected zero-binding capture restore on the next query", () => {
  const {b,gl,submit,query} = pointerSetup(); query(ARRAY,0);
  expect(submit([[O.OP_BEGIN_CLIENT_ARRAY,[]],[O.OP_BIND_BUFFER,[ARRAY,18]]])).toBe(0);
  const bind = gl.bindBuffer.bind(gl); let block = true;
  gl.bindBuffer = (target,value) => { if(block && target===ARRAY && value===null){gl.errors.push(0x502);return;}bind(target,value); };
  expect(submit([[O.OP_END_CLIENT_ARRAY,[]]])).toBe(-5);
  expect(b.savedClientArrayBuffer).toBeNull(); expect(b.shadow.arrayBuffer).not.toBeNull();
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  block = false; expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(b.savedClientArrayBuffer).toBeUndefined(); expect(b.shadow.arrayBuffer).toBeNull();
  expect(gl.bindings.get(ARRAY)).toBeNull(); expect(b.clientArrayRestore).toBeUndefined();
});

it("retires a pending capture without publishing it into another context", () => {
  const {registry,b,gl,submit,object} = pointerSetup(); b.contextId = 1;
  registry.bind({pid:1,sessionId:2,cmdbufAddr:0,cmdbufLen:0}); const peer = registry.get(1,2)!;
  peer.gl = b.gl; peer.contextId = 2; expect(registry.shareObjects(1,2,0)).toBe(true);
  expect(submit([[O.OP_BEGIN_CLIENT_ARRAY,[]],[O.OP_BIND_BUFFER,[ARRAY,18]]])).toBe(0);
  const bind = gl.bindBuffer.bind(gl);
  gl.bindBuffer = (target,value) => {if(target===ARRAY && value===object){gl.errors.push(0x502);return;}bind(target,value);};
  expect(submit([[O.OP_END_CLIENT_ARRAY,[]]])).toBe(-5);
  registry.destroyContext(1,0);
  expect(b.savedClientArrayBuffer).toBeUndefined(); expect(b.clientArrayRestore).toBeUndefined();
  expect(b.clientArrayEndRequested).toBe(false); expect(b.gl).toBeNull();
  const out = new Uint8Array(4);
  expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect([...out]).toEqual([0,0,0,0]); expect(peer.shadow.arrayBuffer).toBeNull();
  registry.destroyContext(1,2); expect(gl.alive.size).toBe(0);
});
