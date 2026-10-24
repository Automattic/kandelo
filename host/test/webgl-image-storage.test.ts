import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { registerImageSource, textureNative, canonicalTexture, WPK_IMAGE_SOURCE_TARGET } from "../src/webgl/image-storage.js";
import { runGlQuery } from "../src/webgl/query.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import * as O from "../src/webgl/ops.js";
function setup() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = reg.get(7, 11)!;
  const gl = new Proxy({ getError: () => 0, getParameter: () => null, isTexture: () => true, isRenderbuffer: () => true }, { get: (target, name) => Reflect.get(target, name) ?? (() => null) }) as unknown as WebGL2RenderingContext;
  b.gl = gl;
  b.contextId = 21;
  return { reg, b, gl };
}
function checked(b: ReturnType<typeof setup>["b"], op: number, words: number[], size = 12) {
  const out = new Uint8Array(size), input = new Uint8Array(new Uint32Array(words).buffer);
  expect(runGlQuery(b, op, input, out)).toBe(size);
  return new Uint32Array(out.buffer);
}
it("keeps source tokens separate from every legal public texture name and reuses one live BO source", () => {
  const { b } = setup(), publicTexture = {} as WebGLTexture, source = {} as WebGLTexture;
  b.textures.set(1, publicTexture);
  b.textures.set(0x60000000, publicTexture);
  expect(registerImageSource(b, 41, source, 2, 3)).toBe(1);
  expect(registerImageSource(b, 41, source, 2, 3)).toBe(1);
  expect(b.imageSources.size).toBe(1);
  expect(b.textures.get(1)).toBe(publicTexture);
  expect(b.textures.get(0x60000000)).toBe(publicTexture);
  b.imageSources.delete(1);
  expect(registerImageSource(b, 42, source, 4, 4)).toBe(2);
  b.nextImageSource = 0x80000000;
  expect(registerImageSource(b, 43, source, 4, 4)).toBe(-12);
  expect(b.imageSources.size).toBe(1);
});
it("preserves the source allocator and public names on metadata allocation failure", () => {
  const { b } = setup(), set = b.imageSources.set;
  b.imageSources.set = () => { throw new RangeError("allocation failed"); };
  try {
    expect(registerImageSource(b, 41, {} as WebGLTexture, 1, 1)).toBe(-12);
  }
  finally {
    b.imageSources.set = set;
  }
  expect(b.nextImageSource).toBe(1);
  expect(b.imageSources.size).toBe(0);
  expect(b.textures.size).toBe(0);
});
it("rejects incomplete image requests and reply spans before invoking the renderer", () => {
  const { b } = setup();
  for (const op of [O.QOP_IMAGE_TARGET, O.QOP_IMAGE_SOURCE_STATE])
    for (const length of [0, 4, 16]) {
      const out = new Uint8Array(12).fill(0xa5);
      expect(runGlQuery(b, op, new Uint8Array(length), out)).toBe(-22);
      expect([...out]).toEqual(Array(12).fill(0xa5));
    }
  for (const length of [0, 8, 16])
    expect(runGlQuery(b, O.QOP_IMAGE_TARGET, new Uint8Array(12), new Uint8Array(length))).toBe(-22);
  expect(b.textureViews.size).toBe(0);
  expect(b.errors).toEqual([]);
});
it("rejects unknown sources and unrealized names without publishing image state", () => {
  const { b } = setup();
  b.textures.set(17, {} as WebGLTexture);
  expect([...checked(b, O.QOP_IMAGE_TARGET, [1, 17, 8])]).toEqual([1, 0, 0x47514c33]);
  expect([...checked(b, O.QOP_IMAGE_TARGET, [1, 18, 8])]).toEqual([1, 0, 0x47514c33]);
  expect([...checked(b, O.QOP_IMAGE_SOURCE_STATE, [1, 18])]).toEqual([1, 0, 0x47514c33]);
  expect(b.textureViews.size).toBe(0);
  expect(b.textures.size).toBe(1);
});
it("queries logical names and realization through a native view after the old native anchor is gone", () => {
  const { b, gl } = setup(), anchor = {} as WebGLTexture, view = {} as WebGLTexture;
  b.textures.set(17, anchor);
  b.textureViews.set(anchor, { native: view, source: null, read: null });
  b.textureViewOwners.set(view, anchor);
  Object.assign(gl, { getParameter: () => view, isTexture: (value: WebGLTexture) => value === view });
  expect(textureNative(b, anchor)).toBe(view);
  expect(canonicalTexture(b, view)).toBe(anchor);
  const out = new Uint8Array(4);
  expect(runGlQuery(b, O.QOP_GET_INTEGERV, new Uint8Array(new Uint32Array([0x8069]).buffer), out)).toBe(4);
  expect(new Uint32Array(out.buffer)[0]).toBe(17);
  expect(checked(b, O.QOP_IS_OBJECT, [1, 17])[1]).toBe(1);
  expect(checked(b, O.QOP_IMAGE_SOURCE_STATE, [1, 17])[1]).toBe(0);
});
it("reports logical renderbuffer dimensions and attachment type for imported texture backing", () => {
  const { b } = setup(), object = {} as WebGLRenderbuffer, fbo = {} as WebGLFramebuffer;
  b.rbos.set(19, object);
  b.shadow.renderbuffer = object;
  b.shadow.fbo = b.shadow.readFbo = fbo;
  b.renderbufferViews.set(object, { native: object, source: { token: 1, bo: 41, texture: {} as WebGLTexture, width: 7, height: 9 } });
  b.framebufferAttachments.set(fbo, new Map([[0x8ce0, { kind: "renderbuffer", object }]]));
  expect(checked(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d42])[1]).toBe(7);
  expect(checked(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d43])[1]).toBe(9);
  expect(checked(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d44])[1]).toBe(0x8058);
  expect([...checked(b, O.QOP_GET_FB_ATTACHMENT, [0x8d40, 0x8ce0], 24)].slice(0, 3)).toEqual([0, 0x8d41, 19]);
});
it("registers a GPU source through the actual kernel host import without overwriting a public texture", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({ io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096) });
  const api = (kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => number>;
  }).env;
  const gl = new Proxy({ getError: () => 0, getParameter: () => null, createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
    FRAMEBUFFER_COMPLETE: 0x8cd5, checkFramebufferStatus: () => 0x8cd5 }, { get: (target, name) => Reflect.get(target, name) ?? (() => { }) }) as unknown as WebGL2RenderingContext;
  kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = kernel.gl.get(7, 11)!;
  b.gl = gl;
  b.contextId = 21;
  const ordinary = {} as WebGLTexture;
  b.textures.set(0x60000000, ordinary);
  expect(kernel.gl.createGpuBo(41, gl, 2, 2)).toBe(0x60000000);
  expect(api.host_gl_bind_foreign_texture(7, 21, 41, WPK_IMAGE_SOURCE_TARGET)).toBe(1);
  expect(b.textures.get(0x60000000)).toBe(ordinary);
  expect(b.textures.size).toBe(1);
  expect(b.imageSources.size).toBe(1);
  expect(api.host_gl_bind_foreign_texture(7, 21, 999, WPK_IMAGE_SOURCE_TARGET)).toBe(-22);
});
