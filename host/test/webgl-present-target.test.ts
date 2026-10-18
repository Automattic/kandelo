import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { blitGpuScanout, ensurePresentTarget } from "../src/webgl/present-target.js";

function makeGl() {
  const texture = {}, framebuffer = {}, depthStencil = {}, previousRenderbuffer = {};
  const gl = {
    TEXTURE_BINDING_2D: 0x8069, TEXTURE_2D: 0x0de1, RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401, RENDERBUFFER: 0x8d41, RENDERBUFFER_BINDING: 0x8ca7,
    DEPTH24_STENCIL8: 0x88f0, DEPTH_STENCIL_ATTACHMENT: 0x821a,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    getParameter: (p: number) => p === 0x8ca7 ? previousRenderbuffer : null,
    createTexture: vi.fn(() => texture), createFramebuffer: vi.fn(() => framebuffer),
    createRenderbuffer: vi.fn(() => depthStencil),
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
  expect(gl.createRenderbuffer).toHaveBeenCalledTimes(1);
  registry.unbind(1);
  expect(gl.deleteRenderbuffer).toHaveBeenCalledExactlyOnceWith(depthStencil);
  expect(gl.deleteTexture).toHaveBeenCalledExactlyOnceWith(texture);
  expect(gl.deleteFramebuffer).toHaveBeenCalledExactlyOnceWith(framebuffer);
});


it("clears deleted framebuffer references after a failed resize and can retry", () => {
  const {gl, framebuffer, depthStencil} = makeGl();
  const registry = new GlContextRegistry();
  registry.bind({pid:1, cmdbufAddr:0, cmdbufLen:0});
  const binding = registry.get(1)!;
  binding.gl = gl as unknown as WebGL2RenderingContext;
  const canvas = {width:640, height:480};
  binding.canvas = canvas as HTMLCanvasElement;
  expect(ensurePresentTarget(binding)).toBe(true);
  gl.getParameter = () => framebuffer;
  gl.checkFramebufferStatus.mockReturnValueOnce(0x8cd6);
  canvas.width = 1280;
  expect(ensurePresentTarget(binding)).toBe(false);
  expect(binding.presentTarget).toBeNull();
  expect(binding.renderTargetFbo).toBeNull();
  expect(binding.shadow.fbo).toBeNull();
  expect(gl.bindFramebuffer).toHaveBeenCalledWith(0x8ca8, null);
  expect(gl.bindFramebuffer).toHaveBeenLastCalledWith(0x8ca9, null);
  expect(gl.deleteRenderbuffer).toHaveBeenCalledWith(depthStencil);
  expect(ensurePresentTarget(binding)).toBe(true);
  expect(gl.createFramebuffer).toHaveBeenCalledTimes(2);
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
