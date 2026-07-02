import { describe, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";

describe("GlContextRegistry", () => {
  it("binds and retrieves with null lazy fields", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0x10000, cmdbufLen: 1 << 20 });
    const b = reg.get(7);
    expect(b).toBeDefined();
    expect(b!.pid).toBe(7);
    expect(b!.cmdbufAddr).toBe(0x10000);
    expect(b!.cmdbufLen).toBe(1 << 20);
    expect(b!.cmdbufView).toBeNull();
    expect(b!.gl).toBeNull();
    expect(b!.canvas).toBeNull();
    expect(b!.contextId).toBeNull();
    expect(b!.surfaceId).toBeNull();
    expect(b!.buffers.size).toBe(0);
    expect(b!.uniformLocations.size).toBe(0);
    expect(b!.nextUniformLoc).toBe(0);
  });

  it("unbinds idempotently", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.unbind(7);
    reg.unbind(7); // second call is a no-op
    expect(reg.get(7)).toBeUndefined();
  });

  it("rebindMemory invalidates the cached cmdbuf view", () => {
    const reg = new GlContextRegistry();
    const sab = new SharedArrayBuffer(1 << 20);
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 1 << 20 });
    const b = reg.get(7)!;
    b.cmdbufView = new Uint8Array(sab, 0, 1 << 20);
    reg.rebindMemory(7);
    expect(reg.get(7)!.cmdbufView).toBeNull();
  });

  it("rebindMemory on an unknown pid is a no-op", () => {
    const reg = new GlContextRegistry();
    expect(() => reg.rebindMemory(999)).not.toThrow();
  });

  it("attachCanvas wires the surface but does not build a context", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    // Plain stand-in: jsdom / node have no OffscreenCanvas. The
    // registry never inspects the canvas — it only stores the
    // reference for the embedder's renderer to use. Tests that
    // exercise getContext("webgl2") live in Playwright (Task B7).
    const canvas = {} as unknown as OffscreenCanvas;
    reg.attachCanvas(7, canvas);
    const b = reg.get(7)!;
    expect(b.canvas).toBe(canvas);
    // gl is constructed lazily at gl_create_context time, not at
    // attach time. attachCanvas only wires the surface.
    expect(b.gl).toBeNull();
  });

  it("detachCanvas clears the canvas and the context", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.attachCanvas(7, {} as unknown as OffscreenCanvas);
    // Forge a context to confirm detachCanvas drops it too.
    reg.get(7)!.gl = {} as unknown as WebGL2RenderingContext;
    reg.detachCanvas(7);
    const b = reg.get(7)!;
    expect(b.canvas).toBeNull();
    expect(b.gl).toBeNull();
  });

  it("attachCanvas before bind queues the canvas and drains on bind", () => {
    const reg = new GlContextRegistry();
    const canvas = {} as unknown as OffscreenCanvas;
    reg.attachCanvas(9, canvas);
    expect(reg.get(9)).toBeUndefined();
    reg.bind({ pid: 9, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(9)!.canvas).toBe(canvas);
  });

  it("detachCanvas drops a pending canvas (no binding yet)", () => {
    const reg = new GlContextRegistry();
    reg.attachCanvas(9, {} as unknown as OffscreenCanvas);
    reg.detachCanvas(9);
    reg.bind({ pid: 9, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(9)!.canvas).toBeNull();
  });

  it("getCanvas returns the bound canvas, the pending canvas, or null", () => {
    const reg = new GlContextRegistry();
    expect(reg.getCanvas(1)).toBeNull();

    const pending = {} as unknown as OffscreenCanvas;
    reg.attachCanvas(2, pending);
    expect(reg.getCanvas(2)).toBe(pending);

    reg.bind({ pid: 2, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.getCanvas(2)).toBe(pending);

    reg.detachCanvas(2);
    expect(reg.getCanvas(2)).toBeNull();
  });

  it("propagating parent canvas via getCanvas + attachCanvas wires both pids to the same canvas", () => {
    const reg = new GlContextRegistry();
    const parentCanvas = {} as unknown as OffscreenCanvas;

    reg.attachCanvas(100, parentCanvas);
    expect(reg.get(100)).toBeUndefined();

    const propagated = reg.getCanvas(100);
    expect(propagated).toBe(parentCanvas);
    reg.attachCanvas(101, propagated!);

    reg.bind({ pid: 100, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.bind({ pid: 101, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(100)!.canvas).toBe(parentCanvas);
    expect(reg.get(101)!.canvas).toBe(parentCanvas);
  });

  it("onChange notifies bind/unbind events and the unsubscribe closure works", () => {
    const reg = new GlContextRegistry();
    const seen: Array<[number, string]> = [];
    const off = reg.onChange((pid, ev) => seen.push([pid, ev]));
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.unbind(7);
    off();
    reg.bind({ pid: 8, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(seen).toEqual([
      [7, "bind"],
      [7, "unbind"],
    ]);
  });

  it("list() returns all live bindings", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.bind({ pid: 2, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.list().map((b) => b.pid).sort()).toEqual([1, 2]);
    reg.unbind(1);
    expect(reg.list().map((b) => b.pid)).toEqual([2]);
  });
});
