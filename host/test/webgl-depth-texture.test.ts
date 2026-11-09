import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { textureLevel } from "../src/webgl/texture-levels.js";

/**
 * OES_depth_texture (revision of January 29, 2012) and OES_packed_depth_stencil
 * API rules, which WebGL 2 (ES 3.0) does not apply:
 * - depth and depth-stencil textures exist only for TEXTURE_2D; any other
 *   target is INVALID_OPERATION (section 3.8 additions; issue 4);
 * - "CopyTexImage2D and CopyTexSubImage2D are not supported";
 * - GenerateMipmap on a depth texture is INVALID_OPERATION (issue 1, b);
 * - DEPTH_COMPONENT pairs only with UNSIGNED_SHORT/UNSIGNED_INT, and those
 *   types only with DEPTH_COMPONENT (Errors);
 * - depth-renderable: DEPTH_COMPONENT textures, DEPTH_COMPONENT16 and
 *   DEPTH24_STENCIL8_OES; stencil-renderable: STENCIL_INDEX8 and
 *   DEPTH24_STENCIL8_OES (and DEPTH_STENCIL_OES textures, dEQP-GLES2
 *   glsFboCompletenessTests.cpp s_oesPackedDepthStencilTexFormats).
 * The type only selects the bits of the supplied data (issue 3), so 16-bit
 * data may update a level specified with 32-bit data.
 */

const TEX = 0x0de1, CUBE_X = 0x8515, FBO = 0x8d40, RBO = 0x8d41;
const COLOR0 = 0x8ce0, DEPTH_ATT = 0x8d00, STENCIL_ATT = 0x8d20;
const RGBA = 0x1908, DEPTH = 0x1902, DEPTH_STENCIL = 0x84f9;
const UB = 0x1401, US = 0x1403, UI = 0x1405, FLOAT = 0x1406, UI_24_8 = 0x84fa;
const COMPLETE = 0x8cd5, INCOMPLETE_ATTACHMENT = 0x8cd6;
const INVALID_OPERATION = 0x502;

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
    // WebGL 2 with the host's native extensions: every attachment passes.
    checkFramebufferStatus: () => COMPLETE,
  };
  b.gl = new Proxy(target, {
    get(object, name: string) {
      if (name in object) return object[name];
      return (...args: unknown[]) => { log.push([name, args]); };
    },
  }) as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], bytes = new Uint8Array()) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true); view.setUint16(2, words.length * 4 + bytes.length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4 + bytes.length)).toBe(0);
  };
  const query = (op: number, words: number[]) => {
    const out = new Uint8Array(12);
    runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    return new DataView(out.buffer).getUint32(0, true);
  };
  const storage = (words: number[]) => query(O.QOP_IMAGE_STORAGE, words) === 0;
  const status = () => query(O.QOP_CHECK_FB_STATUS, [FBO]);
  const texture = (target: number, format: number, type: number, name = 5) => {
    send(O.OP_BIND_TEXTURE, [target === TEX ? TEX : 0x8513, name]);
    return storage([O.OP_TEX_IMAGE_2D, target, 0, format, 4, 4, 0, format, type, 0]);
  };
  const attachTexture = (point: number, format: number, type: number) => {
    expect(texture(TEX, format, type)).toBe(true);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D, [FBO, point, TEX, 5, 0]);
  };
  const attachRenderbuffer = (point: number, internal: number) => {
    send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(storage([O.OP_RENDERBUFFER_STORAGE, RBO, internal, 4, 4])).toBe(true);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, point, RBO, 7]);
  };
  const calls = (name: string) => log.filter(([call]) => call === name);
  return { b, log, send, storage, status, texture, attachTexture, attachRenderbuffer, calls };
}

describe("OES_depth_texture targets", () => {
  it.each([["DEPTH_COMPONENT", DEPTH, US], ["DEPTH_STENCIL_OES", DEPTH_STENCIL, UI_24_8]])(
    "rejects %s on a cube face with INVALID_OPERATION", (_name, format, type) => {
      const { b, texture, calls } = binding();
      expect(texture(CUBE_X, format, type)).toBe(false);
      expect(b.errors).toEqual([INVALID_OPERATION]);
      expect(calls("texImage2D")).toEqual([]);
    });

  it("rejects a depth subimage on a cube face", () => {
    const { b, storage, calls } = binding();
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, CUBE_X, 0, 0, 0, 1, 1, DEPTH, UI, 0])).toBe(false);
    expect(b.errors).toEqual([INVALID_OPERATION]);
    expect(calls("texSubImage2D")).toEqual([]);
  });

  it("records each level's depth and stencil components", () => {
    const { b, texture } = binding();
    expect(texture(TEX, DEPTH_STENCIL, UI_24_8)).toBe(true);
    const gles = textureLevel(b.textures.get(5)!, TEX, 0)!.gles!;
    expect([gles.depth, gles.stencil]).toEqual([true, true]);
    expect(texture(TEX, RGBA, UB)).toBe(true);
    expect(textureLevel(b.textures.get(5)!, TEX, 0)!.gles!.depth).toBe(false);
  });
});

describe("OES_depth_texture format/type pairing and subimages", () => {
  it.each([[DEPTH, FLOAT], [DEPTH, UB], [RGBA, US], [RGBA, UI]])("rejects format %i with type %i", (format, type) => {
    const { b, texture, calls } = binding();
    expect(texture(TEX, format, type)).toBe(false);
    expect(b.errors).toEqual([INVALID_OPERATION]);
    expect(calls("texImage2D")).toEqual([]);
  });

  it.each([["color data into a depth level", DEPTH, US, RGBA, UB], ["depth data into a color level", RGBA, UB, DEPTH, US]])(
    "rejects %s", (_name, levelFormat, levelType, format, type) => {
      const { b, texture, storage, calls } = binding();
      expect(texture(TEX, levelFormat, levelType)).toBe(true);
      expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 0, 0, 0, 1, 1, format, type, 0])).toBe(false);
      expect(b.errors).toEqual([INVALID_OPERATION]);
      expect(calls("texSubImage2D")).toEqual([]);
    });

  it("converts 16-bit depth data for a level specified with 32-bit depth", () => {
    const { b, send, texture, calls } = binding();
    expect(texture(TEX, DEPTH, UI)).toBe(true);
    send(O.OP_PIXEL_STOREI, [0x0cf5, 2]);
    const data = new Uint8Array(new Uint16Array([0xffff, 1]).buffer);
    send(O.OP_TEX_SUB_IMAGE_2D, [TEX, 0, 0, 0, 2, 1, DEPTH, US, data.length], data);
    expect(b.errors).toEqual([]);
    const [[, args]] = calls("texSubImage2D");
    expect(args.slice(6, 8)).toEqual([DEPTH, UI]);
    expect([...(args[8] as Uint32Array)]).toEqual([0xffffffff, 65537]);
  });
});

describe("OES_depth_texture copies and mipmaps", () => {
  it("rejects CopyTexSubImage2D into a depth level", () => {
    const { b, send, texture, calls } = binding();
    expect(texture(TEX, DEPTH, US)).toBe(true);
    send(O.OP_COPY_TEX_SUB_IMAGE_2D, [TEX, 0, 0, 0, 0, 0, 1, 1]);
    expect(b.errors).toEqual([INVALID_OPERATION]);
    expect(calls("copyTexSubImage2D")).toEqual([]);
  });

  it.each([["DEPTH_COMPONENT", DEPTH, UI], ["DEPTH_STENCIL_OES", DEPTH_STENCIL, UI_24_8]])(
    "rejects GenerateMipmap on a %s texture (issue 1)", (_name, format, type) => {
      const { b, send, texture, calls } = binding();
      expect(texture(TEX, format, type)).toBe(true);
      send(O.OP_GENERATE_MIPMAP, [TEX]);
      expect(b.errors).toEqual([INVALID_OPERATION]);
      expect(calls("generateMipmap")).toEqual([]);
    });
});

describe("depth- and stencil-renderability (section 4.4.5)", () => {
  it.each([
    ["DEPTH_COMPONENT texture at depth", DEPTH_ATT, DEPTH, US, COMPLETE],
    ["DEPTH_STENCIL texture at depth", DEPTH_ATT, DEPTH_STENCIL, UI_24_8, COMPLETE],
    ["DEPTH_STENCIL texture at stencil", STENCIL_ATT, DEPTH_STENCIL, UI_24_8, COMPLETE],
    ["DEPTH_COMPONENT texture at stencil", STENCIL_ATT, DEPTH, UI, INCOMPLETE_ATTACHMENT],
    ["RGBA texture at depth", DEPTH_ATT, RGBA, UB, INCOMPLETE_ATTACHMENT],
    ["RGBA texture at stencil", STENCIL_ATT, RGBA, UB, INCOMPLETE_ATTACHMENT],
    ["DEPTH_COMPONENT texture at color", COLOR0, DEPTH, US, INCOMPLETE_ATTACHMENT],
  ])("%s", (_name, point, format, type, expected) => {
    const { status, attachTexture } = binding();
    attachTexture(point, format, type);
    expect(status()).toBe(expected);
  });

  it.each([
    ["DEPTH_COMPONENT16 at depth", DEPTH_ATT, 0x81a5, COMPLETE],
    ["DEPTH24_STENCIL8 at depth", DEPTH_ATT, 0x88f0, COMPLETE],
    ["DEPTH24_STENCIL8 at stencil", STENCIL_ATT, 0x88f0, COMPLETE],
    ["STENCIL_INDEX8 at stencil", STENCIL_ATT, 0x8d48, COMPLETE],
    ["STENCIL_INDEX8 at depth", DEPTH_ATT, 0x8d48, INCOMPLETE_ATTACHMENT],
    ["DEPTH_COMPONENT16 at stencil", STENCIL_ATT, 0x81a5, INCOMPLETE_ATTACHMENT],
    ["RGBA4 at depth", DEPTH_ATT, 0x8056, INCOMPLETE_ATTACHMENT],
    ["RGBA4 at stencil", STENCIL_ATT, 0x8056, INCOMPLETE_ATTACHMENT],
  ])("renderbuffer %s", (_name, point, internal, expected) => {
    const { status, attachRenderbuffer } = binding();
    attachRenderbuffer(point, internal);
    expect(status()).toBe(expected);
  });

  it("raises INVALID_FRAMEBUFFER_OPERATION for a draw with a color texture at depth", () => {
    const { b, send, attachTexture, calls } = binding();
    attachTexture(DEPTH_ATT, RGBA, UB);
    send(O.OP_CLEAR, [0x100]);
    expect(b.errors).toEqual([0x506]);
    expect(calls("clear")).toEqual([]);
  });
});
