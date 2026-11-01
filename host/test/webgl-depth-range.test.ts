import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/** WebGL 2 stand-in that enforces the WebGL rule ES 2.0 does not have:
 * depthRange(zNear, zFar) with zNear > zFar is INVALID_OPERATION
 * (WebGL 1.0 section 6.12, inherited by WebGL 2). */
class DepthGl {
  errors: number[] = [];
  native: [number, number] = [0, 1];
  rejectAll = false;
  log: Array<[string, unknown[]]> = [];
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x0b70) return new Float32Array(this.native);
    return 0;
  }
  depthRange(n: number, f: number) {
    this.log.push(["depthRange", [n, f]]);
    if (this.rejectAll || n > f) { this.errors.push(0x502); return; }
    this.native = [n, f];
  }
}

function binding(gl = new DepthGl()) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  b.gl = gl as unknown as WebGL2RenderingContext;
  return { b, gl };
}

function depthRange(b: ReturnType<typeof binding>["b"], n: number, f: number): void {
  const v = new DataView(b.cmdbufView!.buffer);
  v.setUint16(0, O.OP_DEPTH_RANGEF, true);
  v.setUint16(2, 8, true);
  v.setFloat32(4, n, true);
  v.setFloat32(8, f, true);
  expect(decodeAndDispatch(b, 0, 12)).toBe(0);
}

function glError(b: ReturnType<typeof binding>["b"]): number {
  const reply = new Uint8Array(4);
  expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), reply)).toBe(4);
  return new DataView(reply.buffer).getUint32(0, true);
}

describe("glDepthRangef state ownership", () => {
  it("a natively rejected depthRange leaves the logical shadow unchanged (ES 2.0 section 2.5)", () => {
    const { b, gl } = binding();
    gl.rejectAll = true;
    depthRange(b, 0.25, 0.75);
    expect(glError(b)).toBe(0x502);
    expect(b.shadow.depthRange).toEqual([0, 1]);
  });
});
