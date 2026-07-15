/**
 * Unit tests for the GPU-tier bo bookkeeping in `GlContextRegistry`
 * (`host/src/webgl/registry.ts`), the host half of
 * `DRM_IOCTL_WPK_CREATE_GPU_BO` (PR10). The kernel-side ioctl dispatch +
 * rollback is covered in Rust; these pin the TS half:
 *
 *   - `createGpuBo` allocates ONE texture + FBO, ids from 0x60000000,
 *     saves/restores the shared context's prior TEXTURE_BINDING_2D and
 *     FRAMEBUFFER_BINDING (it runs outside the muxer, mid-frame for
 *     another session),
 *   - a second create for a live bo is idempotent (no realloc, no extra
 *     texImage2D upload) — the zero-copy bind degenerates to the same id,
 *   - `destroyGpuBo` frees the FBO + texture,
 *   - `dropForeignTexturesForBo` leaves GPU bos alone (owned by the bo,
 *     not by any binding).
 */
import { describe, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";

const GL = {
  TEXTURE_2D: 0x0de1,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  LINEAR: 0x2601,
  CLAMP_TO_EDGE: 0x812f,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  FRAMEBUFFER: 0x8d40,
  COLOR_ATTACHMENT0: 0x8ce0,
  TEXTURE_BINDING_2D: 0x8069,
  FRAMEBUFFER_BINDING: 0x8ca6,
} as const;

function makeFakeGl() {
  // Sentinels the alloc path must save and restore around itself.
  const state = {
    binding2d: { name: "prev-tex" } as unknown,
    fboBinding: { name: "prev-fbo" } as unknown,
  };
  const calls = {
    texImage2D: [] as unknown[][],
    framebufferTexture2D: 0,
    bindTexture: [] as unknown[],
    bindFramebuffer: [] as unknown[],
    deletedTextures: [] as unknown[],
    deletedFramebuffers: [] as unknown[],
  };
  let texN = 0;
  let fboN = 0;
  const gl = {
    ...GL,
    createTexture: () => ({ kind: "tex", id: ++texN }),
    createFramebuffer: () => ({ kind: "fbo", id: ++fboN }),
    deleteTexture: (t: unknown) => calls.deletedTextures.push(t),
    deleteFramebuffer: (f: unknown) => calls.deletedFramebuffers.push(f),
    getParameter: (p: number) =>
      p === GL.TEXTURE_BINDING_2D
        ? state.binding2d
        : p === GL.FRAMEBUFFER_BINDING
          ? state.fboBinding
          : null,
    bindTexture: (_target: number, tex: unknown) => calls.bindTexture.push(tex),
    bindFramebuffer: (_target: number, fbo: unknown) => calls.bindFramebuffer.push(fbo),
    texImage2D: (...args: unknown[]) => calls.texImage2D.push(args),
    texParameteri: () => {},
    framebufferTexture2D: () => { calls.framebufferTexture2D++; },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, state };
}

describe("GlContextRegistry — GPU-tier bo (WPK_CREATE_GPU_BO)", () => {
  it("createGpuBo allocates one texture+FBO, ids from 0x60000000, restores prior bindings", () => {
    const { gl, calls, state } = makeFakeGl();
    const reg = new GlContextRegistry();

    const id = reg.createGpuBo(42, gl, 320, 240);
    expect(id).toBe(0x6000_0000);

    const entry = reg.gpuBo(42)!;
    expect(entry.texId).toBe(id);
    expect(entry.w).toBe(320);
    expect(entry.h).toBe(240);

    // Exactly one storage allocation with null data (no upload).
    expect(calls.texImage2D.length).toBe(1);
    expect(calls.texImage2D[0][0]).toBe(GL.TEXTURE_2D);
    expect(calls.texImage2D[0].at(-1)).toBeNull();
    expect(calls.framebufferTexture2D).toBe(1);

    // The prior TEXTURE_BINDING_2D and FRAMEBUFFER_BINDING are restored
    // last — the shared context may be mid-frame for another session.
    expect(calls.bindTexture.at(-1)).toBe(state.binding2d);
    expect(calls.bindFramebuffer.at(-1)).toBe(state.fboBinding);
  });

  it("distinct bos get distinct ids from the GPU band", () => {
    const { gl } = makeFakeGl();
    const reg = new GlContextRegistry();
    expect(reg.createGpuBo(1, gl, 8, 8)).toBe(0x6000_0000);
    expect(reg.createGpuBo(2, gl, 8, 8)).toBe(0x6000_0001);
  });

  it("re-create for a live bo is idempotent — same id, no realloc, no extra upload", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    const id = reg.createGpuBo(7, gl, 64, 64);
    expect(reg.createGpuBo(7, gl, 64, 64)).toBe(id);
    // The zero-copy bind reuses the same texture: still one allocation.
    expect(calls.texImage2D.length).toBe(1);
  });

  it("bind semantics: gpuBo returns the same tex with no upload (zero-copy)", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    const id = reg.createGpuBo(9, gl, 16, 16);
    const uploadsAfterCreate = calls.texImage2D.length;

    // What host_gl_bind_foreign_texture does on the GPU path: look the bo
    // up and return its stable texId — no texImage2D, no copy.
    const gpu = reg.gpuBo(9)!;
    expect(gpu.texId).toBe(id);
    expect(calls.texImage2D.length).toBe(uploadsAfterCreate);
  });

  it("destroyGpuBo frees the FBO and texture", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    reg.createGpuBo(5, gl, 32, 32);
    const entry = reg.gpuBo(5)!;

    reg.destroyGpuBo(5);
    expect(reg.gpuBo(5)).toBeUndefined();
    expect(calls.deletedTextures).toEqual([entry.tex]);
    expect(calls.deletedFramebuffers).toEqual([entry.fbo]);
    // Idempotent: destroying again is a no-op.
    reg.destroyGpuBo(5);
    expect(calls.deletedTextures.length).toBe(1);
  });

  it("dropForeignTexturesForBo leaves GPU bos untouched (bo-owned, not binding-owned)", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    reg.createGpuBo(3, gl, 8, 8);

    reg.dropForeignTexturesForBo(3);
    // The GPU-bo texture survives — it is freed only via destroyGpuBo.
    expect(reg.gpuBo(3)).toBeDefined();
    expect(calls.deletedTextures).toEqual([]);
  });

  it("createGpuBo returns null when the context cannot allocate", () => {
    const { gl } = makeFakeGl();
    // A context that fails to create a framebuffer must roll back the
    // texture and report failure so the kernel falls back to CPU tier.
    (gl as unknown as { createFramebuffer: () => null }).createFramebuffer = () => null;
    const reg = new GlContextRegistry();
    expect(reg.createGpuBo(1, gl, 8, 8)).toBeNull();
    expect(reg.gpuBo(1)).toBeUndefined();
  });
});
