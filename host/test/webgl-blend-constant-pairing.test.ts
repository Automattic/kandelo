import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

const CONSTANT_COLOR = 0x8001, ONE_MINUS_CONSTANT_COLOR = 0x8002;
const CONSTANT_ALPHA = 0x8003, ONE_MINUS_CONSTANT_ALPHA = 0x8004;
const color = (f: number) => f === CONSTANT_COLOR || f === ONE_MINUS_CONSTANT_COLOR;
const alpha = (f: number) => f === CONSTANT_ALPHA || f === ONE_MINUS_CONSTANT_ALPHA;

/** WebGL 1.0 section 6.13 (inherited by WebGL 2): constant color and constant
 * alpha cannot be the source and destination RGB factors together. ES 2.0
 * table 4.1 allows every pair. */
class BlendGl {
  errors: number[] = [];
  calls: number[][] = [];
  getError() { return this.errors.shift() ?? 0; }
  getParameter() { return null; }
  blendFunc(s: number, d: number) { this.blendFuncSeparate(s, d, s, d); }
  blendFuncSeparate(srcRGB: number, dstRGB: number, srcA: number, dstA: number) {
    if ((color(srcRGB) && alpha(dstRGB)) || (alpha(srcRGB) && color(dstRGB))) { this.errors.push(0x502); return; }
    this.calls.push([srcRGB, dstRGB, srcA, dstA]);
  }
}

function setup() {
  const gl = new BlendGl();
  const proxy = new Proxy(gl, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value ?? (() => {});
  } });
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(4096);
  b.gl = proxy as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[]) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  const error = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  return { b, gl, proxy, send, error };
}

describe("constant color / constant alpha blend pairing (WebGL boundary)", () => {
  it.each([
    [O.OP_BLEND_FUNC, [CONSTANT_COLOR, CONSTANT_ALPHA]],
    [O.OP_BLEND_FUNC, [ONE_MINUS_CONSTANT_ALPHA, ONE_MINUS_CONSTANT_COLOR]],
    [O.OP_BLEND_FUNC_SEPARATE, [CONSTANT_ALPHA, CONSTANT_COLOR, 1, 0]],
    [O.OP_BLEND_FUNC_SEPARATE, [ONE_MINUS_CONSTANT_COLOR, ONE_MINUS_CONSTANT_ALPHA, 1, 0]],
  ])("op %i %j is a truthful INVALID_OPERATION with no state change", (op, words) => {
    const { b, gl, proxy, send, error } = setup();
    send(O.OP_BLEND_FUNC_SEPARATE, [0x0302, 0x0303, 1, 0x0303]);
    const before = structuredClone(b.shadow.blendFunc);
    send(op, words);
    expect(error()).toBe(0x502);
    expect(b.shadow.blendFunc).toEqual(before);
    // The rejected pair never reaches owner replay.
    gl.calls.length = 0;
    new GlMuxer(proxy as unknown as WebGL2RenderingContext).switchTo(b);
    expect(gl.calls).toEqual([[0x0302, 0x0303, 1, 0x0303]]);
  });

  it("the alpha factors are not restricted, so that pairing is accepted", () => {
    const { b, send, error } = setup();
    send(O.OP_BLEND_FUNC_SEPARATE, [1, 0, CONSTANT_COLOR, CONSTANT_ALPHA]);
    expect(error()).toBe(0);
    expect(b.shadow.blendFunc).toEqual({ srcRGB: 1, dstRGB: 0, srcA: CONSTANT_COLOR, dstA: CONSTANT_ALPHA });
  });
});
