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
  return { type: "gl_forward_create_context", pid, sessionId: 0, mailbox };
}

class RecordingGl {
  error = 0;
  log: Array<[string, unknown[]]> = [];
  clear(m: number) { this.log.push(["clear", [m]]); }
  getExtension(_name: string): unknown { return null; }
  isContextLost() { return false; }
  getError() { const error = this.error; this.error = 0; return error; }
}

function fakeCanvas(stub: RecordingGl): { canvas: HTMLCanvasElement; getContextCalls: unknown[][] } {
  const calls: unknown[][] = [];
  const canvas = {
    getContext(...args: unknown[]) {
      calls.push(args);
      return new Proxy(stub, {
        get(target, name) {
          if (name === "createVertexArray" || name === "createFramebuffer") return () => ({});
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
  it("queries renderer limits before creating a logical context and then accepts normal creation", () => {
    const worker = new FakeWorker(), stub = new RecordingGl();
    const get = vi.fn((pname:number) => pname === 0x0d33 ? 16384 : 4096);
    Object.assign(stub,{getParameter:get});
    const {canvas,getContextCalls} = fakeCanvas(stub), dispose = setupMainForward(worker,canvas,7);
    const mailbox = createGlForwardQueryMailbox(); prepareGlForwardQuery(mailbox,16);
    worker.fire({type:"gl_forward_query",pid:7,sessionId:0,op:O.QOP_SURFACE_CAPABILITIES,input:new Uint8Array(),mailbox});
    const reply = waitForGlForwardQuery(mailbox);
    expect(reply.rc).toBe(16); expect([...new Uint32Array(reply.bytes.buffer,reply.bytes.byteOffset,4)]).toEqual([4096,4096,16777216,0x47514c33]);
    expect(stub.log).toEqual([]); expect(getContextCalls).toHaveLength(1);
    const create = createMessage(7); worker.fire(create);
    expect(waitForGlForwardQuery(create.mailbox).rc).toBe(0);
    expect(getContextCalls).toHaveLength(2); dispose();
  });

  it("rejects malformed pre-context capability queries before renderer acquisition", () => {
    const worker = new FakeWorker(), {canvas,getContextCalls} = fakeCanvas(new RecordingGl()), dispose = setupMainForward(worker,canvas,7);
    for (const [input,size] of [[new Uint8Array(4),16],[new Uint8Array(),12]] as const) {
      const mailbox = createGlForwardQueryMailbox(); prepareGlForwardQuery(mailbox,size);
      worker.fire({type:"gl_forward_query",pid:7,sessionId:0,op:O.QOP_SURFACE_CAPABILITIES,input,mailbox});
      expect(waitForGlForwardQuery(mailbox).rc).toBe(-22);
    }
    expect(getContextCalls).toHaveLength(0); dispose();
  });

  it("builds gl on gl_forward_create_context and discards on destroy", () => {
    const worker = new FakeWorker();
    const stub = new RecordingGl();
    const { canvas, getContextCalls } = fakeCanvas(stub);
    const dispose = setupMainForward(worker, canvas, 7);

    worker.fire(createMessage(7));
    expect(getContextCalls.length).toBe(1);
    expect(getContextCalls[0][0]).toBe("webgl2");

    worker.fire({ type: "gl_forward_destroy_context", pid: 7, sessionId: 0 });
    worker.fire({ type: "gl_forward_submit", pid: 7, sessionId: 0, bytes: clearCmdbuf() });
    expect(stub.log).toEqual([]);

    dispose();
  });

  it("forwards submit bytes through decodeAndDispatch", () => {
    const worker = new FakeWorker();
    const stub = new RecordingGl();
    const { canvas } = fakeCanvas(stub);
    const dispose = setupMainForward(worker, canvas, 7);

    worker.fire(createMessage(7));
    worker.fire({ type: "gl_forward_submit", pid: 7, sessionId: 0, bytes: clearCmdbuf() });
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
  it("copies only drawable scalars, excluding extra guest-memory properties", () => {
    const worker = new FakeWorker();
    const dispose = setupMainForward(worker, fakeCanvas(new RecordingGl()).canvas, 7);
    const messages: GlForwardMessage[] = [];
    const channel = createMainForwardChannel({ postMessage(message) { messages.push(message); worker.fire(message); } }, 7);
    expect(channel.onCreateContext()).toBe(0);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const drawable = { drawSurfaceId: 0, readSurfaceId: 0, width: 0, height: 0, memory };
    expect(channel.onMakeCurrent!(drawable)).toBe(0);
    const sent = messages.find(message => message.type === "gl_forward_make_current")!;
    expect(Object.keys(sent.drawable).sort()).toEqual(["drawSurfaceId", "height", "readSurfaceId", "width"]);
    expect(sent.drawable).not.toBe(drawable);
    dispose();
  });

  it("retires creation whose acknowledgement loses to timeout", () => {
    const worker = new FakeWorker();
    const dispose = setupMainForward(worker, fakeCanvas(new RecordingGl()).canvas, 7);
    const channel = createMainForwardChannel({ postMessage(message) {
      if (message.type === "gl_forward_destroy_context") throw new Error("cleanup notification lost");
      worker.fire(message);
    } }, 7);
    const compare = Atomics.compareExchange;
    const intercept = vi.spyOn(Atomics, "compareExchange").mockImplementation(((words: Int32Array, index: number, expected: number, value: number) => {
      if (expected === 1 && value === 2) Atomics.store(words, index, 3);
      return compare(words, index, expected, value);
    }) as typeof Atomics.compareExchange);
    try { expect(channel.onCreateContext()).toBe(-5); }
    finally { intercept.mockRestore(); }
    const retry = createMainForwardChannel({ postMessage: message => worker.fire(message) }, 7);
    expect(retry.onCreateContext()).toBe(0);
    dispose();
  });

  it.each(["late", "completion race"])("rolls back an unacknowledged current binding: %s", mode => {
    const worker = new FakeWorker();
    let viewport = [0, 0, 0, 0];
    const gl = Object.assign(new RecordingGl(), {
      viewport(...value: number[]) { viewport = value; },
      getParameter(p: number) { return p === 0x0ba2 ? viewport : null; },
    });
    const { canvas } = fakeCanvas(gl);
    canvas.width = 320; canvas.height = 240;
    const dispose = setupMainForward(worker, canvas, 7);
    const late: GlForwardMessage[] = [];
    const channel = createMainForwardChannel({ postMessage(message) {
      if (message.type === "gl_forward_make_current" && mode === "late") late.push(message);
      else worker.fire(message);
    } }, 7);
    expect(channel.onCreateContext()).toBe(0);
    const compare = Atomics.compareExchange;
    const intercept = mode === "late"
      ? vi.spyOn(Atomics, "wait").mockReturnValue("timed-out")
      : vi.spyOn(Atomics, "compareExchange").mockImplementation(((words: Int32Array, index: number, expected: number, value: number) => {
        if (expected === 1 && value === 2) Atomics.store(words, index, 3);
        return compare(words, index, expected, value);
      }) as typeof Atomics.compareExchange);
    try { expect(channel.onMakeCurrent!({ drawSurfaceId: 0, readSurfaceId: 0, width: 0, height: 0 })).toBe(-5); }
    finally { intercept.mockRestore(); }
    if (mode === "late") worker.fire(late[0]);
    const next = createMainForwardChannel({ postMessage: message => worker.fire(message) }, 7);
    const input = new Uint8Array(4); new DataView(input.buffer).setUint32(0, 0x0ba2, true);
    const query = () => next.onQuery!(O.QOP_GET_INTEGERV, input, 16);
    expect([...new Int32Array(query().bytes.buffer)]).toEqual([0, 0, 320, 240]);
    expect(next.onMakeCurrent!({ drawSurfaceId: 0, readSurfaceId: 0, width: 0, height: 0 })).toBe(0);
    expect([...new Int32Array(query().bytes.buffer)]).toEqual([0, 0, 0, 0]);
    expect(next.onMakeCurrent!({ drawSurfaceId: 1, readSurfaceId: 0, width: 8, height: 8 })).toBe(-22);
    dispose();
  });

  it("routes two sessions of one process through one channel and retires only one", () => {
    const worker = new FakeWorker();
    const gl = new RecordingGl();
    const dispose = setupMainForward(worker, fakeCanvas(gl).canvas, 7);
    const channel = createMainForwardChannel({ postMessage: message => worker.fire(message) }, 7);
    expect(channel.onCreateContext(11)).toBe(0);
    expect(channel.onCreateContext(12)).toBe(0);
    channel.onUnbind!(11);
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), 4, 11).rc).toBe(-5);
    expect(channel.onQuery!(O.QOP_GET_ERROR, new Uint8Array(), 4, 12).rc).toBe(4);
    channel.onSubmit(clearCmdbuf(), 12);
    expect(gl.log).toEqual([["clear", [0x4000]]]);
    dispose();
  });

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
      gl.error = 0x500;
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

it("copies surface creation scalars and reuses the bounded acknowledgement mailbox", () => {
  const messages: GlForwardMessage[] = [];
  const channel = createMainForwardChannel({postMessage(message) {
    messages.push(message);
    if (message.type === "gl_forward_create_surface") {
      const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
      view.setUint32(0,17,true); view.setUint32(4,13,true);
      completeGlForwardQuery(message.mailbox,8,bytes);
    } else if (message.type === "gl_forward_create_context" || message.type === "gl_forward_present") completeGlForwardQuery(message.mailbox,0,new Uint8Array());
  }},7,11);
  const surface = {surfaceId:71,kind:1,width:0,height:0,configId:1,targetBoId:0,unreviewed:new WebAssembly.Memory({initial:1})};
  expect(channel.onCreateSurface!(surface)).toEqual({rc:0,width:17,height:13});
  expect(channel.onCreateContext()).toBe(0);
  const [creation,context] = messages;
  expect(creation.type).toBe("gl_forward_create_surface");
  if (creation.type !== "gl_forward_create_surface" || context.type !== "gl_forward_create_context") throw new Error("wrong route");
  expect(Object.keys(creation.surface).sort()).toEqual(["surfaceId","kind","width","height","configId","targetBoId"].sort());
  expect(creation.mailbox).toBe(context.mailbox);
  expect(channel.onPresent!()).toBe(0);
  const present = messages.at(-1)!;
  if (present.type !== "gl_forward_present") throw new Error("missing present");
  expect(present.mailbox).toBe(creation.mailbox);
  expect(channel.onCreateSurface!({...surface,targetBoId:1})).toEqual({rc:-22,width:0,height:0});
  channel.onDestroySurface!(71);
  expect(messages.at(-1)).toEqual({type:"gl_forward_destroy_surface",pid:7,sessionId:11,surfaceId:71});
});

it("cancels forwarded surface allocation when completion loses its mailbox authority", () => {
  const worker = new FakeWorker();
  const mailbox = createGlForwardQueryMailbox(); prepareGlForwardQuery(mailbox,8);
  const disposed: unknown[] = [];
  const gl = new Proxy({
    isContextLost: () => false, getError: () => 0, getParameter: () => null,
    createFramebuffer: () => ({fbo:true}), createTexture: () => ({texture:true}), createRenderbuffer: () => ({rbo:true}),
    FRAMEBUFFER_COMPLETE:0x8cd5,
    checkFramebufferStatus: () => { Atomics.store(new Int32Array(mailbox),0,3); return 0x8cd5; },
    deleteFramebuffer: (fbo:unknown) => disposed.push(fbo),
  },{get:(object,key) => Reflect.get(object,key) ?? (() => null)});
  const dispose = setupMainForward(worker,{width:4,height:3,getContext:() => gl} as unknown as HTMLCanvasElement,7);
  worker.fire({type:"gl_forward_create_surface",pid:7,sessionId:11,
    surface:{surfaceId:71,kind:1,width:4,height:3,configId:1,targetBoId:0},mailbox});
  expect(disposed).toEqual([{fbo:true}]);
  dispose(); expect(disposed).toHaveLength(1);
});

function shareForwardFixture() {
  const worker=new FakeWorker(),live=new Set<object>(),deleted:object[]=[],messages:GlForwardMessage[]=[];
  const gl=new Proxy({getExtension:()=>null,isContextLost:()=>false,getParameter:()=>null,getError:()=>0,
    createTexture:()=>{const value={};live.add(value);return value;},isTexture:(value:object)=>live.has(value),
    deleteTexture:(value:object)=>{deleted.push(value);live.delete(value);},
  },{get:(object,key)=>Reflect.get(object,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const dispose=setupMainForward(worker,{width:1,height:1,getContext:()=>gl} as unknown as HTMLCanvasElement,7);
  let loseCleanup=false;
  const channel=(session:number)=>createMainForwardChannel({postMessage(message){
    if(loseCleanup && message.type==="gl_forward_destroy_context")throw new Error("lost cleanup");
    messages.push(message);worker.fire(message);
  }},7,session);
  const command=(c:ReturnType<typeof channel>,op:number,words:number[])=>{
    const bytes=new Uint8Array(4+4*words.length),v=new DataView(bytes.buffer);
    v.setUint16(0,op,true);v.setUint16(2,4*words.length,true);words.forEach((word,i)=>v.setUint32(4+4*i,word,true));c.onSubmit(bytes);
  };
  const texture=(c:ReturnType<typeof channel>)=>{
    const input=new Uint8Array(8),v=new DataView(input.buffer);v.setUint32(0,1,true);v.setUint32(4,17,true);
    const reply=c.onQuery!(O.QOP_IS_OBJECT,input,12);expect(reply.rc).toBe(12);
    return new DataView(reply.bytes.buffer,reply.bytes.byteOffset,reply.bytes.length).getUint32(4,true);
  };
  return {worker,channel,command,texture,messages,deleted,live,dispose,setLoseCleanup:(value:boolean)=>{loseCleanup=value;}};
}
it("constructs shared forwarded objects while retaining local state and survivor ownership",()=>{
  const f=shareForwardFixture(),source=f.channel(11),target=f.channel(12),independent=f.channel(13);
  expect(source.onCreateContext()).toBe(0);
  f.command(source,O.OP_GEN_TEXTURES,[1,17]);f.command(source,O.OP_BIND_TEXTURE,[0x0de1,17]);
  expect(target.onCreateContext(12,11)).toBe(0);expect(independent.onCreateContext()).toBe(0);
  expect(f.texture(target)).toBe(1);expect(f.texture(independent)).toBe(0);
  const message=f.messages.find(m=>m.type==="gl_forward_create_context" && m.sessionId===12)!;
  expect(Object.keys(message).sort()).toEqual(["type","pid","sessionId","shareSessionId","mailbox"].sort());
  source.onDestroyContext();expect(f.texture(target)).toBe(1);expect(f.deleted).toEqual([]);
  target.onDestroyContext();expect(f.deleted).toHaveLength(1);expect(f.live.size).toBe(0);
  f.dispose();
});
it("cancels a joined forwarded creation without retiring the source group",()=>{
  const f=shareForwardFixture(),source=f.channel(11),target=f.channel(12);
  expect(source.onCreateContext()).toBe(0);
  f.command(source,O.OP_GEN_TEXTURES,[1,17]);f.command(source,O.OP_BIND_TEXTURE,[0x0de1,17]);
  f.setLoseCleanup(true);
  const compare=Atomics.compareExchange,intercept=vi.spyOn(Atomics,"compareExchange").mockImplementation(((words:Int32Array,index:number,expected:number,value:number)=>{
    if(expected===1 && value===2)Atomics.store(words,index,3);
    return compare(words,index,expected,value);
  }) as typeof Atomics.compareExchange);
  try {expect(target.onCreateContext(12,11)).toBe(-5);} finally {intercept.mockRestore();f.setLoseCleanup(false);}
  expect(f.texture(source)).toBe(1);expect(f.deleted).toEqual([]);
  expect(f.channel(12).onCreateContext(12,11)).toBe(0);
  f.dispose();expect(f.deleted).toHaveLength(1);expect(f.live.size).toBe(0);
});
it("rejects missing and malformed forwarding share identities without damaging an existing source",()=>{
  const f=shareForwardFixture(),source=f.channel(11),target=f.channel(12);
  expect(source.onCreateContext()).toBe(0);
  f.command(source,O.OP_GEN_TEXTURES,[1,17]);f.command(source,O.OP_BIND_TEXTURE,[0x0de1,17]);
  for(const id of [Number.NaN,-1,0x1_0000_0000])expect(target.onCreateContext(12,id)).toBe(-22);
  expect(target.onCreateContext(12,99)).toBe(-22);
  // Malformed reply capacity on an existing context must not destroy it.
  const mailbox=createGlForwardQueryMailbox();prepareGlForwardQuery(mailbox,4);
  f.worker.fire({type:"gl_forward_create_context",pid:7,sessionId:11,shareSessionId:12,mailbox});
  expect(waitForGlForwardQuery(mailbox).rc).toBe(-5);expect(f.texture(source)).toBe(1);
  expect(f.channel(12).onCreateContext(12,11)).toBe(0);f.dispose();expect(f.deleted).toHaveLength(1);
});
