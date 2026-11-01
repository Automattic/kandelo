import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import { getGlesExtensionString } from "../src/webgl/capabilities.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * GL_EXT_color_buffer_half_float (revision 10) on the WebGL 2 renderer:
 * - advertised only when WebGL EXT_color_buffer_float or
 *   EXT_color_buffer_half_float makes 16-bit float color buffers renderable;
 * - RenderbufferStorage accepts RGBA16F, RGB16F, RG16F and R16F;
 * - RGBA/RGBA/HALF_FLOAT_OES textures are renderable; other half-float
 *   images report what the renderer can do (issue 2), never a false COMPLETE;
 *   an RGB16F renderbuffer is emulated on RGBA16F (webgl-opaque-alpha.test.ts);
 * - GetFramebufferAttachmentParameteriv answers
 *   FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT with FLOAT or
 *   UNSIGNED_NORMALIZED_EXT;
 * - ClearColor and BlendColor are not clamped when specified (issues 5, 7, 8).
 */

const TEX = 0x0de1, FBO = 0x8d40, RBO = 0x8d41, COLOR0 = 0x8ce0;
const RGBA = 0x1908, RGB = 0x1907, UB = 0x1401, FLOAT = 0x1406, HALF_OES = 0x8d61;
const RGBA16F = 0x881a, RG16F = 0x822f, R16F = 0x822d, RGBA4 = 0x8056;
const COMPLETE = 0x8cd5, INCOMPLETE_ATTACHMENT = 0x8cd6;
const COMPONENT_TYPE = 0x8211, UNSIGNED_NORMALIZED = 0x8c17;
const INVALID_ENUM = 0x500;

type Call = [string, unknown[]];

function binding(webglExtensions: string[] = ["EXT_color_buffer_float"], nativeStatus = COMPLETE) {
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
    getExtension: (name: string) => webglExtensions.includes(name) ? {} : null,
    createTexture: () => ({ texture: next++ }),
    createFramebuffer: () => ({ framebuffer: next++ }),
    createRenderbuffer: () => ({ renderbuffer: next++ }),
    checkFramebufferStatus: () => nativeStatus,
    getRenderbufferParameter: (_target: number, pname: number) => pname === 0x8d44 ? RGBA16F : 16,
  };
  b.gl = new Proxy(target, {
    get(object, name: string) {
      if (name in object) return object[name];
      return (...args: unknown[]) => { log.push([name, args]); };
    },
  }) as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], floats = false) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true); view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => floats ? view.setFloat32(4 + i * 4, word, true) : view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  const query = (op: number, words: number[], size: number) => {
    const out = new Uint8Array(size + 8);
    runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    const view = new DataView(out.buffer);
    return { status: view.getUint32(0, true), words: Array.from({ length: size / 4 }, (_, i) => view.getUint32(4 + i * 4, true)) };
  };
  const storage = (words: number[]) => query(O.QOP_IMAGE_STORAGE, words, 4).status === 0;
  const status = () => query(O.QOP_CHECK_FB_STATUS, [FBO], 0).status;
  const checkStatus = () => {
    const out = new Uint8Array(4);
    runGlQuery(b, O.QOP_CHECK_FB_STATUS, new Uint8Array(new Uint32Array([FBO]).buffer), out);
    return new DataView(out.buffer).getUint32(0, true);
  };
  const attachTexture = (format: number, type: number) => {
    send(O.OP_BIND_TEXTURE, [TEX, 5]);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, format, 4, 4, 0, format, type, 0])).toBe(true);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D, [FBO, COLOR0, TEX, 5, 0]);
  };
  const attachRenderbuffer = (internal: number) => {
    send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    const accepted = storage([O.OP_RENDERBUFFER_STORAGE, RBO, internal, 4, 4]);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, COLOR0, RBO, 7]);
    return accepted;
  };
  void status;
  return { b, log, send, query, checkStatus, attachTexture, attachRenderbuffer };
}

describe("advertisement", () => {
  it.each([[["EXT_color_buffer_float"], true], [["EXT_color_buffer_half_float"], true], [[], false]])(
    "with WebGL %j the GLES extension is advertised: %s", (webgl, advertised) => {
      const names = getGlesExtensionString({ getExtension: name => (webgl as string[]).includes(name) ? {} : null }).split(" ");
      expect(names.includes("GL_EXT_color_buffer_half_float")).toBe(advertised);
      expect(names).not.toContain("GL_EXT_color_buffer_float");
    });
});

describe("half-float renderbuffers", () => {
  // RGB16F (stored as RGBA16F with an unwritten alpha): webgl-opaque-alpha.test.ts.
  it.each([["RGBA16F", RGBA16F, RGBA16F], ["RG16F", RG16F, RG16F], ["R16F", R16F, R16F]])(
    "accepts %s", (_name, internal, native) => {
      const { b, log, attachRenderbuffer } = binding();
      expect(attachRenderbuffer(internal)).toBe(true);
      expect(b.errors).toEqual([]);
      expect(log.find(([name]) => name === "renderbufferStorage")![1]).toEqual([RBO, native, 4, 4]);
    });

  it("rejects them when the renderer cannot render half-float color", () => {
    const { b, attachRenderbuffer } = binding([]);
    expect(attachRenderbuffer(RGBA16F)).toBe(false);
    expect(b.errors).toContain(INVALID_ENUM);
  });

  it("keeps RGBA16F complete", () => {
    const { checkStatus, attachRenderbuffer } = binding();
    attachRenderbuffer(RGBA16F);
    expect(checkStatus()).toBe(COMPLETE);
  });
});

describe("half-float texture renderability", () => {
  it("RGBA HALF_FLOAT_OES textures are renderable when advertised", () => {
    const { b, send, checkStatus, attachTexture } = binding();
    attachTexture(RGBA, HALF_OES);
    expect(checkStatus()).toBe(COMPLETE);
    send(O.OP_CLEAR, [0x4000]);
    expect(b.errors).toEqual([]);
  });

  it("RGBA HALF_FLOAT_OES textures stay incomplete without the extension", () => {
    const { checkStatus, attachTexture } = binding([]);
    attachTexture(RGBA, HALF_OES);
    expect(checkStatus()).toBe(INCOMPLETE_ATTACHMENT);
  });

  it("RGB HALF_FLOAT_OES textures report the renderer's own completeness", () => {
    expect((() => { const t = binding(["EXT_color_buffer_float"], INCOMPLETE_ATTACHMENT); t.attachTexture(RGB, HALF_OES); return t.checkStatus(); })())
      .toBe(INCOMPLETE_ATTACHMENT);
  });

  it("32-bit float textures remain non-renderable (issue 1)", () => {
    const { checkStatus, attachTexture } = binding();
    attachTexture(RGBA, FLOAT);
    expect(checkStatus()).toBe(INCOMPLETE_ATTACHMENT);
  });
});

describe("FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT", () => {
  const componentType = (t: ReturnType<typeof binding>) => t.query(O.QOP_GET_FB_ATTACHMENT, [FBO, COLOR0, COMPONENT_TYPE], 20);
  it.each([["RGBA16F renderbuffer", RGBA16F, FLOAT], ["RGBA4 renderbuffer", RGBA4, UNSIGNED_NORMALIZED]])(
    "%s", (_name, internal, expected) => {
      const t = binding(); t.attachRenderbuffer(internal);
      expect(componentType(t)).toEqual({ status: 0, words: [RBO, 7, 0, 0, expected] });
    });

  it.each([["RGBA HALF_FLOAT_OES", HALF_OES, FLOAT], ["RGBA UNSIGNED_BYTE", UB, UNSIGNED_NORMALIZED]])(
    "%s texture", (_name, type, expected) => {
      const t = binding(); t.attachTexture(RGBA, type);
      expect(componentType(t).words[4]).toBe(expected);
    });

  it("reports NONE without a component type for an empty attachment", () => {
    const t = binding(); t.send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    expect(componentType(t)).toEqual({ status: 0, words: [0, 0, 0, 0, 0] });
  });

  it("is INVALID_ENUM when the extension is not advertised", () => {
    const t = binding([]); t.attachRenderbuffer(RGBA4);
    expect(componentType(t).status).toBe(1);
    expect(t.b.errors).toContain(INVALID_ENUM);
  });
});

describe("unclamped clear and blend colors (issues 5, 7, 8)", () => {
  it.each([[["EXT_color_buffer_float"], [-1, 2, 0.5, 3]], [[], [0, 1, 0.5, 1]]])(
    "with WebGL %j", (webgl, expected) => {
      const { b, log, send } = binding(webgl as string[]);
      send(O.OP_CLEAR_COLOR, [-1, 2, 0.5, 3], true);
      send(O.OP_BLEND_COLOR, [-1, 2, 0.5, 3], true);
      expect(b.shadow.clearColor).toEqual(expected);
      expect(b.shadow.blendColor).toEqual(expected);
      expect(log.find(([name]) => name === "clearColor")![1]).toEqual(expected);
    });
});
