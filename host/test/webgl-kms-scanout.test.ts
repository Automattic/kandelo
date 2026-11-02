import { afterEach, expect, it } from "vitest";
import { drawGpuScanout, readGpuScanout } from "../src/webgl/kms-scanout";
import { createWasmPosixKernelTestHarness, getKernelGraphicsAccess } from "../src/kernel";
import { defaultShadow } from "../src/webgl/shadow";
import type { GlMuxer } from "../src/webgl/muxer";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { OP_CLEAR, QOP_SURFACE_CAPABILITIES } from "../src/webgl/ops";
import { KMS_CURSOR_FRAMEBUFFER_OFFSET, KMS_CURSOR_RECORD_BYTES } from "../src/dri/kms-cursor-protocol";
import { hasNativeRepair, NativeGlFault, reserveNativeRetirement, setNativeGlFaultReporter } from "../src/webgl/native-recovery";
import { noteStorageWrite, setImageWriteAudit, storageWrites } from "../src/webgl/image-writes";
import { prepareDrawTarget } from "../src/webgl/opaque-alpha";
import { imageTextureOperation, refreshTextureView } from "../src/webgl/image-storage";
import type { GlBinding } from "../src/webgl/registry";

// A refused native restoration or deletion on a live renderer is a fatal
// NativeGlFault (native-recovery.ts): reported once, then thrown through
// every host catch. Tests that count reports install a reporter; always
// reset it.
afterEach(() => setNativeGlFaultReporter(null));
function caught(call: () => unknown): Error | undefined {
  try { call(); } catch (error) { return error as Error; }
  return undefined;
}
const RESTORE_REFUSED = /live renderer refused to restore native state after a rejected change/;

function renderer() {
  const read = {}, draw = {}, pack = {}, fbo = {};
  const state = new Map<number, unknown>([
    [0x8caa, read], [0x8ca6, draw], [0x88ed, pack], [0x0c11, true],
    [0x0d05, 8], [0x0d02, 19], [0x0d04, 3], [0x0d03, 5],
    [0x84e0, 0x84c0], [0x8069, null], [0x8ca7, null], [0x8869, 8],
    [0x0c23, [true, false, true, false]], [0x0c22, [0.25, 0.5, 0.75, 0.125]],
  ]);
  const initial = new Map(state), calls: unknown[][] = [];
  let error = 0, rejectRead = false, rejectRestore = false, lost = false, preserve = true;
  let content = [255, 0, 0, 255], afterRead = () => {};
  // The renderer's canvas: loss events feed renderer-loss.ts's counter.
  const lossListeners: (() => void)[] = [];
  const canvas = { addEventListener: (type: string, listener: () => void) => {
    if (type === "webglcontextlost") lossListeners.push(listener);
  } };
  const gl = {
    canvas,
    isContextLost: () => lost,
    getContextAttributes: () => (lost ? null : { preserveDrawingBuffer: preserve }),
    drawArrays() { calls.push(["drawArrays"]); },
    texSubImage2D() { calls.push(["texSubImage2D"]); },
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
    /** A loss event, then restoration of the same context object. */
    loseAndRestoreContext: () => { lost = true; for (const listener of lossListeners) listener(); lost = false; },
    discardDrawingBuffer: () => { preserve = false; },
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

it("makes a GPU readback restoration the live renderer refuses a fatal fault", () => {
  const r = renderer();
  r.failRead();
  r.failRestore();
  const fault = caught(() => readGpuScanout(r.storage, 2, 2));
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(RESTORE_REFUSED);
  expect(r.calls).toEqual([]);
  // Independent inverse groups still restored the pack buffer and layout.
  expect(r.state.get(0x88ed)).toBe(r.initial.get(0x88ed));
  expect(r.state.get(0x0d05)).toBe(8);
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
  // converted for the cursor canvas. Row zero stays the KMS top row. The
  // render is a counted write to the BO's storage (image-writes.ts).
  r.setPixels([0, 64, 0, 128, 0, 0, 0, 0, 64, 0, 0, 128, 0, 0, 255, 255]);
  noteStorageWrite(kernel.gl.gpuBo(42)!.tex);
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

it("keeps GPU cursor readback failures visible and faults when the live renderer refuses restoration", () => {
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
  const fault = caught(() => kernel.kms.cursorSnapshot());
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(RESTORE_REFUSED);
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
  r.setPixels([0, 255, 0, 255]); noteStorageWrite(kernel.gl.gpuBo(42)!.tex);
  const moved = kernel.kms.applyCursorRecord(record(1n, 9)) ?? kernel.kms.cursorSnapshot();
  expect(reads()).toBe(2);
  expect(moved.x).toBe(9);
  expect(moved.pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 255, 0, 255]));
  expect(first.pixels![0]).toBe(255);
  // No new ioctl/record: observe the native BO again, including context loss.
  r.setPixels([0, 0, 255, 255]); noteStorageWrite(kernel.gl.gpuBo(42)!.tex);
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
    r.setPixels(rgba); noteStorageWrite(r.kernel.gl.gpuBo(42)!.tex);
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

it("faults when the live renderer refuses to restore rejected cursor work", () => {
  const r = selectedKernel();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.failRead(); r.failRestore();
  const fault = caught(() => r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0));
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(RESTORE_REFUSED);
  expect(r.owner.errors).toEqual([]);
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

it("faults when another guard cannot prepare a retired context's cleanup", () => {
  const r = selectedKernel();
  r.kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
  const old = r.kernel.gl.get(7, 11)!;
  old.gl = r.gl; old.contextId = 1;
  const guard = { context: r.gl, prepareRetirement: () => false };
  const lease = r.kernel.gl.retainContextExecution(7, 11, guard)!;
  r.kernel.gl.destroyContext(7, 11);
  const fault = caught(() => lease.release());
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/could not read the selected owner's error flags before retiring a context/);
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

it("faults on a refused inverse after an early KMS selector failure but restores independent state", () => {
  const r = sequenceFault("read", 1, "native"); r.failRestore();
  const fault = caught(() => readGpuScanout(r.storage, 2, 2));
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(RESTORE_REFUSED);
  expect(r.state.get(0x88ed)).toBe(r.initial.get(0x88ed));
  expect([0x0d05, 0x0d02, 0x0d04, 0x0d03].map(p => r.state.get(p)))
    .toEqual([0x0d05, 0x0d02, 0x0d04, 0x0d03].map(p => r.initial.get(p)));
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
  it(`preserves ${kind} front ENOMEM and drops the inverse of a renderer lost during the export`,()=>{
    const r=selectedFront(kind),faults:Error[]=[];setNativeGlFaultReporter(fault=>faults.push(fault));
    r.fault("memory");r.afterFront(r.loseContext);
    expect(r.run()).toBe(-12);expect(r.publications()).toBe(0);
    // A lost renderer has no state left to restore: no fault, no pending repair.
    expect(faults).toEqual([]);expect(hasNativeRepair(r.gl)).toBe(false);
    r.muxer.switchTo(r.owner);expect(r.selections()).toBe(r.before+1);
  });
  it(`reports a ${kind} front inverse the live renderer refuses as a fatal host fault`,()=>{
    const r=selectedFront(kind),faults:Error[]=[];setNativeGlFaultReporter(fault=>faults.push(fault));
    r.failRestore();
    // The reporter latches the fault and host_gl_update_surface rethrows it
    // instead of converting it into EIO.
    const fault=caught(()=>r.run());
    expect(fault).toBeInstanceOf(NativeGlFault);expect(fault!.message).toMatch(RESTORE_REFUSED);
    expect(faults).toEqual([fault]);expect(r.publications()).toBe(0);
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
}

it("invalidates a successful CPU front read if canonical publication refuses",()=>{
  const r=selectedFront("cpu");r.kernel.bos.publishDevicePixels=()=>false;
  expect(r.run()).toBe(-5);r.muxer.switchTo(r.owner);
  expect(r.selections()).toBe(r.before+1);expect(r.binding.errors).toEqual([]);
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
  it(`faults when the live renderer refuses the late read layout inverse${field} without replaying readback`,()=>{
    const r=renderer(),original=r.gl.pixelStorei.bind(r.gl);let restoring=false,reads=0;
    r.onRead(()=>{restoring=true;reads++;});
    r.gl.pixelStorei=(p,v)=>{
      if(restoring&&p===field&&v===r.initial.get(p)){original(p,v);r.setError(0x502);return;}
      original(p,v);
    };
    const fault=caught(()=>readGpuScanout(r.storage,1,2));
    expect(fault).toBeInstanceOf(NativeGlFault);expect(fault!.message).toMatch(RESTORE_REFUSED);
    expect(reads).toBe(1);
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
    it(`faults when the live renderer refuses the post-effect primary ${selector} inverse (${fault})`,()=>{
      const r=renderer();let restoring=false;
      const clear=r.gl.clear.bind(r.gl);r.gl.clear=(bits)=>{clear(bits);restoring=true;};
      const method={draw:"bindFramebuffer",read:"bindFramebuffer",scissor:"enable",mask:"colorMask",clear:"clearColor"}[selector]as"bindFramebuffer"|"enable"|"colorMask"|"clearColor";
      const original=r.gl[method];
      (r.gl as any)[method]=(...args:unknown[])=>{
        const chosen=restoring&&(selector==="draw"?args[0]===0x8ca9&&args[1]===r.initial.get(0x8ca6)
          :selector==="read"?args[0]===0x8ca8&&args[1]===r.initial.get(0x8caa)
          :selector==="scissor"?args[0]===0x0c11:true);
        const value=Reflect.apply(original,r.gl,args);
        if(chosen){if(fault==="throw")throw Error("inverse after effect");r.setError(0x502);}
        return value;
      };
      const refusal=caught(()=>drawGpuScanout(r.storage,2,2));
      expect(refusal).toBeInstanceOf(NativeGlFault);expect(refusal!.message).toMatch(RESTORE_REFUSED);
      // The primary was presented exactly once before its inverse was refused.
      expect(r.calls.filter(call=>call[0]==="opaque primary")).toHaveLength(1);
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
  expect(effects).toBe(0);
  r.binding.surface.borrowedTarget=allocation;
  expect(r.imports.host_gl_submit(8,0,bytes.length,12)).toBe(0);
  expect(effects).toBe(1);
});

// DRM ADDFB2 accepts an exported GLES image's GPU-tier bo (EGLImage →
// gbm_bo_import(GBM_BO_IMPORT_EGL_IMAGE) → drmModeAddFB2), so KMS presents
// the image's own storage: a framebuffer over it is made on first scanout,
// read every vblank like a GBM GPU bo, and deleted with the bo.
it("scans out and samples the cursor from an exported GLES image's own storage", () => {
  const r = selectedKernel(), native = {}, attached: unknown[][] = [], deleted: unknown[] = [];
  Object.assign(r.gl, {
    framebufferTexture2D: (...args: unknown[]) => attached.push(args),
    deleteFramebuffer: (fbo: unknown) => deleted.push(fbo),
  });
  const record = { bo: 43, gl: r.gl, object: {}, native, renderbuffer: false, width: 2, height: 2,
    storage: { target: 0x8516, level: 1 }, sourceUsing: true, boLive: true, format: 0x8058 };
  r.kernel.gl.publishExportedImage(record as any);
  const canvas = { width: 2, height: 2, getContext: () => null };
  r.setPixels([0, 255, 0, 255]);
  const frame = getKernelGraphicsAccess(r.kernel).gpuScanout(
    { bo_id: 43, width: 2, height: 2 } as any, canvas as any, false);
  expect(frame?.direct).toBe(false);
  expect([...(frame as { pixels: Uint8Array }).pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  // The image's cube face and level are attached once, on the read target.
  expect(attached).toEqual([[0x8ca8, 0x8ce0, 0x8516, native, 1]]);
  r.setPixels([0, 0, 255, 255]);
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.kernel.kms.setCursor(100, 3, 43, 2, 2, 0, 0, 0, 0);
  expect([...r.kernel.kms.cursorSnapshot().pixels!.slice(0, 4)]).toEqual([0, 0, 255, 255]);
  expect(attached.length).toBe(1);
  expect(r.state).toEqual(r.selected);
  r.kernel.gl.retireForeignBo(43);
  expect(deleted).toContain(r.storage.fbo);
  expect(hasNativeRepair(r.gl)).toBe(false);
});

it("does not present an exported image that is not normalized color", () => {
  const r = selectedKernel();
  r.kernel.gl.publishExportedImage({ bo: 44, gl: r.gl, object: {}, native: {}, renderbuffer: true,
    width: 2, height: 2, storage: {}, sourceUsing: true, boLive: true, format: 0x8814 } as any);
  expect(getKernelGraphicsAccess(r.kernel).gpuScanout(
    { bo_id: 44, width: 2, height: 2 } as any, { width: 2, height: 2, getContext: () => null } as any, false))
    .toBeNull();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.kernel.kms.setCursor(100, 3, 44, 2, 2, 0, 0, 0, 0);
  expect(r.kernel.kms.cursorSnapshot().pixels).toBeNull();
});

// ---------------------------------------------------------------------------
// Unchanged GPU content is not read back or re-presented every vblank.
//
// A cursor readback is reused while its storage's image write count
// (image-writes.ts) is unchanged; a direct scanout is not redrawn while no
// pixel-changing call was made on its context (context-writes.ts). Each test
// below performs one kind of write and requires the next observation to see
// it. The audit (on in this gate) would also read back on every reuse and
// fault on a change behind an unchanged count; these tests turn it off to
// observe that reuse issues no native call at all.

function withoutAudit(work: () => void): void {
  setImageWriteAudit(false);
  try { work(); } finally { setImageWriteAudit(true); }
}

function cursorKernel() {
  const r = selectedKernel();
  r.kernel.kms.setMaster(100, 1n, 1n);
  r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0);
  const gpu = r.kernel.gl.gpuBo(42)!;
  let nativeCalls = 0;
  for (const name of ["getError", "getParameter", "readPixels", "bindFramebuffer"] as const) {
    const original = r.gl[name] as (...args: unknown[]) => unknown;
    (r.gl as any)[name] = (...args: unknown[]) => { nativeCalls++; return Reflect.apply(original, r.gl, args); };
  }
  const reads = () => r.calls.filter(call => call[0] === "readPixels").length;
  /** One vblank observation's cursor pixels (first four bytes). */
  const observe = () => [...r.kernel.kms.cursorSnapshot().pixels!.slice(0, 4)];
  return { ...r, gpu, reads, observe, nativeCalls: () => nativeCalls };
}

it("reuses an unchanged GPU cursor readback without any native call", () => withoutAudit(() => {
  const r = cursorKernel();
  expect(r.reads()).toBe(1);
  const before = r.nativeCalls();
  for (let tick = 0; tick < 5; tick++) expect(r.observe()).toEqual([255, 0, 0, 255]);
  expect(r.reads()).toBe(1);
  expect(r.nativeCalls()).toBe(before);
  // The guest's selected GL state and error flags were not borrowed.
  expect(r.state).toEqual(r.selected);
}));

function drawBinding(r: ReturnType<typeof cursorKernel>, fbo: WebGLFramebuffer) {
  const shadow = defaultShadow();
  shadow.fbo = fbo;
  return { gl: r.gl, shadow, errors: [] as number[], framebufferAttachments: new Map(),
    textureViews: new Map(), renderbufferViews: new Map() } as unknown as GlBinding;
}

it.each([
  ["a draw or clear into the BO as its EGL surface's framebuffer", (r: ReturnType<typeof cursorKernel>) => {
    // The bridge's draws and clears count their target through prepareDrawTarget.
    prepareDrawTarget(drawBinding(r, r.gpu.fbo));
  }],
  ["a draw or clear into an FBO whose color attachment is an EGLImage sibling of the BO", (r: ReturnType<typeof cursorKernel>) => {
    const sibling = {} as WebGLTexture, userFbo = {} as WebGLFramebuffer;
    const b = drawBinding(r, userFbo);
    b.framebufferAttachments.set(userFbo, new Map([[0x8ce0, { kind: "texture", object: sibling, target: 0x0de1, level: 0 }]]));
    b.textureViews.set(sibling, { native: {} as WebGLTexture, read: null,
      source: { token: 1, bo: 42, texture: r.gpu.tex, width: 2, height: 2 } });
    prepareDrawTarget(b);
  }],
  ["TexSubImage/CopyTexSubImage through an EGLImage sibling texture", (r: ReturnType<typeof cursorKernel>) => {
    const sibling = {} as WebGLTexture, b = drawBinding(r, null as unknown as WebGLFramebuffer);
    b.shadow.textureUnits[0] = sibling;
    b.textureViews.set(sibling, { native: {} as WebGLTexture, read: null,
      source: { token: 1, bo: 42, texture: r.gpu.tex, width: 2, height: 2 } });
    imageTextureOperation(b, 0x0de1, false, () => r.gl.texSubImage2D(0x0de1, 0, 0, 0, 1, 1, 0x1908, 0x1401, null));
  }],
  ["a host copy or resolve into the BO's storage (GBM front copy, MSAA resolve, mirror upload)", (r: ReturnType<typeof cursorKernel>) => {
    noteStorageWrite(r.gpu.tex);
  }],
] as const)("re-reads the GPU cursor after %s", (_kind, write) => withoutAudit(() => {
  const r = cursorKernel();
  expect(r.observe()).toEqual([255, 0, 0, 255]);
  r.setPixels([10, 20, 30, 255]);
  write(r);
  expect(r.observe()).toEqual([10, 20, 30, 255]);
  expect(r.reads()).toBe(2);
  // And reuses the new bytes until the next write.
  expect(r.observe()).toEqual([10, 20, 30, 255]);
  expect(r.reads()).toBe(2);
}));

it("re-reads the GPU cursor after its renderer is lost and restored", () => withoutAudit(() => {
  const r = cursorKernel();
  r.setPixels([9, 9, 9, 255]);
  r.loseAndRestoreContext();
  expect(r.observe()).toEqual([9, 9, 9, 255]);
  expect(r.reads()).toBe(2);
}));

it("shows no cursor while its renderer is lost and re-reads it afterwards", () => withoutAudit(() => {
  const r = cursorKernel();
  r.loseContext();
  expect(r.kernel.kms.cursorSnapshot().pixels).toBeNull();
  expect(r.reads()).toBe(1);
}));

it("re-reads the GPU cursor when its BO is replaced under the same id", () => withoutAudit(() => {
  const r = cursorKernel();
  const imports = r.kernel.testAuthority.buildImportObject(r.memory) as { env: Record<string, (...args: number[]) => number> };
  imports.env.host_gbm_bo_destroy(100, 42);
  expect(r.kernel.gl.createGpuBo(42, r.gl, 2, 2)).toBeGreaterThan(0);
  // The new BO's storage is new: nothing about the old one's count applies.
  r.setPixels([5, 6, 7, 255]);
  r.kernel.kms.setCursor(100, 3, 42, 2, 2, 0, 0, 0, 0);
  expect(r.observe()).toEqual([5, 6, 7, 255]);
  expect(r.reads()).toBe(2);
}));

it("takes the full GPU cursor path while a native repair is pending", () => withoutAudit(() => {
  const r = cursorKernel();
  const retirement = reserveNativeRetirement({ gl: r.gl, errors: [] }, [["deleteTexture", {} as WebGLTexture]])!;
  retirement.pending = true;
  expect(hasNativeRepair(r.gl)).toBe(true);
  r.observe();
  expect(r.reads()).toBe(2);
  expect(hasNativeRepair(r.gl)).toBe(false);
}));

it("faults under the write-count audit when cursor storage changed without a counted write", () => {
  const r = cursorKernel();
  r.setPixels([1, 1, 1, 1]);
  expect(() => r.observe()).toThrow(/changed without a counted write/);
});

function directKernel() {
  const r = selectedKernel();
  const canvas = { width: 2, height: 2, getContext: () => r.gl };
  const fb = { fb_id: 25, bo_id: 42, width: 2, height: 2, x: 0, y: 0 } as any;
  const blits = () => r.calls.filter(call => call.length === 10 && call[8] === 0x4000).length;
  const present = (frame = fb, commits = 1, target: unknown = canvas) =>
    getKernelGraphicsAccess(r.kernel).gpuScanout(frame, target as any, true, 0, commits);
  return { ...r, canvas, fb, blits, present };
}

it("does not redraw an unchanged direct GPU scanout", () => {
  const r = directKernel();
  expect(r.present()?.direct).toBe(true);
  expect(r.blits()).toBe(1);
  const before = r.calls.length;
  for (let tick = 0; tick < 5; tick++) expect(r.present()?.direct).toBe(true);
  expect(r.blits()).toBe(1);
  expect(r.calls.length).toBe(before);
  expect(r.state).toEqual(r.selected);
});

it.each([
  ["a guest draw on the context", (r: ReturnType<typeof directKernel>) => { r.gl.drawArrays(4, 0, 3); }],
  ["a texture upload on the context", (r: ReturnType<typeof directKernel>) => {
    r.gl.texSubImage2D(0x0de1, 0, 0, 0, 1, 1, 0x1908, 0x1401, null);
  }],
  ["a clear of the canvas (a dark CRTC)", (r: ReturnType<typeof directKernel>) => {
    getKernelGraphicsAccess(r.kernel).withGraphicsState(r.gl, () => {
      r.gl.bindFramebuffer(0x8d40, null); r.gl.disable(0x0c11);
      r.gl.colorMask(false, false, false, true); r.gl.clearColor(0, 0, 0, 1); r.gl.clear(0x4000);
    });
  }],
  ["a call no classification names", (r: ReturnType<typeof directKernel>) => {
    (r.gl as any).drawingBufferStorage(0x8058, 2, 2);
  }],
  ["a canvas resize", (r: ReturnType<typeof directKernel>) => { r.canvas.width = 3; }],
  ["a lost and restored renderer", (r: ReturnType<typeof directKernel>) => { r.loseAndRestoreContext(); }],
] as const)("redraws a direct GPU scanout after %s", (_kind, change) => {
  const r = directKernel();
  (r.gl as any).drawingBufferStorage = () => {};
  r.present();
  change(r);
  r.present();
  expect(r.blits()).toBe(2);
  expect([r.canvas.width, r.canvas.height]).toEqual([2, 2]);
  r.present();
  expect(r.blits()).toBe(2);
});

it("counts every call of an extension obtained after tracking began as a write", () => {
  const r = directKernel();
  const extension = { multiDrawArraysWEBGL() {} };
  (r.gl as any).getExtension = () => extension;
  r.present();
  (r.gl as any).getExtension("WEBGL_multi_draw").multiDrawArraysWEBGL();
  r.present();
  expect(r.blits()).toBe(2);
});

it.each([
  ["another framebuffer", (fb: any) => ({ ...fb, fb_id: 26 }), 1],
  ["a new commit of the same framebuffer", (fb: any) => fb, 2],
  ["a panned viewport", (fb: any) => ({ ...fb, x: 1, width: 1 }), 1],
] as const)("redraws a direct GPU scanout for %s", (_kind, next, commits) => {
  const r = directKernel();
  r.present();
  r.present(next(r.fb), commits);
  expect(r.blits()).toBe(2);
});

it("redraws a direct GPU scanout on another canvas, or when the context does not preserve its drawing buffer", () => {
  const r = directKernel();
  r.present();
  r.present(r.fb, 1, { width: 2, height: 2, getContext: () => r.gl });
  expect(r.blits()).toBe(2);
  r.discardDrawingBuffer();
  r.present(); r.present();
  expect(r.blits()).toBe(4);
});

it("takes the full direct scanout path while a native repair is pending, and keeps no record of a failed one", () => {
  const r = directKernel();
  r.present();
  const retirement = reserveNativeRetirement({ gl: r.gl, errors: [] }, [["deleteTexture", {} as WebGLTexture]])!;
  retirement.pending = true;
  r.present();
  expect(r.blits()).toBe(2);
  // A rejected blit throws and leaves nothing to reuse.
  const blit = r.gl.blitFramebuffer;
  r.gl.drawArrays(4, 0, 3);
  (r.gl as any).blitFramebuffer = () => { r.setError(0x502); };
  expect(() => r.present()).toThrow("GPU scanout blit failed");
  (r.gl as any).blitFramebuffer = blit;
  r.present();
  expect(r.blits()).toBe(3);
});

it("counts a sibling view's refresh from its canonical image as a write of the view's own storage", () => {
  // A GLES image exported from an EGLImage sibling texture is presented from
  // the sibling's private copy, which a refresh rewrites.
  const r = renderer();
  (r.gl as any).copyTexSubImage2D = () => { r.calls.push(["copyTexSubImage2D"]); };
  const canonical = {} as WebGLTexture, sibling = {} as WebGLTexture;
  const view = { native: {} as WebGLTexture, read: {} as WebGLFramebuffer,
    source: { token: 1, bo: 7, texture: canonical, width: 2, height: 2 } };
  const b = { gl: r.gl, shadow: defaultShadow(), errors: [] as number[], textureViews: new Map([[sibling, view]]),
    renderbufferViews: new Map(), framebufferAttachments: new Map() } as unknown as GlBinding;
  const before = storageWrites(view.native).count;
  expect(refreshTextureView(b, sibling)).toBe(true);
  expect(r.calls.filter(call => call[0] === "copyTexSubImage2D")).toHaveLength(1);
  expect(storageWrites(view.native).count).toBeGreaterThan(before);
  expect(r.state).toEqual(r.initial);
});
