/*
 * A native GL deletion or state restoration that the host's own bookkeeping
 * depends on, refused by a live renderer, is a fatal host fault: nothing
 * guarantees a retry "before later GL work" will ever run or succeed. A lost
 * renderer (including one restored after the loss) is the exception: its
 * objects and state are gone with it, so cleanup completes without touching
 * it and the bindings report the loss through renderer-loss.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import * as R from "../src/webgl/native-recovery.js";
import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement, hasNativeRepair } from "../src/webgl/native-recovery.js";
import { SubmitFrame, SubmitQueue } from "../src/webgl/submit-queue.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";

type Fault = Error & { name: string };
const setReporter = (reporter: ((fault: Error) => void) | null) =>
  (Reflect.get(R, "setNativeGlFaultReporter") as ((r: typeof reporter) => void) | undefined)?.(reporter);
afterEach(() => setReporter(null));

function renderer() {
  let lost = false, refuse = false;
  const errors: number[] = [], live = new Set<object>(), listeners: (() => void)[] = [];
  const make = () => { const value = {}; live.add(value); return value; };
  const remove = (value: object) => { if (refuse) { errors.push(0x502); return; } live.delete(value); };
  const gl = {
    canvas: { addEventListener: (type: string, listener: () => void) => { if (type === "webglcontextlost") listeners.push(listener); } },
    isContextLost: () => lost,
    getError: () => errors.shift() ?? 0,
    getParameter: () => null,
    createTexture: make, createFramebuffer: make,
    deleteTexture: remove, deleteFramebuffer: remove,
    bindTexture: () => { if (refuse) errors.push(0x502); },
  } as unknown as WebGL2RenderingContext;
  return { gl, live, make, owner: { gl, errors: [] as number[], shadow: {} },
    refuse(value: boolean) { refuse = value; },
    lose() { lost = true; for (const listener of listeners) listener(); },
    restore() { lost = false; } };
}

function caught(call: () => unknown): Fault | undefined {
  try { call(); } catch (error) { return error as Fault; }
  return undefined;
}

it("makes a deletion a live renderer refuses a fatal fault, reported before it is thrown", () => {
  const r = renderer(), reported: Error[] = [];
  setReporter(fault => reported.push(fault));
  const texture = r.make();
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture", texture]])!;
  r.refuse(true);
  const fault = caught(() => retireNativeRetirement(retirement));
  expect(fault?.name, "the refused deletion was left pending for a later retry").toBe("NativeGlFault");
  expect(fault!.message).toMatch(/live renderer refused deleteTexture/);
  expect(reported).toEqual([fault]);
});

it("completes a deletion on a lost renderer without a native call or a fault", () => {
  const r = renderer();
  setReporter(() => { throw new Error("a lost renderer must not fault"); });
  const texture = r.make();
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture", texture]])!;
  r.lose(); r.refuse(true);
  expect(retireNativeRetirement(retirement)).toBe(true);
  expect(retirement.complete).toBe(true);
});

it("completes deletion of an object from before a loss after the renderer is restored", () => {
  // The restored context reports INVALID_OPERATION for an object of the lost
  // generation; that refusal is the loss, not a live-renderer fault.
  const r = renderer();
  const texture = r.make();
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture", texture]])!;
  r.lose(); r.restore(); r.refuse(true);
  expect(caught(() => retireNativeRetirement(retirement))).toBeUndefined();
  expect(retirement.complete).toBe(true);
});

it("makes a native state restoration a live renderer refuses a fatal fault", () => {
  const r = renderer(), reported: Error[] = [];
  setReporter(fault => reported.push(fault));
  const fault = caught(() => applyNativeChanges(r.owner, [{
    apply: () => { r.refuse(true); return false; },
    restore: nativeInverse(r.owner, [["bindTexture", 0x0de1, null]]),
  }]));
  expect(fault?.name, "the refused restoration was kept as a pending repair").toBe("NativeGlFault");
  expect(fault!.message).toMatch(/refused to restore native state/);
  expect(reported).toEqual([fault]);
});

it("drops a restoration on a lost renderer instead of fencing the context", () => {
  const r = renderer();
  const texture = r.make();
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture", texture]])!;
  expect(applyNativeChanges(r.owner, [{
    apply: () => { r.lose(); r.refuse(true); return false; },
    restore: nativeInverse(r.owner, [["bindTexture", 0x0de1, null]]),
  }])).toBe(false);
  expect(hasNativeRepair(r.gl)).toBe(false);
  expect(retireNativeRetirement(retirement)).toBe(true);
});

it("collects a deletion requested during a native change when that change ends", () => {
  const r = renderer();
  const texture = r.make();
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture", texture]])!;
  expect(applyNativeChanges(r.owner, [{
    apply: () => { retireNativeRetirement(retirement); return true; },
    restore: nativeInverse(r.owner),
  }])).toBe(true);
  expect(retirement.complete).toBe(true);
  expect(r.live.has(texture)).toBe(false);
});

it("makes a submission whose execution refuses release a fatal fault", () => {
  const reported: Error[] = [];
  setReporter(fault => reported.push(fault));
  const registry = new GlContextRegistry();
  registry.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 64 });
  const binding = registry.get(7, 11)!;
  const queue = new SubmitQueue(() => false, () => ({ binding, admitted: true, run: work => work(), release: () => false }));
  const frame = new SubmitFrame(new Uint8Array(8), 0, 8);
  queue.enqueue(binding, frame);
  const fault = caught(() => queue.removeSession(7, 11));
  expect(fault?.name, "the frame kept its execution for a later retry").toBe("NativeGlFault");
  expect(reported).toEqual([fault]);
});

it("makes a retired context whose cleanup cannot start a fatal fault", () => {
  const r = renderer();
  const registry = new GlContextRegistry();
  registry.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 64 });
  const binding = registry.get(7, 11)!; binding.gl = r.gl; binding.contextId = 1;
  const lease = registry.retainContextExecution(7, 11, { context: r.gl, prepareRetirement: () => false })!;
  registry.destroyContext(7, 11);
  const fault = caught(() => lease.release());
  expect(fault?.name, "the retired context waited for a later retry").toBe("NativeGlFault");
  expect(fault!.message).toMatch(/error flags before retiring a context/);
});

it("routes a native GL fault to the kernel's host-fault callback", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const onHostFault = vi.fn();
  createWasmPosixKernelTestHarness({ io: {} as any, callbacks: { onHostFault } as any, memory, pointerWidth: 4 });
  const r = renderer();
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture", r.make()]])!;
  r.refuse(true);
  const fault = caught(() => retireNativeRetirement(retirement));
  expect(fault).toBeInstanceOf(Error);
  expect(onHostFault).toHaveBeenCalledWith(fault);
});
