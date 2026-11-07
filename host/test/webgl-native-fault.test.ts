import {withNativeBatch} from "../src/webgl/native-batch.js";
/*
 * A native GL deletion or state restoration that the host's own bookkeeping
 * depends on, refused by a live renderer, is a fatal host fault: nothing
 * guarantees a retry "before later GL work" will ever run or succeed. A lost
 * renderer (including one restored after the loss) is the exception: its
 * objects and state are gone with it, so cleanup completes without touching
 * it and the bindings report the loss through renderer-loss.ts.
 */
import { finalizeShader } from "../src/webgl/program-objects.js";
import * as Loss from "../src/webgl/renderer-loss.js";
import { observeRendererLoss, rendererLossCount, rendererLost, markRendererReset } from "../src/webgl/renderer-loss.js";
import { destroyBufferStorage } from "../src/webgl/buffer-storage.js";
import { destroyTextureView, destroyRenderbufferView } from "../src/webgl/image-storage.js";
import { afterEach, expect, it, vi } from "vitest";
import * as R from "../src/webgl/native-recovery.js";
import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement, hasNativeRepair } from "../src/webgl/native-recovery.js";
import { SubmitFrame, SubmitQueue } from "../src/webgl/submit-queue.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelEntryGatedInstance, KernelEntryGate, isKernelExportFailure } from "../src/kernel-entry-gate.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";

type Fault = Error & { name: string };
const setReporter = (reporter: ((fault: Error) => void) | null) =>
  (Reflect.get(R, "setNativeGlFaultReporter") as ((r: typeof reporter) => void) | undefined)?.(reporter);
afterEach(() => setReporter(null));

function renderer() {
  let lost = false, refuse = false;
  const errors: number[] = [], live = new Set<object>(), listeners: (() => void)[] = [], restored: (() => void)[] = [];
  const make = () => { const value = {}; live.add(value); return value; };
  const remove = (value: object) => { if (refuse) { errors.push(0x502); return; } live.delete(value); };
  const gl = {
    canvas: { addEventListener: (type: string, listener: () => void) => { if (type === "webglcontextlost") listeners.push(listener); else if (type === "webglcontextrestored") restored.push(listener); } },
    isContextLost: () => lost,
    getError: () => errors.shift() ?? 0,
    getParameter: () => null,
    createTexture: make, createFramebuffer: make,
    deleteTexture: remove, deleteFramebuffer: remove, deleteBuffer: remove, deleteRenderbuffer: remove, deleteShader: remove,
    bindTexture: () => { if (refuse) errors.push(0x502); },
  } as unknown as WebGL2RenderingContext;
  return { gl, live, make, owner: { gl, errors: [] as number[], shadow: {} },
    refuse(value: boolean) { refuse = value; },
    lose() { lost = true; for (const listener of listeners) listener(); },
    restore() { lost = false; for (const listener of restored) listener(); } };
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

for (const kind of ["buffer", "texture", "renderbuffer"] as const) {
  it(`retires ${kind} storage first scheduled after loss and restoration`, () => {
    const r = renderer(), registry = new GlContextRegistry();
    registry.bind({pid:7, sessionId:11, cmdbufAddr:0, cmdbufLen:64});
    const b = registry.get(7,11)!; b.gl = r.gl;
    observeRendererLoss(b);
    const object = r.make();
    r.lose(); r.restore(); r.refuse(true);
    const destroy = kind === "buffer" ? destroyBufferStorage : kind === "texture" ? destroyTextureView : destroyRenderbufferView;
    expect(caught(() => expect(destroy(b,object)).toBe(true))).toBeUndefined();
  });
}

it("keeps the original generation in an independent native owner", () => {
  const r = renderer(); observeRendererLoss(r.owner);
  const owner = R.nativeOwner(r.owner), object = r.make();
  r.lose(); r.restore(); r.refuse(true);
  const retirement = reserveNativeRetirement(owner, [["deleteTexture",object]])!;
  expect(caught(() => retireNativeRetirement(retirement))).toBeUndefined();
  expect(retirement.complete).toBe(true);
});

it("still faults on refused deletion of a new object after restoration", () => {
  const r = renderer(); observeRendererLoss(r.owner);
  r.lose(); r.restore();
  const fresh = {gl:r.gl, errors:[] as number[]}; observeRendererLoss(fresh);
  const retirement = reserveNativeRetirement(fresh, [["deleteTexture",r.make()]])!;
  r.refuse(true);
  expect(caught(() => retireNativeRetirement(retirement))?.name).toBe("NativeGlFault");
});

it("records synchronous loss before the delayed canvas event, without counting it twice", () => {
  const r = renderer(); observeRendererLoss(r.owner);
  const object = r.make();
  (Reflect.get(Loss,"noteRendererLoss") as ((gl: WebGL2RenderingContext) => void) | undefined)?.(r.gl);
  expect(rendererLossCount(r.gl)).toBe(1);
  r.lose();
  expect(rendererLossCount(r.gl)).toBe(1);
  r.restore(); r.refuse(true);
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture",object]])!;
  expect(caught(() => retireNativeRetirement(retirement))).toBeUndefined();
});

it("does not discard native cleanup when only the logical guest context reset", () => {
  const r = renderer(); observeRendererLoss(r.owner);
  const retirement = reserveNativeRetirement(r.owner, [["deleteTexture",r.make()]])!;
  markRendererReset(r.owner);
  expect(rendererLost(r.owner)).toBe(true);
  r.refuse(true);
  expect(caught(() => retireNativeRetirement(retirement))?.name).toBe("NativeGlFault");
});

it("a recreated context in the same session starts after the earlier renderer loss", () => {
  const r = renderer(), registry = new GlContextRegistry();
  registry.bind({pid:7, sessionId:11, cmdbufAddr:0, cmdbufLen:64});
  const b = registry.get(7,11)!; b.gl = r.gl; observeRendererLoss(b);
  r.lose(); r.restore();
  expect(rendererLost(b)).toBe(true);
  registry.destroyContext(7,11);
  b.gl = r.gl; observeRendererLoss(b);
  expect(rendererLost(b)).toBe(false);
});

it("still faults when a new shader's final deletion is refused after restoration", () => {
  const r = renderer(); observeRendererLoss(r.owner); r.lose(); r.restore();
  const registry = new GlContextRegistry();
  registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:64});
  const b = registry.get(7,11)!; b.gl = r.gl; observeRendererLoss(b);
  b.shaders.set(1,r.make()); b.shaderDeletePending.add(1);
  r.refuse(true);
  expect(caught(() => finalizeShader(b,1))?.name).toBe("NativeGlFault");
});

it("detects a second physical loss on Node renderers without canvas events", () => {
  const r = renderer(); Reflect.deleteProperty(r.gl,"canvas");
  observeRendererLoss(r.owner);
  r.lose(); expect(rendererLost(r.owner)).toBe(true);
  r.restore();
  const next = {gl:r.gl,errors:[] as number[]}; observeRendererLoss(next);
  const object = r.make();
  r.lose(); expect(rendererLost(next)).toBe(true);
  r.restore(); r.refuse(true);
  const retirement = reserveNativeRetirement(next,[["deleteTexture",object]])!;
  expect(caught(() => retireNativeRetirement(retirement))).toBeUndefined();
});

it("retains the first reported native fault when finally cleanup fails too", () => {
  const reported: Error[] = [];
  setReporter(fault => reported.push(fault));
  let first: unknown;
  const thrown = caught(() => {
    try { R.nativeGlFault("first native invariant failure"); }
    catch (error) { first = error; throw error; }
    finally { R.nativeGlFault("secondary cleanup failure"); }
  });
  expect(reported).toEqual([first]);
  expect(thrown).toBe(first);
  expect(thrown?.message).toBe("first native invariant failure");
});

it("latches a native fault before its reporter can reenter and restores a new reporter", () => {
  const reported: Error[] = [];
  setReporter(fault => {
    reported.push(fault);
    if (reported.length === 1) R.nativeGlFault("reporter follow-up failure");
  });
  const thrown = caught(() => R.nativeGlFault("original native failure"));
  expect(reported).toEqual([thrown]);
  const next: Error[] = [];
  setReporter(fault => next.push(fault));
  const replacement = caught(() => R.nativeGlFault("new kernel failure"));
  expect(next).toEqual([replacement]);
  expect(replacement?.message).toBe("new kernel failure");
  expect(replacement).not.toBe(thrown);
});

it("preserves an actual kernel-export failure raised by the fatal reporter through finally cleanup", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const rawTrap = new WebAssembly.RuntimeError("fatal shutdown export failed");
  const raw = createKernelScratchTestInstance(4,memory,() => ({
    kernel_transfer_scratch_cancel: () => { throw rawTrap; },
  }),() => 4096);
  const instance = createKernelEntryGatedInstance(raw,new KernelEntryGate());
  let reports = 0, first: unknown;
  setReporter(() => { reports++; (instance.exports.kernel_transfer_scratch_cancel as (token:bigint)=>number)(1n); });
  const thrown = caught(() => {
    try { R.nativeGlFault("native failure starts shutdown"); }
    catch (error) { first=error; throw error; }
    finally { R.nativeGlFault("cleanup after shutdown failed"); }
  });
  expect(reports).toBe(1);
  expect(isKernelExportFailure(first)).toBe(true);
  expect((first as Error).cause).toBe(rawTrap);
  expect(thrown).toBe(first);
  expect(isKernelExportFailure(thrown)).toBe(true);
});

it("keeps a known-rejected bookkeeping repair exact inside a predicted guest batch",()=>{
  const r=renderer(),reported:Error[]=[];
  const owner={...r.owner,pid:7,sessionId:11};owner.errors.push(0x501);
  setReporter(fault=>reported.push(fault));
  const fault=caught(()=>withNativeBatch(owner,"known rejected host change",()=>
    applyNativeChanges(owner,[{
      // This is an already rejected change, not guest API acceptance. Its
      // inverse must be proved before this live shared renderer can proceed.
      apply:()=>{r.refuse(true);return false;},
      restore:nativeInverse(owner,[["bindTexture",0x0de1,null]]),
    }])?0:-5));
  expect(fault?.name).toBe("NativeGlFault");
  expect(fault!.message).toMatch(/refused to restore native state/);
  expect(reported).toEqual([fault]);
  expect(owner.errors).toEqual([0x501]);
});

it("keeps an accepted draw's private savepoint exact before discarding its inverse",()=>{
  const r=renderer(),reported:Error[]=[];
  const owner={...r.owner,pid:7,sessionId:11};owner.errors.push(0x501);
  let draws=0;
  setReporter(fault=>reported.push(fault));
  const fault=caught(()=>withNativeBatch(owner,"private draw savepoint",()=>
    applyNativeChanges(owner,[{
      apply:()=>{draws++;r.refuse(true);return true;},
      restore:nativeInverse(owner),
    }],{finalizer:R.bookkeepingNativeInverse(owner,[["bindTexture",0x0de1,null]])})?0:-5));
  expect(fault?.name).toBe("NativeGlFault");
  expect(fault!.message).toMatch(/refused to restore native state/);
  expect(reported).toEqual([fault]);
  expect(draws).toBe(1);
  expect(owner.errors).toEqual([0x501]);
});

it("reserves reusable inverse receivers before metadata refusal can mutate native state",()=>{
  const r=renderer(),effects=vi.fn();
  const inverse=R.prepareNativeInverse(r.owner,[["bindTexture",0xde1,null]])!;
  const map=Array.prototype.map;
  let prepared:R.PreparedNativeChanges|null=null;
  try{
    Array.prototype.map=function(){throw new Error("injected cold metadata exhaustion");};
    prepared=R.PreparedNativeChanges.reserve(r.owner,[{apply:()=>{effects();return true;},restore:inverse}]);
  }finally{Array.prototype.map=map;}
  expect(prepared).toBeNull();expect(effects).not.toHaveBeenCalled();expect(r.owner.errors).toEqual([0x505]);
});

it("reuses warmed native receivers without allocating map, inverse, or stack metadata",()=>{
  const r=renderer(),calls:unknown[]=[],guestErrors:number[]=[];
  const owner=Object.assign(r.owner,{pid:7,sessionId:11});
  r.gl.bindTexture=(_target,texture)=>{calls.push(texture);};
  const selected=r.make(),original=r.make();
  const apply=R.prepareNativeCall(r.gl,["bindTexture",0xde1,selected]);
  const inverse=R.prepareNativeInverse(owner,[["bindTexture",0xde1,original]])!;
  const receiver=R.PreparedNativeChanges.reserve(owner,[{apply:()=>R.checkedPreparedNativeCall(owner,apply),restore:inverse}],{finalizer:inverse})!;
  // Admission had a receipt-local queue. The same reserved owner must follow
  // the ordinary guest queue, or restoration falls back to per-call drains.
  owner.errors=guestErrors;
  withNativeBatch(owner,"prime reusable receiver",()=>{expect(receiver.apply()).toBe(true);});
  calls.length=0;let samples=0,accepted=false;
  r.gl.getError=()=>{samples++;return 0;};
  const map=Array.prototype.map,flatMap=Array.prototype.flatMap,set=WeakMap.prototype.set;
  const forbidden=()=>{throw new Error("warm metadata allocation");};
  try{
    Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
    withNativeBatch(owner,"reused receiver",()=>{accepted=receiver.apply();});
  }finally{Array.prototype.map=map;Array.prototype.flatMap=flatMap;WeakMap.prototype.set=set;}
  expect(accepted).toBe(true);expect(calls).toEqual([selected,original]);expect(samples).toBe(1);
  expect(guestErrors).toEqual([]);expect(hasNativeRepair(r.gl)).toBe(false);
});

it("keeps refused reusable restoration owned and fatal on a live renderer",()=>{
  const r=renderer();
  const inverse=R.prepareNativeInverse(r.owner,[["bindTexture",0xde1,null]])!;
  const receiver=R.PreparedNativeChanges.reserve(r.owner,[{apply:()=>{r.refuse(true);return false;},restore:inverse}])!;
  expect(caught(()=>receiver.apply())?.name).toBe("NativeGlFault");
  expect(hasNativeRepair(r.gl)).toBe(true);
});
