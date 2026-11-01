import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * GLES 2.0.25 sections 3.7.1, 3.7.2 and 4.4.3 admit only the ES2 base
 * formats plus the formats added by the extensions the host advertises.
 * WebGL 2 accepts the GLES 3 sized formats as well, so the host must apply
 * the ES2 table before any native image call.
 */

const INVALID_ENUM = 0x500, INVALID_VALUE = 0x501, INVALID_OPERATION = 0x502;
const TEXTURE_2D = 0x0de1, RENDERBUFFER = 0x8d41;
const RGBA = 0x1908, RGB = 0x1907, LUMINANCE = 0x1909, DEPTH_COMPONENT = 0x1902;
const UNSIGNED_BYTE = 0x1401, UNSIGNED_SHORT = 0x1403, UNSIGNED_INT = 0x1405, FLOAT = 0x1406;
const HALF_FLOAT = 0x140b, HALF_FLOAT_OES = 0x8d61;

type Call = [string, unknown[]];

function recordingGl(extensions: string[] = []) {
  const log: Call[] = [];
  let next = 1;
  const target: Record<string, unknown> = {
    getError: () => 0,
    isContextLost: () => false,
    getParameter: (pname: number) => pname === 0x8b4d ? 8 : pname === 0x0d33 || pname === 0x851c ? 4096 : 0,
    getExtension: (name: string) => extensions.includes(name) ? {} : null,
    createTexture: () => ({ texture: next++ }),
    createRenderbuffer: () => ({ renderbuffer: next++ }),
    createFramebuffer: () => ({ framebuffer: next++ }),
  };
  const gl = new Proxy(target, {
    get(object, name: string) {
      if (name in object) return object[name];
      return (...args: unknown[]) => { log.push([name, args]); };
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

function binding(extensions: string[] = []) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  const { gl, log } = recordingGl(extensions);
  b.gl = gl;
  return { b, log };
}

function storage(b: ReturnType<typeof binding>["b"], words: number[]): number {
  const out = new Uint8Array(12);
  expect(runGlQuery(b, O.QOP_IMAGE_STORAGE, new Uint8Array(new Uint32Array(words).buffer), out)).toBe(12);
  return new DataView(out.buffer).getUint32(0, true) === 0 ? 1 : 0;
}

const texImage = (internal: number, format: number, type: number) =>
  [O.OP_TEX_IMAGE_2D, TEXTURE_2D, 0, internal, 4, 4, 0, format, type, 0];
const texSubImage = (format: number, type: number) =>
  [O.OP_TEX_SUB_IMAGE_2D, TEXTURE_2D, 0, 0, 0, 1, 1, format, type, 0];
const rbStorage = (internal: number) => [O.OP_RENDERBUFFER_STORAGE, RENDERBUFFER, internal, 4, 4];

function nativeCalls(log: Call[], name: string) { return log.filter(([call]) => call === name); }

describe("ES2 TexImage2D admission (section 3.7.1)", () => {
  it.each([
    ["sized RGBA8", 0x8058, RGBA, UNSIGNED_BYTE, INVALID_VALUE],
    ["sized RGB10_A2", 0x8059, RGBA, UNSIGNED_BYTE, INVALID_VALUE],
    ["ES3 packed type", RGBA, RGBA, 0x8368, INVALID_ENUM],
    ["sized DEPTH_COMPONENT24", 0x81a6, DEPTH_COMPONENT, UNSIGNED_INT, INVALID_VALUE],
    ["internalformat zero", 0, RGBA, UNSIGNED_BYTE, INVALID_VALUE],
    ["unknown format", RGBA, 0, UNSIGNED_BYTE, INVALID_ENUM],
    ["unknown type", RGBA, RGBA, 0, INVALID_ENUM],
    ["ES3 HALF_FLOAT token", RGBA, RGBA, HALF_FLOAT, INVALID_ENUM],
    ["internalformat differs from format", RGB, RGBA, UNSIGNED_BYTE, INVALID_OPERATION],
    ["RGBA with UNSIGNED_SHORT", RGBA, RGBA, UNSIGNED_SHORT, INVALID_OPERATION],
    ["RGB with 4444", RGB, RGB, 0x8033, INVALID_OPERATION],
    ["depth with FLOAT", DEPTH_COMPONENT, DEPTH_COMPONENT, FLOAT, INVALID_OPERATION],
  ])("rejects %s before native storage", (_name, internal, format, type, error) => {
    const { b, log } = binding();
    expect(storage(b, texImage(internal, format, type))).toBe(0);
    expect(b.errors).toEqual([error]);
    expect(nativeCalls(log, "texImage2D")).toEqual([]);
  });

  it.each([
    ["RGBA bytes", RGBA, UNSIGNED_BYTE, RGBA, UNSIGNED_BYTE],
    ["RGB 565", RGB, 0x8363, RGB, 0x8363],
    ["luminance bytes", LUMINANCE, UNSIGNED_BYTE, LUMINANCE, UNSIGNED_BYTE],
    ["OES half float", RGBA, HALF_FLOAT_OES, 0x881a, HALF_FLOAT],
    ["OES float", RGB, FLOAT, 0x8815, FLOAT],
    ["EXT_texture_rg", 0x8227, UNSIGNED_BYTE, 0x822b, UNSIGNED_BYTE],
    ["OES_depth_texture", DEPTH_COMPONENT, UNSIGNED_SHORT, 0x81a5, UNSIGNED_SHORT],
    ["OES_packed_depth_stencil", 0x84f9, 0x84fa, 0x88f0, 0x84fa],
  ])("admits %s", (_name, format, type, nativeInternal, nativeType) => {
    const { b, log } = binding();
    expect(storage(b, texImage(format, format, type))).toBe(1);
    expect(b.errors).toEqual([]);
    const [[, args]] = nativeCalls(log, "texImage2D");
    expect([args[2], args[6], args[7]]).toEqual([nativeInternal, format, nativeType]);
  });

  it("applies the same table to queued OP_TEX_IMAGE_2D records", () => {
    const { b, log } = binding();
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, O.OP_TEX_IMAGE_2D, true); view.setUint16(2, 36, true);
    const words = texImage(0x8058, RGBA, UNSIGNED_BYTE).slice(1);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 40)).toBe(0);
    expect(b.errors).toEqual([INVALID_VALUE]);
    expect(nativeCalls(log, "texImage2D")).toEqual([]);
  });
});

describe("ES2 TexSubImage2D format/type admission (section 3.7.2)", () => {
  it.each([
    ["sized format token", 0x8058, UNSIGNED_BYTE, INVALID_ENUM],
    ["ES3 integer format", 0x8d99, UNSIGNED_BYTE, INVALID_ENUM],
    ["ES3 HALF_FLOAT token", RGBA, HALF_FLOAT, INVALID_ENUM],
    ["RGBA with UNSIGNED_INT", RGBA, UNSIGNED_INT, INVALID_OPERATION],
    ["565 with RGBA", RGBA, 0x8363, INVALID_OPERATION],
  ])("rejects %s before destination admission", (_name, format, type, error) => {
    const { b, log } = binding();
    expect(storage(b, texSubImage(format, type))).toBe(0);
    expect(b.errors).toEqual([error]);
    expect(nativeCalls(log, "texSubImage2D")).toEqual([]);
  });
});

describe("ES2 CopyTexImage2D internalformat admission (section 3.7.2)", () => {
  function copy(internal: number) {
    const { b, log } = binding();
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, O.OP_COPY_TEX_IMAGE_2D, true); view.setUint16(2, 32, true);
    [TEXTURE_2D, 0, internal, 0, 0, 4, 4, 0].forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 36)).toBe(0);
    return { b, calls: nativeCalls(log, "copyTexImage2D") };
  }
  it.each([0x8058, 0x8051, DEPTH_COMPONENT, 0x84f9, 0x80e1, 0])("rejects internalformat %i with INVALID_ENUM", internal => {
    const { b, calls } = copy(internal);
    expect(b.errors).toEqual([INVALID_ENUM]);
    expect(calls).toEqual([]);
  });
  it.each([RGBA, RGB, LUMINANCE, 0x1906, 0x190a, 0x1903, 0x8227])("admits base internalformat %i", internal => {
    const { b, calls } = copy(internal);
    expect(b.errors).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("ES2 RenderbufferStorage internalformat admission (section 4.4.3)", () => {
  it.each([
    ["DEPTH_COMPONENT24 (OES_depth24 not advertised)", 0x81a6],
    ["RGB10_A2", 0x8059],
    ["SRGB8_ALPHA8", 0x8c43],
    ["RGBA8UI", 0x8d7c],
    ["DEPTH32F_STENCIL8", 0x8cad],
    ["RGBA16F without a color-buffer extension", 0x881a],
    ["unsized RGBA", RGBA],
  ])("rejects %s with INVALID_ENUM", (_name, internal) => {
    const { b, log } = binding();
    expect(storage(b, rbStorage(internal))).toBe(0);
    expect(b.errors).toEqual([INVALID_ENUM]);
    expect(nativeCalls(log, "renderbufferStorage")).toEqual([]);
  });

  it.each([
    ["RGBA4", 0x8056], ["RGB5_A1", 0x8057], ["RGB565", 0x8d62],
    ["DEPTH_COMPONENT16", 0x81a5], ["STENCIL_INDEX8", 0x8d48],
    ["OES_rgb8_rgba8 RGBA8", 0x8058], ["OES_rgb8_rgba8 RGB8", 0x8051],
    ["OES_packed_depth_stencil", 0x88f0], ["EXT_texture_rg R8", 0x8229],
  ])("admits %s", (_name, internal) => {
    const { b, log } = binding();
    expect(storage(b, rbStorage(internal))).toBe(1);
    expect(b.errors).toEqual([]);
    expect(nativeCalls(log, "renderbufferStorage")).toEqual([[ "renderbufferStorage", [RENDERBUFFER, internal, 4, 4]]]);
  });

  it("admits half-float color buffers only when the host advertises them", () => {
    const { b, log } = binding(["EXT_color_buffer_half_float"]);
    expect(storage(b, rbStorage(0x881a))).toBe(1);
    expect(storage(b, rbStorage(0x8814))).toBe(0); // RGBA32F needs EXT_color_buffer_float
    expect(b.errors).toEqual([INVALID_ENUM]);
    expect(nativeCalls(log, "renderbufferStorage")).toHaveLength(1);
  });

  it("admits 32-bit float color buffers when EXT_color_buffer_float is advertised", () => {
    const { b } = binding(["EXT_color_buffer_float"]);
    expect(storage(b, rbStorage(0x8814))).toBe(1);
    expect(storage(b, rbStorage(0x881a))).toBe(1);
    expect(b.errors).toEqual([]);
  });
});
