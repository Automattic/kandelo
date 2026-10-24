import { describe, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";

describe("GlContextRegistry", () => {
  it("shares object ownership while keeping state and containers local until final retirement", () => {
    const reg = new GlContextRegistry(), deleted: unknown[] = [];
    const gl = new Proxy({ isContextLost: () => false, getError: () => 0,
      getParameter: () => null,
      deleteTexture: (object: unknown) => deleted.push(object),
      deleteBuffer: (object: unknown) => deleted.push(object),
      deleteFramebuffer: (object: unknown) => deleted.push(object),
    }, { get: (object,key) => Reflect.get(object,key) ?? (() => {}) }) as unknown as WebGL2RenderingContext;
    for (const session of [11,12]) {
      reg.bind({pid:7,sessionId:session,cmdbufAddr:0,cmdbufLen:4});
      const b = reg.get(7,session)!; b.gl = gl; b.contextId = session;
    }
    const a = reg.get(7,11)!, b = reg.get(7,12)!;
    expect(reg.shareObjects(7,12,11)).toBe(true);
    const texture = {} as WebGLTexture, buffer = {} as WebGLBuffer, fbo = {} as WebGLFramebuffer;
    a.textures.set(71,texture); a.buffers.set(72,buffer); a.fbos.set(73,fbo);
    a.nextUniformLoc = 9;
    expect(b.textures.get(71)).toBe(texture); expect(b.buffers.get(72)).toBe(buffer);
    expect(++b.nextUniformLoc).toBe(10); expect(a.nextUniformLoc).toBe(10);
    expect(b.fbos.has(73)).toBe(false); expect(b.vaos).not.toBe(a.vaos);
    a.errors.push(0x500); a.shadow.viewport = [1,2,3,4];
    expect(b.errors).toEqual([]); expect(b.shadow.viewport).toEqual([0,0,0,0]);
    reg.destroyContext(7,11);
    expect(deleted).toEqual([fbo]);
    expect(b.textures.get(71)).toBe(texture); expect(b.buffers.get(72)).toBe(buffer);
    expect(a.textures.size).toBe(0);
    reg.destroyContext(7,12);
    expect(deleted).toEqual([fbo,texture,buffer]);
    expect(b.textures.size).toBe(0); expect(b.nextUniformLoc).toBe(10);
  });

  it("refuses sharing a used target or incompatible renderer without changing ownership", () => {
    const reg = new GlContextRegistry(), gl = {} as WebGL2RenderingContext;
    for (const session of [11,12]) {
      reg.bind({pid:7,sessionId:session,cmdbufAddr:0,cmdbufLen:4});
      const b = reg.get(7,session)!; b.gl = gl; b.contextId = session;
    }
    const source = reg.get(7,11)!, target = reg.get(7,12)!, old = target.objects;
    target.gl = {} as WebGL2RenderingContext;
    expect(reg.shareObjects(7,12,11)).toBe(false);
    target.gl = gl; target.hasBeenCurrent = true;
    expect(reg.shareObjects(7,12,11)).toBe(false);
    target.hasBeenCurrent = false;target.savedClientArrayBuffer=null;
    expect(reg.shareObjects(7,12,11)).toBe(false);
    target.savedClientArrayBuffer=undefined; target.textures.set(1,{} as WebGLTexture);
    expect(reg.shareObjects(7,12,11)).toBe(false);
    expect(target.objects).toBe(old); expect(target.objects).not.toBe(source.objects);
  });

  it("preserves u32 session identities received as signed Wasm i32 arguments", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, sessionId: -2147483647, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(7, 0x80000001)!.sessionId).toBe(0x80000001);
    reg.unbind(7, -2147483647);
    expect(reg.list()).toEqual([]);
  });

  it("keeps two sessions in one process independent through scoped retirement", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, sessionId: 11, cmdbufAddr: 128, cmdbufLen: 32 });
    const first = reg.get(7, 11)!;
    first.contextId = 21;
    first.errors.push(0x500);
    first.cmdbufView = new Uint8Array(32);
    reg.bind({ pid: 7, sessionId: 12, cmdbufAddr: 256, cmdbufLen: 64 });
    const second = reg.get(7, 12)!;
    second.contextId = 22;
    expect(reg.get(7, 11)).toBe(first);
    expect(reg.get(7), "a process-only lookup must refuse ambiguity").toBeUndefined();
    expect(reg.getContext(7, 21)).toBe(first);
    expect(reg.getContext(7, 22)).toBe(second);
    expect(second.errors).toEqual([]);
    expect(second.cmdbufAddr).toBe(256);
    reg.unbind(7, 11);
    expect(first.cmdbufView).toBeNull();
    expect(reg.get(7, 11)).toBeUndefined();
    expect(reg.get(7, 12)).toBe(second);
    expect(second.contextId).toBe(22);
    reg.unbind(7);
    expect(reg.list()).toEqual([]);
  });

  it("retires every session even when a forwarding retirement notification fails", () => {
    const reg = new GlContextRegistry();
    reg.attachMainForward(7, {
      onCreateContext: () => 0, onDestroyContext() {}, onSubmit() {},
      onUnbind() { throw new Error("port closed"); },
    });
    for (const sessionId of [11, 12]) {
      reg.bind({ pid: 7, sessionId, cmdbufAddr: 0, cmdbufLen: 4 });
    }
    expect(() => reg.unbind(7)).toThrow("port closed");
    expect(reg.list()).toEqual([]);
  });

  it("invalidates every session's cached view after process memory growth", () => {
    const reg = new GlContextRegistry();
    for (const sessionId of [11, 12]) {
      reg.bind({ pid: 7, sessionId, cmdbufAddr: 0, cmdbufLen: 4 });
      reg.get(7, sessionId)!.cmdbufView = new Uint8Array(4);
    }
    reg.rebindMemory(7);
    expect(reg.list().map(b => b.cmdbufView)).toEqual([null, null]);
  });

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

  it("retires a destroyed context without replaying its program or losing its surface", () => {
    const deleted: unknown[] = [];
    const gl = new Proxy({}, { get: () => (object: unknown) => deleted.push(object) }) as WebGL2RenderingContext;
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 128, cmdbufLen: 1024 });
    const b = reg.get(7)!;
    const program = {} as WebGLProgram;
    const texture = {} as WebGLTexture;
    const vao = {} as WebGLVertexArrayObject;
    b.gl = gl;
    b.contextId = 1;
    b.surfaceId = 2;
    b.surfaceSize = { width: 800, height: 600 };
    b.programs.set(1, program);
    b.textures.set(2, texture);
    b.foreignTextures.set(100, { tex: texture, texId: 2, w: 1, h: 1, scratch: null });
    b.shadow.currentProgram = b.currentProgram = program;
    b.shadow.defaultVao = vao;
    b.nextUniformLoc = 10;
    reg.destroyContext(7);
    expect(deleted.filter(object => object === texture)).toHaveLength(1);
    expect(deleted).toContain(program);
    expect(deleted).toContain(vao);
    expect(b.shadow.currentProgram).toBeNull();
    expect(b.currentProgram).toBeNull();
    expect(b.programs.size).toBe(0);
    expect(b.textures.size).toBe(0);
    expect(b.foreignTextures.size).toBe(0);
    expect(b.gl).toBeNull();
    expect(b.surfaceId).toBe(2);
    expect(b.surfaceSize).toEqual({ width: 800, height: 600 });
    expect(b.cmdbufAddr).toBe(128);
    expect(b.nextUniformLoc).toBe(10);
    reg.destroyContext(7);
    expect(deleted.filter(object => object === program)).toHaveLength(1);
  });

  it("rebindMemory on an unknown pid is a no-op", () => {
    const reg = new GlContextRegistry();
    expect(() => reg.rebindMemory(999)).not.toThrow();
  });

  it("unbinds a physically current owned program without changing another owner's program", () => {
    const reg = new GlContextRegistry();
    const own={} as WebGLProgram, other={} as WebGLProgram;
    let current: WebGLProgram | null = own;
    const calls: (WebGLProgram | null)[]=[];
    const gl=new Proxy({}, { get(_target,key) {
      if(key === "getParameter") return () => current;
      if(key === "useProgram") return (program: WebGLProgram | null) => { current=program; calls.push(program); };
      return () => {};
    } }) as WebGL2RenderingContext;
    for (const pid of [1,2]) {
      reg.bind({pid,cmdbufAddr:0,cmdbufLen:0});
      reg.get(pid)!.gl=gl;
      reg.get(pid)!.programs.set(1,own);
    }
    reg.destroyContext(1);
    expect(current).toBeNull();
    expect(calls).toEqual([null]);
    current=other;
    reg.destroyContext(2);
    expect(current).toBe(other);
    expect(calls).toEqual([null]);
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
