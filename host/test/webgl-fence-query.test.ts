import { afterEach, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { NativeGlFault, setNativeGlFaultReporter } from "../src/webgl/native-recovery.js";
import { QOP_CREATE_FENCE, QOP_FENCE_STATUS, QOP_RELEASE_FENCE, QOP_FLUSH } from "../src/webgl/ops.js";

import { markRendererReset, rendererLost, RENDERER_LOST } from "../src/webgl/renderer-loss.js";
import { setGlDiagnosticReporter } from "../src/webgl/diagnostics.js";
import { configureGlAudit, resetGlAuditForTesting } from "../src/webgl/native-audit.js";
afterEach(() => { setGlDiagnosticReporter(null); resetGlAuditForTesting(); setNativeGlFaultReporter(null); });

function renderer() {
  let serial = 0, flushes = 0, errorReads = 0;
  const live = new Map<WebGLSync, number>(), deleted: WebGLSync[] = [];
  const errors: number[] = [];
  const hooks = { create: () => {} };
  const gl = new Proxy({
    getError: () => { errorReads++; return errors.shift() ?? 0; },
    getParameter: () => null,
    flush() { flushes++; },
    isContextLost: () => false,
    fenceSync() { const fence = { serial: ++serial } as WebGLSync; live.set(fence, 0x9118); hooks.create(); return fence; },
    getSyncParameter: (fence: WebGLSync) => live.get(fence) ?? null,
    deleteSync(fence: WebGLSync) { expect(live.delete(fence)).toBe(true); deleted.push(fence); },
  }, { get(target, name) { return Reflect.get(target, name) ?? (() => null); } }) as unknown as WebGL2RenderingContext;
  return { gl, live, deleted, hooks, errors, errorReads: () => errorReads, created: () => serial, flushes: () => flushes,
    signal() { for (const fence of live.keys()) live.set(fence, 0x9119); } };
}
function bytes(token: number): Uint8Array {
  const value = new Uint8Array(4); new DataView(value.buffer).setUint32(0, token, true); return value;
}
function words(value: Uint8Array): number[] {
  const data = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: value.byteLength / 4 }, (_, index) => data.getUint32(index * 4, true));
}
function direct(width: 4 | 8, onHostFault?: (fault: Error) => void) {
  const native = renderer(), memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({ io: {}, memory, pointerWidth: width, callbacks: { onHostFault },
    instance: createKernelScratchTestInstance(width, memory, () => ({}), () => width === 4 ? 4096 : 4096n),
  });
  kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 4096, cmdbufLen: 4096 });
  const binding = kernel.gl.get(7, 11)!; binding.gl = native.gl; binding.contextId = 1;
  const imports = kernel.testAuthority.buildImportObject(memory).env as Record<string, (...args: any[]) => any>;
  const ptr = (value: number) => width === 4 ? value : BigInt(value);
  function query(op: number, token: number, inputLength = 4, outputLength = 16, destination = 8192, session = 11) {
    new Uint8Array(memory.buffer, 4096, 4).set(bytes(token));
    new Uint8Array(memory.buffer, 8192, 16).fill(0xa5);
    const rc = imports.host_gl_query(7, op, ptr(4096), ptr(inputLength), ptr(destination), ptr(outputLength), session);
    return { rc, output: new Uint8Array(memory.buffer, 8192, 16).slice() };
  }
  return { kernel, native, memory, binding, query };
}

it.each([4, 8] as const)("direct fence queries preserve retained authority and idempotent identity at wasm%d import widths", width => {
  const value = direct(width);
  expect(words(value.query(QOP_CREATE_FENCE, 7).output)).toEqual([0, 7, 0, 0x47514c33]);
  expect(value.native.created()).toBe(1);
  expect(words(value.query(QOP_CREATE_FENCE, 7).output)).toEqual([0, 7, 0, 0x47514c33]);
  expect(value.native.created()).toBe(1);
  value.kernel.gl.destroyContext(7, 11);
  expect(value.binding.gl).toBeNull(); value.native.signal();
  expect(words(value.query(QOP_FENCE_STATUS, 7).output)).toEqual([0, 7, 1, 0x47514c33]);
  expect(words(value.query(QOP_RELEASE_FENCE, 7).output)).toEqual([0, 7, 0, 0x47514c33]);
  expect(words(value.query(QOP_RELEASE_FENCE, 7).output)).toEqual([0, 7, 0, 0x47514c33]);
  expect(value.native.deleted).toHaveLength(1);
  expect(words(value.query(QOP_FENCE_STATUS, 7).output)).toEqual([2, 7, 0, 0x47514c33]);
  value.kernel.releaseProcessViews(7);
});
it.each([4, 8] as const)("direct fence requests preflight malformed input/output without native work at wasm%d widths", width => {
  const value = direct(width);
  for (const [inputLength, outputLength] of [[0,16], [8,16], [4,12], [4,20]]) {
    const result = value.query(QOP_CREATE_FENCE, 7, inputLength, outputLength);
    expect(result.rc).toBe(-22); expect([...result.output]).toEqual(Array(16).fill(0xa5));
    expect(value.native.created()).toBe(0);
  }
  expect(value.query(QOP_CREATE_FENCE, 0).rc).toBe(-22);
  expect(value.query(QOP_CREATE_FENCE, 7, 4, 16, value.memory.buffer.byteLength - 8).rc).toBe(-14);
  expect(value.native.created()).toBe(0);
  value.kernel.releaseProcessViews(7);
});
it("does not publish a reply for failed native status observation", () => {
  const value = direct(4); value.query(QOP_CREATE_FENCE, 7);
  value.native.gl.getSyncParameter = () => null;
  const result = value.query(QOP_FENCE_STATUS, 7);
  expect(result.rc).toBe(-5); expect([...result.output]).toEqual(Array(16).fill(0xa5));
  value.kernel.releaseProcessViews(7);
});
it("keeps equal client tokens scoped to distinct object sessions", () => {
  const value = direct(4); value.query(QOP_CREATE_FENCE, 7);
  value.kernel.gl.bind({ pid: 7, sessionId: 12, cmdbufAddr: 4096, cmdbufLen: 4096 });
  expect(words(value.query(QOP_FENCE_STATUS, 7, 4, 16, 8192, 12).output)).toEqual([2, 7, 0, 0x47514c33]);
  value.query(QOP_RELEASE_FENCE, 7, 4, 16, 8192, 12);
  expect(value.native.deleted).toHaveLength(0);
  expect(value.binding.fences.has(7)).toBe(true);
  value.kernel.releaseProcessViews(7);
});
it("a known cancellation token prevents late direct creation from reviving it", () => {
  const value = direct(4);
  expect(value.query(QOP_RELEASE_FENCE, 7).rc).toBe(16);
  expect(words(value.query(QOP_CREATE_FENCE, 7).output)).toEqual([1, 7, 0, 0x47514c33]);
  expect(value.native.created()).toBe(0);
  expect(words(value.query(QOP_CREATE_FENCE, 8).output)).toEqual([0, 8, 0, 0x47514c33]);
  value.kernel.releaseProcessViews(7);
});

it.each([4, 8] as const)("server flush is acknowledged and preflights empty payloads at wasm%d widths", width => {
  const value = direct(width);
  expect(value.query(QOP_FLUSH, 0, 0, 0).rc).toBe(0);
  expect(value.native.flushes()).toBe(1);
  for (const [input, output] of [[4, 0], [0, 4]]) {
    const reply = value.query(QOP_FLUSH, 0, input, output);
    expect(reply.rc).toBe(-22);
    expect([...reply.output]).toEqual(Array(16).fill(0xa5));
  }
  expect(value.native.flushes()).toBe(1);
  value.kernel.releaseProcessViews(7);
});
it("reports a fence deletion the live renderer refuses as a fatal host fault", () => {
  const faults: Error[] = [];
  try {
    const value = direct(4, fault => faults.push(fault)); value.query(QOP_CREATE_FENCE, 7);
    value.native.gl.deleteSync = () => { value.native.errors.push(0x502); };
    // The kernel's host-fault callback latches the fault, and host_gl_query
    // rethrows it instead of converting it into an EIO reply.
    let thrown: unknown;
    try { value.query(QOP_RELEASE_FENCE, 7); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(NativeGlFault);
    expect((thrown as Error).message).toMatch(/live renderer refused deleteSync of an object the host retired/);
    expect(faults).toEqual([thrown]);
    expect(value.native.deleted).toHaveLength(0);
  } finally { setNativeGlFaultReporter(null); }
});
it("preserves selected flags on valid fence admission", () => {
  const value = direct(4); value.query(QOP_CREATE_FENCE, 7);
  value.binding.errors.push(0x500);
  expect(value.query(QOP_CREATE_FENCE, 8).rc).toBe(16);
  expect(value.binding.errors).toEqual([0x500]);
  value.kernel.releaseProcessViews(7);
  expect(value.native.deleted).toHaveLength(2);
});

it.each([4, 8] as const)("samples creation and polling once per fence query at wasm%d widths", width => {
  const value = direct(width);
  const before = value.native.errorReads();
  expect(value.query(QOP_CREATE_FENCE, 7).rc).toBe(16);
  expect(value.native.errorReads() - before).toBe(1);
  const afterCreate = value.native.errorReads();
  expect(value.query(QOP_FENCE_STATUS, 7).rc).toBe(16);
  expect(value.native.errorReads() - afterCreate).toBe(1);
  value.kernel.releaseProcessViews(7);
});

it.each([0x502, 0x505])("resets a fence creator on native flag %s without publishing its candidate", flag => {
  const value = direct(4);
  const peer = { gl: value.native.gl };
  const messages: string[] = [];
  setGlDiagnosticReporter(d => messages.push(d.message));
  value.native.hooks.create = () => value.native.errors.push(flag);
  const result = value.query(QOP_CREATE_FENCE, 7);
  expect(result.rc).toBe(RENDERER_LOST);
  expect([...result.output]).toEqual(Array(16).fill(0xa5));
  expect(rendererLost(value.binding)).toBe(true);
  expect(rendererLost(peer)).toBe(false);
  expect(value.binding.fences.has(7)).toBe(false);
  expect(value.native.live.size).toBe(0);
  expect(value.binding.errors).toEqual([]);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(/pid 7 session 11 batch .*query 0x2e/);
  value.kernel.releaseProcessViews(7);
});

it("resets an unexpected native fence-status error instead of swallowing it privately", () => {
  const value = direct(4);
  setGlDiagnosticReporter(() => {});
  expect(value.query(QOP_CREATE_FENCE, 7).rc).toBe(16);
  value.native.gl.getSyncParameter = () => { value.native.errors.push(0x502); return 0x9118; };
  const result = value.query(QOP_FENCE_STATUS, 7);
  expect(result.rc).toBe(RENDERER_LOST);
  expect([...result.output]).toEqual(Array(16).fill(0xa5));
  expect(rendererLost(value.binding)).toBe(true);
  expect(value.binding.errors).toEqual([]);
  value.kernel.releaseProcessViews(7);
});

it("releases a retained fence after the guest context resets", () => {
  const value = direct(4);
  expect(value.query(QOP_CREATE_FENCE, 7).rc).toBe(16);
  markRendererReset(value.binding);
  expect(value.query(QOP_RELEASE_FENCE, 7).rc).toBe(16);
  expect(value.native.deleted).toHaveLength(1);
  value.kernel.releaseProcessViews(7);
});

it("keeps a divergent fence creation fatal under audit and cancels its unpublished candidate", () => {
  const value = direct(4);
  setGlDiagnosticReporter(() => {});
  configureGlAudit({ mode: "fatal", sink: () => {}, fault: message => { throw new NativeGlFault(message); } });
  value.native.hooks.create = () => value.native.errors.push(0x502);
  expect(() => value.query(QOP_CREATE_FENCE, 7)).toThrow(NativeGlFault);
  expect(value.binding.fences.has(7)).toBe(false);
  expect(value.native.live.size).toBe(0);
  expect(rendererLost(value.binding)).toBe(true);
});
