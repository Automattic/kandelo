import { expect, it } from "vitest";
import { drawGpuScanout, readGpuScanout } from "../src/webgl/kms-scanout";
import { createWasmPosixKernelTestHarness, getKernelGraphicsAccess } from "../src/kernel";
import { defaultShadow } from "../src/webgl/shadow";
import type { GlMuxer } from "../src/webgl/muxer";
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
  const record = (lease: bigint, x: number) => {
    const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
    view.setBigUint64(0, lease, true);
    [42, 2, 2, x, 4, 0, 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    return bytes;
  };
  const reads = () => r.calls.filter(call => call[0] === "readPixels").length;
  const first = kernel.kms.applyCursorRecord(record(1n, 1)) ?? kernel.kms.cursorSnapshot();
  expect(reads()).toBe(1);
  expect(first.pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
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
  kernel.kms.dropMaster(1n, 1n);
  const retired = kernel.kms.applyCursorRecord(record(1n, 22)) ?? kernel.kms.cursorSnapshot();
  expect(retired.pixels).toBeNull();
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
  return { ...r, kernel, muxer, owner, selected, selections };
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
const readSteps = ["bindFramebuffer:36008", "bindBuffer", "pixelStorei:3333", "pixelStorei:3330", "pixelStorei:3332", "pixelStorei:3331", "readPixels"];

function sequenceFault(kind: "draw" | "read", index: number, fault: "native" | "throw") {
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
          if (fault === "throw") throw Error("native operation refused");
          pending.push(0x502); return;
        }
      }
      return Reflect.apply(original, r.gl, args);
    };
  }
  return { ...r, forward };
}

for (const kind of ["draw", "read"] as const) for (let index = 0; index < 7; index++)
  for (const fault of ["native", "throw"] as const)
    it(`restores KMS ${kind} after ${fault} step ${index} and never executes its dependent suffix`, () => {
      const r = sequenceFault(kind, index, fault);
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
  expect(reads).toBe(kind === "draw" ? 16 : 17);
  expect(r.state).toEqual(r.initial); expect(hasNativeRepair(r.gl)).toBe(false);
});
