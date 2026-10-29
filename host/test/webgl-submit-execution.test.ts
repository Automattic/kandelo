import { expect, it, vi } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { SubmitFrame, SubmitQueue } from "../src/webgl/submit-queue.js";
import { drainSubmitQueue } from "../src/webgl/submit-drain.js";
import { defaultFramebuffer } from "../src/webgl/framebuffer.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";

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
    f.queue.retryRetirements();
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

it("failed native retirement remains retryable without deleting an accepted prefix twice", () => {
  const f = fixture(), old = f.binding.presentTarget!;
  f.queue.enqueue(f.binding, frame());
  expect(resizeSurfaceTarget(f.binding, 8, 6)).toBe(true);
  const destroy = f.gl.deleteFramebuffer.bind(f.gl);
  let reject = true;
  f.gl.deleteFramebuffer = value => {
    if (value === old.fbo && reject) throw new Error("delete blocked");
    destroy(value);
  };
  expect(drainSubmitQueue(f.queue, () => f.muxer, () => 0)).toBe(0);
  expect(f.live.has(old.fbo)).toBe(true);
  reject = false;
  f.queue.retryRetirements();
  expect(f.live.has(old.fbo)).toBe(false);
  f.queue.retryRetirements();
  expect(f.deleted.filter(value => value === old.fbo)).toHaveLength(1);
  f.registry.unbind(7);
});
