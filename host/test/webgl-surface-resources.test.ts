import { expect, it, vi } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { applyCurrentDrawable, prepareCurrentDrawable } from "../src/webgl/current.js";
import { defaultFramebuffer } from "../src/webgl/framebuffer.js";
import { ensurePresentTarget } from "../src/webgl/present-target.js";
import { releaseSurfaceResources } from "../src/webgl/surface-resources.js";

function renderer() {
  let next = 1;
  return {
    TEXTURE_BINDING_2D: 0x8069, TEXTURE_2D: 0xde1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    RENDERBUFFER: 0x8d41, RENDERBUFFER_BINDING: 0x8ca7,
    DEPTH24_STENCIL8: 0x88f0, DEPTH_STENCIL_ATTACHMENT: 0x821a,
    COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_COMPLETE: 0x8cd5, isContextLost: () => false,
    getParameter: vi.fn(() => null), getError: () => 0,
    createTexture: vi.fn(() => ({id:next++})), createFramebuffer: vi.fn(() => ({id:next++})), createRenderbuffer: vi.fn(() => ({id:next++})),
    bindTexture: vi.fn(), bindFramebuffer: vi.fn(), bindRenderbuffer: vi.fn(),
    texImage2D: vi.fn(), texParameteri: vi.fn(), framebufferTexture2D: vi.fn(),
    renderbufferStorage: vi.fn(), framebufferRenderbuffer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    deleteTexture: vi.fn(), deleteFramebuffer: vi.fn(), deleteRenderbuffer: vi.fn(),
  };
}
function binding(reg: GlContextRegistry, gl: ReturnType<typeof renderer>, sessionId: number, surfaceId: number | null, pid = 1) {
  reg.bind({pid,sessionId,cmdbufAddr:0,cmdbufLen:0});
  const b = reg.get(pid,sessionId)!;
  b.gl = gl as unknown as WebGL2RenderingContext; b.contextId = sessionId;
  b.surfaceId = surfaceId; b.canvas = {width:4,height:3} as HTMLCanvasElement;
  if (surfaceId !== null) expect(ensurePresentTarget(b)).toBe(true);
  return b;
}
function select(b: GlBinding, draw: GlBinding, read = draw) {
  return applyCurrentDrawable(b,{drawSurfaceId:draw.surfaceId!,readSurfaceId:read.surfaceId!,width:4,height:3},
    {draw:draw.surface,read:read.surface});
}

it("retains a surface's native storage across context destruction and replacement", () => {
  const reg = new GlContextRegistry(), gl = renderer(), b = binding(reg,gl,10,71);
  const surface = b.surface, target = b.presentTarget!;
  expect(select(b,b)).toBe(true);
  reg.destroyContext(1,10);
  expect(b.gl).toBeNull(); expect(b.surface).toBe(surface); expect(b.presentTarget).toBe(target);
  expect(surface.users.size).toBe(0); expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(target.fbo);
  b.gl = gl as unknown as WebGL2RenderingContext; b.contextId = 99;
  expect(ensurePresentTarget(b)).toBe(true); expect(b.presentTarget).toBe(target);
  expect(select(b,b)).toBe(true); expect(defaultFramebuffer(b)).toBe(target.fbo);
  reg.destroySurface(1,10);
  expect(b.surfaceId).toBeNull(); expect(defaultFramebuffer(b)).toBe(target.fbo);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(target.fbo);
  releaseSurfaceResources(b);
  expect(gl.deleteFramebuffer).toHaveBeenCalledExactlyOnceWith(target.fbo);
  expect(gl.deleteTexture).toHaveBeenCalledExactlyOnceWith(target.tex);
  expect(gl.deleteRenderbuffer).toHaveBeenCalledExactlyOnceWith(target.depthStencil);
  reg.unbind(1);
});

it("keeps independent draw/read surfaces alive after their owner descriptions retire", () => {
  const reg = new GlContextRegistry(), gl = renderer();
  const a = binding(reg,gl,10,71), b = binding(reg,gl,11,72), c = binding(reg,gl,12,null);
  const draw = a.surface, read = b.surface, drawTarget = a.presentTarget!, readTarget = b.presentTarget!;
  expect(select(c,a,b)).toBe(true);
  expect(c.shadow.fbo).toBe(drawTarget.fbo); expect(c.shadow.readFbo).toBe(readTarget.fbo);
  expect(draw.users.size).toBe(1); expect(read.users.size).toBe(1);
  reg.unbind(1,10); reg.unbind(1,11);
  expect(draw.ownerAlive).toBe(false); expect(read.ownerAlive).toBe(false);
  expect(defaultFramebuffer(c)).toBe(drawTarget.fbo); expect(defaultFramebuffer(c,true)).toBe(readTarget.fbo);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(drawTarget.fbo);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(readTarget.fbo);
  const user = {} as WebGLFramebuffer; c.shadow.fbo = user;
  releaseSurfaceResources(c);
  expect(c.shadow.fbo).toBe(user); expect(c.shadow.readFbo).toBeNull();
  expect(gl.deleteFramebuffer.mock.calls.filter(([f]) => f === drawTarget.fbo)).toHaveLength(1);
  expect(gl.deleteFramebuffer.mock.calls.filter(([f]) => f === readTarget.fbo)).toHaveLength(1);
  expect(draw.users.size).toBe(0); expect(read.users.size).toBe(0);
  reg.unbind(1,12);
});

it("replaces a surface allocation across selectors while preserving user FBOs and other read targets", () => {
  const reg = new GlContextRegistry(), gl = renderer();
  const a = binding(reg,gl,10,71), b = binding(reg,gl,11,72);
  const c = binding(reg,gl,12,null), d = binding(reg,gl,13,null);
  expect(select(c,a,b)).toBe(true); expect(select(d,a,a)).toBe(true);
  const old = a.presentTarget!, read = b.presentTarget!, user = {} as WebGLFramebuffer;
  d.shadow.fbo = user; a.canvas!.width = 8;
  expect(ensurePresentTarget(a)).toBe(true);
  const next = a.presentTarget!;
  expect(next.fbo).not.toBe(old.fbo);
  expect(c.shadow.fbo).toBe(next.fbo); expect(c.shadow.readFbo).toBe(read.fbo);
  expect(d.shadow.fbo).toBe(user); expect(d.shadow.readFbo).toBe(next.fbo);
  expect(gl.deleteFramebuffer).toHaveBeenCalledWith(old.fbo);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(read.fbo);
  reg.unbind(1);
});

it("rejects foreign, mismatched and retired surface bindings before changing ownership", () => {
  const reg = new GlContextRegistry(), gl = renderer();
  const a = binding(reg,gl,10,71), c = binding(reg,gl,12,null);
  expect(select(c,a)).toBe(true);
  const previous = c.currentDrawable, viewport = c.shadow.viewport;
  const foreign = binding(reg,gl,11,72,2), otherRenderer = binding(reg,renderer(),14,73);
  expect(select(c,foreign)).toBe(false); expect(select(c,otherRenderer)).toBe(false);
  expect(applyCurrentDrawable(c,{drawSurfaceId:99,readSurfaceId:71,width:4,height:3},{draw:a.surface,read:a.surface})).toBe(false);
  const old = a.surface; reg.unbind(1,10);
  expect(applyCurrentDrawable(c,{drawSurfaceId:71,readSurfaceId:71,width:4,height:3},{draw:old,read:old})).toBe(false);
  expect(c.currentDrawable).toBe(previous); expect(c.shadow.viewport).toBe(viewport);
  expect(old.users.has(c)).toBe(true); expect(foreign.surface.users.size).toBe(0);
  reg.unbind(1); reg.unbind(2);
});

it("cancels a prepared bind without releasing retained storage or publishing viewport/default state", () => {
  const reg = new GlContextRegistry(), gl = renderer();
  const a = binding(reg,gl,10,71), c = binding(reg,gl,12,null);
  expect(select(c,a)).toBe(true);
  const old = a.surface, target = a.presentTarget!; reg.unbind(1,10);
  const previous = c.currentDrawable, viewport = c.shadow.viewport;
  const candidate = prepareCurrentDrawable(c,{drawSurfaceId:0,readSurfaceId:0,width:0,height:0})!;
  expect(c.undefinedDefaultFbo).toBeNull(); expect(c.currentDrawable).toBe(previous);
  candidate.cancel();
  expect(c.shadow.viewport).toBe(viewport); expect(old.users.has(c)).toBe(true);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalledWith(target.fbo);
  const accepted = prepareCurrentDrawable(c,{drawSurfaceId:0,readSurfaceId:0,width:0,height:0})!;
  accepted.commit(); accepted.cancel();
  expect(c.drawSurface).toBeNull(); expect(c.readSurface).toBeNull();
  expect(c.shadow.fbo).toBe(c.undefinedDefaultFbo); expect(old.users.size).toBe(0);
  expect(gl.deleteFramebuffer).toHaveBeenCalledWith(target.fbo);
  reg.unbind(1);
});

it("restores separate EGL draw/read defaults when framebuffer zero is rebound", async () => {
  const {decodeAndDispatch} = await import("../src/webgl/bridge.js");
  const O = await import("../src/webgl/ops.js");
  const reg = new GlContextRegistry(), gl = renderer();
  const a = binding(reg,gl,10,71), b = binding(reg,gl,11,72), c = binding(reg,gl,12,null);
  expect(select(c,a,b)).toBe(true);
  const user = {id:99} as WebGLFramebuffer; c.fbos.set(99,user);
  c.cmdbufView = new Uint8Array(12);
  const send = (name: number) => {
    const view = new DataView(c.cmdbufView!.buffer);
    view.setUint16(0,O.OP_BIND_FRAMEBUFFER,true); view.setUint16(2,8,true);
    view.setUint32(4,0x8d40,true); view.setUint32(8,name,true);
    expect(decodeAndDispatch(c,0,12)).toBe(0);
  };
  send(99); expect(c.shadow.fbo).toBe(user); expect(c.shadow.readFbo).toBe(user);
  send(0);
  expect(c.shadow.fbo).toBe(a.presentTarget!.fbo);
  expect(c.shadow.readFbo).toBe(b.presentTarget!.fbo);
  expect(gl.bindFramebuffer).toHaveBeenCalledWith(0x8ca9,a.presentTarget!.fbo);
  expect(gl.bindFramebuffer).toHaveBeenLastCalledWith(0x8ca8,b.presentTarget!.fbo);
  send(99);
  let error = 0;
  gl.getError = () => { const value = error; error = 0; return value; };
  gl.bindFramebuffer.mockImplementation((target: number, fbo: WebGLFramebuffer | null) => {
    if (target === 0x8ca8 && fbo === b.presentTarget!.fbo) error = 0x502;
  });
  send(0);
  expect(c.errors).toContain(0x502);
  expect(c.shadow.fbo).toBe(user); expect(c.shadow.readFbo).toBe(user);
  expect(gl.bindFramebuffer).toHaveBeenLastCalledWith(0x8ca8,user);
  gl.bindFramebuffer.mockReset(); send(0);
  expect(c.shadow.fbo).toBe(a.presentTarget!.fbo); expect(c.shadow.readFbo).toBe(b.presentTarget!.fbo);
  reg.unbind(1);
});
