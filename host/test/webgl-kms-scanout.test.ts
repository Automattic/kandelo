import { expect, it } from "vitest";
import { drawGpuScanout, readGpuScanout } from "../src/webgl/kms-scanout";
import { createWasmPosixKernelTestHarness, getKernelGraphicsAccess } from "../src/kernel";
import { defaultShadow } from "../src/webgl/shadow";
import type { GlMuxer } from "../src/webgl/muxer";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { OP_CLEAR, QOP_SURFACE_CAPABILITIES } from "../src/webgl/ops";
import { KMS_CURSOR_FRAMEBUFFER_OFFSET, KMS_CURSOR_RECORD_BYTES } from "../src/dri/kms-cursor-protocol";
import { hasNativeRepair, repairNativeState, reserveNativeRetirement } from "../src/webgl/native-recovery";

function renderer() {
  const read = {}, draw = {}, pack = {}, fbo = {};
  const state = new Map<number, unknown>([
    [0x8caa, read], [0x8ca6, draw], [0x88ed, pack], [0x0c11, true],
    [0x0d05, 8], [0x0d02, 19], [0x0d04, 3], [0x0d03, 5],
    [0x84e0, 0x84c0], [0x8069, null], [0x8ca7, null], [0x8869, 8],
    [0x0c23, [true, false, true, false]], [0x0c22, [0.25, 0.5, 0.75, 0.125]],
  ]);
  const initial = new Map(state), calls: unknown[][] = [];
  let error = 0, rejectRead = false, rejectRestore = false, lost = false;
  let content = [255, 0, 0, 255], afterRead = () => {};
  const gl = {
    isContextLost: () => lost,
    createVertexArray: () => ({}),
    bindVertexArray() { calls.push(["select vertex array"]); },
    viewport() {}, scissor() {}, clearDepth() {}, clearStencil() {}, lineWidth() {},
    depthRange() {}, polygonOffset() {}, sampleCoverage() {}, depthMask() {}, depthFunc() {},
    stencilFuncSeparate() {}, stencilMaskSeparate() {}, stencilOpSeparate() {},
    blendColor() {}, blendFuncSeparate() {}, blendEquationSeparate() {},
    cullFace() {}, frontFace() {}, useProgram() {}, vertexAttrib4f() {},
    activeTexture: (value: number) => state.set(0x84e0, value),
    createTexture: () => ({}), createFramebuffer: () => fbo, createRenderbuffer: () => ({}),
    deleteTexture() {}, deleteFramebuffer() {}, deleteRenderbuffer() {}, deleteVertexArray() {},
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
    bindBuffer: (target: number, value: unknown) => {
      if (target === 0x88eb) state.set(0x88ed, value);
    },
    pixelStorei: (name: number, value: number) => state.set(name, value),
    colorMask: (...value: boolean[]) => state.set(0x0c23, value),
    clearColor: (...value: number[]) => state.set(0x0c22, value),
    clear(mask: number) {
      expect(mask).toBe(0x4000);
      expect(state.get(0x8ca6)).toBeNull();
      expect(state.get(0x0c23)).toEqual([false, false, false, true]);
      expect((state.get(0x0c22) as number[])[3]).toBe(1);
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
      const alignment = state.get(0x0d05) as number;
      expect([1, 2, 4, 8]).toContain(alignment);
      expect((_w * 4) % alignment).toBe(0);
      expect([0x0d02, 0x0d04, 0x0d03].map(name => state.get(name))).toEqual([0, 0, 0]);
      expect(pixels.byteLength).toBe(_w * _h * 4);
      if (rejectRead) { error = 0x502; return; }
      pixels.set(content);
      afterRead();
      calls.push(["readPixels", pixels]);
    },
  } as unknown as WebGL2RenderingContext;
  return { gl, state, initial, calls, storage: { gl, fbo, w: 2, h: 2 },
    setPixels: (pixels: number[]) => { content = pixels; },
    setError: (value: number) => { error = value; },
    onRead: (work: () => void) => { afterRead = work; },
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

it("presents and reads back the CRTC's panned viewport of a GPU framebuffer", () => {
  const r = renderer();
  // A 1x1 viewport panned to (1, 1) of the 2x2 BO (top row first).
  expect(drawGpuScanout(r.storage, 1, 1, 1, 1)).toBe(true);
  expect(r.calls[0]).toEqual([1, 1, 2, 2, 0, 1, 1, 0, 0x4000, 0x2600]);
  const reads: unknown[] = [];
  const read = r.gl.readPixels.bind(r.gl);
  (r.gl as unknown as { readPixels: typeof read }).readPixels = (...args: Parameters<typeof read>) => {
    reads.push(args.slice(0, 4));
    r.setPixels([1, 2, 3, 4]);
    read(...args);
  };
  expect([...readGpuScanout(r.storage, 1, 1, 1, 0)!]).toEqual([1, 2, 3, 4]);
  expect(reads).toEqual([[1, 0, 1, 1]]);
  // A viewport reaching outside the BO is refused before any native call.
  const calls = r.calls.length;
  expect(drawGpuScanout(r.storage, 2, 2, 1, 0)).toBe(false);
  expect(readGpuScanout(r.storage, 1, 1, 2, 0)).toBeNull();
  expect(r.calls.length).toBe(calls);
  expect(r.state).toEqual(r.initial);
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

it("reuses an accepted cursor record's GPU sample while later observations see live writes and loss", () => {
  const r = renderer();
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({io: {} as any, callbacks: {}, memory,
    pointerWidth: 4, instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096)});
  kernel.gl.createGpuBo(42, r.gl, 2, 2);
  kernel.kms.setMaster(100, 1n, 1n);
  const imports = kernel.testAuthority.buildImportObject(memory) as {env:Record<string,(...args:any[])=>any>};
  const fbId = 25;
  expect(imports.env.host_kms_addfb(100,fbId,42,2,2,0x34325241,8)).toBe(0);
  const record = (_reserved: bigint, x: number, framebuffer = fbId) => {
    const bytes = new Uint8Array(KMS_CURSOR_RECORD_BYTES), view = new DataView(bytes.buffer);
    [42, 2, 2, x, 4, 0, 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    view.setUint32(KMS_CURSOR_FRAMEBUFFER_OFFSET,framebuffer,true);
    return bytes;
  };
  const reads = () => r.calls.filter(call => call[0] === "readPixels").length;
  const first = kernel.kms.applyCursorRecord(record(1n, 1)) ?? kernel.kms.cursorSnapshot();
  expect(reads()).toBe(1);
  expect(first.pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
  expect(() => kernel.kms.applyCursorRecord(record(1n,1,0))).toThrow("image identity");
  expect(reads()).toBe(1); // Refused before sampling native storage.
  r.setPixels([0, 255, 0, 255]);
  const moved = kernel.kms.applyCursorRecord(record(1n, 9)) ?? kernel.kms.cursorSnapshot();
  expect(reads()).toBe(2);
  expect(moved.x).toBe(9);
  expect(moved.pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 255, 0, 255]));
  expect(first.pixels![0]).toBe(255);
  // No new ioctl/record: observe the native BO again, including context loss.
  r.setPixels([0, 0, 255, 255]);
  expect(kernel.kms.cursorSnapshot().pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 255, 255]));
  expect(reads()).toBe(3);
  r.loseContext();
  expect(kernel.kms.cursorSnapshot().pixels).toBeNull();
  expect(reads()).toBe(3);
  // Dropping master keeps the device cursor plane; the lost image stays
  // unpresented and motion still applies without sampling dead storage.
  kernel.kms.dropMaster(1n, 1n);
  const kept = kernel.kms.applyCursorRecord(record(0n, 22)) ?? kernel.kms.cursorSnapshot();
  expect(kept).toMatchObject({ x: 22, pixels: null });
  expect(reads()).toBe(3);
  expect(r.state).toEqual(r.initial);
});

// Select a real kernel-owned muxer, then use public KMS/scanout consumers.
// No new production authority or access to guest/kernel memory is exposed.
function selectedKernel() {
  const r = renderer(), memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({ io: {} as any, callbacks: {}, memory,
    pointerWidth: 4, instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096) });
  kernel.gl.createGpuBo(42, r.gl, 2, 2);
  const muxer = Reflect.get(kernel, "glMuxerFor").call(kernel, r.gl) as GlMuxer;
  const owner = { shadow: defaultShadow(), errors: [] as number[] };
  owner.shadow.fbo = r.initial.get(0x8ca6) as WebGLFramebuffer;
  owner.shadow.readFbo = r.initial.get(0x8caa) as WebGLFramebuffer;
  muxer.switchTo(owner);
  const selected = new Map(r.state);
  const selections = () => r.calls.filter(call => call[0] === "select vertex array").length;
  return { ...r, kernel, memory, muxer, owner, selected, selections };
}

it("preserves the selected GL owner across successful live GPU cursor samples", () => {
  const r = selectedKernel();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.setError(0x500);
  r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0);
  expect(r.owner.errors).toEqual([0x500]);
  for (const rgba of [[0, 255, 0, 255], [0, 0, 255, 255]]) {
    r.setPixels(rgba);
    expect([...r.kernel.kms.cursorSnapshot().pixels!.slice(0, 4)]).toEqual(rgba);
    expect(r.state).toEqual(r.selected);
    r.muxer.switchTo(r.owner);
    expect(r.selections()).toBe(1);
  }
});

it.each([false, true])("preserves the GL selection after restored scanout (direct: %s)", direct => {
  const r = selectedKernel(), canvas = { width: 2, height: 2, getContext: () => r.gl };
  const frame = getKernelGraphicsAccess(r.kernel).gpuScanout(
    { bo_id: 42, width: 2, height: 2 } as any, canvas as any, direct);
  expect(frame?.direct).toBe(direct);
  expect(r.state).toEqual(r.selected);
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(1);
});

it("invalidates the selected GL state before a scanout drawing-buffer resize", () => {
  const r = selectedKernel(), canvas = { width: 1, height: 1, getContext: () => r.gl };
  expect(getKernelGraphicsAccess(r.kernel).gpuScanout(
    { bo_id: 42, width: 2, height: 2 } as any, canvas as any, true)?.direct).toBe(true);
  expect([canvas.width, canvas.height]).toEqual([2, 2]);
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(2);
});

it("invalidates selection on rejected cursor work and retains failed inverse repair", () => {
  const r = selectedKernel();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.failRead(); r.failRestore();
  expect(() => r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0))
    .toThrow("GPU cursor readback failed");
  expect(hasNativeRepair(r.gl)).toBe(true);
  expect(r.owner.errors).toEqual([]);
  expect(() => r.muxer.switchTo(r.owner)).toThrow("restoration remains pending");
  r.allowRead(); r.allowRestore();
  r.muxer.switchTo(r.owner);
  expect(hasNativeRepair(r.gl)).toBe(false);
  expect(r.selections()).toBe(2);
  expect(r.state).toEqual(r.selected);
});

it.each(["cursor", "scanout"] as const)("stands down and invalidates an already-lost %s context", kind => {
  const r = selectedKernel();
  r.kernel.kms.setMaster(100, 1n, 1n);
  if (kind === "cursor") r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0);
  r.loseContext();
  if (kind === "cursor") expect(r.kernel.kms.cursorSnapshot().pixels).toBeNull();
  else expect(getKernelGraphicsAccess(r.kernel).gpuScanout(
    { bo_id: 42, width: 2, height: 2 } as any,
    { width: 2, height: 2, getContext: () => r.gl } as any, true)).toBeNull();
  // Even though this fake renderer accepts calls while lost, old selection
  // must no longer authorize the muxer's same-owner fast path.
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(2);
});

it("invalidates its canonical muxer before cleanup registered with another guard", () => {
  const r = selectedKernel();
  r.kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
  const old = r.kernel.gl.get(7, 11)!;
  old.gl = r.gl; old.contextId = 1;
  let refuse = true;
  const guard = { context: r.gl, prepareRetirement() {
    if (refuse) return false;
    // This guard knows this renderer, but does not know its canonical muxer.
    r.gl.bindFramebuffer(0x8d40, null);
    return true;
  } };
  const lease = r.kernel.gl.retainContextExecution(7, 11, guard)!;
  r.kernel.gl.destroyContext(7, 11);
  expect(lease.release()).toBe(false);
  expect(r.kernel.gl.hasExecutionRetirements(r.gl)).toBe(true);
  refuse = false;
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0);
  expect(r.kernel.gl.hasExecutionRetirements(r.gl)).toBe(false);
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(2);
  expect(r.state).toEqual(r.selected);
  expect(lease.release()).toBe(true);
});

it("invalidates before a pending native inverse successfully repairs", () => {
  const r = selectedKernel();
  r.failRead(); r.failRestore();
  expect(readGpuScanout(r.storage, 2, 2)).toBeNull();
  expect(hasNativeRepair(r.gl)).toBe(true);
  r.allowRead(); r.allowRestore();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0);
  expect(hasNativeRepair(r.gl)).toBe(false);
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(2);
  expect(r.state).toEqual(r.selected);
});

it("retains guest error ownership after an initial capture failure", () => {
  const r = selectedKernel(), getError = r.gl.getError;
  r.gl.getError = () => { throw new Error("error capture refused"); };
  r.kernel.kms.setMaster(100, 1n, 1n);
  expect(() => r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0))
    .toThrow("error capture refused");
  r.gl.getError = getError; r.setError(0x501);
  r.muxer.switchTo(r.owner);
  expect(r.owner.errors).toEqual([0x501]);
  expect(r.selections()).toBe(2);
});

it("invalidates if native context loss occurs during an otherwise restored read", () => {
  const r = selectedKernel();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.onRead(r.loseContext);
  expect(() => r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0))
    .toThrow("Device graphics state was not restored");
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(2);
});

it("still invalidates generic device callbacks that do not promise a checked inverse", () => {
  const r = selectedKernel();
  getKernelGraphicsAccess(r.kernel).withGraphicsState(r.gl, () => {
    r.gl.pixelStorei(0x0d05, 1);
  });
  r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(2);
  expect(r.state).toEqual(r.selected);
});

const drawSteps = ["disable", "bindFramebuffer:36008", "bindFramebuffer:36009", "blitFramebuffer", "colorMask", "clearColor", "clear"];
const readSteps = ["bindFramebuffer:36008", "bindBuffer", "pixelStorei:3330", "pixelStorei:3332", "pixelStorei:3331", "readPixels"];

function sequenceFault(kind: "draw" | "read", index: number, fault: "native" | "throw", afterEffect = false) {
  const r = renderer(), forward: string[] = [], pending: number[] = [];
  const originalError = r.gl.getError.bind(r.gl);
  r.gl.getError = () => pending.shift() ?? originalError();
  let restoring = false, rejected = false;
  for (const name of ["disable", "enable", "bindFramebuffer", "blitFramebuffer", "colorMask", "clearColor", "clear", "bindBuffer", "pixelStorei", "readPixels"] as const) {
    const original = r.gl[name];
    (r.gl as any)[name] = (...args: unknown[]) => {
      // The existing inverse starts with the old draw/read selector. Calls
      // before that anchor must be exactly the accepted/rejected prefix.
      if (name === "bindFramebuffer" && (kind === "draw"
        ? args[0] === 0x8ca9 && args[1] === r.initial.get(0x8ca6)
        : args[0] === 0x8ca8 && args[1] === r.initial.get(0x8caa))) restoring = true;
      if (!restoring) {
        forward.push(name === "bindFramebuffer" || name === "pixelStorei" ? `${name}:${args[0]}` : name);
        if (!rejected && forward.length - 1 === index) {
          rejected = true;
          if (afterEffect) Reflect.apply(original, r.gl, args);
          if (fault === "throw") throw Error("native operation refused");
          pending.push(0x502); return;
        }
      }
      return Reflect.apply(original, r.gl, args);
    };
  }
  return { ...r, forward };
}

for (const kind of ["draw", "read"] as const) for (let index = 0; index < (kind === "draw" ? drawSteps : readSteps).length; index++)
  for (const fault of ["native", "throw"] as const) for (const afterEffect of [false, true])
    it(`restores KMS ${kind} after ${afterEffect ? "post-effect" : "pre-effect"} ${fault} step ${index} and never executes its dependent suffix`, () => {
      const r = sequenceFault(kind, index, fault, afterEffect);
      expect(kind === "draw" ? drawGpuScanout(r.storage, 2, 2) : readGpuScanout(r.storage, 2, 2)).toBe(kind === "draw" ? false : null);
      expect(r.forward).toEqual((kind === "draw" ? drawSteps : readSteps).slice(0, index + 1));
      expect(r.state).toEqual(r.initial); expect(hasNativeRepair(r.gl)).toBe(false);
    });

it("keeps a rejected inverse after an early KMS selector failure and repairs independent state", () => {
  const r = sequenceFault("read", 1, "native"); r.failRestore();
  expect(readGpuScanout(r.storage, 2, 2)).toBeNull(); expect(hasNativeRepair(r.gl)).toBe(true);
  expect(r.state.get(0x88ed)).toBe(r.initial.get(0x88ed));
  expect([0x0d05, 0x0d02, 0x0d04, 0x0d03].map(p => r.state.get(p)))
    .toEqual([0x0d05, 0x0d02, 0x0d04, 0x0d03].map(p => r.initial.get(p)));
  r.allowRestore(); expect(repairNativeState(r.gl)).toBe(true);
  expect(hasNativeRepair(r.gl)).toBe(false); expect(r.state).toEqual(r.initial);
});

for (const kind of ["draw", "read"] as const) it(`keeps every KMS ${kind} post-check and inverse with local forward and inverse entries`, () => {
  const r = renderer(), originalError = r.gl.getError.bind(r.gl); let reads = 0;
  r.gl.getError = () => { reads++; return originalError(); };
  expect(kind === "draw" ? drawGpuScanout(r.storage, 2, 2) : readGpuScanout(r.storage, 2, 2) !== null).toBe(true);
  expect(reads).toBe(kind === "draw" ? 16 : 15);
  expect(r.state).toEqual(r.initial); expect(hasNativeRepair(r.gl)).toBe(false);
});

/** Normal borrowed-target publication, using this harness's allocator-
 * authorized kernel scratch. No synthetic allocation/retirement capability is minted. */
function publishBorrowedTarget(imports: Record<string,(...args:any[])=>any>, memory: WebAssembly.Memory,
  pid: number, session: number, surface: number, bo: number) {
  const attrs = new DataView(memory.buffer,96,32);
  [1,2,2,1,bo,0,0,0].forEach((value,index)=>attrs.setUint32(index*4,value,true));
  expect(imports.host_gl_update_surface(pid,surface,96,32,session)).toBe(0);
}

/** Real kernel front-export callback, with a separately selected peer owner.
 * These controls prove selector/error ownership, not native pixel performance. */
function selectedFront(kind: "gpu" | "cpu") {
  const r = selectedKernel(), target = {}, pending: number[] = [];
  let fault = "", afterFront = () => {}, copies = 0, publications = 0;
  const originalError = r.gl.getError.bind(r.gl);
  r.gl.getError = () => pending.shift() ?? originalError();
  r.state.set(0x0c02, 0x8ce1); r.selected.set(0x0c02, 0x8ce1);
  r.gl.readBuffer = (value: number) => { r.state.set(0x0c02, value); };
  r.gl.blitFramebuffer = () => {
    expect(r.state.get(0x8caa)).toBe(r.storage.fbo);
    expect(r.state.get(0x8ca6)).toBe(target);
    copies++;
    if (fault === "throw") throw Error("front copy unavailable");
    if (fault === "memory") pending.push(0x505);
    afterFront();
  };
  const nativeRead = r.gl.readPixels.bind(r.gl);
  r.gl.readPixels = ((...args: Parameters<WebGL2RenderingContext["readPixels"]>) => {
    copies++;
    if (fault === "throw") throw Error("front read unavailable");
    if (fault === "memory") { pending.push(0x505); afterFront(); return; }
    Reflect.apply(nativeRead, r.gl, args); afterFront();
  }) as WebGL2RenderingContext["readPixels"];
  // Imports read their private scratch attrs from this kernel's existing
  // memory; the published BO remains independent canonical storage.
  const imports = r.kernel.testAuthority.buildImportObject(r.memory) as {env:Record<string,(...args:any[])=>any>};
  r.kernel.gl.bind({pid:8,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
  const binding = r.kernel.gl.get(8,12)!;
  binding.gl = r.gl; binding.contextId = 22; binding.surfaceId = 71;
  binding.pendingRenderTargetBoId = 42; binding.renderTargetFbo = r.storage.fbo;
  binding.surfaceSize = {width:2,height:2};
  // A bare FBO is not accepted storage ownership. Publish the registry BO's
  // actual retirement through the same import used by ordinary GBM surfaces.
  publishBorrowedTarget(imports.env,r.memory,8,12,71,42);
  expect(binding.surface.borrowedTarget?.retirement).toBe(r.kernel.gl.gpuBo(42)!.retirement);
  if (kind === "gpu") {
    const create = r.gl.createFramebuffer;
    r.gl.createFramebuffer = () => target as WebGLFramebuffer;
    expect(r.kernel.gl.createGpuBo(43,r.gl,2,2)).toBeGreaterThan(0);
    r.gl.createFramebuffer = create;
  } else {
    r.kernel.bos.create({pid:8,bo_id:43,size:16,w:2,h:2,stride:8});
    const publish = r.kernel.bos.publishDevicePixels.bind(r.kernel.bos);
    r.kernel.bos.publishDevicePixels = (bo,pixels) => {publications++; return publish(bo,pixels);};
  }
  const attrs = new DataView(r.memory.buffer,64,32);
  attrs.setUint32(0,1,true); attrs.setUint32(4,2,true); attrs.setUint32(8,2,true);
  attrs.setUint32(12,1,true); attrs.setUint32(20,43,true);
  if (kind === "cpu") {attrs.setUint32(24,0x34324241,true);attrs.setUint32(28,8,true);}
  // Allocation is legitimately stateful; establish the known peer afterward.
  r.muxer.switchTo(r.owner); const before = r.selections();
  return {...r,binding,attrs,before,imports:imports.env,
    run:()=>imports.env.host_gl_update_surface(8,71,64,32,12),
    fault:(value:string)=>{fault=value;},afterFront:(callback:()=>void)=>{afterFront=callback;},
    copies:()=>copies,publications:()=>publications,
  };
}

for (const kind of ["gpu","cpu"] as const) {
  it(`keeps the selected peer and its pending errors after checked ${kind} front export`,()=>{
    const r=selectedFront(kind);r.setError(0x500);
    expect(r.run()).toBe(0);expect(r.copies()).toBe(1);
    expect(r.owner.errors).toEqual([0x500]);expect(r.binding.errors).toEqual([]);
    expect(r.state).toEqual(r.selected);r.muxer.switchTo(r.owner);
    expect(r.selections()).toBe(r.before);
    if(kind==="cpu")expect(r.publications()).toBe(1);
  });
  it.each(["memory","throw"])(`invalidates ${kind} front export after %s and preserves errno`,fault=>{
    const r=selectedFront(kind);r.fault(fault);
    expect(r.run()).toBe(fault==="memory"?-12:-5);
    expect(r.binding.errors).toEqual([]);expect(r.owner.errors).toEqual([]);
    r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before+1);
    expect(r.state).toEqual(r.selected);expect(r.publications()).toBe(0);
  });
  it(`refuses ${kind} front publication after late native context loss`,()=>{
    const r=selectedFront(kind);r.afterFront(r.loseContext);
    expect(r.run()).toBe(-5);expect(r.publications()).toBe(0);
    r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before+1);
  });
  it(`preserves ${kind} front ENOMEM even when the final context-loss guard rejects`,()=>{
    const r=selectedFront(kind);r.fault("memory");r.afterFront(r.loseContext);
    expect(r.run()).toBe(-12);expect(r.publications()).toBe(0);
    expect(hasNativeRepair(r.gl)).toBe(true);
    expect(() => r.muxer.switchTo(r.owner)).toThrow("Native GL restoration remains pending");
    expect(r.selections()).toBe(r.before);
  });
  it(`retains failed ${kind} front inverses and revokes selection before later repair`,()=>{
    const r=selectedFront(kind);r.failRestore();
    expect(r.run()).toBe(-5);expect(hasNativeRepair(r.gl)).toBe(true);
    expect(r.publications()).toBe(0);r.allowRestore();
    expect(r.run()).toBe(0);expect(hasNativeRepair(r.gl)).toBe(false);
    r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before+1);
    expect(r.state).toEqual(r.selected);expect(r.binding.errors).toEqual([]);
  });
  it(`retains ${kind} front invalid-source errno before the private capture`,()=>{
    const r=selectedFront(kind),getError=r.gl.getError;let captures=0;
    r.binding.renderTargetFbo=null;
    r.gl.getError=()=>{if(++captures>1)throw Error("private capture must not run");return getError();};
    expect(r.run()).toBe(-22);expect(captures).toBe(1);expect(r.copies()).toBe(0);
    r.gl.getError=getError;r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before);
  });
  it(`refuses ${kind} front work when outgoing error capture fails`,()=>{
    const r=selectedFront(kind),getError=r.gl.getError;r.setError(0x501);
    r.gl.getError=()=>{throw Error("capture unavailable");};
    expect(r.run()).toBe(-5);expect(r.copies()).toBe(0);expect(r.publications()).toBe(0);
    r.gl.getError=getError;r.muxer.switchTo(r.owner);
    expect(r.owner.errors).toEqual([0x501]);expect(r.binding.errors).toEqual([]);
    expect(r.selections()).toBe(r.before+1);
  });
  it(`does not borrow ${kind} front state across another guard's execution cleanup`,()=>{
    const r=selectedFront(kind);r.kernel.gl.bind({pid:9,sessionId:13,cmdbufAddr:0,cmdbufLen:0});
    const old=r.kernel.gl.get(9,13)!;old.gl=r.gl;old.contextId=23;
    let refuse=true;
    const guard={context:r.gl,prepareRetirement(){if(refuse)return false;r.gl.bindFramebuffer(0x8d40,null);return true;}};
    const lease=r.kernel.gl.retainContextExecution(9,13,guard)!;
    r.kernel.gl.destroyContext(9,13);expect(lease.release()).toBe(false);
    refuse=false;expect(r.run()).toBe(0);expect(r.kernel.gl.hasExecutionRetirements(r.gl)).toBe(false);
    r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before+1);expect(lease.release()).toBe(true);
  });
}

it("revokes selected peer state before a capabilities query retries another guard's cleanup",()=>{
  const r=selectedFront("gpu");r.state.set(0x0d33,4096);r.state.set(0x84e8,4096);
  r.kernel.gl.bind({pid:9,sessionId:13,cmdbufAddr:0,cmdbufLen:0});
  const old=r.kernel.gl.get(9,13)!;old.gl=r.gl;old.contextId=23;
  let refuse=true;
  const guard={context:r.gl,prepareRetirement(){if(refuse)return false;r.gl.bindFramebuffer(0x8d40,null);return true;}};
  const lease=r.kernel.gl.retainContextExecution(9,13,guard)!;
  r.kernel.gl.destroyContext(9,13);expect(lease.release()).toBe(false);refuse=false;
  r.setError(0x501);
  expect(r.imports.host_gl_query(8,QOP_SURFACE_CAPABILITIES,0,0,512,16,12)).toBe(16);
  r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before+1);
  expect(r.owner.errors).toEqual([0x501]);expect(r.binding.errors).toEqual([]);
  expect(lease.release()).toBe(true);
});

it("invalidates a successful CPU front read if canonical publication refuses",()=>{
  const r=selectedFront("cpu");r.kernel.bos.publishDevicePixels=()=>false;
  expect(r.run()).toBe(-5);r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(r.before+1);expect(r.binding.errors).toEqual([]);
});

it("refuses another guard's cleanup while the selected peer's flags remain unread",()=>{
  const r=selectedFront("gpu");r.kernel.gl.bind({pid:9,sessionId:13,cmdbufAddr:0,cmdbufLen:0});
  const old=r.kernel.gl.get(9,13)!;old.gl=r.gl;old.contextId=23;
  let refuse=true,cleanups=0;
  const guard={context:r.gl,prepareRetirement(){if(refuse)return false;cleanups++;r.gl.bindFramebuffer(0x8d40,null);return true;}};
  const lease=r.kernel.gl.retainContextExecution(9,13,guard)!;
  r.kernel.gl.destroyContext(9,13);expect(lease.release()).toBe(false);refuse=false;
  const getError=r.gl.getError;r.setError(0x501);r.gl.getError=()=>{throw Error("unread selected error");};
  expect(r.run()).toBe(-5);expect(cleanups).toBe(0);expect(r.copies()).toBe(0);
  r.gl.getError=getError;expect(r.run()).toBe(0);expect(cleanups).toBe(1);
  expect(r.owner.errors).toEqual([0x501]);expect(r.binding.errors).toEqual([]);
  expect(lease.release()).toBe(true);
});

/** A second real BO-backed surface. Native allocation/publication is setup,
 * so reselect the existing owner before measuring its later logical rebind. */
function secondDrawable(r: ReturnType<typeof selectedDrawable>, framebuffer: WebGLFramebuffer) {
  r.kernel.gl.bind({pid:8,sessionId:14,cmdbufAddr:0,cmdbufLen:0});
  const second=r.kernel.gl.get(8,14)!;second.gl=r.gl;second.contextId=24;
  second.surfaceId=72;second.pendingRenderTargetBoId=44;
  const create=r.gl.createFramebuffer;r.gl.createFramebuffer=()=>framebuffer;
  try { expect(r.kernel.gl.createGpuBo(44,r.gl,2,2)).toBeGreaterThan(0); }
  finally { r.gl.createFramebuffer=create; }
  publishBorrowedTarget(r.imports,r.memory,8,14,72,44);
  expect(second.surface.borrowedTarget?.retirement).toBe(r.kernel.gl.gpuBo(44)!.retirement);
  expect(r.submit()).toBe(0);r.before=r.selections();r.binds.length=0;
}

function selectedDrawable() {
  const r = selectedFront("gpu");
  r.binding.cmdbufView = new Uint8Array(0);
  expect(r.imports.host_gl_make_current(8,22,71,71,12)).toBe(0);
  expect(r.imports.host_gl_submit(8,0,0,12)).toBe(0);
  const before = r.selections();
  const binds: unknown[][] = [], bind = r.gl.bindFramebuffer.bind(r.gl);
  r.gl.bindFramebuffer = (target,value) => { binds.push([target,value]); bind(target,value); };
  return {...r,before,binds,submit:()=>r.imports.host_gl_submit(8,0,0,12),
    makeCurrent:()=>r.imports.host_gl_make_current(8,22,71,71,12),
    release:()=>r.imports.host_gl_make_current(8,0,0,0,12)};
}

it.each([false,true])("restores only framebuffer selectors after same-owner current transition (release: %s)",release=>{
  const r=selectedDrawable();r.binding.shadow.viewport=[3,4,5,6];r.binding.shadow.scissor.rect=[1,2,3,4];
  // Selectors are context state; changing these through ordinary commands is
  // outside this fixture's transition. Explicitly establish their selection.
  r.muxer.invalidateCurrent();expect(r.submit()).toBe(0);const before=r.selections();r.binds.length=0;
  r.setError(0x501);
  if(release)expect(r.release()).toBe(0);
  expect(r.makeCurrent()).toBe(0);expect(r.submit()).toBe(0);
  expect(r.selections()).toBe(before);
  expect(r.binds).toEqual(release?[[0x8ca9,r.binding.shadow.fbo],[0x8ca8,r.binding.shadow.readFbo]]:[]);
  expect(r.binding.shadow.viewport).toEqual([3,4,5,6]);expect(r.binding.shadow.scissor.rect).toEqual([1,2,3,4]);
  expect(r.binding.errors).toEqual([0x501]);expect(r.owner.errors).toEqual([]);
});

it("restores distinct draw/read defaults without displacing user FBO state",()=>{
  const r=selectedDrawable(), readFbo={};
  secondDrawable(r,readFbo as WebGLFramebuffer);
  expect(r.imports.host_gl_make_current(8,22,71,72,12)).toBe(0);expect(r.submit()).toBe(0);
  expect(r.state.get(0x8ca6)).toBe(r.storage.fbo);expect(r.state.get(0x8caa)).toBe(readFbo);
  expect(r.selections()).toBe(r.before);
  const userDraw={},userRead={};r.binding.shadow.fbo=userDraw;r.binding.shadow.readFbo=userRead;
  r.muxer.invalidateCurrent();expect(r.submit()).toBe(0);const before=r.selections();
  expect(r.release()).toBe(0);expect(r.makeCurrent()).toBe(0);expect(r.submit()).toBe(0);
  expect(r.state.get(0x8ca6)).toBe(userDraw);expect(r.state.get(0x8caa)).toBe(userRead);
  expect(r.selections()).toBe(before);
});

it("never retains a drawable witness across a peer selection or a generic mutation",()=>{
  const r=selectedDrawable();expect(r.release()).toBe(0);
  r.muxer.switchTo(r.owner);const before=r.selections();
  expect(r.makeCurrent()).toBe(0);expect(r.submit()).toBe(0);expect(r.selections()).toBe(before+1);
  expect(r.makeCurrent()).toBe(0);
  getKernelGraphicsAccess(r.kernel).withGraphicsState(r.gl,()=>r.gl.bindFramebuffer(0x8d40,null));
  expect(r.submit()).toBe(0);expect(r.selections()).toBe(before+2);
});

it("keeps first-current initialization outside the framebuffer-only witness",()=>{
  const r=selectedFront("gpu");r.binding.cmdbufView=new Uint8Array(0);
  r.muxer.switchTo(r.binding);const before=r.selections();
  expect(r.imports.host_gl_make_current(8,22,71,71,12)).toBe(0);
  expect(r.imports.host_gl_submit(8,0,0,12)).toBe(0);expect(r.selections()).toBe(before+1);
  expect(r.binding.shadow.viewport).toEqual([0,0,2,2]);expect(r.binding.shadow.scissor.rect).toEqual([0,0,2,2]);
});

it("uses full selection for a newly allocated surfaceless container, then restores only its selectors",()=>{
  const r=selectedDrawable();
  expect(r.imports.host_gl_make_current(8,22,0,0,12)).toBe(0);expect(r.submit()).toBe(0);
  expect(r.selections()).toBe(r.before+1);const fbo=r.binding.undefinedDefaultFbo;expect(fbo).not.toBeNull();
  expect(r.makeCurrent()).toBe(0);expect(r.submit()).toBe(0);
  expect(r.imports.host_gl_make_current(8,22,0,0,12)).toBe(0);expect(r.submit()).toBe(0);
  expect(r.selections()).toBe(r.before+1);expect(r.state.get(0x8ca6)).toBe(fbo);expect(r.state.get(0x8caa)).toBe(fbo);
});

for(const target of [0x8ca9,0x8ca8])for(const fault of ["native","throw"]as const)
  it(`refuses dependent guest work after ${fault} drawable selector ${target}`,()=>{
    const r=selectedDrawable();let draws=0,rejected=false;
    r.gl.clear=()=>{draws++;};
    const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);view.setUint16(0,OP_CLEAR,true);view.setUint16(2,4,true);view.setUint32(4,0x4000,true);
    r.binding.cmdbufView=bytes;r.binding.cmdbufLen=8;
    expect(r.release()).toBe(0);expect(r.makeCurrent()).toBe(0);const bind=r.gl.bindFramebuffer.bind(r.gl);
    r.gl.bindFramebuffer=(which,value)=>{if(!rejected&&which===target){rejected=true;if(fault==="throw")throw Error("selector refused");r.setError(0x502);return;}bind(which,value);};
    expect(r.imports.host_gl_submit(8,0,8,12)).toBe(-5);expect(draws).toBe(0);
    expect(r.binding.errors).toEqual([]);
    r.gl.bindFramebuffer=bind;expect(r.imports.host_gl_submit(8,0,8,12)).toBe(0);expect(draws).toBe(1);
    expect(r.selections()).toBe(r.before+1);
  });

it("invalidates before releasing an owner-dead surface's final native allocation",()=>{
  const r=selectedDrawable(),fbo=r.storage.fbo,texture={},depth={};
  const retirement=reserveNativeRetirement({gl:r.gl,errors:[]},[["deleteFramebuffer",fbo],["deleteTexture",texture],["deleteRenderbuffer",depth]])!;
  r.binding.surface.presentTarget={fbo,tex:texture,depthStencil:depth,w:2,h:2,retirement};
  const surface=r.binding.surface;surface.ownerAlive=false;
  let deletes=0,selectedDuringDeletion:unknown;
  r.gl.deleteFramebuffer=()=>{deletes++;selectedDuringDeletion=Reflect.get(r.muxer,"current");};
  expect(r.release()).toBe(0);expect(deletes).toBe(1);expect(surface.users.size).toBe(0);
  expect(selectedDuringDeletion).toBeNull();
  r.muxer.switchTo(r.binding);expect(r.selections()).toBe(r.before+1);
});

it("keeps the dirty drawable witness through a fixed KMS helper's exact native inverse",()=>{
  const r=selectedDrawable(),nextFbo={};
  secondDrawable(r,nextFbo as WebGLFramebuffer);
  expect(r.imports.host_gl_make_current(8,22,72,72,12)).toBe(0);
  expect(r.binding.shadow.fbo).toBe(nextFbo);expect(r.state.get(0x8ca6)).toBe(r.storage.fbo);
  r.kernel.kms.setMaster(100,1n,1n);r.kernel.kms.setCursor(100,3,42,2,2,0,0,0,0);
  // The helper restores the actual old native preimage, not the new shadow.
  expect(r.state.get(0x8ca6)).toBe(r.storage.fbo);
  expect(r.submit()).toBe(0);expect(r.state.get(0x8ca6)).toBe(nextFbo);
  expect(r.state.get(0x8caa)).toBe(nextFbo);expect(r.selections()).toBe(r.before);
});

it("uses full selection after pending native repair during a drawable transition",()=>{
  const r=selectedDrawable();r.failRead();
  // A real native selector delta is required to exercise its failed inverse;
  // an already-selected read FBO now needs neither a write nor restoration.
  r.state.set(0x8caa,{});
  const bind=r.gl.bindFramebuffer.bind(r.gl);let reads=0,reject=true;
  r.gl.bindFramebuffer=(which,value)=>{
    if(which===0x8ca8&&++reads>1&&reject){r.setError(0x502);return;}
    bind(which,value);
  };
  expect(readGpuScanout(r.storage,2,2)).toBeNull();expect(hasNativeRepair(r.gl)).toBe(true);
  r.allowRead();reject=false;expect(r.makeCurrent()).toBe(0);expect(r.submit()).toBe(0);
  expect(hasNativeRepair(r.gl)).toBe(false);expect(r.selections()).toBe(r.before+1);
});

it("refuses a dirty drawable after context loss before dependent guest work",()=>{
  const r=selectedDrawable();let draws=0;r.gl.clear=()=>{draws++;};
  const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);
  view.setUint16(0,OP_CLEAR,true);view.setUint16(2,4,true);view.setUint32(4,0x4000,true);
  r.binding.cmdbufView=bytes;r.binding.cmdbufLen=8;
  expect(r.release()).toBe(0);expect(r.makeCurrent()).toBe(0);const bind=r.gl.bindFramebuffer.bind(r.gl);
  r.gl.bindFramebuffer=(which,value)=>{bind(which,value);r.loseContext();};
  expect(r.imports.host_gl_submit(8,0,8,12)).toBe(-5);expect(draws).toBe(0);
  expect(Reflect.get(r.muxer,"current")).toBeNull();
});

it("does not reuse a dirty drawable witness for a replacement context with the same numeric identity",()=>{
  const r=selectedDrawable();expect(r.release()).toBe(0);expect(r.makeCurrent()).toBe(0);
  r.imports.host_gl_destroy_context(8,22);
  const replacement=r.kernel.gl.get(8,12)!;replacement.gl=r.gl;replacement.contextId=22;
  replacement.cmdbufView=new Uint8Array(0);replacement.hasBeenCurrent=true;
  expect(r.imports.host_gl_submit(8,0,0,12)).toBe(0);expect(r.selections()).toBe(r.before+1);
});

it.each([false,true])("adds no selector/error work for clean surfaceless current (release: %s)",release=>{
  const r=selectedDrawable(),create=r.gl.createFramebuffer;
  r.gl.createFramebuffer=()=>({});
  expect(r.imports.host_gl_make_current(8,22,0,0,12)).toBe(0);expect(r.submit()).toBe(0);
  r.gl.createFramebuffer=create;const before=r.selections();r.binds.length=0;
  const getError=r.gl.getError;let errorReads=0;
  r.gl.getError=()=>{errorReads++;return getError();};
  expect(r.submit()).toBe(0);const ordinaryEntryReads=errorReads;errorReads=0;
  r.setError(0x501);
  if(release)expect(r.release()).toBe(0);
  expect(r.imports.host_gl_make_current(8,22,0,0,12)).toBe(0);
  expect(errorReads).toBe(0);expect(r.binds).toEqual([]);
  expect(r.submit()).toBe(0);
  // One extra read consumes the actual queued guest flag, independently of
  // the ordinary entry's terminal clean read. No private selector checks.
  expect(errorReads).toBe(ordinaryEntryReads+1);
  expect(r.binds).toEqual([]);expect(r.selections()).toBe(before);
  expect(r.binding.errors).toEqual([0x501]);expect(r.owner.errors).toEqual([]);
});

it("never launders a prior dirty drawable through an unchanged logical bind",()=>{
  const r=selectedDrawable();expect(r.release()).toBe(0);expect(r.makeCurrent()).toBe(0);
  // This bind's before/after refs match, but the earlier release/rebind left
  // the physical selectors unknown. The pending check must remain required.
  expect(r.makeCurrent()).toBe(0);r.binds.length=0;expect(r.submit()).toBe(0);
  expect(r.binds).toEqual([[0x8ca9,r.binding.shadow.fbo],[0x8ca8,r.binding.shadow.readFbo]]);
  expect(r.selections()).toBe(r.before);
});

it("fully invalidates if an otherwise pure drawable commit throws before its changed-selector mark",()=>{
  const r=selectedDrawable(),surface=r.binding.surface,add=surface.users.add;
  surface.users.add=()=>{throw Error("membership allocation refused");};
  expect(r.makeCurrent()).toBe(-5);expect(Reflect.get(r.muxer,"current")).toBeNull();
  surface.users.add=add;expect(r.submit()).toBe(0);expect(r.selections()).toBe(r.before+1);
});

it("resets every native constant after a generic callback writes an index absent guest shadows",()=>{
  const r=selectedDrawable(),values=new Map<number,number[]>();r.state.set(0x8869,8);
  r.gl.vertexAttrib4f=(index,...value)=>{values.set(index,value);};
  getKernelGraphicsAccess(r.kernel).withGraphicsState(r.gl,()=>r.gl.vertexAttrib4f(6,2,3,4,5));
  expect(values.get(6)).toEqual([2,3,4,5]);expect(r.binding.shadow.vertexAttribValues.size).toBe(0);
  expect(r.submit()).toBe(0);
  expect([...values.keys()]).toEqual([6,0,1,2,3,4,5,7]);
  expect([...values.values()].every(value=>value.join(",")==="0,0,0,1")).toBe(true);
});

it("fences generic callback constants before reentrant work and retains coverage after callback and replay failures",()=>{
  const r=selectedDrawable(),values=new Map<number,number[]>();r.state.set(0x8869,8);
  let reject=false;
  r.gl.vertexAttrib4f=(index,...value)=>{values.set(index,value);if(reject&&index===7)throw Error("constant replay refused");};
  expect(()=>getKernelGraphicsAccess(r.kernel).withGraphicsState(r.gl,()=>{
    r.gl.vertexAttrib4f(6,2,3,4,5);
    expect(r.submit()).toBe(0);expect(values.get(6)).toEqual([0,0,0,1]);
    r.gl.vertexAttrib4f(7,5,4,3,2);throw Error("generic callback refused");
  })).toThrow("generic callback refused");
  reject=true;expect(r.submit()).toBe(-5);expect(Reflect.get(r.muxer,"current")).toBeNull();
  reject=false;expect(r.submit()).toBe(0);
  expect([...values.values()].every(value=>value.join(",")==="0,0,0,1")).toBe(true);
});

it("retries a generic callback's full constant reset after native limit admission refuses",()=>{
  const r=selectedDrawable(),values=new Map<number,number[]>();r.state.set(0x8869,0);
  r.gl.vertexAttrib4f=(index,...value)=>{values.set(index,value);};r.setError(0x501);
  getKernelGraphicsAccess(r.kernel).withGraphicsState(r.gl,()=>r.gl.vertexAttrib4f(6,2,3,4,5));
  expect(r.binding.errors).toEqual([0x501]);expect(r.submit()).toBe(-5);
  expect(Reflect.get(r.muxer,"current")).toBeNull();expect(values.get(6)).toEqual([2,3,4,5]);
  r.state.set(0x8869,8);expect(r.submit()).toBe(0);expect(values.get(6)).toEqual([0,0,0,1]);
  expect(values.size).toBe(8);expect(r.binding.errors).toEqual([0x501]);
});


/** Selector deltas come from checked native captures, not logical shadows. */
function observeSelectorWrites(r: ReturnType<typeof renderer>) {
  const writes: unknown[][] = [];
  for (const name of ["bindFramebuffer", "bindBuffer", "pixelStorei", "disable", "enable", "colorMask", "clearColor"] as const) {
    const original = r.gl[name];
    (r.gl as any)[name] = (...args: unknown[]) => { writes.push([name, ...args]); return Reflect.apply(original, r.gl, args); };
  }
  let checks = 0;
  const getError = r.gl.getError.bind(r.gl);
  r.gl.getError = () => { checks++; return getError(); };
  return {writes, checks: () => checks};
}

it("omits every unchanged native read selector and its inverse while still checking actual readback", () => {
  const r = renderer();
  r.state.set(0x8caa,r.storage.fbo); r.state.set(0x88ed,null);
  for (const p of [0x0d02,0x0d04,0x0d03]) r.state.set(p,0);
  const before = new Map(r.state), observed = observeSelectorWrites(r);
  expect(readGpuScanout(r.storage,2,2)).not.toBeNull();
  expect(observed.writes).toEqual([]); expect(observed.checks()).toBe(4);
  expect(r.state).toEqual(before); expect(hasNativeRepair(r.gl)).toBe(false);
});

it("omits every unchanged native primary selector and inverse while retaining blit and opaque clear", () => {
  const r = renderer();
  r.state.set(0x8caa,r.storage.fbo); r.state.set(0x8ca6,null); r.state.set(0x0c11,false);
  r.state.set(0x0c23,[false,false,false,true]); r.state.set(0x0c22,[0,0,0,1]);
  const before = new Map(r.state), observed = observeSelectorWrites(r);
  expect(drawGpuScanout(r.storage,2,2)).toBe(true);
  expect(observed.writes).toEqual([]); expect(observed.checks()).toBe(5);
  expect(r.calls).toEqual([[0,0,2,2,0,2,2,0,0x4000,0x2600],["opaque primary"]]);
  expect(r.state).toEqual(before); expect(hasNativeRepair(r.gl)).toBe(false);
});

for (const width of [1,2]) for (const alignment of [1,2,4,8])
  it(`keeps tight RGBA rows for width${width} with captured alignment${alignment}`, () => {
    const r = renderer();r.state.set(0x0d05,alignment);
    r.state.set(0x8caa,r.storage.fbo);r.state.set(0x88ed,null);
    for (const p of [0x0d02,0x0d04,0x0d03]) r.state.set(p,0);
    const data = Array.from({length:width*2*4},(_,i)=>i+1);r.setPixels(data);
    const before = new Map(r.state), observed = observeSelectorWrites(r);
    expect(Array.from(readGpuScanout(r.storage,width,2)!)).toEqual(data);
    expect(observed.writes).toEqual(width===1&&alignment===8
      ? [["pixelStorei",0x0d05,4],["pixelStorei",0x0d05,8]] : []);
    expect(r.state).toEqual(before);expect(hasNativeRepair(r.gl)).toBe(false);
  });

for (const fault of ["native","throw"] as const) for (const afterEffect of [false,true])
  it(`restores the changed odd-width alignment after ${afterEffect?"post":"pre"}-effect ${fault}`,()=>{
    const r=renderer(),original=r.gl.pixelStorei.bind(r.gl);let failed=false;
    r.gl.pixelStorei=(p,v)=>{
      if(!failed&&p===0x0d05&&v===4){failed=true;if(afterEffect)original(p,v);if(fault==="throw")throw Error("alignment refused");r.setError(0x502);return;}
      original(p,v);
    };
    expect(readGpuScanout(r.storage,1,2)).toBeNull();expect(failed).toBe(true);
    expect(r.state).toEqual(r.initial);expect(hasNativeRepair(r.gl)).toBe(false);
  });

for (const field of [0x0d05,0x0d02,0x0d04,0x0d03])
  it(`retains a late failed read layout inverse${field} until repair without replaying readback`,()=>{
    const r=renderer(),original=r.gl.pixelStorei.bind(r.gl);let restoring=false,reject=true,reads=0;
    r.onRead(()=>{restoring=true;reads++;});
    r.gl.pixelStorei=(p,v)=>{
      if(restoring&&reject&&p===field&&v===r.initial.get(p)){original(p,v);r.setError(0x502);return;}
      original(p,v);
    };
    expect(readGpuScanout(r.storage,1,2)).toBeNull();expect(reads).toBe(1);expect(hasNativeRepair(r.gl)).toBe(true);
    // The pending inverse fences a second presentation before it reaches pixels.
    expect(readGpuScanout(r.storage,1,2)).toBeNull();expect(reads).toBe(1);
    reject=false;expect(repairNativeState(r.gl)).toBe(true);expect(r.state).toEqual(r.initial);
    expect(hasNativeRepair(r.gl)).toBe(false);expect(reads).toBe(1);
  });

for (const selector of ["read", "draw", "scissor", "mask", "clear"] as const)
  it(`changes and restores only the mismatched primary ${selector} selector`,()=>{
    const r=renderer();
    r.state.set(0x8caa,r.storage.fbo);r.state.set(0x8ca6,null);r.state.set(0x0c11,false);
    r.state.set(0x0c23,[false,false,false,true]);r.state.set(0x0c22,[0,0,0,1]);
    const desired=new Map(r.state);
    const key={read:0x8caa,draw:0x8ca6,scissor:0x0c11,mask:0x0c23,clear:0x0c22}[selector];
    r.state.set(key,r.initial.get(key));const before=new Map(r.state),o=observeSelectorWrites(r);
    expect(drawGpuScanout(r.storage,2,2)).toBe(true);expect(r.state).toEqual(before);
    const expected:Record<typeof selector,unknown[][]>={
      read:[["bindFramebuffer",0x8ca8,desired.get(0x8caa)],["bindFramebuffer",0x8ca8,before.get(0x8caa)]],
      draw:[["bindFramebuffer",0x8ca9,null],["bindFramebuffer",0x8ca9,before.get(0x8ca6)]],
      scissor:[["disable",0x0c11],["enable",0x0c11]],
      mask:[["colorMask",false,false,false,true],["colorMask",...(before.get(0x0c23)as boolean[])]],
      clear:[["clearColor",...(before.get(0x0c22)as number[]).slice(0,3),1],["clearColor",...(before.get(0x0c22)as number[])]],
    };
    expect(o.writes).toEqual(expected[selector]);expect(hasNativeRepair(r.gl)).toBe(false);
  });

for (const selector of ["read","pack","row","pixels","rows"] as const)
  it(`changes and restores only the mismatched readback ${selector} selector`,()=>{
    const r=renderer();r.state.set(0x8caa,r.storage.fbo);r.state.set(0x88ed,null);
    for(const p of [0x0d02,0x0d04,0x0d03])r.state.set(p,0);
    const key={read:0x8caa,pack:0x88ed,row:0x0d02,pixels:0x0d04,rows:0x0d03}[selector];
    r.state.set(key,r.initial.get(key));const before=new Map(r.state),o=observeSelectorWrites(r);
    expect(readGpuScanout(r.storage,2,2)).not.toBeNull();expect(r.state).toEqual(before);
    expect(o.writes).toEqual(selector==="read"
      ? [["bindFramebuffer",0x8ca8,r.storage.fbo],["bindFramebuffer",0x8ca8,before.get(key)]]
      :selector==="pack"?[["bindBuffer",0x88eb,null],["bindBuffer",0x88eb,before.get(key)]]
      :[["pixelStorei",key,0],["pixelStorei",key,before.get(key)]]);
    expect(hasNativeRepair(r.gl)).toBe(false);
  });

for (const selector of ["draw","read","scissor","mask","clear"] as const)
  for(const fault of ["native","throw"]as const)
    it(`fences a post-effect late primary ${selector} inverse ${fault} without repeating pixels`,()=>{
      const r=renderer();let restoring=false,reject=true;
      const clear=r.gl.clear.bind(r.gl);r.gl.clear=(bits)=>{clear(bits);restoring=true;};
      const method={draw:"bindFramebuffer",read:"bindFramebuffer",scissor:"enable",mask:"colorMask",clear:"clearColor"}[selector]as"bindFramebuffer"|"enable"|"colorMask"|"clearColor";
      const original=r.gl[method];
      (r.gl as any)[method]=(...args:unknown[])=>{
        const chosen=restoring&&reject&&(selector==="draw"?args[0]===0x8ca9&&args[1]===r.initial.get(0x8ca6)
          :selector==="read"?args[0]===0x8ca8&&args[1]===r.initial.get(0x8caa)
          :selector==="scissor"?args[0]===0x0c11:true);
        const value=Reflect.apply(original,r.gl,args);
        if(chosen){if(fault==="throw")throw Error("inverse after effect");r.setError(0x502);}
        return value;
      };
      expect(drawGpuScanout(r.storage,2,2)).toBe(false);expect(hasNativeRepair(r.gl)).toBe(true);
      const completed=r.calls.length;expect(drawGpuScanout(r.storage,2,2)).toBe(false);expect(r.calls.length).toBe(completed);
      reject=false;expect(repairNativeState(r.gl)).toBe(true);expect(r.state).toEqual(r.initial);
      expect(r.calls.length).toBe(completed);expect(hasNativeRepair(r.gl)).toBe(false);
    });

it("preserves readback failure reporting when every captured selector already matches",()=>{
  const r=renderer();r.state.set(0x8caa,r.storage.fbo);r.state.set(0x88ed,null);
  for(const p of [0x0d02,0x0d04,0x0d03])r.state.set(p,0);
  const before=new Map(r.state),o=observeSelectorWrites(r);r.failRead();
  expect(readGpuScanout(r.storage,2,2)).toBeNull();expect(o.writes).toEqual([]);
  expect(r.state).toEqual(before);expect(hasNativeRepair(r.gl)).toBe(false);
});


it("preserves arbitrary captured clear RGB and omits alpha1 writes while the checked mask keeps primary output opaque",()=>{
  const r=renderer();r.state.set(0x0c22,[0.25,0.5,0.75,1]);
  const before=new Map(r.state),o=observeSelectorWrites(r);
  expect(drawGpuScanout(r.storage,2,2)).toBe(true);
  // renderer.clear asserts the RGB-off/alpha-on mask and alpha1 at execution.
  expect(r.calls.at(-1)).toEqual(["opaque primary"]);
  expect(o.writes.filter(call=>call[0]==="clearColor")).toEqual([]);
  expect(r.state).toEqual(before);expect(hasNativeRepair(r.gl)).toBe(false);
});


it("refuses unjournaled borrowed storage before commands and accepts its restored real allocation",()=>{
  const r=selectedFront("gpu"),allocation=r.binding.surface.borrowedTarget;
  expect(allocation).not.toBeNull();
  let effects=0;r.gl.clear=()=>{effects++;};
  const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);
  view.setUint16(0,OP_CLEAR,true);view.setUint16(2,4,true);view.setUint32(4,0x4000,true);
  r.binding.cmdbufView=bytes;r.binding.cmdbufLen=bytes.length;
  expect(r.imports.host_gl_make_current(8,22,71,71,12)).toBe(0);
  r.binding.surface.borrowedTarget=null;
  expect(r.imports.host_gl_submit(8,0,bytes.length,12)).toBe(-12);
  expect(effects).toBe(0);expect(r.kernel.gl.hasExecutionRetirements(r.gl)).toBe(false);
  r.binding.surface.borrowedTarget=allocation;
  expect(r.imports.host_gl_submit(8,0,bytes.length,12)).toBe(0);
  expect(effects).toBe(1);
});
