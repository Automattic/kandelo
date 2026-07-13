/**
 * Unit tests for the BIND_FOREIGN_TEXTURE host upload path
 * (`host/src/webgl/foreign-texture.ts`). The kernel-side ioctl dispatch
 * is covered in Rust (drm_bind_foreign_texture_uploads_and_writes_
 * texture_id); these pin the TS half: texture-id allocation from
 * 0x40000000, texImage2D-then-texSubImage2D reuse, stride-aware upload
 * with GL state save/restore, and bo-lifetime cleanup.
 */
import { describe, expect, it } from "vitest";
import { bindForeignTexture } from "../src/webgl/foreign-texture.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import type { GlBinding } from "../src/webgl/registry.js";

const GL_UNPACK_ROW_LENGTH = 0x0cf2;

function makeFakeGl() {
  // Sentinels the upload path must save and restore around itself —
  // it runs outside the muxer, on a context another user was driving.
  const state = {
    activeTexture: 0x84c2, // "unit 2 was active"
    binding2d: { name: "prev-tex" },
  };
  const calls = {
    texImage2D: 0,
    texSubImage2D: 0,
    pixelStorei: [] as number[][],
    bindTexture: [] as unknown[],
    activeTexture: [] as number[],
    deletedTextures: [] as unknown[],
  };
  let texN = 0;
  const gl = {
    TEXTURE0: 0x84c0,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE_BINDING_2D: 0x8069,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    createTexture: () => ({ id: ++texN }),
    deleteTexture: (t: unknown) => { calls.deletedTextures.push(t); },
    getParameter: (p: number) =>
      p === 0x84e0 ? state.activeTexture : state.binding2d,
    activeTexture: (u: number) => { calls.activeTexture.push(u); },
    pixelStorei: (p: number, v: number) => { calls.pixelStorei.push([p, v]); },
    bindTexture: (_target: number, tex: unknown) => { calls.bindTexture.push(tex); },
    texParameteri: () => {},
    texImage2D: () => { calls.texImage2D++; },
    texSubImage2D: () => { calls.texSubImage2D++; },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, state };
}

function makeBinding(gl: WebGL2RenderingContext | null): { reg: GlContextRegistry; b: GlBinding } {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = reg.get(7)!;
  b.gl = gl;
  return { reg, b };
}

describe("bindForeignTexture — BIND_FOREIGN_TEXTURE upload path", () => {
  it("first bind uploads at the bo stride, mirrors the id, and restores GL state", () => {
    const { gl, calls, state } = makeFakeGl();
    const { b } = makeBinding(gl);
    const dims = { w: 4, h: 2, stride: 32 }; // 8-px stride over a 4-px row
    const bytes = new Uint8Array(dims.stride * dims.h);

    const id = bindForeignTexture(b, 55, bytes, dims);
    expect(id).toBe(0x4000_0000);
    expect(calls.texImage2D).toBe(1);
    // The id is mirrored into the cmdbuf texture table so glBindTexture
    // in a subsequent submit resolves it.
    expect(b.textures.get(id)).toBe(b.foreignTextures.get(55)!.tex);
    // Rows upload at the bo stride, then unpack state resets.
    expect(calls.pixelStorei).toContainEqual([GL_UNPACK_ROW_LENGTH, 8]);
    expect(calls.pixelStorei.at(-2)).toEqual([GL_UNPACK_ROW_LENGTH, 0]);
    // The previously-bound texture and active unit are restored.
    expect(calls.bindTexture.at(-1)).toBe(state.binding2d);
    expect(calls.activeTexture.at(-1)).toBe(state.activeTexture);
  });

  it("rebind refreshes via texSubImage2D under a stable id; resize reallocates", () => {
    const { gl, calls } = makeFakeGl();
    const { b } = makeBinding(gl);
    const bytes = new Uint8Array(32 * 4);

    const id = bindForeignTexture(b, 55, bytes, { w: 4, h: 2, stride: 32 });
    expect(bindForeignTexture(b, 55, bytes, { w: 4, h: 2, stride: 32 })).toBe(id);
    expect(calls.texImage2D).toBe(1);
    expect(calls.texSubImage2D).toBe(1);

    expect(bindForeignTexture(b, 55, bytes, { w: 8, h: 4, stride: 32 })).toBe(id);
    expect(calls.texImage2D).toBe(2);
  });

  it("distinct bos get distinct ids", () => {
    const { gl } = makeFakeGl();
    const { b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    const a = bindForeignTexture(b, 1, bytes, { w: 2, h: 2, stride: 8 });
    const c = bindForeignTexture(b, 2, bytes, { w: 2, h: 2, stride: 8 });
    expect(a).toBe(0x4000_0000);
    expect(c).toBe(0x4000_0001);
  });

  it("rejects a sub-row stride (EINVAL) and a missing GL context (EIO)", () => {
    const { gl } = makeFakeGl();
    const { b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    expect(bindForeignTexture(b, 1, bytes, { w: 4, h: 2, stride: 12 })).toBe(-22);
    const { b: noGl } = makeBinding(null);
    expect(bindForeignTexture(noGl, 1, bytes, { w: 4, h: 2, stride: 16 })).toBe(-5);
  });

  it("dropForeignTexturesForBo deletes the texture and both mirror entries", () => {
    const { gl, calls } = makeFakeGl();
    const { reg, b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    const id = bindForeignTexture(b, 55, bytes, { w: 2, h: 2, stride: 8 });
    const tex = b.foreignTextures.get(55)!.tex;

    reg.dropForeignTexturesForBo(55);
    expect(calls.deletedTextures).toEqual([tex]);
    expect(b.foreignTextures.has(55)).toBe(false);
    expect(b.textures.has(id)).toBe(false);
  });
});
