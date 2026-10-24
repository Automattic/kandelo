import { expect, it, vi } from "vitest";
import { hasNativeRepair } from "../src/webgl/native-recovery.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { blitGpuScanout, ensurePresentTarget } from "../src/webgl/present-target.js";

function makeGl() {
  let next = 10;
  const texture = {id:1}, framebuffer = {id:2}, depthStencil = {id:3}, previousRenderbuffer = {id:4};
  const gl = {
    TEXTURE_BINDING_2D: 0x8069, TEXTURE_2D: 0x0de1, RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401, RENDERBUFFER: 0x8d41, RENDERBUFFER_BINDING: 0x8ca7,
    DEPTH24_STENCIL8: 0x88f0, DEPTH_STENCIL_ATTACHMENT: 0x821a,
    FRAMEBUFFER_COMPLETE: 0x8cd5, isContextLost: () => false, getError: () => 0, activeTexture: vi.fn(),
    getParameter: (p: number) => p === 0x84e0 ? 0x84c0 : p === 0x8ca7 ? previousRenderbuffer : null,
    createTexture: vi.fn(() => ({id:next++})).mockReturnValueOnce(texture), createFramebuffer: vi.fn(() => ({id:next++})).mockReturnValueOnce(framebuffer),
    createRenderbuffer: vi.fn(() => ({id:next++})).mockReturnValueOnce(depthStencil),
    bindTexture: vi.fn(), bindFramebuffer: vi.fn(), bindRenderbuffer: vi.fn(),
    texImage2D: vi.fn(), texParameteri: vi.fn(), framebufferTexture2D: vi.fn(),
    renderbufferStorage: vi.fn(), framebufferRenderbuffer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    deleteTexture: vi.fn(), deleteFramebuffer: vi.fn(), deleteRenderbuffer: vi.fn(),
  };
  return {gl, texture, framebuffer, depthStencil, previousRenderbuffer};
}

it("backs the EGL window with depth and stencil, resizes it, and releases it", () => {
  const {gl, texture, framebuffer, depthStencil, previousRenderbuffer} = makeGl();
  const registry = new GlContextRegistry();
  registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 0 });
  const binding = registry.get(1)!;
  binding.gl = gl as unknown as WebGL2RenderingContext;
  const canvas = { width: 640, height: 480 };
  binding.canvas = canvas as HTMLCanvasElement;
  expect(ensurePresentTarget(binding)).toBe(true);
  expect(gl.renderbufferStorage).toHaveBeenCalledWith(0x8d41, 0x88f0, 640, 480);
  expect(gl.framebufferRenderbuffer).toHaveBeenCalledWith(0x8ca9, 0x821a, 0x8d41, depthStencil);
  expect(gl.bindRenderbuffer).toHaveBeenLastCalledWith(0x8d41, previousRenderbuffer);
  canvas.width = 1280;
  canvas.height = 720;
  expect(ensurePresentTarget(binding)).toBe(true);
  expect(gl.renderbufferStorage).toHaveBeenLastCalledWith(0x8d41, 0x88f0, 1280, 720);
  expect(gl.createRenderbuffer).toHaveBeenCalledTimes(2);
  const resized = binding.presentTarget!;
  registry.unbind(1);
  expect(gl.deleteRenderbuffer).toHaveBeenCalledWith(resized.depthStencil);
  expect(gl.deleteTexture).toHaveBeenCalledWith(resized.tex);
  expect(gl.deleteFramebuffer).toHaveBeenCalledWith(resized.fbo);
  expect(gl.deleteRenderbuffer).toHaveBeenCalledWith(depthStencil);
  expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
  expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
});


it("preserves the drawable after a failed candidate resize and retries atomically", () => {
  const {gl, framebuffer} = makeGl();
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:0});
  const binding = registry.get(1)!; binding.gl = gl as unknown as WebGL2RenderingContext;
  const canvas = {width:640,height:480}; binding.canvas = canvas as HTMLCanvasElement;
  expect(ensurePresentTarget(binding)).toBe(true);
  const original = binding.presentTarget;
  gl.getParameter = p => p === 0x84e0 ? 0x84c0 : framebuffer;
  gl.checkFramebufferStatus.mockReturnValueOnce(0x8cd6); canvas.width = 1280;
  expect(ensurePresentTarget(binding)).toBe(false);
  expect(binding.presentTarget).toBe(original);
  expect(binding.renderTargetFbo).toBe(framebuffer);
  expect(binding.shadow.fbo).toBe(framebuffer);
  expect(gl.bindFramebuffer).toHaveBeenLastCalledWith(0x8ca9,framebuffer);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(framebuffer);
  expect(ensurePresentTarget(binding)).toBe(true);
  expect(binding.presentTarget).not.toBe(original);
  expect(binding.shadow.fbo).toBe(binding.presentTarget!.fbo);
  expect(gl.createFramebuffer).toHaveBeenCalledTimes(3);
  expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
  registry.unbind(1);
});

it.each(["allocation", "storage", "completeness", "lost renderer"])("keeps the old surface after candidate failure: %s", stage => {
  const {gl} = makeGl(); const reg = new GlContextRegistry();
  reg.bind({pid:1,cmdbufAddr:0,cmdbufLen:0}); const b = reg.get(1)!;
  b.gl = gl as unknown as WebGL2RenderingContext;
  const canvas = {width:4,height:3}; b.canvas = canvas as HTMLCanvasElement;
  expect(ensurePresentTarget(b)).toBe(true); const old = b.presentTarget!;
  canvas.width = 8;
  if (stage === "allocation") gl.createRenderbuffer.mockImplementationOnce(() => null!);
  if (stage === "storage") gl.texImage2D.mockImplementationOnce(() => { throw new Error("driver allocation failure"); });
  if (stage === "completeness") gl.checkFramebufferStatus.mockImplementationOnce(() => { throw new Error("driver status failure"); });
  if (stage === "lost renderer") gl.isContextLost = () => true;
  expect(ensurePresentTarget(b)).toBe(false);
  expect(b.presentTarget).toBe(old); expect(b.shadow.fbo).toBe(old.fbo);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(old.fbo);
  expect(gl.deleteTexture).not.toHaveBeenCalledWith(old.tex);
  expect(gl.deleteRenderbuffer).not.toHaveBeenCalledWith(old.depthStencil);
  gl.isContextLost = () => false;
  expect(ensurePresentTarget(b)).toBe(true);
  expect(b.presentTarget).not.toBe(old); reg.unbind(1);
});

const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_READ_FRAMEBUFFER_BINDING = 0x8caa;
const GL_DRAW_FRAMEBUFFER_BINDING = 0x8ca6;
const GL_SCISSOR_TEST = 0x0c11;
const GL_COLOR_BUFFER_BIT = 0x4000;
const GL_NEAREST = 0x2600;

class RecordingGl {
  readonly SCISSOR_TEST = GL_SCISSOR_TEST;
  readonly COLOR_BUFFER_BIT = GL_COLOR_BUFFER_BIT;
  readonly NEAREST = GL_NEAREST;
  log: Array<[string, unknown[]]> = [];
  read: unknown = { kind: "fbo", id: "guest-read" };
  draw: unknown = { kind: "fbo", id: "guest-draw" };
  scissor = true;

  getParameter(p: number) {
    if (p === GL_READ_FRAMEBUFFER_BINDING) return this.read;
    if (p === GL_DRAW_FRAMEBUFFER_BINDING) return this.draw;
    if (p === GL_SCISSOR_TEST) return this.scissor;
    return null;
  }
  bindFramebuffer(target: number, fbo: unknown) {
    this.log.push(["bindFramebuffer", [target, fbo]]);
  }
  blitFramebuffer(...args: number[]) { this.log.push(["blitFramebuffer", args]); }
  enable(cap: number) { this.log.push(["enable", [cap]]); }
  disable(cap: number) { this.log.push(["disable", [cap]]); }
}

it("copies a GPU scanout buffer onto the canvas with the top row first", () => {
  const gl = new RecordingGl();
  const registry = new GlContextRegistry();
  registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 0 });
  const binding = registry.get(1)!;
  binding.gl = gl as unknown as WebGL2RenderingContext;
  const fbo = { kind: "fbo", id: "scanout" } as unknown as WebGLFramebuffer;

  blitGpuScanout(binding, { fbo }, 640, 480);

  expect(gl.log).toEqual([
    ["disable", [GL_SCISSOR_TEST]],
    ["bindFramebuffer", [GL_READ_FRAMEBUFFER, fbo]],
    ["bindFramebuffer", [GL_DRAW_FRAMEBUFFER, null]],
    ["blitFramebuffer", [
      0, 0, 640, 480,
      0, 480, 640, 0,
      GL_COLOR_BUFFER_BIT, GL_NEAREST,
    ]],
    ["enable", [GL_SCISSOR_TEST]],
    ["bindFramebuffer", [GL_READ_FRAMEBUFFER, gl.read]],
    ["bindFramebuffer", [GL_DRAW_FRAMEBUFFER, gl.draw]],
  ]);
});

class SurfaceFailureGl {
  readonly TEXTURE_2D = 0x0de1; readonly RGBA = 0x1908; readonly UNSIGNED_BYTE = 0x1401;
  readonly RENDERBUFFER = 0x8d41; readonly DEPTH24_STENCIL8 = 0x88f0; readonly DEPTH_STENCIL_ATTACHMENT = 0x821a;
  readonly COLOR_ATTACHMENT0 = 0x8ce0; readonly FRAMEBUFFER_COMPLETE = 0x8cd5;
  readonly TEXTURE_MIN_FILTER = 0x2801; readonly TEXTURE_MAG_FILTER = 0x2800;
  readonly TEXTURE_WRAP_S = 0x2802; readonly TEXTURE_WRAP_T = 0x2803;
  readonly LINEAR = 0x2601; readonly CLAMP_TO_EDGE = 0x812f;
  readonly TEXTURE_BINDING_2D = 0x8069;
  readonly RENDERBUFFER_BINDING = 0x8ca7;
  readonly oldTexture = {}; readonly oldRead = {}; readonly oldDraw = {}; readonly oldRbo = {};
  active = 0x84c2; texture: object|null = this.oldTexture;
  read: object|null = this.oldRead; draw: object|null = this.oldDraw; rbo: object|null = this.oldRbo;
  errors:number[] = []; created:object[] = []; deleted:object[] = [];
  rejectStorage = false; rejectRestore = false; rejectDelete = false; storageCalls = 0;
  isContextLost() { return false; }
  getError() { return this.errors.shift() ?? 0; }
  getParameter(p:number) { return p === 0x84e0 ? this.active : p === 0x8069 ? this.texture : p === 0x8caa ? this.read : p === 0x8ca6 ? this.draw : p === 0x8ca7 ? this.rbo : null; }
  activeTexture(unit:number) { this.active = unit; }
  bindTexture(_target:number,value:object|null) {
    if (this.rejectRestore && value === this.oldTexture) { this.errors.push(0x505); return; }
    this.texture = value;
  }
  bindRenderbuffer(_target:number,value:object|null) { this.rbo = value; }
  bindFramebuffer(target:number,value:object|null) { if (target !== 0x8ca8) this.draw = value; if (target !== 0x8ca9) this.read = value; }
  createTexture() { const value = {}; this.created.push(value); return value; }
  createFramebuffer() { const value = {}; this.created.push(value); return value; }
  createRenderbuffer() { const value = {}; this.created.push(value); return value; }
  texImage2D() { this.storageCalls++; if (this.rejectStorage) this.errors.push(0x505); }
  texParameteri() {} framebufferTexture2D() {} renderbufferStorage() {} framebufferRenderbuffer() {}
  checkFramebufferStatus() { return 0x8cd5; }
  deleteFramebuffer(value:object) { if (this.rejectDelete) this.errors.push(0x505); else this.deleted.push(value); }
  deleteTexture(value:object) { this.deleted.push(value); }
  deleteRenderbuffer(value:object) { this.deleted.push(value); }
}

for (const stage of ["storage","finalizer"] as const) {
  it(`retains failed surface ${stage} restoration and candidate cleanup after creator retirement`, () => {
    const reg = new GlContextRegistry(), native = new SurfaceFailureGl();
    const gl = native as unknown as WebGL2RenderingContext;
    reg.bind({pid:1,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
    reg.bind({pid:1,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
    const b = reg.get(1,11)!, peer = reg.get(1,12)!; b.gl = peer.gl = gl;
    b.canvas = {width:4,height:3} as HTMLCanvasElement;
    native.rejectStorage = stage === "storage"; native.rejectRestore = true;
    expect(ensurePresentTarget(b)).toBe(false); expect(b.presentTarget).toBeNull();
    expect(hasNativeRepair(gl)).toBe(true); expect(native.deleted).toEqual([]);
    const allocations = native.created.length, out = new Uint8Array(4).fill(165);
    reg.unbind(1,11);
    expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
    expect([...out]).toEqual([165,165,165,165]); expect(native.created).toHaveLength(allocations);
    native.rejectRestore = false; native.rejectDelete = true;
    expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
    expect([native.active,native.texture,native.read,native.draw,native.rbo]).toEqual([0x84c2,native.oldTexture,native.oldRead,native.oldDraw,native.oldRbo]);
    native.rejectDelete = false;
    expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
    expect([...out]).toEqual([0,0,0,0]); expect(hasNativeRepair(gl)).toBe(false);
    expect(native.deleted).toHaveLength(3);
    for (const object of native.created) expect(native.deleted.filter(value=>value === object)).toHaveLength(1);
    expect(native.storageCalls).toBe(1); expect(b.errors).toEqual([]); expect(peer.errors).toEqual([]);
    reg.unbind(1,12);
  });
}

it("keeps accepted resized storage while old native deletion remains fenced", () => {
  const reg = new GlContextRegistry(), native = new SurfaceFailureGl();
  const gl = native as unknown as WebGL2RenderingContext;
  reg.bind({pid:1,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const b = reg.get(1,11)!; b.gl = gl; b.canvas = {width:4,height:3} as HTMLCanvasElement;
  expect(ensurePresentTarget(b)).toBe(true); const old = b.presentTarget!;
  native.rejectDelete = true; b.canvas.width = 8;
  expect(ensurePresentTarget(b)).toBe(true); const accepted = b.presentTarget!;
  expect(accepted).not.toBe(old); expect(b.shadow.fbo).toBe(accepted.fbo);
  expect(hasNativeRepair(gl)).toBe(true);
  const output = new Uint8Array(4).fill(165);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),output)).toBe(-5);
  native.rejectDelete = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),output)).toBe(4);
  expect(b.presentTarget).toBe(accepted); expect(native.storageCalls).toBe(2);
  reg.unbind(1,11);
  for (const object of native.created) expect(native.deleted.filter(value=>value === object)).toHaveLength(1);
});
