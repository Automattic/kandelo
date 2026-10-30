import { expect, it } from "vitest";
import { drawGpuScanout, readGpuScanout } from "../src/webgl/kms-scanout";
import { createWasmPosixKernelTestHarness } from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { hasNativeRepair, repairNativeState } from "../src/webgl/native-recovery";

function renderer() {
  const read = {}, draw = {}, pack = {}, fbo = {};
  const state = new Map<number, unknown>([
    [0x8caa, read], [0x8ca6, draw], [0x88ed, pack], [0x0c11, true],
    [0x0d05, 8], [0x0d02, 19], [0x0d04, 3], [0x0d03, 5],
    [0x84e0, 0x84c0], [0x8069, null], [0x8ca7, null],
    [0x0c23, [true, false, true, false]], [0x0c22, [0.25, 0.5, 0.75, 0.125]],
  ]);
  const initial = new Map(state), calls: unknown[][] = [];
  let error = 0, rejectRead = false, rejectRestore = false, lost = false;
  let content = [255, 0, 0, 255];
  const gl = {
    isContextLost: () => lost,
    activeTexture: (value: number) => state.set(0x84e0, value),
    createTexture: () => ({}), createFramebuffer: () => fbo, createRenderbuffer: () => ({}),
    deleteTexture() {}, deleteFramebuffer() {}, deleteRenderbuffer() {},
    bindTexture: (_target: number, value: unknown) => state.set(0x8069, value),
    bindRenderbuffer: (_target: number, value: unknown) => state.set(0x8ca7, value),
    texImage2D() {}, texParameteri() {}, framebufferTexture2D() {},
    renderbufferStorage() {}, framebufferRenderbuffer() {}, checkFramebufferStatus: () => 0x8cd5,
    getError() { const result = error; error = 0; return result; },
    getParameter: (name: number) => state.get(name),
    enable: (name: number) => state.set(name, true),
    disable: (name: number) => state.set(name, false),
    bindFramebuffer(target: number, value: unknown) {
      if (target === 0x8ca8 && value === read && rejectRestore) { error = 0x502; return; }
      if (target === 0x8d40) state.set(0x8caa, value);
      state.set(target === 0x8ca8 ? 0x8caa : 0x8ca6, value);
    },
    bindBuffer: (_target: number, value: unknown) => state.set(0x88ed, value),
    pixelStorei: (name: number, value: number) => state.set(name, value),
    colorMask: (...value: boolean[]) => state.set(0x0c23, value),
    clearColor: (...value: number[]) => state.set(0x0c22, value),
    clear(mask: number) {
      expect(mask).toBe(0x4000);
      expect(state.get(0x8ca6)).toBeNull();
      expect(state.get(0x0c23)).toEqual([false, false, false, true]);
      expect(state.get(0x0c22)).toEqual([0, 0, 0, 1]);
      calls.push(["opaque primary"]);
    },
    blitFramebuffer(...args: unknown[]) {
      expect(state.get(0x8caa)).toBe(fbo);
      expect(state.get(0x8ca6)).toBeNull();
      expect(state.get(0x0c11)).toBe(false);
      calls.push(args);
    },
    readPixels(_x: number, _y: number, _w: number, _h: number,
      _format: number, _type: number, pixels: Uint8Array) {
      expect(state.get(0x8caa)).toBe(fbo);
      expect(state.get(0x88ed)).toBeNull();
      expect([0x0d05, 0x0d02, 0x0d04, 0x0d03].map(name => state.get(name)))
        .toEqual([1, 0, 0, 0]);
      if (rejectRead) { error = 0x502; return; }
      pixels.set(content);
      calls.push(["readPixels", pixels]);
    },
  } as unknown as WebGL2RenderingContext;
  return { gl, state, initial, calls, storage: { gl, fbo, w: 2, h: 2 },
    setPixels: (pixels: number[]) => { content = pixels; },
    loseContext: () => { lost = true; },
    failRead: () => { rejectRead = true; },
    allowRead: () => { rejectRead = false; },
    failRestore: () => { rejectRestore = true; },
    allowRestore: () => { rejectRestore = false; },
  };
}

it("blits only the selected GPU framebuffer and restores both selectors and scissor", () => {
  const r = renderer();
  expect(drawGpuScanout(r.storage, 2, 2)).toBe(true);
  expect(r.calls).toEqual([[0, 0, 2, 2, 0, 2, 2, 0, 0x4000, 0x2600], ["opaque primary"]]);
  expect(r.state).toEqual(r.initial);
  expect(hasNativeRepair(r.gl)).toBe(false);
});

it("copies GPU pixels into independent bytes and restores the caller's pack layout", () => {
  const r = renderer();
  const pixels = readGpuScanout(r.storage, 2, 2)!;
  expect(pixels.buffer).toBeInstanceOf(ArrayBuffer);
  expect(pixels.byteLength).toBe(16);
  expect([...pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  expect(r.state).toEqual(r.initial);
  expect(hasNativeRepair(r.gl)).toBe(false);
});

it("rejects invalid readback geometry before native mutation or allocation", () => {
  const r = renderer();
  for (const [w, h] of [[0, 1], [-1, 1], [1.5, 1], [3, 1], [1, 3], [Number.MAX_SAFE_INTEGER, 2]]) {
    expect(readGpuScanout(r.storage, w, h)).toBeNull();
  }
  expect(r.calls).toEqual([]);
  expect(r.state).toEqual(r.initial);
});

it("retains a rejected restoration and fences later GPU presentation until repair", () => {
  const r = renderer();
  r.failRead();
  r.failRestore();
  expect(readGpuScanout(r.storage, 2, 2)).toBeNull();
  expect(hasNativeRepair(r.gl)).toBe(true);
  expect(drawGpuScanout(r.storage, 2, 2)).toBe(false);
  expect(r.calls).toEqual([]);
  // Independent inverse groups still restored the pack buffer and layout.
  expect(r.state.get(0x88ed)).toBe(r.initial.get(0x88ed));
  expect(r.state.get(0x0d05)).toBe(8);
  r.allowRestore();
  expect(repairNativeState(r.gl)).toBe(true);
  expect(r.state).toEqual(r.initial);
  expect(drawGpuScanout(r.storage, 2, 2)).toBe(true);
});

it("presents actual rendered GPU cursor bytes through the kernel's shared KMS registry", () => {
  const r = renderer();
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({io: {} as any, callbacks: {}, memory,
    pointerWidth: 4, instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096)});
  expect(kernel.gl.createGpuBo(42, r.gl, 2, 2)).toBeGreaterThan(0);
  kernel.kms.setMaster(100, 1n, 1n);
  // No CPU mirror exists: this is the framebuffer actually painted by GL.
  kernel.kms.setCursor(100, 3, 42, 2, 2, -1, 4, 0, 0);
  expect(Array.from(kernel.kms.cursorSnapshot().pixels!.slice(0, 4))).toEqual([255, 0, 0, 255]);
  expect(r.state).toEqual(r.initial);
  // Readback is RGBA, not CPU ARGB, and remains premultiplied until
  // converted for the cursor canvas. Row zero stays the KMS top row.
  r.setPixels([0, 64, 0, 128, 0, 0, 0, 0, 64, 0, 0, 128, 0, 0, 255, 255]);
  const updated = kernel.kms.cursorSnapshot();
  expect(Array.from(updated.pixels!)).toEqual([0, 128, 0, 128, 0, 0, 0, 0, 128, 0, 0, 128, 0, 0, 255, 255]);
  r.loseContext();
  expect(kernel.kms.cursorSnapshot().pixels).toBeNull();
  expect(updated.pixels![1]).toBe(128);
  kernel.kms.dropMaster(1n, 1n);
  expect(kernel.kms.cursorSnapshot().pixels).toBeNull();
  const imports = kernel.testAuthority.buildImportObject(memory) as {env: Record<string, (...args: number[]) => void>};
  imports.env.host_gbm_bo_destroy(100, 42);
  expect(kernel.gl.gpuBo(42)).toBeUndefined();
});

it("keeps GPU cursor readback failures visible and restores the selected peer", () => {
  const r = renderer();
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({io: {} as any, callbacks: {}, memory,
    pointerWidth: 4, instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096)});
  expect(kernel.gl.createGpuBo(42, r.gl, 2, 2)).toBeGreaterThan(0);
  kernel.kms.setMaster(100, 1n, 1n);
  r.failRead();
  expect(() => kernel.kms.setCursor(100, 1, 42, 2, 2, 0, 0, 0, 0)).toThrow("GPU cursor readback failed");
  expect(r.state).toEqual(r.initial);
  r.failRestore();
  expect(() => kernel.kms.cursorSnapshot()).toThrow("GPU cursor readback failed");
  expect(hasNativeRepair(r.gl)).toBe(true);
  r.allowRead(); r.allowRestore();
  // Retry the same retained storage only after its inverse journal repairs.
  expect(kernel.kms.cursorSnapshot().pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
  expect(hasNativeRepair(r.gl)).toBe(false);
  expect(r.state).toEqual(r.initial);
});
