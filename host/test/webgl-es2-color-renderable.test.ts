import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * GLES 2.0.25 section 4.4.5: a color attachment must be color-renderable.
 * The host enables WebGL EXT_color_buffer_float for its own render targets,
 * so the native renderer reports RGBA32F/RGBA16F attachments complete. A
 * GLES 2 context advertises no float color-buffer extension, so dEQP-GLES2
 * functional.fbo.completeness.renderable.texture.color0.rgba_float and
 * rgba_half_float_oes require FRAMEBUFFER_INCOMPLETE_ATTACHMENT
 * (es2fFboCompletenessTests.cpp s_es2ExtFormats, glsFboUtil.cpp
 * attachment renderability). The fake renderer below always reports
 * COMPLETE, as WebGL 2 does once those extensions are on.
 *
 * Rows 7 and 8 of the dEQP cross-check: with GL_EXT_texture_rg, sized R8/RG8
 * are valid texture internal formats; with GL_EXT_texture_format_BGRA8888,
 * BGRA and BGRA8_EXT are required-renderable renderbuffer formats
 * (glsFboCompletenessTests.cpp s_extTextureRgRboFormats,
 * s_extTextureFormatBGRA8888Formats).
 */

const TEX = 0x0de1, FBO = 0x8d40, RBO = 0x8d41, COLOR0 = 0x8ce0;
const RGBA = 0x1908, RGB = 0x1907, L = 0x1909, RED = 0x1903, RG = 0x8227, DEPTH = 0x1902;
const UB = 0x1401, US = 0x1403, FLOAT = 0x1406, HALF_OES = 0x8d61;
const COMPLETE = 0x8cd5, INCOMPLETE_ATTACHMENT = 0x8cd6;
const INVALID_OPERATION = 0x502, INVALID_FRAMEBUFFER_OPERATION = 0x506;

type Call = [string, unknown[]];

function binding() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  const log: Call[] = [];
  let next = 1;
  const target: Record<string, unknown> = {
    getError: () => 0,
    isContextLost: () => false,
    getParameter: (pname: number) => pname === 0x8b4d ? 8 : pname === 0x0d33 || pname === 0x851c ? 4096 : null,
    getExtension: () => ({}),
    createTexture: () => ({ texture: next++ }),
    createFramebuffer: () => ({ framebuffer: next++ }),
    createRenderbuffer: () => ({ renderbuffer: next++ }),
    checkFramebufferStatus: () => COMPLETE,
    getRenderbufferParameter: (_target: number, pname: number) => pname === 0x8d44 ? 0x8058 : 8,
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
  const query = (op: number, words: number[], size = 4) => {
    const out = new Uint8Array(size + 8);
    const rc = runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    return { rc, view: new DataView(out.buffer) };
  };
  const storage = (words: number[]) => query(O.QOP_IMAGE_STORAGE, words).view.getUint32(0, true) === 0;
  const status = () => query(O.QOP_CHECK_FB_STATUS, [FBO]).view.getUint32(0, true);
  const attachTexture = (format: number, type: number, internal = format) => {
    send(O.OP_BIND_TEXTURE, [TEX, 5]);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, internal, 4, 4, 0, format, type, 0])).toBe(true);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D, [FBO, COLOR0, TEX, 5, 0]);
  };
  const attachRenderbuffer = (internal: number) => {
    send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(storage([O.OP_RENDERBUFFER_STORAGE, RBO, internal, 4, 4])).toBe(true);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, COLOR0, RBO, 7]);
  };
  return { b, log, send, query, storage, status, attachTexture, attachRenderbuffer };
}

const consumers = (log: Call[]) => log.filter(([name]) =>
  ["clear", "drawArrays", "readPixels", "copyTexImage2D", "copyTexSubImage2D"].includes(name));

describe("ES2 color-renderability of texture attachments (section 4.4.5)", () => {
  it.each([
    ["RGBA FLOAT", RGBA, FLOAT], ["RGB FLOAT", RGB, FLOAT],
    ["RGBA HALF_FLOAT_OES", RGBA, HALF_OES], ["RGB HALF_FLOAT_OES", RGB, HALF_OES],
    ["LUMINANCE bytes", L, UB], ["LUMINANCE FLOAT", L, FLOAT], ["DEPTH_COMPONENT", DEPTH, US],
  ])("%s is attachment-incomplete although WebGL 2 reports complete", (_name, format, type) => {
    const { b, log, send, query, status, attachTexture } = binding();
    attachTexture(format, type);
    expect(status()).toBe(INCOMPLETE_ATTACHMENT);
    send(O.OP_CLEAR, [0x4000]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    send(O.OP_COPY_TEX_SUB_IMAGE_2D, [TEX, 0, 0, 0, 0, 0, 1, 1]);
    expect(query(O.QOP_READ_PIXELS, [0, 0, 1, 1, RGBA, UB]).rc).toBe(-22);
    expect(b.errors).toEqual([INVALID_FRAMEBUFFER_OPERATION]);
    expect(consumers(log)).toEqual([]);
  });

  it.each([
    ["RGBA bytes (OES_rgb8_rgba8)", RGBA, UB], ["RGB 565", RGB, 0x8363], ["RGBA 4444", RGBA, 0x8033],
    ["RED bytes", RED, UB], ["RG FLOAT", RG, FLOAT], ["RED HALF_FLOAT_OES", RED, HALF_OES],
  ])("%s keeps the native completeness", (_name, format, type) => {
    const { b, log, send, status, attachTexture } = binding();
    attachTexture(format, type);
    expect(status()).toBe(COMPLETE);
    send(O.OP_CLEAR, [0x4000]);
    expect(b.errors).toEqual([]);
    expect(consumers(log)).toEqual([["clear", [0x4000]]]);
  });

  it("carries non-renderability to levels made by GenerateMipmap", () => {
    const { send, storage, status } = binding();
    send(O.OP_BIND_TEXTURE, [TEX, 5]);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, RGBA, 4, 4, 0, RGBA, FLOAT, 0])).toBe(true);
    send(O.OP_GENERATE_MIPMAP, [TEX]);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D, [FBO, COLOR0, TEX, 5, 1]);
    expect(status()).toBe(INCOMPLETE_ATTACHMENT);
  });

  it("follows a level respecified with a renderable format", () => {
    const { storage, status, attachTexture } = binding();
    attachTexture(RGBA, FLOAT);
    expect(status()).toBe(INCOMPLETE_ATTACHMENT);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, RGBA, 4, 4, 0, RGBA, UB, 0])).toBe(true);
    expect(status()).toBe(COMPLETE);
  });
});

describe("EXT_texture_rg sized texture formats", () => {
  it.each([["R8", 0x8229, RED], ["RG8", 0x822b, RG]])("accepts internal %s with its unsized format", (_name, internal, format) => {
    const { b, log, status, attachTexture } = binding();
    attachTexture(format, UB, internal);
    expect(b.errors).toEqual([]);
    const [, args] = log.find(([name]) => name === "texImage2D")!;
    expect([args[2], args[6], args[7]]).toEqual([internal, format, UB]);
    expect(status()).toBe(COMPLETE);
  });

  it.each([[0x8229, RG, UB], [0x8229, RED, FLOAT], [0x822b, RED, UB]])(
    "rejects internal %i with format %i type %i", (internal, format, type) => {
      const { b, storage } = binding();
      expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, internal, 4, 4, 0, format, type, 0])).toBe(false);
      expect(b.errors).toEqual([INVALID_OPERATION]);
    });
});

describe("EXT_texture_format_BGRA8888 renderbuffers", () => {
  it.each([["BGRA", 0x80e1], ["BGRA8_EXT", 0x93a1]])("stores %s as RGBA8 and reports it renderable", (_name, internal) => {
    const { b, log, query, status, attachRenderbuffer } = binding();
    attachRenderbuffer(internal);
    expect(b.errors).toEqual([]);
    expect(log.filter(([name]) => name === "renderbufferStorage")).toEqual([["renderbufferStorage", [RBO, 0x8058, 4, 4]]]);
    expect(status()).toBe(COMPLETE);
    // GetRenderbufferParameteriv reports the requested internal format.
    const reply = query(O.QOP_GET_RENDERBUFFER_PARAMETER, [RBO, 0x8d44]);
    expect(reply.view.getUint32(4, true)).toBe(internal);
  });

  it("keeps depth renderbuffers out of color attachment", () => {
    const { status, attachRenderbuffer } = binding();
    attachRenderbuffer(0x81a5);
    expect(status()).toBe(INCOMPLETE_ATTACHMENT);
  });
});
