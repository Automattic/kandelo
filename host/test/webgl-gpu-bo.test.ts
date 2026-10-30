/**
 * Unit tests for the GPU-tier bo bookkeeping in `GlContextRegistry`
 * (`host/src/webgl/registry.ts`), the host half of
 * `DRM_IOCTL_WPK_CREATE_GPU_BO` (PR10). The kernel-side ioctl dispatch +
 * rollback is covered in Rust; these pin the TS half:
 *
 *   - `createGpuBo` allocates a texture, FBO and depth/stencil renderbuffer,
 *     ids from 0x60000000, and saves/restores the shared context's texture,
 *     renderbuffer and separate read/draw framebuffer bindings (it runs
 *     outside the muxer, mid-frame for another session),
 *   - a second create for a live bo is idempotent (no realloc, no extra
 *     texImage2D upload),
 *   - `destroyGpuBo` frees the FBO, texture and renderbuffer,
 *   - `dropForeignTexturesForBo` leaves GPU bos alone (owned by the bo,
 *     not by any binding).
 */
import { describe, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { registerImageSource } from "../src/webgl/image-storage.js";
import { prepareBorrowedSurfaceTarget, retainSurfaceStorage } from "../src/webgl/surface-resources.js";
import { hasNativeRepair } from "../src/webgl/native-recovery.js";

const GL = {
  TEXTURE_2D: 0x0de1,
  ACTIVE_TEXTURE: 0x84e0,
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
  DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  RENDERBUFFER: 0x8d41,
  RENDERBUFFER_BINDING: 0x8ca7,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
} as const;

function makeFakeGl() {
  // Sentinels the alloc path must save and restore around itself.
  const state = {
    binding2d: { name: "prev-tex" } as unknown,
    fboBinding: { name: "prev-fbo" } as unknown,
    readBinding: { name: "prev-read" } as unknown,
    rboBinding: { name: "prev-rbo" } as unknown,
  };
  const calls = {
    texImage2D: [] as unknown[][],
    framebufferTexture2D: 0,
    bindTexture: [] as unknown[],
    bindFramebuffer: [] as unknown[],
    deletedTextures: [] as unknown[],
    deletedFramebuffers: [] as unknown[],
    deletedRenderbuffers: [] as unknown[],
    bindRenderbuffer: [] as unknown[],
    renderbufferStorage: [] as unknown[][],
    framebufferRenderbuffer: [] as unknown[][],
  };
  let texN = 0;
  let fboN = 0;
  const gl = {
    ...GL,
    getError: () => 0,
    isContextLost: () => false,
    activeTexture: () => {},
    createTexture: () => ({ kind: "tex", id: ++texN }),
    createFramebuffer: () => ({ kind: "fbo", id: ++fboN }),
    createRenderbuffer: () => ({ kind: "rbo" }),
    deleteRenderbuffer: (r: unknown) => calls.deletedRenderbuffers.push(r),
    deleteTexture: (t: unknown) => calls.deletedTextures.push(t),
    deleteFramebuffer: (f: unknown) => calls.deletedFramebuffers.push(f),
    getParameter: (p: number) =>
      p === GL.ACTIVE_TEXTURE ? 0x84c0 : p === GL.TEXTURE_BINDING_2D
        ? state.binding2d
        : p === GL.FRAMEBUFFER_BINDING
          ? state.fboBinding
          : p === GL.READ_FRAMEBUFFER_BINDING ? state.readBinding
            : p === GL.RENDERBUFFER_BINDING ? state.rboBinding : null,
    bindTexture: (_target: number, tex: unknown) => calls.bindTexture.push(tex),
    bindFramebuffer: (_target: number, fbo: unknown) => calls.bindFramebuffer.push(fbo),
    texImage2D: (...args: unknown[]) => calls.texImage2D.push(args),
    texParameteri: () => {},
    framebufferTexture2D: () => { calls.framebufferTexture2D++; },
    bindRenderbuffer: (_target: number, rbo: unknown) => calls.bindRenderbuffer.push(rbo),
    renderbufferStorage: (...args: unknown[]) => calls.renderbufferStorage.push(args),
    framebufferRenderbuffer: (...args: unknown[]) => calls.framebufferRenderbuffer.push(args),
    checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
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
    expect(calls.bindFramebuffer.at(-2)).toBe(state.fboBinding);
    expect(calls.bindFramebuffer.at(-1)).toBe(state.readBinding);
    expect(calls.bindRenderbuffer.at(-1)).toBe(state.rboBinding);
    expect(calls.renderbufferStorage).toEqual([[GL.RENDERBUFFER, GL.DEPTH24_STENCIL8, 320, 240]]);
    expect(calls.framebufferRenderbuffer).toEqual([
      [GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, entry.depthStencil],
    ]);
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
    // Repeated allocation leaves canonical storage intact.
    expect(calls.texImage2D.length).toBe(1);
  });

  it("canonical GPU storage lookup does not upload pixels", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    const id = reg.createGpuBo(9, gl, 16, 16);
    const uploadsAfterCreate = calls.texImage2D.length;

    // A lookup returns private canonical storage, not a public raw view.
    const gpu = reg.gpuBo(9)!;
    expect(gpu.texId).toBe(id);
    expect(calls.texImage2D.length).toBe(uploadsAfterCreate);
  });

  it("destroyGpuBo frees the FBO, texture and depth/stencil renderbuffer", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    reg.createGpuBo(5, gl, 32, 32);
    const entry = reg.gpuBo(5)!;

    reg.destroyGpuBo(5);
    expect(reg.gpuBo(5)).toBeUndefined();
    expect(calls.deletedTextures).toEqual([entry.tex]);
    expect(calls.deletedFramebuffers).toEqual([entry.fbo]);
    expect(calls.deletedRenderbuffers).toEqual([entry.depthStencil]);
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

  it("context destruction leaves registered canonical GPU storage owned by its BO", () => {
    const { gl, calls } = makeFakeGl();
    const reg = new GlContextRegistry();
    reg.createGpuBo(3, gl, 8, 8);
    const bo = reg.gpuBo(3)!;
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    const b = reg.get(7)!;
    b.gl = gl;
    expect(registerImageSource(b, 3, bo.tex, 8, 8)).toBeGreaterThan(0);
    reg.destroyContext(7);
    expect(b.imageSources.size).toBe(0);
    expect(reg.gpuBo(3)).toBe(bo);
    expect(calls.deletedTextures).toEqual([]);
    reg.destroyGpuBo(3);
    expect(calls.deletedTextures).toEqual([bo.tex]);
  });

  it("preserves current context state when a new drawable targets a GPU buffer", () => {
    const { gl } = makeFakeGl();
    const reg = new GlContextRegistry();
    reg.createGpuBo(3, gl, 8, 8);
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    const b = reg.get(7)!;
    b.gl = gl; b.hasBeenCurrent = true; b.pendingRenderTargetBoId = 3;
    b.shadow.viewport = [1, 2, 5, 6];
    const framebuffer = gl.createFramebuffer();
    b.shadow.fbo = framebuffer;
    expect(reg.applyRenderTarget(b)).toBe(true);
    expect(b.renderTargetFbo).toBe(reg.gpuBo(3)!.fbo);
    expect(b.shadow.viewport).toEqual([1, 2, 5, 6]);
    expect(b.shadow.fbo).toBe(framebuffer);
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

  it("rolls back an incomplete target without changing another session's bindings", () => {
    const { gl, calls, state } = makeFakeGl();
    gl.checkFramebufferStatus = () => 0x8cd6;
    const reg = new GlContextRegistry();
    expect(reg.createGpuBo(10, gl, 32, 32)).toBeNull();
    expect(reg.gpuBo(10)).toBeUndefined();
    expect(calls.deletedTextures).toHaveLength(1);
    expect(calls.deletedFramebuffers).toHaveLength(1);
    expect(calls.deletedRenderbuffers).toHaveLength(1);
    expect(calls.bindFramebuffer.slice(-2)).toEqual([state.fboBinding, state.readBinding]);
    expect(calls.bindRenderbuffer.at(-1)).toBe(state.rboBinding);
  });
});

it("rejects a native GPU allocation error before publishing canonical storage",()=>{
  const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();let error=0;
  gl.getError=()=>{const value=error;error=0;return value;};
  gl.texImage2D=()=>{error=0x505;};
  expect(reg.createGpuBo(41,gl,2,2)).toBeNull();expect(reg.gpuBo(41)).toBeUndefined();
  expect(calls.deletedFramebuffers).toHaveLength(1);expect(calls.deletedTextures).toHaveLength(1);
  expect(calls.deletedRenderbuffers).toHaveLength(1);expect(gl.getError()).toBe(0);
});
it("does not replay accepted GPU deletion members after a later member rejects",()=>{
  const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();reg.createGpuBo(41,gl,2,2);
  const destroy=gl.deleteTexture.bind(gl);let reject=true;
  gl.deleteTexture=value=>{if(reject)throw new Error("texture delete rejected");destroy(value);};
  expect(reg.destroyGpuBo(41)).toBe(false);reject=false;
  expect(reg.destroyGpuBo(41)).toBe(true);
  expect(calls.deletedFramebuffers).toHaveLength(1);expect(calls.deletedRenderbuffers).toHaveLength(1);
  expect(calls.deletedTextures).toHaveLength(1);
});
it("keeps a borrowed GPU allocation while a copied surface lease outlives public BO retirement",()=>{
  const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();reg.createGpuBo(41,gl,2,2);
  const old=reg.gpuBo(41)!;
  reg.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});const b=reg.get(7,11)!;
  b.gl=gl;b.contextId=1;b.surfaceId=31;
  prepareBorrowedSurfaceTarget(b,old,41)();
  const lease=retainSurfaceStorage(b.surface);
  expect(reg.destroyGpuBo(41)).toBe(true);
  expect(calls.deletedFramebuffers).not.toContain(old.fbo);expect(lease).not.toBeNull();
  expect(reg.gpuBo(41)).toBeUndefined();reg.destroySurface(7,11);
  expect(lease!.framebuffer).toBe(old.fbo);expect([lease!.width,lease!.height,lease!.surfaceId]).toEqual([2,2,31]);
  expect(lease!.release(null)).toBe(true);expect(calls.deletedFramebuffers).toEqual([old.fbo]);
  reg.unbind(7);
});
it.each([[0,2,2],[-1,2,2],[0x100000000,2,2],[41,0,2],[41,2,-1],[41,NaN,2],[41,2,1.5],[41,0x80000000,2]])(
  "rejects malformed BO/dimension metadata %s/%s/%s before native allocation",(id,w,h)=>{
    const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();
    expect(reg.createGpuBo(id,gl,w,h)).toBeNull();expect(calls.texImage2D).toEqual([]);
  });
it("refuses conflicting renderer or dimensions for an existing public BO",()=>{
  const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();
  const id=reg.createGpuBo(41,gl,2,2);
  expect(reg.createGpuBo(41,gl,2,2)).toBe(id);
  expect(reg.createGpuBo(41,gl,3,2)).toBeNull();expect(reg.createGpuBo(41,makeFakeGl().gl,2,2)).toBeNull();
  expect(calls.texImage2D).toHaveLength(1);expect(reg.destroyGpuBo(41)).toBe(true);
});
it("keeps retired BO generations and cloned surface leases disjoint from ID reuse",()=>{
  const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();reg.createGpuBo(41,gl,2,2);const old=reg.gpuBo(41)!;
  reg.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});const b=reg.get(7,11)!;b.gl=gl;b.surfaceId=31;
  prepareBorrowedSurfaceTarget(b,old,41)();const first=retainSurfaceStorage(b.surface)!;
  expect(reg.destroyGpuBo(41)).toBe(true);expect(retainSurfaceStorage(b.surface)).toBeNull();
  const second=first.clone()!;expect(second).not.toBeNull();
  reg.createGpuBo(41,gl,4,3);const fresh=reg.gpuBo(41)!;expect(fresh.texId).toBeGreaterThan(old.texId);
  prepareBorrowedSurfaceTarget(b,fresh,41)();expect(first.framebuffer).toBe(old.fbo);
  expect(first.release(null)).toBe(true);expect(calls.deletedFramebuffers).toEqual([]);
  expect(second.release(null)).toBe(true);expect(calls.deletedFramebuffers).toEqual([old.fbo]);
  expect(reg.gpuBo(41)).toBe(fresh);expect(reg.destroyGpuBo(41)).toBe(true);
  expect(calls.deletedFramebuffers).toEqual([old.fbo,fresh.fbo]);reg.unbind(7);
});
it("keeps a rejected candidate and selector inverse until restoration accepts",()=>{
  const {gl,calls,state}=makeFakeGl(),reg=new GlContextRegistry();const bind=gl.bindFramebuffer.bind(gl);let reject=true;
  gl.bindFramebuffer=(target,framebuffer)=>{if(reject && framebuffer===state.readBinding)throw new Error("read selector rejected");bind(target,framebuffer);};
  expect(reg.createGpuBo(41,gl,2,2)).toBeNull();expect(reg.gpuBo(41)).toBeUndefined();
  expect(hasNativeRepair(gl)).toBe(true);expect(calls.deletedFramebuffers).toEqual([]);
  expect(reg.createGpuBo(42,gl,2,2)).toBeNull();expect(calls.texImage2D).toHaveLength(1);
  reject=false;expect(reg.createGpuBo(42,gl,2,2)).not.toBeNull();
  expect(calls.deletedFramebuffers).toHaveLength(1);expect(calls.deletedTextures).toHaveLength(1);
  expect(hasNativeRepair(gl)).toBe(false);expect(reg.destroyGpuBo(42)).toBe(true);
});
it("keeps an unheld failed retirement hidden and refuses recreation until checked cleanup",()=>{
  const {gl,calls}=makeFakeGl(),reg=new GlContextRegistry();reg.createGpuBo(41,gl,2,2);const old=reg.gpuBo(41)!;
  const remove=gl.deleteFramebuffer.bind(gl);let reject=true;
  gl.deleteFramebuffer=value=>{if(reject)throw new Error("FBO retirement rejected");remove(value);};
  expect(reg.destroyGpuBo(41)).toBe(false);expect(reg.gpuBo(41)).toBeUndefined();
  reg.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});const b=reg.get(7,11)!;
  b.gl=gl;b.pendingRenderTargetBoId=41;expect(reg.applyRenderTarget(b)).toBe(false);
  expect(calls.deletedTextures).toEqual([]);expect(calls.deletedRenderbuffers).toEqual([]);
  expect(reg.createGpuBo(41,gl,2,2)).toBeNull();expect(calls.texImage2D).toHaveLength(1);
  reject=false;expect(reg.destroyGpuBo(41)).toBe(true);
  expect(calls.deletedFramebuffers).toEqual([old.fbo]);expect(calls.deletedTextures).toEqual([old.tex]);
  reg.unbind(7);
});
