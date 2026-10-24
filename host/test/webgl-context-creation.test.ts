import { describe, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { ensurePresentTarget } from "../src/webgl/present-target.js";

function harness(callbacks = {}) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: { getProcessMemory: () => memory, ...callbacks },
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  });
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel,
    memory, imports: imports.env,
    setMaster: (pid: number) => imports.env.host_kms_set_master(pid),
    create: (pid: number, id = 1, sessionId?: number) =>
      imports.env.host_gl_create_context(pid, id, 0, 0, sessionId),
  };
}

describe("context creation acknowledgement", () => {
  it("rejects a replacement renderer while retaining the existing surface for retry", () => {
    const {kernel, create, imports} = harness();
    const deleted: unknown[] = [];
    const renderer = () => new Proxy({
      getExtension: () => null, isContextLost: () => false, getParameter: () => null, getError: () => 0,
      createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
      FRAMEBUFFER_COMPLETE: 0x8cd5, checkFramebufferStatus: () => 0x8cd5,
      deleteFramebuffer: (value: unknown) => deleted.push(value),
    }, {get: (object,key) => Reflect.get(object,key) ?? (() => null)}) as unknown as WebGL2RenderingContext;
    const original = renderer(); let selected = original;
    kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
    kernel.gl.attachCanvas(7,{width:4,height:3,getContext:() => selected} as unknown as OffscreenCanvas);
    expect(create(7,21,11)).toBe(0);
    const b = kernel.gl.get(7,11)!; b.surfaceId = 71;
    expect(ensurePresentTarget(b)).toBe(true); const target = b.presentTarget;
    imports.host_gl_destroy_context(7,21);
    selected = renderer();
    expect(create(7,22,11)).toBe(-19);
    expect(b.contextId).toBeNull(); expect(b.gl).toBeNull();
    expect(b.presentTarget).toBe(target); expect(deleted).toEqual([]);
    selected = original;
    expect(create(7,23,11)).toBe(0); expect(b.gl).toBe(original);
    expect(ensurePresentTarget(b)).toBe(true); expect(b.presentTarget).toBe(target);
    imports.host_gl_unbind(7,11);
    expect(deleted).toEqual([target!.fbo]);
  });

  it("rolls back a failed surfaceless allocation and retires its successful retry", () => {
    const { kernel, create, imports } = harness();
    kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    let allocate = false;
    const framebuffer = {} as WebGLFramebuffer, deleted: unknown[] = [];
    const gl = { getExtension: () => null, isContextLost: () => false, getError: () => 0,
      createFramebuffer: () => allocate ? framebuffer : null,
      deleteFramebuffer: (value: unknown) => deleted.push(value) };
    kernel.gl.attachCanvas(7, { width: 100, height: 80, getContext: () => gl } as unknown as OffscreenCanvas);
    expect(create(7, 21, 11)).toBe(0);
    const b = kernel.gl.get(7, 11)!; b.surfaceId = 31;
    expect(imports.host_gl_make_current(7, 21, 31, 31, 11)).toBe(0);
    const prior = b.currentDrawable;
    expect(imports.host_gl_make_current(7, 21, 0, 0, 11)).toBe(-12);
    expect(b.currentDrawable).toBe(prior);
    expect(b.shadow.fbo).toBeNull(); expect(b.shadow.readFbo).toBeNull();
    expect(b.shadow.viewport).toEqual([0,0,100,80]);
    allocate = true;
    expect(imports.host_gl_make_current(7, 21, 0, 0, 11)).toBe(0);
    expect(b.shadow.fbo).toBe(framebuffer); expect(b.shadow.readFbo).toBe(framebuffer);
    const user = {} as WebGLFramebuffer;
    b.shadow.fbo = user; b.shadow.readFbo = user;
    expect(imports.host_gl_make_current(7, 21, 31, 31, 11)).toBe(0);
    expect(b.shadow.fbo).toBe(user); expect(b.shadow.readFbo).toBe(user);
    expect(imports.host_gl_make_current(7, 21, 0, 0, 11)).toBe(0);
    expect(b.shadow.fbo).toBe(user); expect(b.shadow.readFbo).toBe(user);
    imports.host_gl_destroy_context(7,21);
    expect(deleted).toEqual([framebuffer]);
    expect(b.undefinedDefaultFbo).toBeNull();
  });

  it("uses a GPU window's real buffer size when no canvas is attached", () => {
    const { kernel, create, imports, memory } = harness();
    const gl = new Proxy({
      getExtension: () => null, isContextLost: () => false, getParameter: () => null,
      createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
      FRAMEBUFFER_COMPLETE: 0x8cd5, checkFramebufferStatus: () => 0x8cd5,
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) });
    kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    kernel.gl.attachCanvas(7, { width: 320, height: 240, getContext: () => gl } as unknown as OffscreenCanvas);
    expect(create(7, 21, 11)).toBe(0);
    const b = kernel.gl.get(7, 11)!;
    expect(kernel.gl.createGpuBo(37, b.gl!, 64, 32)).not.toBeNull();
    b.canvas = null; b.surfaceId = 1; b.pendingRenderTargetBoId = 37;
    expect(imports.host_gl_make_current(7, 21, 1, 1, 11)).toBe(0);
    expect(b.shadow.viewport).toEqual([0, 0, 64, 32]);
    expect(b.shadow.scissor.rect).toEqual([0, 0, 64, 32]);
    expect(kernel.gl.createGpuBo(38, b.gl!, 96, 48)).not.toBeNull();
    kernel.gl.applyRenderTarget(b);
    b.shadow.viewport = [1, 2, 5, 6]; b.shadow.scissor.rect = [0, 1, 4, 5];
    const attrs = new DataView(memory.buffer, 64, 32);
    attrs.setUint32(0, 1, true); attrs.setUint32(12, 1, true); attrs.setUint32(16, 38, true);
    expect(imports.host_gl_update_surface(7, 1, 64, 32, 11)).toBe(0);
    expect(b.renderTargetFbo).toBe(kernel.gl.gpuBo(38)!.fbo);
    expect(b.surfaceSize).toEqual({ width: 96, height: 48 });
    expect(b.shadow.viewport).toEqual([1, 2, 5, 6]);
    expect(b.shadow.scissor.rect).toEqual([0, 1, 4, 5]);
    const target = b.renderTargetFbo;
    attrs.setUint32(16, 99, true);
    expect(imports.host_gl_update_surface(7, 1, 64, 32, 11)).toBe(-5);
    expect(b.renderTargetFbo).toBe(target);
    expect(b.surfaceSize).toEqual({ width: 96, height: 48 });
  });

  it.each([false, true])("initializes drawable state once (surfaceless first: %s)", surfaceless => {
    const { kernel, create, imports } = harness();
    kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    const gl = { getExtension: () => null, isContextLost: () => false,
      createFramebuffer: () => ({}), getError: () => 0 };
    kernel.gl.attachCanvas(7, { width: 320, height: 240, getContext: () => gl } as unknown as OffscreenCanvas);
    expect(create(7, 21, 11)).toBe(0);
    const b = kernel.gl.get(7, 11)!;
    b.surfaceId = 31;
    b.surfaceSize = { width: 100, height: 80 };
    const firstSurface = surfaceless ? 0 : 31;
    expect(imports.host_gl_make_current(7, 21, firstSurface, firstSurface, 11)).toBe(0);
    expect(b.shadow.viewport).toEqual(surfaceless ? [0, 0, 0, 0] : [0, 0, 100, 80]);
    expect(b.shadow.scissor.rect).toEqual(b.shadow.viewport);
    b.shadow.viewport = [1, 2, 5, 6]; b.shadow.scissor.rect = [0, 1, 4, 5];
    expect(imports.host_gl_make_current(7, 0, 0, 0, 11)).toBe(0);
    expect(b.currentDrawable).toBeNull();
    expect(imports.host_gl_make_current(7, 21, 31, 31, 11)).toBe(0);
    expect(b.shadow.viewport).toEqual([1, 2, 5, 6]);
    expect(b.shadow.scissor.rect).toEqual([0, 1, 4, 5]);
  });

  it("keeps client binding state unchanged after a rejected forwarded make-current", () => {
    const { kernel, create, imports } = harness();
    kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    let result: number | Error = -12;
    kernel.gl.attachMainForward(7, {
      onCreateContext: () => 0, onDestroyContext() {}, onSubmit() {},
      onMakeCurrent() { if (result instanceof Error) throw result; return result; },
    });
    expect(create(7, 21, 11)).toBe(0);
    const b = kernel.gl.get(7, 11)!;
    for (const value of [-12, 1, new Error("port closed")]) {
      result = value;
      expect(imports.host_gl_make_current(7, 21, 0, 0, 11)).toBe(value === -12 ? -12 : -5);
      expect(b.currentDrawable).toBeNull();
      expect(b.hasBeenCurrent).toBe(false);
    }
    result = 0;
    expect(imports.host_gl_make_current(7, 21, 0, 0, 11)).toBe(0);
    expect(b.hasBeenCurrent).toBe(true);
  });

  it("routes command buffers and context retirement independently within one process", () => {
    const { kernel, imports, create, memory } = harness();
    let color: number[] = [];
    const rendered: number[][] = [];
    const gl = new Proxy({
      isContextLost: () => false, getExtension: () => null, getParameter: () => null,
      getError: () => 0, clearColor: (...value: number[]) => { color = value; },
      clear: () => rendered.push([...color]),
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) });
    kernel.gl.attachCanvas(7, { width: 16, height: 16, getContext: () => gl } as unknown as OffscreenCanvas);
    for (const [index, sessionId] of [11, 12].entries()) {
      const addr = 128 + index * 64;
      imports.host_gl_bind(7, addr, 64, sessionId);
      expect(create(7, 21 + index, sessionId)).toBe(0);
      const words = new DataView(memory.buffer, addr, 28);
      words.setUint16(0, 2, true); words.setUint16(2, 16, true); // clear color
      [index, 1 - index, 0, 1].forEach((value, at) => words.setFloat32(4 + at * 4, value, true));
      words.setUint16(20, 1, true); words.setUint16(22, 4, true); // clear
      words.setUint32(24, 0x4000, true);
      expect(imports.host_gl_submit(7, 0, 28, sessionId)).toBe(0);
    }
    expect(imports.host_gl_present(7)).toBe(-5); // ambiguous process-only request
    expect(imports.host_gl_present(7, 99)).toBe(-5); // unknown session
    expect(imports.host_gl_submit(7, 20, 8, 11)).toBe(0);
    expect(rendered).toEqual([[0, 1, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1]]);
    imports.host_gl_unbind(7, 11);
    expect(kernel.gl.get(7, 11)).toBeUndefined();
    expect(kernel.gl.get(7, 12)!.contextId).toBe(22);
    expect(imports.host_gl_submit(7, 20, 8, 12)).toBe(0);
    expect(rendered.at(-1)).toEqual([1, 0, 0, 1]);
  });

  it("does not claim a KMS canvas on failure and claims it on retry", () => {
    let available = false;
    const claims: number[] = [];
    const gl = new Proxy({
      getExtension: () => null, isContextLost: () => false,
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) });
    const canvas = { width: 16, height: 16, getContext: () => available ? gl : null };
    const { kernel, create, setMaster } = harness({
      getKmsCanvas: () => canvas, getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: (id: number) => claims.push(id),
    });
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    setMaster(7);
    expect(create(7)).toBe(-19);
    expect(kernel.gl.get(7)!.canvas).toBeNull();
    expect(claims).toEqual([]);
    available = true;
    expect(create(7)).toBe(0);
    expect(kernel.gl.get(7)!.claimedKmsCrtc).toBe(1);
    expect(claims).toEqual([1]);
  });

  it("fails without a renderer and leaves creation retryable", () => {
    const { kernel, create } = harness();
    expect(create(7)).toBe(-5);
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    const b = kernel.gl.get(7)!;
    expect(create(7)).toBe(-19); // ENODEV
    expect(b.contextId).toBeNull();
    expect(b.gl).toBeNull();
    const gl = { getExtension: () => null, isContextLost: () => false };
    kernel.gl.attachCanvas(7, {
      width: 16, height: 16, getContext: () => gl,
    } as unknown as OffscreenCanvas);
    expect(create(7, 2)).toBe(0);
    expect(b.contextId).toBe(2);
    expect(b.gl).toBe(gl);
    expect(create(7, 3)).toBe(-16); // EBUSY
    expect(b.contextId).toBe(2);
  });

  it.each(["unavailable", "lost", "throwing"])("rejects a %s native context", mode => {
    const { kernel, create } = harness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    kernel.gl.attachCanvas(7, {
      width: 16, height: 16,
      getContext: () => {
        if (mode === "throwing") throw new Error("allocation failed");
        return mode === "unavailable" ? null : {
          getExtension: () => null, isContextLost: () => true,
        };
      },
    } as unknown as OffscreenCanvas);
    expect(create(7)).toBeLessThan(0);
    const b = kernel.gl.get(7)!;
    expect(b.contextId).toBeNull();
    expect(b.gl).toBeNull();
    expect(b.claimedKmsCrtc).toBeNull();
  });

  it("publishes a forwarded context only after a successful acknowledgement", () => {
    const { kernel, create } = harness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    let rc = -12;
    kernel.gl.attachMainForward(7, {
      onCreateContext: () => rc, onDestroyContext() {}, onSubmit() {},
    });
    const b = kernel.gl.get(7)!;
    expect(create(7)).toBe(-12);
    expect(b.contextId).toBeNull();
    rc = 0;
    expect(create(7)).toBe(0);
    expect(b.contextId).toBe(1);
  });
});
