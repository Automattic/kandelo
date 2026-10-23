import { describe, expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import {
  setupMainForward,
  createMainForwardChannel,
  type ForwardWorkerLike,
  type GlForwardMessage,
} from "../src/webgl/main-forward.js";
import {
  completeGlForwardQuery, createGlForwardQueryMailbox, prepareGlForwardQuery,
  waitForGlForwardQuery, glForwardQueryCapacity,
} from "../src/webgl/main-forward-query.js";
import * as O from "../src/webgl/ops.js";

class FakeWorker implements ForwardWorkerLike {
  listener: ((e: MessageEvent) => void) | null = null;
  addEventListener(_t: "message", l: (e: MessageEvent) => void): void {
    this.listener = l;
  }
  removeEventListener(_t: "message", l: (e: MessageEvent) => void): void {
    if (this.listener === l) this.listener = null;
  }
  fire(data: GlForwardMessage): void {
    if (!this.listener) throw new Error("FakeWorker: no listener");
    this.listener({ data } as MessageEvent);
  }
}

function createMessage(pid: number): GlForwardMessage {
  const mailbox = createGlForwardQueryMailbox();
  prepareGlForwardQuery(mailbox, 0);
  return { type: "gl_forward_create_context", pid, mailbox };
}

class RecordingGl {
  log: Array<[string, unknown[]]> = [];
  clear(m: number) { this.log.push(["clear", [m]]); }
  getExtension(_name: string): unknown { return null; }
  isContextLost() { return false; }
  getError() { return 0x500; }
}

function fakeCanvas(stub: RecordingGl): { canvas: HTMLCanvasElement; getContextCalls: unknown[][] } {
  const calls: unknown[][] = [];
  const canvas = {
    getContext(...args: unknown[]) {
      calls.push(args);
      return new Proxy(stub, {
        get(target, name) {
          if (name === "createVertexArray") return () => ({});
          return Reflect.get(target, name) ?? (() => {});
        },
      });
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, getContextCalls: calls };
}

/** One OP_CLEAR(0x4000) entry. */
function clearCmdbuf(): Uint8Array {
  const bytes = new Uint8Array(8);
  const v = new DataView(bytes.buffer);
  v.setUint16(0, O.OP_CLEAR, true);
  v.setUint16(2, 4, true);
  v.setUint32(4, 0x4000, true);
  return bytes;
}

describe("setupMainForward", () => {
  it("builds gl on gl_forward_create_context and discards on destroy", () => {
    const worker = new FakeWorker();
    const stub = new RecordingGl();
    const { canvas, getContextCalls } = fakeCanvas(stub);
    const dispose = setupMainForward(worker, canvas, 7);

    worker.fire(createMessage(7));
    expect(getContextCalls.length).toBe(1);
    expect(getContextCalls[0][0]).toBe("webgl2");

    worker.fire({ type: "gl_forward_destroy_context", pid: 7 });
    worker.fire({ type: "gl_forward_submit", pid: 7, bytes: clearCmdbuf() });
    expect(stub.log).toEqual([]);

    dispose();
  });

  it("forwards submit bytes through decodeAndDispatch", () => {
    const worker = new FakeWorker();
    const stub = new RecordingGl();
    const { canvas } = fakeCanvas(stub);
    const dispose = setupMainForward(worker, canvas, 7);

    worker.fire(createMessage(7));
    worker.fire({ type: "gl_forward_submit", pid: 7, bytes: clearCmdbuf() });
    expect(stub.log).toEqual([["clear", [0x4000]]]);

    dispose();
  });

  it("ignores messages for other pids", () => {
    const worker = new FakeWorker();
    const stub = new RecordingGl();
    const { canvas, getContextCalls } = fakeCanvas(stub);
    const dispose = setupMainForward(worker, canvas, 7);

    worker.fire(createMessage(99));
    expect(getContextCalls.length).toBe(0);

    dispose();
  });

  it("dispose() unregisters the listener", () => {
    const worker = new FakeWorker();
    const stub = new RecordingGl();
    const { canvas } = fakeCanvas(stub);
    const dispose = setupMainForward(worker, canvas, 7);
    expect(worker.listener).not.toBeNull();
    dispose();
    expect(worker.listener).toBeNull();
  });
});

describe("GlContextRegistry forward channel", () => {
  it("attachMainForward applies eagerly when binding exists", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    const calls: string[] = [];
    reg.attachMainForward(7, {
      onCreateContext: () => { calls.push("create"); return 0; },
      onDestroyContext: () => calls.push("destroy"),
      onSubmit: () => calls.push("submit"),
    });
    expect(reg.get(7)!.forward).not.toBeNull();
    reg.get(7)!.forward!.onCreateContext();
    expect(calls).toEqual(["create"]);
  });

  it("attachMainForward defers until bind() when binding is absent", () => {
    const reg = new GlContextRegistry();
    const channel = {
      onCreateContext: () => 0,
      onDestroyContext: () => {},
      onSubmit: () => {},
    };
    reg.attachMainForward(7, channel);
    expect(reg.get(7)).toBeUndefined();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(7)!.forward).toBe(channel);
  });

  it("detachMainForward clears both pending and active channels", () => {
    const reg = new GlContextRegistry();
    const channel = {
      onCreateContext: () => 0,
      onDestroyContext: () => {},
      onSubmit: () => {},
    };
    reg.attachMainForward(7, channel);
    reg.detachMainForward(7);
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(7)!.forward).toBeNull();

    reg.attachMainForward(7, channel);
    expect(reg.get(7)!.forward).toBe(channel);
    reg.detachMainForward(7);
    expect(reg.get(7)!.forward).toBeNull();
  });

  it("unbind() drops the forward channel", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.attachMainForward(7, {
      onCreateContext: () => 0,
      onDestroyContext: () => {},
      onSubmit: () => {},
    });
    reg.unbind(7);
    expect(reg.get(7)).toBeUndefined();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(reg.get(7)!.forward).toBeNull();
  });
});

describe("main-thread synchronous query transport", () => {
  it.each(["unavailable", "lost", "throwing"])("acknowledges %s renderer failure and allows retry", mode => {
    const worker = new FakeWorker();
    let failed = true;
    const gl = new RecordingGl();
    const liveCanvas = fakeCanvas(gl).canvas;
    const canvas = {
      width: 16, height: 16,
      getContext() {
        if (failed && mode === "throwing") throw new Error("no renderer");
        if (failed && mode === "unavailable") return null;
        gl.isContextLost = () => failed && mode === "lost";
        return liveCanvas.getContext("webgl2");
      },
    } as unknown as HTMLCanvasElement;
    const dispose = setupMainForward(worker, canvas, 7);
    const channel = createMainForwardChannel({ postMessage: message => worker.fire(message) }, 7);
    expect(channel.onCreateContext()).toBeLessThan(0);
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), 4).rc).toBe(-1);
    failed = false;
    expect(channel.onCreateContext()).toBe(0);
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), 4).rc).toBe(4);
    dispose();
  });

  it("does not allocate a context for a timed-out creation delivered late", () => {
    const worker = new FakeWorker();
    const { canvas, getContextCalls } = fakeCanvas(new RecordingGl());
    const dispose = setupMainForward(worker, canvas, 7);
    const messages: GlForwardMessage[] = [];
    const channel = createMainForwardChannel({ postMessage: m => messages.push(m) }, 7);
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    try { expect(channel.onCreateContext()).toBe(-5); }
    finally { wait.mockRestore(); }
    expect(messages.map(m => m.type)).toEqual([
      "gl_forward_create_context", "gl_forward_destroy_context",
    ]);
    for (const message of messages) worker.fire(message);
    expect(getContextCalls).toEqual([]);
    expect(channel.onCreateContext()).toBe(-5); // retired mailbox cannot be reused
    expect(getContextCalls).toEqual([]);
    dispose();
  });

  it("orders submits before queries, reuses bounded storage, and copies guest bytes", () => {
    const worker = new FakeWorker();
    const gl = new RecordingGl();
    const dispose = setupMainForward(worker, fakeCanvas(gl).canvas, 7);
    const messages: GlForwardMessage[] = [];
    const channel = createMainForwardChannel({ postMessage(message) {
      messages.push(message);
      worker.fire(message);
    } }, 7);
    channel.onCreateContext();
    const guest = new Uint8Array(new SharedArrayBuffer(32));
    guest.set(clearCmdbuf());
    channel.onSubmit(guest.subarray(0,8));
    for (let i = 0; i < 10; i++) {
      const result = channel.onQuery!(O.QOP_GET_ERROR, guest.subarray(0,0), 4);
      expect(result.rc).toBe(4);
      expect([...result.bytes]).toEqual([0,5,0,0]);
      expect(result.bytes.buffer).toBeInstanceOf(ArrayBuffer);
    }
    expect(gl.log).toEqual([["clear",[0x4000]]]);
    const queries = messages.filter(m => m.type === "gl_forward_query");
    expect(new Set(queries.map(m => m.mailbox)).size).toBe(1);
    expect(queries[0].mailbox.byteLength).toBeLessThan(66_000);
    expect(queries.every(m => m.input.buffer instanceof ArrayBuffer)).toBe(true);
    const submitted = messages.find(m => m.type === "gl_forward_submit")!;
    guest.fill(0);
    expect([...submitted.bytes]).toEqual([...clearCmdbuf()]);
    channel.onDestroyContext();
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), 4).rc).toBe(-1);
    dispose();
  });

  it("contains invalid results and leaves no authority to reuse a timed-out mailbox", () => {
    const mailbox = createGlForwardQueryMailbox();
    expect(() => prepareGlForwardQuery(mailbox, 65537)).toThrow();
    prepareGlForwardQuery(mailbox, 4);
    expect(glForwardQueryCapacity(mailbox)).toBe(4);
    expect(() => completeGlForwardQuery(mailbox, 5, new Uint8Array(5))).toThrow();
    expect(() => completeGlForwardQuery(mailbox, 4, new Uint8Array(3))).toThrow();
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    try { expect(waitForGlForwardQuery(mailbox).rc).toBe(-5); }
    finally { wait.mockRestore(); }
    completeGlForwardQuery(mailbox, 4, new Uint8Array([1,2,3,4]));
    expect(() => prepareGlForwardQuery(mailbox, 4)).toThrow(/retired/);
    expect(waitForGlForwardQuery(mailbox).rc).toBe(-5);
  });

  it("contains a throwing renderer and validates lengths before posting", () => {
    const worker = new FakeWorker();
    const gl = new RecordingGl();
    gl.getError = () => { throw new Error("context failed"); };
    const dispose = setupMainForward(worker, fakeCanvas(gl).canvas, 7);
    const post = vi.fn((message: GlForwardMessage) => worker.fire(message));
    const channel = createMainForwardChannel({ postMessage: post }, 7);
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(65537), 4).rc).toBe(-22);
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), -1).rc).toBe(-22);
    expect(post).not.toHaveBeenCalled();
    channel.onCreateContext();
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), 4).rc).toBe(-5);
    dispose();
  });
});
