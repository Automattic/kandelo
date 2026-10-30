import { expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { setupMainForward, type GlForwardMessage } from "../src/webgl/main-forward.js";
import { createGlForwardQueryMailbox, prepareGlForwardQuery, retireGlForwardQuery, waitForGlForwardQuery } from "../src/webgl/main-forward-query.js";
import { QOP_CREATE_FENCE, QOP_FENCE_STATUS, QOP_RELEASE_FENCE, QOP_FLUSH } from "../src/webgl/ops.js";

function renderer() {
  let serial = 0, flushes = 0;
  const live = new Map<WebGLSync, number>(), deleted: WebGLSync[] = [];
  const errors: number[] = [];
  const hooks = { create: () => {} };
  const gl = new Proxy({
    getError: () => errors.shift() ?? 0,
    getParameter: () => null,
    flush() { flushes++; },
    isContextLost: () => false,
    fenceSync() { const fence = { serial: ++serial } as WebGLSync; live.set(fence, 0x9118); hooks.create(); return fence; },
    getSyncParameter: (fence: WebGLSync) => live.get(fence) ?? null,
    deleteSync(fence: WebGLSync) { expect(live.delete(fence)).toBe(true); deleted.push(fence); },
  }, { get(target, name) { return Reflect.get(target, name) ?? (() => null); } }) as unknown as WebGL2RenderingContext;
  return { gl, live, deleted, hooks, errors, created: () => serial, flushes: () => flushes,
    signal() { for (const fence of live.keys()) live.set(fence, 0x9119); } };
}
function bytes(token: number): Uint8Array {
  const value = new Uint8Array(4); new DataView(value.buffer).setUint32(0, token, true); return value;
}
function words(value: Uint8Array): number[] {
  const data = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: value.byteLength / 4 }, (_, index) => data.getUint32(index * 4, true));
}
function direct(width: 4 | 8) {
  const native = renderer(), memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({ io: {}, memory, pointerWidth: width,
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

function forwarded() {
  const native = renderer();
  let listener: ((event: MessageEvent) => void) | null = null;
  const worker = { addEventListener(_type: "message", next: (event: MessageEvent) => void) { listener = next; }, removeEventListener() { listener = null; } };
  const fire = (data: GlForwardMessage) => listener!({ data } as MessageEvent);
  const dispose = setupMainForward(worker, { width: 1, height: 1, getContext: () => native.gl } as unknown as HTMLCanvasElement, 7);
  const create = createGlForwardQueryMailbox(); prepareGlForwardQuery(create, 0);
  fire({ type: "gl_forward_create_context", pid: 7, sessionId: 11, mailbox: create });
  expect(waitForGlForwardQuery(create).rc).toBe(0);
  function query(op: number, token: number, mailbox = createGlForwardQueryMailbox(), outputLength = 16, input = bytes(token)) {
    prepareGlForwardQuery(mailbox, outputLength);
    fire({ type: "gl_forward_query", pid: 7, sessionId: 11, op, input, mailbox });
    return waitForGlForwardQuery(mailbox);
  }
  return { native, query, fire, dispose };
}
it("forwarded fences retain completion after creator destruction and reconcile duplicate creation", () => {
  const value = forwarded();
  expect(words(value.query(QOP_CREATE_FENCE, 9).bytes)).toEqual([0, 9, 0, 0x47514c33]);
  value.query(QOP_CREATE_FENCE, 9); expect(value.native.created()).toBe(1);
  value.fire({ type: "gl_forward_destroy_context", pid: 7, sessionId: 11 });
  value.native.signal();
  expect(words(value.query(QOP_FENCE_STATUS, 9).bytes)).toEqual([0, 9, 1, 0x47514c33]);
  value.query(QOP_RELEASE_FENCE, 9); value.query(QOP_RELEASE_FENCE, 9);
  expect(value.native.deleted).toHaveLength(1); value.dispose();
});
it("cancels a forwarded candidate when the worker retires its reply during allocation", () => {
  const value = forwarded(), mailbox = createGlForwardQueryMailbox();
  value.native.hooks.create = () => retireGlForwardQuery(mailbox);
  expect(value.query(QOP_CREATE_FENCE, 9, mailbox).rc).toBe(-5);
  expect(value.native.created()).toBe(1); expect(value.native.deleted).toHaveLength(1);
  expect(words(value.query(QOP_FENCE_STATUS, 9).bytes)).toEqual([2, 9, 0, 0x47514c33]);
  value.native.hooks.create = () => {};
  expect(words(value.query(QOP_CREATE_FENCE, 9).bytes)).toEqual([1, 9, 0, 0x47514c33]);
  expect(value.native.created()).toBe(1); value.dispose();
});
it("does not allocate a native fence for a request delivered after mailbox retirement", () => {
  const value = forwarded(), mailbox = createGlForwardQueryMailbox();
  prepareGlForwardQuery(mailbox, 16); retireGlForwardQuery(mailbox);
  value.fire({ type: "gl_forward_query", pid: 7, sessionId: 11, op: QOP_CREATE_FENCE, input: bytes(9), mailbox });
  expect(value.native.created()).toBe(0); value.dispose();
});
it("known-token cancellation is idempotent on the forwarded receiver", () => {
  const value = forwarded();
  value.query(QOP_RELEASE_FENCE, 9); value.query(QOP_RELEASE_FENCE, 9);
  expect(words(value.query(QOP_CREATE_FENCE, 9).bytes)).toEqual([1, 9, 0, 0x47514c33]);
  expect(value.native.created()).toBe(0);
  expect(words(value.query(QOP_CREATE_FENCE, 10).bytes)).toEqual([0, 10, 0, 0x47514c33]);
  value.dispose(); expect(value.native.deleted).toHaveLength(1);
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
it("the forwarded receiver acknowledges flush without inventing a completion wait", () => {
  const value = forwarded();
  expect(value.query(QOP_FLUSH, 0, createGlForwardQueryMailbox(), 0, new Uint8Array()).rc).toBe(0);
  expect(value.native.flushes()).toBe(1);
  expect(value.query(QOP_FLUSH, 0).rc).toBe(-22);
  expect(value.native.flushes()).toBe(1);
  value.dispose();
});

it("rejects malformed fence requests before replaying pending cleanup, then preserves selected flags on valid admission", () => {
  const value = direct(4); value.query(QOP_CREATE_FENCE, 7);
  const destroy = value.native.gl.deleteSync;
  value.native.gl.deleteSync = () => { value.native.errors.push(0x502); };
  expect(value.query(QOP_RELEASE_FENCE, 7).rc).toBe(16);
  expect(value.native.deleted).toHaveLength(0);
  value.native.gl.deleteSync = destroy;
  expect(value.query(QOP_CREATE_FENCE, 8, 0, 16).rc).toBe(-22);
  expect(value.native.deleted).toHaveLength(0);
  value.native.errors.push(0x500);
  expect(value.query(QOP_CREATE_FENCE, 8).rc).toBe(16);
  expect(value.native.deleted).toHaveLength(1);
  expect(value.binding.errors).toEqual([0x500]);
  value.kernel.releaseProcessViews(7);
  expect(value.native.deleted).toHaveLength(2);
});
