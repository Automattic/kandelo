import { runUniformUpload } from "../src/webgl/uniform-upload.js";
import * as UniformOps from "../src/webgl/ops.js";
import { expect, it, vi } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { SubmitFrame, SubmitQueue } from "../src/webgl/submit-queue.js";
import { drainSubmitQueue } from "../src/webgl/submit-drain.js";
import { defaultFramebuffer } from "../src/webgl/framebuffer.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { OP_CLEAR, QOP_GET_ERROR } from "../src/webgl/ops.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";
import { NativeGlFault } from "../src/webgl/native-recovery.js";

function caught(call: () => unknown): Error | undefined {
  try { call(); } catch (error) { return error as Error; }
  return undefined;
}

function fixture() {
  let serial = 0;
  const live = new Set<object>(), deleted: object[] = [];
  const make = () => { const value = { serial: ++serial }; live.add(value); return value; };
  const remove = (value: object) => { live.delete(value); deleted.push(value); };
  const gl = new Proxy({
    getError: () => 0, isContextLost: () => false,
    getParameter: (p: number) => p === 0x84e0 ? 0x84c0 : null,
    checkFramebufferStatus: () => 0x8cd5,
    createFramebuffer: make, createTexture: make, createRenderbuffer: make,
    deleteFramebuffer: remove, deleteTexture: remove, deleteRenderbuffer: remove,
    createVertexArray: make, deleteVertexArray: remove,
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) }) as unknown as WebGL2RenderingContext;
  const registry = new GlContextRegistry();
  registry.bind({ pid: 7, sessionId: 11, cmdbufAddr: 256, cmdbufLen: 40 });
  const binding = registry.get(7, 11)!;
  binding.gl = gl; binding.contextId = 1;
  binding.surface.surfaceId = 31;
  expect(resizeSurfaceTarget(binding, 4, 3)).toBe(true);
  expect(applyCurrentDrawable(binding, { drawSurfaceId: 31, readSurfaceId: 31, width: 4, height: 3 })).toBe(true);
  const muxer = new GlMuxer(gl);
  const capture = vi.fn((b: GlBinding) => Reflect.get(registry, "retainSubmitExecution")?.call(registry, b, muxer));
  const queue = new (SubmitQueue as any)(undefined, capture) as SubmitQueue;
  return { registry, binding, gl, muxer, queue, capture, live, deleted };
}
const frame = () => new SubmitFrame(new Uint8Array([1]), 0, 1);

it("queued work retains the accepted drawable allocation across resize", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(f.binding, 8, 6)).toBe(true);
  const latest = f.binding.presentTarget!;
  expect(f.live.has(old.fbo)).toBe(true);
  const seen: unknown[] = [];
  expect(drainSubmitQueue(f.queue, () => f.muxer, b => {
    seen.push(defaultFramebuffer(b), defaultFramebuffer(b, true));
    const accepted = Reflect.get(b, "executionDrawable");
    expect(accepted.drawable).toEqual({ drawSurfaceId: 31, readSurfaceId: 31, width: 4, height: 3 });
  })).toBe(0);
  expect(seen).toEqual([old.fbo, old.fbo]);
  expect(defaultFramebuffer(f.binding)).toBe(latest.fbo);
  expect(f.binding.shadow.fbo).toBe(latest.fbo);
  expect(f.live.has(old.fbo)).toBe(false);
  expect(f.deleted.filter(value => value === old.fbo)).toHaveLength(1);
  f.registry.unbind(7);
});

it("queued work uses its revoked context instead of the replacement public slot", () => {
  const f = fixture(), old = f.binding.presentTarget!, texture = f.gl.createTexture()!;
  f.binding.textures.set(1, texture);
  f.queue.enqueue(f.binding, frame());
  f.registry.destroyContext(7, 11);
  const replacement = f.registry.get(7, 11)!;
  replacement.gl = f.gl; replacement.contextId = 2;
  expect(f.live.has(texture)).toBe(true);
  expect(replacement).not.toBe(f.binding);
  expect(drainSubmitQueue(f.queue, () => f.muxer, b => {
    expect(b).toBe(f.binding); expect(b.contextId).toBe(1);
    expect(defaultFramebuffer(b)).toBe(old.fbo);
    expect(b.textures.get(1)).toBe(texture);
  })).toBe(0);
  expect(f.live.has(texture)).toBe(false);
  expect(replacement.contextId).toBe(2);
  f.registry.unbind(7);
});

it("purging copied commands releases accepted context and drawable owners once", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(f.binding, 8, 6)).toBe(true);
  expect(f.live.has(old.fbo)).toBe(true);
  f.queue.removeSession(7, 11); f.queue.removeSession(7, 11);
  expect(f.queue.isEmpty()).toBe(true);
  expect(f.live.has(old.fbo)).toBe(false);
  expect(f.deleted.filter(value => value === old.fbo)).toHaveLength(1);
  expect(f.capture).toHaveBeenCalledTimes(1);
  f.registry.unbind(7);
});

it("a rejected frame releases its retained storage without replaying its accepted prefix", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(f.binding, 8, 6)).toBe(true);
  const dispatch = vi.fn(() => -5);
  expect(drainSubmitQueue(f.queue, () => f.muxer, dispatch)).toBe(-5);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(f.live.has(old.fbo)).toBe(false);
  expect(drainSubmitQueue(f.queue, () => f.muxer, dispatch)).toBe(0);
  expect(dispatch).toHaveBeenCalledTimes(1);
  f.registry.unbind(7);
});

it("reentrant queue draining cannot collect the currently executing context", () => {
  const f = fixture(), texture = f.gl.createTexture()!;
  f.binding.textures.set(1, texture);
  f.queue.enqueue(f.binding, frame());
  expect(drainSubmitQueue(f.queue, () => f.muxer, () => {
    f.registry.destroyContext(7, 11);
    expect(f.live.has(texture)).toBe(true);
  })).toBe(0);
  expect(f.live.has(texture)).toBe(false);
  f.registry.unbind(7);
});

it("copied selectors omit extra caller fields and preserve user framebuffer changes", () => {
  const f = fixture(), user = f.gl.createFramebuffer()!;
  Object.assign(f.binding.currentDrawable!, { extra: { borrowed: true } });
  f.queue.enqueue(f.binding, frame());
  expect(drainSubmitQueue(f.queue, () => f.muxer, b => {
    const accepted = Reflect.get(b, "executionDrawable");
    expect(accepted.drawable.extra).toBeUndefined();
    expect(Object.isFrozen(accepted.drawable)).toBe(true);
    expect(accepted.drawSurfaceId).toBe(31);
    expect([accepted.drawWidth, accepted.drawHeight]).toEqual([4, 3]);
    b.shadow.fbo = user;
  })).toBe(0);
  expect(f.binding.shadow.fbo).toBe(user);
  f.gl.deleteFramebuffer(user);
  f.registry.unbind(7);
});

it("changed raw canvas storage fails before dispatch rather than targeting its replacement", () => {
  const f = fixture();
  f.registry.destroySurface(7, 11);
  f.binding.canvas = { width: 4, height: 3 } as HTMLCanvasElement;
  f.binding.currentDrawable = null;
  f.binding.drawSurface = f.binding.readSurface = null;
  f.binding.shadow.fbo = f.binding.shadow.readFbo = null;
  f.queue.enqueue(f.binding, frame());
  f.binding.canvas.width = 8;
  const dispatch = vi.fn();
  expect(drainSubmitQueue(f.queue, () => f.muxer, dispatch)).toBe(-5);
  expect(dispatch).not.toHaveBeenCalled();
  expect(f.queue.isEmpty()).toBe(true);
  f.registry.unbind(7);
});

it("a live renderer refusing deletion of a frame's retained storage is a fatal fault", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(f.binding, 8, 6)).toBe(true);
  const destroy = f.gl.deleteFramebuffer.bind(f.gl);
  f.gl.deleteFramebuffer = value => {
    if (value === old.fbo) throw new Error("delete blocked");
    destroy(value);
  };
  const fault = caught(() => drainSubmitQueue(f.queue, () => f.muxer, () => 0));
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/live renderer refused deleteFramebuffer of an object the host retired/);
  expect(f.live.has(old.fbo)).toBe(true);
  expect(f.deleted.filter(value => value === old.fbo)).toHaveLength(0);
});

it("in-frame resize preserves both accepted native and logical default selectors", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  let draw: WebGLFramebuffer | null = null, read: WebGLFramebuffer | null = null;
  const get = f.gl.getParameter.bind(f.gl);
  f.gl.getParameter = (p: number) => p === 0x8caa ? read : p === 0x8ca6 ? draw : get(p);
  f.gl.bindFramebuffer = (target, value) => {
    if (target === 0x8d40 || target === 0x8ca9) draw = value;
    if (target === 0x8d40 || target === 0x8ca8) read = value;
  };
  f.queue.enqueue(f.binding, frame());
  expect(drainSubmitQueue(f.queue, () => f.muxer, b => {
    expect([draw, read]).toEqual([old.fbo, old.fbo]);
    expect(resizeSurfaceTarget(b, 9, 7)).toBe(true);
    expect([draw, read]).toEqual([old.fbo, old.fbo]);
    expect([b.shadow.fbo, b.shadow.readFbo]).toEqual([old.fbo, old.fbo]);
    expect(defaultFramebuffer(b)).toBe(old.fbo);
  })).toBe(0);
  expect([f.binding.shadow.fbo, f.binding.shadow.readFbo])
    .toEqual([f.binding.presentTarget!.fbo, f.binding.presentTarget!.fbo]);
  f.registry.unbind(7);
});

it("independent read allocation retains its own dimensions and lifetime", () => {
  const f = fixture();
  f.registry.bind({ pid: 7, sessionId: 12, cmdbufAddr: 0, cmdbufLen: 0 });
  const reader = f.registry.get(7, 12)!;
  reader.gl = f.gl; reader.contextId = 2; reader.surfaceId = 32;
  expect(resizeSurfaceTarget(reader, 2, 5)).toBe(true);
  expect(applyCurrentDrawable(f.binding, { drawSurfaceId: 31, readSurfaceId: 32, width: 4, height: 3 },
    { draw: f.binding.surface, read: reader.surface })).toBe(true);
  const oldRead = reader.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(reader, 8, 10)).toBe(true);
  f.registry.destroySurface(7, 12);
  expect(f.live.has(oldRead.fbo)).toBe(true);
  expect(drainSubmitQueue(f.queue, () => f.muxer, b => {
    expect(defaultFramebuffer(b, true)).toBe(oldRead.fbo);
    expect([b.executionDrawable!.readWidth, b.executionDrawable!.readHeight]).toEqual([2, 5]);
    expect(defaultFramebuffer(b)).toBe(f.binding.presentTarget!.fbo);
  })).toBe(0);
  expect(f.live.has(oldRead.fbo)).toBe(false);
  f.registry.unbind(7);
});

it("a throwing cleanup receipt after failed admission is a fatal fault", () => {
  const f = fixture();
  const release = vi.fn(() => { throw new Error("cleanup callback failed"); });
  const queue = new SubmitQueue(undefined, b => ({ binding:b, admitted:false, run: work => work(), release }));
  const fault = caught(() => queue.enqueue(f.binding, frame()));
  // The receipt's fault outranks the admission failure it was cleaning up.
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/releasing a GL submission's execution threw/);
  expect((fault!.cause as Error).message).toBe("cleanup callback failed");
  expect(queue.isEmpty()).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
  f.registry.unbind(7);
});

it("a live renderer refusing deletion of a purged frame's retained storage is a fatal fault", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(f.binding, 8, 6)).toBe(true);
  const destroy = f.gl.deleteFramebuffer.bind(f.gl);
  f.gl.deleteFramebuffer = value => { if (value === old.fbo) throw new Error("blocked"); destroy(value); };
  const fault = caught(() => f.queue.removeSession(7, 11));
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/live renderer refused deleteFramebuffer of an object the host retired/);
  expect(f.live.has(old.fbo)).toBe(true);
});

it("unchanged consecutive execution selectors do not force full logical state replay", () => {
  const f = fixture(), replay = vi.fn();
  f.gl.viewport = replay;
  f.queue.enqueue(f.binding, frame()); f.queue.enqueue(f.binding, frame());
  expect(drainSubmitQueue(f.queue, () => f.muxer, () => 0)).toBe(0);
  expect(replay).toHaveBeenCalledTimes(1);
  f.registry.unbind(7);
});

it("reentrant drain leaves later frames queued until the current frame tail completes", () => {
  const f = fixture(), events: string[] = [];
  f.queue.enqueue(f.binding, frame());
  const dispatch = (b: GlBinding) => {
    if (events.length) { events.push("later"); return; }
    events.push("prefix");
    expect(resizeSurfaceTarget(b, 8, 6)).toBe(true);
    // Admission observes the new logical target, not the active old snapshot.
    f.queue.enqueue(b, frame());
    expect(drainSubmitQueue(f.queue, () => f.muxer, dispatch)).toBe(0);
    events.push("tail");
  };
  expect(drainSubmitQueue(f.queue, () => f.muxer, dispatch)).toBe(0);
  expect(events).toEqual(["prefix", "tail", "later"]);
  expect(f.queue.isEmpty()).toBe(true);
  f.registry.unbind(7);
});



it("a throwing consumed receipt is a fatal fault that stops the drain", () => {
  const f = fixture();
  let serial = 0;
  const retired: number[] = [], ran: number[] = [];
  const queue = new SubmitQueue(undefined,b => {
    const id = ++serial;
    return { binding:b, admitted:true, run: work => { ran.push(id); return work(); }, release: () => {
      if (id === 1) throw new Error("first receipt blocked");
      retired.push(id); return true;
    } };
  });
  queue.enqueue(f.binding,frame()); queue.enqueue(f.binding,frame());
  const fault = caught(() => drainSubmitQueue(queue,() => f.muxer,() => 0));
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/releasing a GL submission's execution threw/);
  expect((fault!.cause as Error).message).toBe("first receipt blocked");
  expect(ran).toEqual([1]); expect(retired).toEqual([]);
});

it("cancelling retained storage captures flags for the selected peer's error owner", () => {
  const f = fixture();
  f.registry.bind({pid:8,sessionId:1,cmdbufAddr:0,cmdbufLen:0});
  const peer = f.registry.get(8,1)!; peer.gl = f.gl; peer.contextId = 2;
  f.queue.enqueue(f.binding,frame());
  expect(resizeSurfaceTarget(f.binding,8,6)).toBe(true);
  f.muxer.switchTo(peer);
  let error = 0x500;
  f.gl.getError = () => { const pending = error; error = 0; return pending; };
  f.queue.removePid(7);
  expect(peer.errors).toEqual([0x500]); expect(f.binding.errors).toEqual([]);
  f.registry.unbind(7); f.registry.unbind(8);
});

it("accepted command tickets hold session order across public context replacement", () => {
  const f = fixture();
  f.queue.enqueue(f.binding,frame());
  const order = Reflect.get(f.binding,"operations");
  expect(order?.pending).toBe(1);
  expect(order.tryBeginImmediate("present")).toBeNull();
  f.registry.destroyContext(7,11);
  const replacement = f.registry.get(7,11)!;
  expect(Reflect.get(replacement,"operations")).toBe(order);
  expect(drainSubmitQueue(f.queue,() => f.muxer,() => 0)).toBe(0);
  const present = order.tryBeginImmediate("present"); expect(present).not.toBeNull(); present.finish();
  f.registry.unbind(7);
});

it("a busy logical stream leaves runnable peers drainable and resumes its exact frame", () => {
  const f = fixture();
  f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});
  const peer = f.registry.get(7,12)!; peer.gl = f.gl; peer.contextId = 2;
  expect(f.registry.shareObjects(7,12,11)).toBe(true);
  expect(peer.operations).not.toBe(f.binding.operations);
  const active = f.binding.operations.tryBeginImmediate("query")!;
  f.queue.enqueue(f.binding,frame()); f.queue.enqueue(peer,frame());
  const seen: number[] = [];
  expect(drainSubmitQueue(f.queue,() => f.muxer,b => {seen.push(b.sessionId);})).toBe(0);
  expect(seen).toEqual([12]); expect(f.queue.isEmpty()).toBe(false);
  active.finish();
  expect(drainSubmitQueue(f.queue,() => f.muxer,b => {seen.push(b.sessionId);})).toBe(0);
  expect(seen).toEqual([12,11]); expect(f.queue.isEmpty()).toBe(true);
  f.registry.unbind(7);
});


it("retires pending uniform staging with its exact accepted execution owner",()=>{
  const f=fixture(),b=f.binding,program={} as WebGLProgram;
  b.programs.set(20,program);b.currentProgram=b.shadow.currentProgram=program;b.currentProgramId=20;
  b.uniformLocationRecords.set(1,{program:20,canonical:"value",native:{} as WebGLUniformLocation,metadata:{executable:program,type:0x1406,array:true,remaining:2},state:"published",references:0});
  runUniformUpload(b,UniformOps.OP_UNIFORM_UPLOAD_BEGIN,
    new DataView(new Uint32Array([1,UniformOps.OP_UNIFORM1FV,1,20000,0]).buffer),()=>{});
  const pending=b.uniformUpload;expect(pending?.payload?.byteLength).toBe(16);
  f.queue.enqueue(b,frame());f.registry.destroyContext(7,11);
  const replacement=f.registry.get(7,11)!;
  expect(replacement).not.toBe(b);expect(replacement.uniformUpload).toBeNull();
  expect(b.uniformUpload).toBe(pending);
  f.queue.removeSession(7,11);expect(b.uniformUpload).toBeNull();
  expect(f.queue.isEmpty()).toBe(true);f.registry.unbind(7,11);
});
