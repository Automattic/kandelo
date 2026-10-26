import { describe, expect, it } from "vitest";

import { createWasmPosixKernelTestHarness, WasmPosixKernel } from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

/**
 * The KMS GL canvas auto-attach must not depend on whether the DRM-master
 * pid bound an FB (drmModeSetCrtc) before or after it created its GL
 * context (eglCreateContext).
 *
 * - modeset.c order: drmModeSetCrtc → eglCreateContext.
 * - SDL2 KMSDRM order: eglCreateContext (+ all shader compiles) →
 *   first SDL_GL_SwapWindow → first drmModeSetCrtc.
 *
 * The old gate keyed on `masterCrtcForPid`, which is null until an FB is
 * bound, so the SDL2 order built the GL context with no canvas and every
 * GLES call silently no-op'd — a black screen with working audio.
 */

function harness(callbacks: Record<string, unknown>): {
  kernel: WasmPosixKernel & Record<string, any>;
  imports: { env: Record<string, (...args: any[]) => any> };
  memory: WebAssembly.Memory;
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: callbacks as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(
      4,
      memory,
      () => ({}),
      () => 4096,
    ),
  }) as WasmPosixKernel & Record<string, any>;
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel, imports, memory };
}

function fakeCanvas(width = 300, height = 150): {
  width: number;
  height: number;
  getContext: () => unknown;
} {
  // Canvas-backed GL renders into an offscreen present target and blits it
  // to the canvas on present (host/src/webgl/present-target.ts), so the
  // context needs the few calls that target makes. None of them is under
  // test here; they only have to succeed.
  const glCtx = {
    isContextLost: () => false,
    getError: () => 0,
    getExtension: () => null,
    getParameter: (p:number) => p === 0x84e0 ? 0x84c0 : null,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    deleteRenderbuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    deleteTexture: () => {},
    deleteFramebuffer: () => {},
    bindTexture: () => {},
    bindFramebuffer: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 0x8cd5, // FRAMEBUFFER_COMPLETE
    blitFramebuffer: () => {},
    enable: () => {},
    disable: () => {},
  };
  return { width, height, getContext: () => glCtx };
}

const PID = 101;

it.each([false, true])("rebuilds a recreated EGL window before drawing (new context: %s)", (newContext) => {
  let drawFramebuffer: unknown = null;
  let contextLost = false;
  const presented: number[] = [];
  const deletedRenderbuffers: unknown[] = [];
  const gl = new Proxy({
    ...fakeCanvas().getContext() as object,
    getParameter: (p: number) => p === 0x84e0 ? 0x84c0 : p === 0x8ca6 ? drawFramebuffer : null,
    bindFramebuffer: (target: number, fbo: unknown) => {
      if (target === 0x8d40 || target === 0x8ca9) drawFramebuffer = fbo;
    },
    deleteFramebuffer: (fbo: unknown) => {
      if (drawFramebuffer === fbo) drawFramebuffer = null;
    },
    deleteRenderbuffer: (rbo: unknown) => deletedRenderbuffers.push(rbo),
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    isContextLost: () => contextLost,
  }, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => {},
  });
  const canvas = { width: 640, height: 480, getContext: () => gl };
  const { kernel, imports, memory } = harness({
    getKmsCanvas: () => canvas,
    getKmsCrtcIds: () => [1],
    markKmsCanvasGlOwned: () => {},
    getKmsDisplaySize: () => ({ width: 640, height: 480 }),
    onKmsGlPresented: (crtc: number) => presented.push(crtc),
  });
  kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 128, cmdbufLen: 0 });
  const binding = kernel.gl.get(PID)!;
  binding.cmdbufView = new Uint8Array(memory.buffer, 128, 0);
  imports.env.host_kms_set_master(PID, 1n, 1n);
  imports.env.host_kms_addfb(PID, 10, 100, 640, 480, 0x34325258, 2560);
  imports.env.host_kms_set_fb(PID, 1, 10);
  imports.env.host_gl_create_context(PID, 1, 0, 0);
  expect(imports.env.host_gl_submit(PID, 0, 0)).toBe(0);
  const oldTarget = binding.presentTarget!.fbo;
  const oldDepthStencil = binding.presentTarget!.depthStencil;
  expect(drawFramebuffer).toBe(oldTarget);

  // SDL can recreate the window surface while retaining its GL context.
  binding.surfaceId = 71; // Existing kernel-issued surface identity.
  imports.env.host_gl_destroy_surface(PID, 71);
  expect(deletedRenderbuffers).toContain(oldDepthStencil);
  if (newContext) imports.env.host_gl_destroy_context(PID, 1);
  const attrs = new DataView(memory.buffer, 64, 36);
  attrs.setUint32(0, 1, true); attrs.setUint32(12, 1, true);
  attrs.setUint32(4, 800, true);
  attrs.setUint32(8, 600, true);
  expect(imports.env.host_gl_create_surface(PID, 2, 64, 36)).toBe(0);
  if (newContext) imports.env.host_gl_create_context(PID, 2, 0, 0);
  // SDL creates the resized EGL surface/context before its next SETCRTC.
  // The old scanout must not override that new drawable and clear the
  // completed first frame when the new FB is finally latched.
  // Private storage accepts the size without resizing another context's canvas.
  if (newContext) expect([canvas.width, canvas.height]).toEqual([800, 600]);
  else expect([canvas.width, canvas.height]).toEqual([640, 480]);
  expect([binding.presentTarget!.w, binding.presentTarget!.h]).toEqual([800, 600]);
  expect(binding.presentTarget, "the next frame needs a target before any draws").not.toBeNull();
  expect(binding.presentTarget!.fbo).not.toBe(oldTarget);
  expect(imports.env.host_gl_submit(PID, 0, 0)).toBe(0);
  expect(drawFramebuffer, "the muxer must replay the new default target").toBe(binding.presentTarget!.fbo);
  expect(presented).toEqual([]);
  expect(imports.env.host_gl_present(PID)).toBe(0);
  expect(imports.env.host_gl_present(PID)).toBe(0);
  expect(presented).toEqual([1, 1]);
  contextLost = true;
  expect(imports.env.host_gl_present(PID)).toBe(-5);
  expect(imports.env.host_gl_present(PID + 1)).toBe(0);
  expect(presented).toEqual([1, 1]);
});

describe("KMS GL canvas auto-attach — ordering independence", () => {
  it("attaches at eglCreateContext when the master pid has no FB bound yet (SDL2 KMSDRM order)", () => {
    const canvas = fakeCanvas(1920, 1080);
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
    });
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    // SDL2 acquires DRM master early, then creates its GL context and
    // compiles shaders BEFORE the first drmModeSetCrtc (which the KMSDRM
    // backend defers to the first SwapWindow). No host_kms_set_fb yet.
    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_gl_create_context(PID, 1, 0, 0);

    const b = kernel.gl.get(PID)!;
    expect(b.canvas, "canvas must attach from master + registered canvas").toBe(canvas);
    expect(
      b.gl,
      "WebGL2 context must be built at create time so shader compiles are real",
    ).not.toBeNull();
  });

  it("still attaches in the modeset order (drmModeSetCrtc before eglCreateContext)", () => {
    const canvas = fakeCanvas(1920, 1080);
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
    });
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_kms_addfb(PID, 10, 100, 1920, 1080, 0x34325258, 7680);
    imports.env.host_kms_set_fb(PID, 1, 10);
    imports.env.host_gl_create_context(PID, 1, 0, 0);

    const b = kernel.gl.get(PID)!;
    expect(b.canvas).toBe(canvas);
    expect(b.gl).not.toBeNull();
  });

  it("resizes the drawing buffer to the bound FB dims at drmModeSetCrtc", () => {
    // Canvas registered at the default 300x150; the FB the program binds
    // is 1920x1080. Without a resize, glViewport(1920,1080) clips.
    const canvas = fakeCanvas(300, 150);
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
    });
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_gl_create_context(PID, 1, 0, 0);
    // Context built against the default-sized canvas; now the program
    // adds its real FB and points the CRTC at it.
    imports.env.host_kms_addfb(PID, 10, 100, 1920, 1080, 0x34325258, 7680);
    imports.env.host_kms_set_fb(PID, 1, 10);

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  it("requires an explicit context retry after a renderer becomes available", () => {
    const canvas = fakeCanvas(1920, 1080);
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
    });
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });
    expect(imports.env.host_gl_create_context(PID, 1, 0, 0)).toBe(-19);
    const b = kernel.gl.get(PID)!;
    expect(b.gl).toBeNull();
    expect(b.contextId).toBeNull();
    expect(b.canvas).toBeNull();

    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_kms_addfb(PID, 10, 100, 1920, 1080, 0x34325258, 7680);
    imports.env.host_kms_set_fb(PID, 1, 10);
    // Failed creation cannot become successful behind the guest's back
    // when a later modeset supplies a canvas. Only a new request can do so.
    expect(b.gl).toBeNull();
    expect(b.contextId).toBeNull();
    expect(imports.env.host_gl_create_context(PID, 2, 0, 0)).toBe(0);
    expect(b.gl).not.toBeNull();
    expect(b.contextId).toBe(2);
  });

  it("does not mark the canvas GL-owned if getContext('webgl2') returns null", () => {
    // A canvas that cannot yield a WebGL2 context (e.g. a prior 2D
    // acquisition). Marking it GL-owned would disable the 2D-blit pump,
    // stranding it with neither GL nor a blit — a black canvas.
    const canvas = { width: 1920, height: 1080, getContext: () => null };
    let markedCrtc: number | null = null;
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: (crtc: number) => {
        markedCrtc = crtc;
      },
    });
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_gl_create_context(PID, 1, 0, 0);

    const b = kernel.gl.get(PID)!;
    expect(b.gl, "no WebGL2 context available").toBeNull();
    expect(markedCrtc, "must not claim GL ownership without a GL context").toBeNull();
  });
});

/**
 * The other half of the claim: when the GL session that claimed a KMS
 * canvas ends, the CRTC must go back to the vblank pump. Otherwise both
 * pump presenters keep skipping it and the canvas freezes on the dead
 * session's last GL frame.
 *
 * This was untested, and it hid two failures in turn: first there was no
 * release at all, then the release path existed but read a claim that
 * nothing recorded, so it returned early every time.
 */
describe("KMS GL canvas release — the claim is handed back", () => {
  it("keeps the canvas claimed until the last session in a process retires", () => {
    const owned: number[] = [], released: number[] = [];
    const canvas = fakeCanvas(640, 480);
    const { kernel, imports } = harness({
      getKmsCanvas: () => canvas, getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: (id: number) => owned.push(id),
      markKmsCanvasGlReleased: (id: number) => released.push(id),
    });
    imports.env.host_kms_set_master(PID, 1n, 1n);
    for (const sessionId of [11, 12]) {
      kernel.gl.bind({ displayFileId: 1n, pid: PID, sessionId, cmdbufAddr: 0, cmdbufLen: 0 });
      expect(imports.env.host_gl_create_context(PID, sessionId + 20, 0, 0, sessionId)).toBe(0);
    }
    expect(owned).toEqual([1]);
    imports.env.host_gl_unbind(PID, 11);
    expect(released).toEqual([]);
    expect(kernel.gl.get(PID, 12)!.claimedKmsCrtc).toBe(1);
    imports.env.host_gl_unbind(PID, 12);
    expect(released).toEqual([1]);
  });

  function claimed(): {
    kernel: WasmPosixKernel & Record<string, any>;
    imports: { env: Record<string, (...args: any[]) => any> };
    released: number[];
  } {
    const canvas = fakeCanvas(1920, 1080);
    const released: number[] = [];
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
      markKmsCanvasGlReleased: (crtc: number) => {
        released.push(crtc);
      },
    });
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });
    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_gl_create_context(PID, 1, 0, 0);
    expect(kernel.gl.get(PID)!.claimedKmsCrtc, "the claim is recorded").toBe(1);
    return { kernel, imports, released };
  }

  it("releases the CRTC when the guest unbinds its GL session", () => {
    const { imports, released } = claimed();
    imports.env.host_gl_unbind(PID);
    expect(released).toEqual([1]);
  });

  it("releases the CRTC when the guest destroys its GL context", () => {
    const { imports, released } = claimed();
    imports.env.host_gl_destroy_context(PID, 1);
    expect(released).toEqual([1]);
  });

  it("releases the CRTC from the process-release backstop (exec, trap, forced exit)", () => {
    // The guest-side hooks never run when a process traps or is killed;
    // releaseProcessViews is the only thing that can hand the canvas back.
    const { kernel, released } = claimed();
    kernel.releaseProcessViews(PID);
    expect(released).toEqual([1]);
  });

  it("releases exactly once when several release paths fire", () => {
    const { kernel, imports, released } = claimed();
    imports.env.host_gl_destroy_context(PID, 1);
    kernel.releaseProcessViews(PID);
    expect(released).toEqual([1]);
  });
});
