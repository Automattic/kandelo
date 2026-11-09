import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * Guest-visible GLES 2.0.25 enum sets. The native renderer is WebGL 2, so
 * WebGL 2 and WEBGL-only names stay private to host internals: a GLES 2
 * guest must get INVALID_ENUM for them, without any native call or shadow
 * change.
 */

const INVALID_ENUM = 0x500;
type Call = [string, unknown[]];

function binding() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  const log: Call[] = [];
  const target: Record<string, unknown> = {
    getError: () => 0,
    isContextLost: () => false,
    getParameter: (pname: number) => { log.push(["getParameter", [pname]]); return 7; },
    getProgramParameter: (_program: unknown, pname: number) => { log.push(["getProgramParameter", [pname]]); return 1; },
    checkFramebufferStatus: (target: number) => { log.push(["checkFramebufferStatus", [target]]); return 0x8cd5; },
    createFramebuffer: () => ({ framebuffer: 1 }),
  };
  b.gl = new Proxy(target, {
    get(object, name: string) {
      if (name in object) return object[name];
      return (...args: unknown[]) => { log.push([name, args]); };
    },
  }) as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[]) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true); view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  const query = (op: number, words: number[]) => {
    const out = new Uint8Array(16).fill(0xaa);
    const rc = runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    return { rc, value: new DataView(out.buffer).getUint32(0, true) };
  };
  return { b, log, send, query };
}

describe("glPixelStorei (sections 3.6.1 and 4.3.1)", () => {
  it.each([
    ["PACK_ROW_LENGTH", 0x0d02], ["PACK_SKIP_ROWS", 0x0d03], ["PACK_SKIP_PIXELS", 0x0d04],
    ["UNPACK_IMAGE_HEIGHT", 0x806e], ["UNPACK_SKIP_IMAGES", 0x806d],
    // EXT_unpack_subimage state is kept by the guest encoder, never the host.
    ["UNPACK_ROW_LENGTH", 0x0cf2], ["UNPACK_SKIP_ROWS", 0x0cf3], ["UNPACK_SKIP_PIXELS", 0x0cf4],
    ["UNPACK_FLIP_Y_WEBGL", 0x9240], ["zero", 0],
  ])("rejects %s with INVALID_ENUM and keeps the host default", (_name, pname) => {
    const { b, log, send } = binding();
    const before = new Map(b.shadow.pixelStore);
    send(O.OP_PIXEL_STOREI, [pname, 3]);
    expect(b.errors).toEqual([INVALID_ENUM]);
    expect(log).toEqual([]);
    expect(b.shadow.pixelStore).toEqual(before);
  });

  it("applies the two GLES 2 alignment names", () => {
    const { b, log, send } = binding();
    send(O.OP_PIXEL_STOREI, [0x0cf5, 2]);
    send(O.OP_PIXEL_STOREI, [0x0d05, 8]);
    expect(b.errors).toEqual([]);
    expect(log).toEqual([["pixelStorei", [0x0cf5, 2]], ["pixelStorei", [0x0d05, 8]]]);
    expect([b.shadow.unpackAlignment, b.shadow.packAlignment]).toEqual([2, 8]);
  });
});

describe("glGet* pnames (section 6.1, tables 6.2-6.21)", () => {
  it.each([
    ["MAX_3D_TEXTURE_SIZE", 0x8073], ["MAX_ARRAY_TEXTURE_LAYERS", 0x88ff], ["MAX_SAMPLES", 0x8d57],
    ["MAX_DRAW_BUFFERS", 0x8824], ["DRAW_BUFFER0", 0x8825], ["MAX_COLOR_ATTACHMENTS", 0x8cdf],
    ["READ_FRAMEBUFFER_BINDING", 0x8caa], ["READ_BUFFER", 0x0c02], ["VERTEX_ARRAY_BINDING", 0x85b5],
    ["PIXEL_UNPACK_BUFFER_BINDING", 0x88ef], ["TRANSFORM_FEEDBACK_BINDING", 0x8e25],
    ["UNPACK_FLIP_Y_WEBGL", 0x9240], ["UNPACK_COLORSPACE_CONVERSION_WEBGL", 0x9243],
    ["MAX_CLIENT_WAIT_TIMEOUT_WEBGL", 0x9247], ["PACK_ROW_LENGTH", 0x0d02],
    ["UNPACK_IMAGE_HEIGHT", 0x806e], ["RASTERIZER_DISCARD", 0x8c89],
  ])("rejects %s with INVALID_ENUM and no native query", (_name, pname) => {
    for (const op of [O.QOP_GET_INTEGERV, O.QOP_GET_FLOATV]) {
      const { b, log, query } = binding();
      expect(query(op, [pname]).rc).toBe(-22);
      expect(b.errors).toEqual([INVALID_ENUM]);
      expect(log).toEqual([]);
    }
  });

  it.each([
    ["MAX_TEXTURE_SIZE", 0x0d33], ["MAX_VERTEX_ATTRIBS", 0x8869], ["ALPHA_BITS", 0x0d55],
    ["IMPLEMENTATION_COLOR_READ_FORMAT", 0x8b9b], ["OES_standard_derivatives hint", 0x8b8b],
  ])("answers %s", (_name, pname) => {
    const { b, query } = binding();
    expect(query(O.QOP_GET_INTEGERV, [pname]).rc).toBe(4);
    expect(b.errors).toEqual([]);
  });
});

describe("implementation read type (OES_texture_half_float tokens)", () => {
  it("reports WebGL 2's HALF_FLOAT read type as GLES 2's HALF_FLOAT_OES", () => {
    const { b, query } = binding();
    const gl = b.gl as unknown as { getParameter: (pname: number) => unknown };
    gl.getParameter = (pname: number) => pname === 0x8b9a ? 0x140b : 0;
    expect(query(O.QOP_GET_INTEGERV, [0x8b9a])).toEqual({ rc: 4, value: 0x8d61 });
    expect(b.errors).toEqual([]);
  });
});

describe("glGetProgramiv pnames (section 6.1.8)", () => {
  it.each([
    ["TRANSFORM_FEEDBACK_BUFFER_MODE", 0x8c7f], ["TRANSFORM_FEEDBACK_VARYINGS", 0x8c83],
    ["ACTIVE_UNIFORM_BLOCKS", 0x8a36], ["PROGRAM_BINARY_RETRIEVABLE_HINT", 0x8257],
  ])("rejects %s with INVALID_ENUM", (_name, pname) => {
    const { b, log, query } = binding();
    b.programs.set(5, {} as WebGLProgram);
    expect(query(O.QOP_GET_PROGRAMIV, [5, pname]).rc).toBe(-22);
    expect(b.errors).toEqual([INVALID_ENUM]);
    expect(log).toEqual([]);
  });

  it("answers LINK_STATUS", () => {
    const { b, query } = binding();
    b.programs.set(5, {} as WebGLProgram);
    expect(query(O.QOP_GET_PROGRAMIV, [5, 0x8b82])).toEqual({ rc: 4, value: 1 });
    expect(b.errors).toEqual([]);
  });
});

describe("framebuffer targets (section 4.4.1)", () => {
  it.each([["READ_FRAMEBUFFER", 0x8ca8], ["DRAW_FRAMEBUFFER", 0x8ca9], ["zero", 0]])(
    "rejects %s for BindFramebuffer and attachments", (_name, target) => {
      const { b, log, send } = binding();
      send(O.OP_BIND_FRAMEBUFFER, [target, 4]);
      send(O.OP_FRAMEBUFFER_TEXTURE_2D, [target, 0x8ce0, 0x0de1, 0, 0]);
      send(O.OP_FRAMEBUFFER_RENDERBUFFER, [target, 0x8ce0, 0x8d41, 0]);
      expect(b.errors).toEqual([INVALID_ENUM]);
      expect(log.filter(([name]) => name.startsWith("bindFramebuffer") || name.startsWith("framebuffer"))).toEqual([]);
      expect(b.fbos.has(4)).toBe(false);
    });

  it.each([["READ_FRAMEBUFFER", 0x8ca8], ["DRAW_FRAMEBUFFER", 0x8ca9]])(
    "rejects %s for CheckFramebufferStatus with status zero", (_name, target) => {
      const { b, log, query } = binding();
      expect(query(O.QOP_CHECK_FB_STATUS, [target])).toEqual({ rc: 4, value: 0 });
      expect(b.errors).toEqual([INVALID_ENUM]);
      expect(log).toEqual([]);
    });

  it("binds GL_FRAMEBUFFER", () => {
    const { b, log, send } = binding();
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 4]);
    expect(b.errors).toEqual([]);
    expect(log.filter(([name]) => name === "bindFramebuffer")).toHaveLength(1);
  });
});
