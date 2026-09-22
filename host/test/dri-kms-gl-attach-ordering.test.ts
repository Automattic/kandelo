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
  return { kernel, imports };
}

function fakeCanvas(width = 300, height = 150): {
  width: number;
  height: number;
  getContext: () => unknown;
} {
  const glCtx = { getExtension: () => null };
  return { width, height, getContext: () => glCtx };
}

const PID = 101;

describe("KMS GL canvas auto-attach — ordering independence", () => {
  it("attaches at eglCreateContext when the master pid has no FB bound yet (SDL2 KMSDRM order)", () => {
    const canvas = fakeCanvas(1920, 1080);
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
    });
    kernel.gl.bind({ pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    // SDL2 acquires DRM master early, then creates its GL context and
    // compiles shaders BEFORE the first drmModeSetCrtc (which the KMSDRM
    // backend defers to the first SwapWindow). No host_kms_set_fb yet.
    imports.env.host_kms_set_master(PID);
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
    kernel.gl.bind({ pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    imports.env.host_kms_set_master(PID);
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
    kernel.gl.bind({ pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    imports.env.host_kms_set_master(PID);
    imports.env.host_gl_create_context(PID, 1, 0, 0);
    // Context built against the default-sized canvas; now the program
    // adds its real FB and points the CRTC at it.
    imports.env.host_kms_addfb(PID, 10, 100, 1920, 1080, 0x34325258, 7680);
    imports.env.host_kms_set_fb(PID, 1, 10);

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  it("requires DRM master at eglCreateContext: a context created before SET_MASTER is a silent no-op window (M2)", () => {
    // Documents the fix's ordering dependency. The shipped SDL2 KMSDRM
    // backend acquires DRM master during video init, BEFORE
    // eglCreateContext (verified with live host instrumentation:
    // host_kms_set_master fires before host_gl_create_context), so this
    // window is never entered in practice. But a program that deferred
    // drmSetMaster until its first frame would create+compile against a
    // null GL context here, and the later set_fb attach could not
    // retroactively re-run those compiles — a silent black screen.
    const canvas = fakeCanvas(1920, 1080);
    const { kernel, imports } = harness({
      getKmsCanvas: (crtc: number) => (crtc === 1 ? canvas : undefined),
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
    });
    kernel.gl.bind({ pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    // Context created while the pid holds neither master nor an FB: the
    // fix cannot resolve a canvas, so b.gl stays null and every GLES call
    // (including shader compiles) silently no-ops.
    imports.env.host_gl_create_context(PID, 1, 0, 0);
    let b = kernel.gl.get(PID)!;
    expect(b.gl, "no canvas attachable without master → silent no-op window").toBeNull();
    expect(b.canvas ?? null, "no canvas attached").toBeNull();

    // Master + FB arriving later DO build the context via the set_fb hook,
    // but this is too late for shaders already compiled against the null
    // context — which is exactly why the fix depends on master-first.
    imports.env.host_kms_set_master(PID);
    imports.env.host_kms_addfb(PID, 10, 100, 1920, 1080, 0x34325258, 7680);
    imports.env.host_kms_set_fb(PID, 1, 10);
    b = kernel.gl.get(PID)!;
    expect(
      b.gl,
      "set_fb hook builds the context late; earlier GLES calls were already lost",
    ).not.toBeNull();
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
    kernel.gl.bind({ pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });

    imports.env.host_kms_set_master(PID);
    imports.env.host_gl_create_context(PID, 1, 0, 0);

    const b = kernel.gl.get(PID)!;
    expect(b.gl, "no WebGL2 context available").toBeNull();
    expect(markedCrtc, "must not claim GL ownership without a GL context").toBeNull();
  });
});
