import { describe, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { ensurePresentTarget } from "../src/webgl/present-target.js";
import { querySurfaceCapabilities } from "../src/webgl/surface-capabilities.js";
import * as O from "../src/webgl/ops.js";

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

it("reports actual surface limits before context creation without publishing a renderer or drawing state", () => {
  const {kernel,imports,memory,create} = harness();
  const errors: number[] = [], calls: string[] = [];
  const gl = new Proxy({
    getError: () => errors.shift() ?? 0, isContextLost: () => false, getExtension: () => null,
    getParameter: (pname: number) => { calls.push(`get:${pname}`); return pname === 0x0d33 ? 16384 : pname === 0x84e8 ? 8192 : null; },
  },{get:(target,key) => Reflect.get(target,key) ?? (() => { calls.push(String(key)); return null; })}) as unknown as WebGL2RenderingContext;
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  kernel.gl.attachCanvas(7,{width:4,height:3,getContext:() => gl} as unknown as OffscreenCanvas);
  const b = kernel.gl.get(7,11)!, shadow = b.shadow;
  expect(imports.host_gl_query(7,O.QOP_SURFACE_CAPABILITIES,0,0,512,16,11)).toBe(16);
  expect([...new Uint32Array(memory.buffer,512,4)]).toEqual([8192,8192,67108864,0x47514c33]);
  expect(calls).toEqual([`get:${0x0d33}`,`get:${0x84e8}`]);
  expect(b.gl).toBeNull(); expect(b.contextId).toBeNull(); expect(b.shadow).toBe(shadow); expect(b.surfaceId).toBeNull();
  expect(create(7,21,11)).toBe(0); expect(b.gl).toBe(gl);
});

it("preflights surface-capability spans and retains sentinels on unavailable or invalid native limits", () => {
  const {kernel,imports,memory} = harness(); let contexts = 0;
  const errors: number[] = [], owner = {errors:[] as number[],gl:{isContextLost:()=>false,getError:()=>errors.shift()??0,getParameter:()=>0} as unknown as WebGL2RenderingContext};
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  kernel.gl.attachCanvas(7,{getContext:() => {contexts++; return owner.gl;}} as unknown as OffscreenCanvas);
  const output = new Uint8Array(memory.buffer,512,16); output.fill(0xa5);
  expect(imports.host_gl_query(7,O.QOP_SURFACE_CAPABILITIES,0,0,memory.buffer.byteLength+4,16,11)).toBe(-14);
  expect(imports.host_gl_query(7,O.QOP_SURFACE_CAPABILITIES,0,1,512,16,11)).toBe(-22);
  expect(imports.host_gl_query(7,O.QOP_SURFACE_CAPABILITIES,0,0,512,12,11)).toBe(-22); expect(contexts).toBe(0);
  for (const bad of [0,-1,Infinity,3.5,0x80000000]) {
    owner.gl.getParameter = () => bad;
    expect(querySurfaceCapabilities(owner.gl,new Uint8Array(),output)).toBe(-5);
    expect([...output]).toEqual(Array(16).fill(165));
  }
  owner.gl.getParameter = () => {errors.push(0x500);return 8192;};
  expect(querySurfaceCapabilities(owner.gl,new Uint8Array(),output)).toBe(-5); expect(owner.errors).toEqual([]);
  expect([...output]).toEqual(Array(16).fill(165));
});

it("reads shared renderer limits for an unbound client while preserving the outgoing owner's errors", () => {
  const {kernel,imports,memory,setMaster} = harness(), errors:number[] = [];
  const gl = new Proxy({
    getError:()=>errors.shift()??0,isContextLost:()=>false,
    getParameter:(pname:number)=>pname===0x0d33?16384:pname===0x84e8?4096:null,
  },{get:(target,key)=>Reflect.get(target,key)??(String(key).startsWith("create")?()=>({}):()=>{})}) as unknown as WebGL2RenderingContext;
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0}); setMaster(7);
  const owner = kernel.gl.get(7,11)!; owner.gl = gl; owner.contextId = 21;
  expect(imports.host_gl_submit(7,0,0,11)).toBe(0);
  kernel.gl.bind({pid:8,sessionId:12,cmdbufAddr:0,cmdbufLen:0}); const client = kernel.gl.get(8,12)!;
  errors.push(0x501);
  expect(imports.host_gl_query(8,O.QOP_SURFACE_CAPABILITIES,0,0,512,16,12)).toBe(16);
  expect([...new Uint32Array(memory.buffer,512,4)]).toEqual([4096,4096,16777216,0x47514c33]);
  expect(owner.errors).toEqual([0x501]); expect(client.errors).toEqual([]);
  expect(client.gl).toBeNull(); expect(client.contextId).toBeNull(); expect(owner.contextId).toBe(21);
});

it("does not claim or resize KMS scanout merely to inspect renderer limits", () => {
  const claims:string[] = [], canvas = {width:11,height:7,getContext:()=>({
    isContextLost:()=>false,getError:()=>0,getParameter:()=>8192,
  } as unknown as WebGL2RenderingContext)} as unknown as OffscreenCanvas;
  const {kernel,imports,setMaster} = harness({getKmsCrtcIds:()=>[1],getKmsCanvas:()=>canvas,
    markKmsCanvasGlOwned:()=>claims.push("owned"),markKmsCanvasGlReleased:()=>claims.push("released")});
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0}); setMaster(7);
  expect(imports.host_gl_query(7,O.QOP_SURFACE_CAPABILITIES,0,0,512,16,11)).toBe(16);
  const b = kernel.gl.get(7,11)!;
  expect([canvas.width,canvas.height]).toEqual([11,7]); expect(claims).toEqual([]);
  expect(b.claimedKmsCrtc).toBeNull(); expect(b.gl).toBeNull(); expect(b.canvas).toBeNull();
});

for (const failure of ["throw","never-clears"] as const) {
  it(`does not steal pending owner flags when capability error capture ${failure}`, () => {
    const {kernel,imports,memory,setMaster} = harness();
    let fail = false, reads = 0;
    const gl = new Proxy({
      isContextLost:()=>false,
      getError:()=> { if (fail && failure === "throw") throw new Error("unavailable error read"); return fail ? 0x502 : 0; },
      getParameter:()=> { reads++; return 4096; },
    },{get:(target,key)=>Reflect.get(target,key)??(String(key).startsWith("create")?()=>({}):()=>{})}) as unknown as WebGL2RenderingContext;
    kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0}); setMaster(7);
    const owner = kernel.gl.get(7,11)!; owner.gl = gl; owner.contextId = 21;
    expect(imports.host_gl_submit(7,0,0,11)).toBe(0);
    kernel.gl.bind({pid:8,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
    const output = new Uint8Array(memory.buffer,512,16); output.fill(0xa5); reads = 0; fail = true;
    expect(imports.host_gl_query(8,O.QOP_SURFACE_CAPABILITIES,0,0,512,16,12)).toBe(-5);
    expect(reads).toBe(0); expect([...output]).toEqual(Array(16).fill(165));
    expect(owner.errors).toEqual(failure === "throw" ? [] : [0x502]);
    expect(kernel.gl.get(8,12)!.errors).toEqual([]);
    fail = false;
    expect(imports.host_gl_query(8,O.QOP_SURFACE_CAPABILITIES,0,0,512,16,12)).toBe(16);
    expect(owner.contextId).toBe(21); expect(kernel.gl.get(8,12)!.gl).toBeNull();
  });
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
    kernel.gl.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
    const peer = kernel.gl.get(7,12)!; peer.gl = b.gl; peer.contextId = 22;
    expect(imports.host_gl_make_current(7,22,1,1,12)).toBe(0);
    const oldTarget = b.renderTargetFbo;
    expect(peer.shadow.fbo).toBe(oldTarget); expect(peer.shadow.readFbo).toBe(oldTarget);
    b.shadow.viewport = [1, 2, 5, 6]; b.shadow.scissor.rect = [0, 1, 4, 5];
    const attrs = new DataView(memory.buffer, 64, 32);
    attrs.setUint32(0, 1, true); attrs.setUint32(12, 1, true); attrs.setUint32(16, 38, true);
    expect(imports.host_gl_update_surface(7, 1, 64, 32, 11)).toBe(0);
    expect(b.renderTargetFbo).toBe(kernel.gl.gpuBo(38)!.fbo);
    expect(b.surfaceSize).toEqual({ width: 96, height: 48 });
    expect(peer.shadow.fbo).toBe(b.renderTargetFbo); expect(peer.shadow.readFbo).toBe(b.renderTargetFbo);
    expect(peer.currentDrawable).toEqual({drawSurfaceId:1,readSurfaceId:1,width:96,height:48});
    expect(peer.shadow.viewport).toEqual([0,0,64,32]);
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


describe("surface creation acknowledgement", () => {
  it("rejects malformed metadata without publishing identity or changing caller bytes", () => {
    const {kernel, imports, memory} = harness();
    kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
    const b = kernel.gl.get(7,11)!;
    const attrs = new Uint32Array(memory.buffer,64,9);
    attrs.set([99,4,3,1,0,0,0,0,0]);
    const before = attrs.slice();
    expect(imports.host_gl_create_surface(7,71,64,36,11)).toBe(-22);
    expect(b.surfaceId).toBeNull(); expect(attrs).toEqual(before);
  });
});

it("publishes accepted dimensions and private storage, preserving state on allocation failure", () => {
  const {kernel,imports,memory} = harness();
  let allocate = false;
  const deleted: unknown[] = [], blits: unknown[][] = [];
  let serial = 0;
  const gl = new Proxy({
    getExtension: () => null, isContextLost: () => false, getParameter: () => null, getError: () => 0,
    createTexture: () => allocate ? {texture:++serial} : null,
    createFramebuffer: () => allocate ? {framebuffer:++serial} : null,
    createRenderbuffer: () => allocate ? {renderbuffer:++serial} : null,
    blitFramebuffer: (...args:unknown[]) => blits.push(args),
    FRAMEBUFFER_COMPLETE: 0x8cd5, checkFramebufferStatus: () => 0x8cd5,
    deleteFramebuffer: (value:unknown) => deleted.push(value),
  }, {get: (object,key) => Reflect.get(object,key) ?? (() => null)}) as unknown as WebGL2RenderingContext;
  const canvas = {width:8,height:6,getContext:() => gl} as unknown as OffscreenCanvas;
  kernel.gl.attachCanvas(7,canvas);
  imports.host_gl_bind(7,128,0,11);
  const b = kernel.gl.get(7,11)!, original = b.surface;
  const attrs = new Uint32Array(memory.buffer,64,9);
  attrs.set([1,0,0,1,0,0,0,0,0]); const before = attrs.slice();
  expect(imports.host_gl_create_surface(7,71,64,36,11)).toBe(-12);
  expect(b.surface).toBe(original); expect(b.surfaceId).toBeNull(); expect(attrs).toEqual(before);
  allocate = true;
  expect(imports.host_gl_create_surface(7,72,64,36,11)).toBe(0);
  expect([...attrs]).toEqual([1,8,6,1,0,0,0,0,0]);
  const accepted = b.surface, fbo = b.presentTarget!.fbo;
  expect(b.surfaceId).toBe(72); expect(b.gl).toBeNull(); // Logical context not created yet.
  expect(imports.host_gl_create_surface(7,73,64,36,11)).toBe(-16);
  expect(b.surface).toBe(accepted); expect(deleted).toEqual([]);
  imports.host_gl_destroy_surface(7,71,11); expect(b.surface).toBe(accepted);
  expect(imports.host_gl_create_context(7,21,0,0,11)).toBe(0);
  expect(imports.host_gl_make_current(7,21,72,72,11)).toBe(0);
  expect(imports.host_gl_present(7,11)).toBe(0);
  expect(blits).toHaveLength(1); expect(blits[0].slice(0,8)).toEqual([0,0,8,6,0,0,8,6]);
  imports.host_gl_make_current(7,0,0,0,11);
  imports.host_gl_destroy_surface(7,72,11);
  expect(deleted).toEqual([fbo]); expect(b.surfaceId).toBeNull();
});

it("selects independent surfaces across sessions and retains them after their owners unbind", () => {
  const {kernel,imports,memory} = harness();
  const deleted: unknown[] = [];
  let serial = 0;
  const gl = new Proxy({
    getExtension: () => null, isContextLost: () => false, getParameter: () => null, getError: () => 0,
    createTexture: () => ({tex:++serial}), createFramebuffer: () => ({fbo:++serial}), createRenderbuffer: () => ({rbo:++serial}),
    FRAMEBUFFER_COMPLETE:0x8cd5, checkFramebufferStatus: () => 0x8cd5,
    deleteFramebuffer: (value:unknown) => deleted.push(value),
  },{get:(object,key) => Reflect.get(object,key) ?? (() => null)}) as unknown as WebGL2RenderingContext;
  kernel.gl.attachCanvas(7,{width:8,height:6,getContext:() => gl} as unknown as OffscreenCanvas);
  for (const [i,session] of [11,12,13].entries()) {
    imports.host_gl_bind(7,128,0,session);
    expect(imports.host_gl_create_context(7,21+i,0,0,session)).toBe(0);
    if (i < 2) {
      new Uint32Array(memory.buffer,64,9).set([1,3+i,2,1,0,0,0,0,0]);
      expect(imports.host_gl_create_surface(7,71+i,64,36,session)).toBe(0);
    }
  }
  const a = kernel.gl.get(7,11)!, b = kernel.gl.get(7,12)!, c = kernel.gl.get(7,13)!;
  const first = a.surface, second = b.surface;
  const firstFbo = a.presentTarget!.fbo, secondFbo = b.presentTarget!.fbo;
  expect(imports.host_gl_make_current(7,23,71,72,13)).toBe(0);
  expect(c.drawSurface).toBe(first); expect(c.readSurface).toBe(second);
  expect(c.currentDrawable).toEqual({drawSurfaceId:71,readSurfaceId:72,width:3,height:2});
  imports.host_gl_unbind(7,11); imports.host_gl_unbind(7,12);
  expect(first.ownerAlive).toBe(false); expect(second.ownerAlive).toBe(false); expect(deleted).toEqual([]);
  expect(imports.host_gl_make_current(7,23,71,72,13)).toBe(-22);
  expect(c.drawSurface).toBe(first); expect(c.readSurface).toBe(second);
  expect(imports.host_gl_make_current(7,0,0,0,13)).toBe(0);
  expect(new Set(deleted)).toEqual(new Set([firstFbo,secondFbo]));
});

function sharingRenderer() {
  return new Proxy({getExtension:()=>null,isContextLost:()=>false,getParameter:()=>null,getError:()=>0,
    createFramebuffer:()=>({}),createTexture:()=>({}),createRenderbuffer:()=>({}),
    FRAMEBUFFER_COMPLETE:0x8cd5,checkFramebufferStatus:()=>0x8cd5,
  },{get:(object,key)=>Reflect.get(object,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
}
describe("share group construction",()=>{
  it("joins the live source before publication and retains objects after source destruction",()=>{
    const {kernel,imports,memory,create}=harness(),gl=sharingRenderer();
    kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
    kernel.gl.attachCanvas(7,{width:1,height:1,getContext:()=>gl} as unknown as OffscreenCanvas);
    expect(create(7,21,11)).toBe(0);
    const source=kernel.gl.get(7,11)!,texture={} as WebGLTexture;
    source.textures.set(5,texture);source.shadow.activeTexture=3;source.errors.push(0x500);
    kernel.gl.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
    new Uint32Array(memory.buffer,64,4).set([2,21,0,0]);
    expect(imports.host_gl_create_context(7,22,64,16,12)).toBe(0);
    const target=kernel.gl.get(7,12)!;
    expect(target.objects).toBe(source.objects);expect(target.textures.get(5)).toBe(texture);
    expect(target.shadow).not.toBe(source.shadow);expect(target.shadow.activeTexture).toBe(0);expect(target.errors).toEqual([]);
    imports.host_gl_destroy_context(7,21);
    expect(target.textures.get(5)).toBe(texture);expect(target.objects.members.size).toBe(1);
    kernel.gl.bind({pid:7,sessionId:13,cmdbufAddr:0,cmdbufLen:0});
    new Uint32Array(memory.buffer,64,4).set([2,22,0,0]);
    expect(imports.host_gl_create_context(7,23,64,16,13)).toBe(0);
    expect(kernel.gl.get(7,13)!.objects).toBe(target.objects);
    imports.host_gl_unbind(7);
    expect(target.textures.size).toBe(0);
  });
  it("rejects malformed, missing, foreign-process, stale and incompatible sources without publishing a target",()=>{
    const {kernel,imports,memory,create}=harness(),gl=sharingRenderer();
    kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
    kernel.gl.attachCanvas(7,{width:1,height:1,getContext:()=>gl} as unknown as OffscreenCanvas);
    expect(create(7,21,11)).toBe(0);
    kernel.gl.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
    const target=kernel.gl.get(7,12)!,original=target.objects;
    for(const request of [[2,99,0,0],[2,21,1,0],[2,21,0,22],[1,21,0,0]]) {
      new Uint32Array(memory.buffer,64,4).set(request);
      expect(imports.host_gl_create_context(7,22,64,16,12)).toBe(-22);
      expect(target.contextId).toBeNull();expect(target.objects).toBe(original);
    }
    new Uint32Array(memory.buffer,64,4).set([2,21,0,0]);
    expect(imports.host_gl_create_context(7,22,64,12,12)).toBe(-22);
    kernel.gl.bind({pid:8,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
    expect(imports.host_gl_create_context(8,22,64,16,12)).toBe(-22);
    target.canvas={width:1,height:1,getContext:()=>sharingRenderer()} as unknown as OffscreenCanvas;
    expect(imports.host_gl_create_context(7,22,64,16,12)).toBe(-19);
    expect(target.contextId).toBeNull();expect(kernel.gl.get(7,11)!.contextId).toBe(21);
    target.canvas={width:1,height:1,getContext:()=>gl} as unknown as OffscreenCanvas;
    imports.host_gl_destroy_context(7,21);
    expect(imports.host_gl_create_context(7,22,64,16,12)).toBe(-22);
    expect(target.contextId).toBeNull();
  });
});
it("translates a shared kernel context identity to a reviewed forward session before acknowledgement",()=>{
  const {kernel,imports,memory,create}=harness();
  const calls:Array<[number|undefined,number|undefined]>=[];let rc=0;
  kernel.gl.attachMainForward(7,{onCreateContext:(session,source)=>{calls.push([session,source]);return rc;},onDestroyContext(){},onSubmit(){}});
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  kernel.gl.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
  expect(create(7,21,11)).toBe(0);
  const target=kernel.gl.get(7,12)!,source=kernel.gl.get(7,11)!;
  new Uint32Array(memory.buffer,64,4).set([2,21,0,0]);rc=-12;
  expect(imports.host_gl_create_context(7,22,64,16,12)).toBe(-12);
  expect(target.contextId).toBeNull();expect(source.contextId).toBe(21);
  rc=0;expect(imports.host_gl_create_context(7,22,64,16,12)).toBe(0);
  expect(target.contextId).toBe(22);expect(calls).toEqual([[11,undefined],[12,11],[12,11]]);
});
