import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

const FRONT = 0x0404, BACK = 0x0405, FRONT_AND_BACK = 0x0408;
const CULL_FACE = 0x0b44, STENCIL_TEST = 0x0b90, RASTERIZER_DISCARD = 0x8c89;
const ELEMENT = 0x8893, COPY_READ = 0x8f36, COPY_WRITE = 0x8f37;
type Face = { func: number; ref: number; mask: number; write: number };
type Draw = { mode: number; indices: number[]; front: Face; back: Face; cull: number | null; discard: boolean };

/** WebGL 1.0 section 6.11 (inherited by WebGL 2): a draw whose front and back
 * stencil ref, value mask or write mask differ is INVALID_OPERATION. */
class StencilGl {
  errors: number[] = [];
  stencilBits = 8;
  front: Face = { func: 0x0207, ref: 0, mask: 0xffffffff, write: 0xffffffff };
  back: Face = { func: 0x0207, ref: 0, mask: 0xffffffff, write: 0xffffffff };
  enabled = new Set<number>();
  cullMode = BACK;
  bound = new Map<number, object | null>();
  data = new Map<object, Uint8Array>();
  draws: Draw[] = [];
  failDiscardDraw = false;
  private next = 1;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x0d57) return this.stencilBits;
    if (pname === 0x8895) return this.bound.get(ELEMENT) ?? null;
    if (pname === COPY_READ || pname === COPY_WRITE) return this.bound.get(pname) ?? null;
    return null;
  }
  checkFramebufferStatus() { return 0x8cd5; }
  isContextLost() { return false; }
  enable(cap: number) { this.enabled.add(cap); }
  disable(cap: number) { this.enabled.delete(cap); }
  cullFace(mode: number) { this.cullMode = mode; }
  private faces(face: number): Face[] {
    return face === FRONT ? [this.front] : face === BACK ? [this.back] : [this.front, this.back];
  }
  stencilFunc(func: number, ref: number, mask: number) { this.stencilFuncSeparate(FRONT_AND_BACK, func, ref, mask); }
  stencilFuncSeparate(face: number, func: number, ref: number, mask: number) {
    for (const f of this.faces(face)) Object.assign(f, { func, ref, mask: mask >>> 0 });
  }
  stencilMask(mask: number) { this.stencilMaskSeparate(FRONT_AND_BACK, mask); }
  stencilMaskSeparate(face: number, mask: number) { for (const f of this.faces(face)) f.write = mask >>> 0; }
  createBuffer() { return { buffer: this.next++ }; }
  bindBuffer(target: number, buffer: object | null) { this.bound.set(target, buffer); }
  bufferData(target: number, source: number | ArrayBufferView, _usage: number) {
    const bytes = typeof source === "number" ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
    this.data.set(this.bound.get(target)!, bytes);
  }
  bufferSubData(target: number, offset: number, source: ArrayBufferView) {
    this.data.get(this.bound.get(target)!)!.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), offset);
  }
  getBufferSubData(target: number, offset: number, out: ArrayBufferView) {
    const bytes = this.data.get(this.bound.get(target)!)!;
    new Uint8Array(out.buffer, out.byteOffset, out.byteLength).set(bytes.subarray(offset, offset + out.byteLength));
  }
  private record(mode: number, indices: number[]) {
    const discard = this.enabled.has(RASTERIZER_DISCARD);
    if (this.front.ref !== this.back.ref || this.front.mask !== this.back.mask || this.front.write !== this.back.write ||
        (discard && this.failDiscardDraw)) {
      this.errors.push(0x502); return;
    }
    this.draws.push({ mode, indices, front: { ...this.front }, back: { ...this.back },
      cull: this.enabled.has(CULL_FACE) ? this.cullMode : null, discard });
  }
  drawArrays(mode: number, first: number, count: number) {
    this.record(mode, Array.from({ length: count }, (_, i) => first + i));
  }
  drawElements(mode: number, count: number, type: number, offset: number) {
    const bytes = this.data.get(this.bound.get(ELEMENT)!)!;
    const width = type === 0x1405 ? 4 : type === 0x1403 ? 2 : 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.record(mode, Array.from({ length: count }, (_, i) =>
      width === 4 ? view.getUint32(offset + i * 4, true) : width === 2 ? view.getUint16(offset + i * 2, true) : view.getUint8(offset + i)));
  }
}

function setup() {
  const gl = new StencilGl();
  const proxy = new Proxy(gl, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value ?? (() => {});
  } });
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(4096);
  b.gl = proxy as unknown as WebGL2RenderingContext;
  const raw = (op: number, payload: Uint8Array) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, payload.length, true);
    b.cmdbufView!.set(payload, 4);
    expect(decodeAndDispatch(b, 0, 4 + payload.length)).toBe(0);
  };
  const send = (op: number, words: number[]) => {
    const payload = new Uint8Array(words.length * 4);
    words.forEach((word, i) => new DataView(payload.buffer).setUint32(i * 4, word >>> 0, true));
    raw(op, payload);
  };
  const error = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  return { b, gl, send, raw, error };
}

/** Stencil test on, front ref 1 / write 0x0f, back ref 2 / write 0xf0. */
function twoSided() {
  const t = setup();
  t.send(O.OP_ENABLE, [STENCIL_TEST]);
  t.send(O.OP_STENCIL_FUNC_SEPARATE, [FRONT, 0x0202, 1, 0xff]);
  t.send(O.OP_STENCIL_FUNC_SEPARATE, [BACK, 0x0205, 2, 0xff]);
  t.send(O.OP_STENCIL_MASK_SEPARATE, [FRONT, 0x0f]);
  t.send(O.OP_STENCIL_MASK_SEPARATE, [BACK, 0xf0]);
  expect(t.error()).toBe(0);
  return t;
}

const frontState: Face = { func: 0x0202, ref: 1, mask: 0xff, write: 0x0f };
const backState: Face = { func: 0x0205, ref: 2, mask: 0xff, write: 0xf0 };

function expectRestored(gl: StencilGl, cullEnabled = false) {
  expect(gl.front).toEqual(frontState);
  expect(gl.back).toEqual(backState);
  expect(gl.enabled.has(CULL_FACE)).toBe(cullEnabled);
  expect(gl.enabled.has(RASTERIZER_DISCARD)).toBe(false);
  expect(gl.cullMode).toBe(BACK);
}

/** Sub-draws after the discard validation pass: face, indices. */
function passes(gl: StencilGl) {
  const [validation, ...rest] = gl.draws;
  expect(validation.discard).toBe(true);
  return rest.map(draw => {
    expect(draw.discard).toBe(false);
    const face = draw.cull === BACK ? "front" : draw.cull === FRONT ? "back" : "none";
    // The drawn face's own state is exact; the culled face only mirrors its
    // ref/value mask/write mask to satisfy WebGL.
    if (face === "front") { expect(draw.front).toEqual(frontState); expect(draw.back.ref).toBe(1); }
    if (face === "back") { expect(draw.back).toEqual(backState); expect(draw.front.ref).toBe(2); }
    return [face, draw.mode, draw.indices];
  });
}

describe("separate front/back stencil state (ES 2.0 section 4.1.4)", () => {
  it("splits TRIANGLES into alternating face passes that keep primitive order", () => {
    const { gl, send, error } = twoSided();
    send(O.OP_DRAW_ARRAYS, [4, 10, 9]);
    expect(error()).toBe(0);
    // Each triangle is offered to its two passes back to back, so whichever
    // pass rasterizes it does so before any later triangle.
    expect(passes(gl)).toEqual([
      ["front", 4, [10, 11, 12]],
      ["back", 4, [10, 11, 12, 13, 14, 15]],
      ["front", 4, [13, 14, 15, 16, 17, 18]],
      ["back", 4, [16, 17, 18]],
    ]);
    expect(gl.draws[0].indices).toEqual(Array.from({ length: 9 }, (_, i) => 10 + i));
    expectRestored(gl);
  });

  it("keeps triangle-strip parity, using a degenerate lead-in for odd starts", () => {
    const { gl, send, error } = twoSided();
    send(O.OP_DRAW_ARRAYS, [5, 0, 6]);
    expect(error()).toBe(0);
    expect(passes(gl)).toEqual([
      ["front", 5, [0, 1, 2]],
      ["back", 5, [0, 1, 2, 3]],
      ["front", 5, [1, 1, 2, 3, 4]],
      ["back", 5, [2, 3, 4, 5]],
      ["front", 5, [3, 3, 4, 5]],
    ]);
    expectRestored(gl);
  });

  it("keeps the fan centre for every triangle-fan pass", () => {
    const { gl, send, error } = twoSided();
    send(O.OP_DRAW_ARRAYS, [6, 2, 5]);
    expect(error()).toBe(0);
    expect(passes(gl)).toEqual([
      ["front", 6, [2, 3, 4]],
      ["back", 6, [2, 3, 4, 5]],
      ["front", 6, [2, 4, 5, 6]],
      ["back", 6, [2, 5, 6]],
    ]);
    expectRestored(gl);
  });

  it("splits indexed draws using the guest's indices", () => {
    const { gl, send, raw, error } = twoSided();
    send(O.OP_BIND_BUFFER, [ELEMENT, 5]);
    const indices = new Uint16Array([7, 3, 9, 4, 8, 1]);
    const payload = new Uint8Array(12 + indices.byteLength);
    const view = new DataView(payload.buffer);
    view.setUint32(0, ELEMENT, true);
    view.setUint32(4, indices.byteLength, true);
    payload.set(new Uint8Array(indices.buffer), 8);
    view.setUint32(8 + indices.byteLength, 0x88e4, true);
    raw(O.OP_BUFFER_DATA, payload);
    send(O.OP_DRAW_ELEMENTS, [4, 6, 0x1403, 0]);
    expect(error()).toBe(0);
    expect(passes(gl)).toEqual([
      ["front", 4, [7, 3, 9]],
      ["back", 4, [7, 3, 9, 4, 8, 1]],
      ["front", 4, [4, 8, 1]],
    ]);
    expectRestored(gl);
  });

  it("points and lines are front-facing: one draw with the front state", () => {
    for (const mode of [0, 1, 2, 3]) {
      const { gl, send, error } = twoSided();
      send(O.OP_DRAW_ARRAYS, [mode, 0, 4]);
      expect(error()).toBe(0);
      expect(gl.draws).toHaveLength(1);
      expect(gl.draws[0].front).toEqual(frontState);
      expect(gl.draws[0].back).toEqual({ ...backState, ref: 1, mask: 0xff, write: 0x0f });
      expectRestored(gl);
    }
  });

  it("user culling selects the only rasterized face without splitting", () => {
    const { gl, send, error } = twoSided();
    send(O.OP_ENABLE, [CULL_FACE]);
    send(O.OP_CULL_FACE, [FRONT]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 6]);
    expect(error()).toBe(0);
    expect(gl.draws).toHaveLength(1);
    expect(gl.draws[0].back).toEqual(backState);
    expect(gl.draws[0].cull).toBe(FRONT);
    send(O.OP_CULL_FACE, [BACK]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 6]);
    expect(gl.draws[1].front).toEqual(frontState);
    expect(gl.draws[1].cull).toBe(BACK);
    expectRestored(gl, true);
  });

  it("a disabled stencil test or equal effective state needs no split", () => {
    const { gl, send, error } = twoSided();
    send(O.OP_DISABLE, [STENCIL_TEST]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 6]);
    expect(gl.draws).toHaveLength(1);
    // With 8 stencil bits, refs clamp to 255 and only the low 8 mask bits
    // count, so these differing values select identical stencil behaviour.
    send(O.OP_ENABLE, [STENCIL_TEST]);
    send(O.OP_STENCIL_FUNC_SEPARATE, [FRONT, 0x0202, 0x1ff, 0xffffffff]);
    send(O.OP_STENCIL_FUNC_SEPARATE, [BACK, 0x0205, 0x3ff, 0xff]);
    send(O.OP_STENCIL_MASK_SEPARATE, [FRONT_AND_BACK, 0x0f]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 6]);
    expect(gl.draws).toHaveLength(2);
    expect(gl.draws[1].back.func).toBe(0x0205);
    expect(error()).toBe(0);
  });

  it("a draw rejected by validation has no rendering side effects", () => {
    const { gl, send, error } = twoSided();
    gl.failDiscardDraw = true;
    send(O.OP_DRAW_ARRAYS, [4, 0, 6]);
    expect(error()).toBe(0x502);
    expect(gl.draws).toEqual([]);
    expectRestored(gl);
  });
});
