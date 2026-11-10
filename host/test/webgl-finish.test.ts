import { describe, expect, it } from "vitest";
import { finishRenderer, webglFinishReturnsEarly } from "../src/webgl/finish.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import * as O from "../src/webgl/ops.js";

const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37, PIXEL_PACK = 0x88eb;

/** WebGL2 stand-in for the calls completion may make. Buffers are plain
 * objects; bindings and contents are tracked so restoration is observable. */
class CompletionGl {
  log: Array<[string, unknown[]]> = [];
  bindings = new Map<number, unknown>();
  contents = new Map<unknown, Uint8Array>();
  errors: number[] = [];
  lost = false;
  copyError = 0;
  loseOnRead = false;
  private next = 1;
  private lossListeners: Array<() => void> = [];
  canvas = { addEventListener: (type: string, listener: () => void) => {
    if (type === "webglcontextlost") this.lossListeners.push(listener);
  } };
  loseContext(): void { for (const listener of this.lossListeners) listener(); }
  createBuffer() { const buffer = { buffer: this.next++ }; this.log.push(["createBuffer", []]); return buffer; }
  deleteBuffer(buffer: unknown) { this.log.push(["deleteBuffer", [buffer]]); }
  bindBuffer(target: number, buffer: unknown) { this.log.push(["bindBuffer", [target, buffer]]); this.bindings.set(target, buffer); }
  bufferData(target: number, size: number, usage: number) {
    this.log.push(["bufferData", [target, size, usage]]);
    this.contents.set(this.bindings.get(target), new Uint8Array(size));
  }
  copyBufferSubData(read: number, write: number, from: number, to: number, size: number) {
    this.log.push(["copyBufferSubData", [read, write, from, to, size]]);
    if (this.copyError) { this.errors.push(this.copyError); return; }
    this.contents.get(this.bindings.get(write))!.set(this.contents.get(this.bindings.get(read))!.subarray(from, from + size), to);
  }
  getBufferSubData(target: number, offset: number, destination: Uint8Array) {
    this.log.push(["getBufferSubData", [target, offset, destination.byteLength, this.bindings.get(target)]]);
    destination.set(this.contents.get(this.bindings.get(target))!.subarray(offset, offset + destination.byteLength));
    if (this.loseOnRead) this.lost = true;
  }
  finish() { this.log.push(["finish", []]); }
  isContextLost() { return this.lost; }
  getError() { return this.errors.shift() ?? 0; }
  getParameter(name: number) {
    if (name === COPY_READ || name === COPY_WRITE) return this.bindings.get(name) ?? null;
    throw new Error(`unexpected getParameter ${name}`);
  }
}

function setup() {
  const gl = new CompletionGl();
  const registry = new GlContextRegistry();
  registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 64 });
  const b = registry.get(1)!;
  b.gl = gl as unknown as WebGL2RenderingContext;
  // Bindings that belong to the guest or to other host work.
  const guestRead = { guest: "read" }, guestWrite = { guest: "write" }, guestPack = { guest: "pack" };
  gl.bindings.set(COPY_READ, guestRead);
  gl.bindings.set(COPY_WRITE, guestWrite);
  gl.bindings.set(PIXEL_PACK, guestPack);
  gl.log = [];
  return { gl, b, guestRead, guestWrite, guestPack };
}
const names = (gl: CompletionGl) => gl.log.map(([name]) => name);

describe("glFinish completion", () => {
  it.each([
    ["Chromium", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", true],
    ["Edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0", true],
    ["Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15", true],
    ["Firefox for iOS (WebKit)", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/155.0 Mobile/15E148 Safari/605.1.15", true],
    ["Firefox", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0", false],
    ["Node.js", "Node.js/24", false],
    ["no navigator", undefined, false],
  ])("classifies %s", (_name, userAgent, early) => {
    expect(webglFinishReturnsEarly(userAgent)).toBe(early);
  });

  it("uses only the native finish where it completes", () => {
    const { gl, b } = setup();
    expect(finishRenderer(b, false)).toBe(true);
    expect(names(gl)).toEqual(["finish"]);
  });

  it("waits on a private buffer copy and restores the copy bindings", () => {
    const { gl, b, guestRead, guestWrite, guestPack } = setup();
    expect(finishRenderer(b, true)).toBe(true);
    expect(names(gl)).toEqual([
      "finish", "createBuffer", "createBuffer",
      "bindBuffer", "bindBuffer", "bufferData", "bufferData",
      "copyBufferSubData", "getBufferSubData", "bindBuffer", "bindBuffer",
    ]);
    const read = gl.log.find(([name]) => name === "getBufferSubData")![1];
    expect(read.slice(0, 3)).toEqual([COPY_WRITE, 0, 4]);
    expect(read[3]).not.toBe(guestWrite);
    expect(gl.bindings.get(COPY_READ)).toBe(guestRead);
    expect(gl.bindings.get(COPY_WRITE)).toBe(guestWrite);
    // No pixel pack state, pack buffer or framebuffer is touched.
    expect(gl.bindings.get(PIXEL_PACK)).toBe(guestPack);
    expect(b.errors).toEqual([]);
  });

  it("reuses the private buffers on one renderer", () => {
    const { gl, b } = setup();
    expect(finishRenderer(b, true)).toBe(true);
    gl.log = [];
    expect(finishRenderer(b, true)).toBe(true);
    expect(names(gl)).toEqual(["finish", "bindBuffer", "bindBuffer", "copyBufferSubData", "getBufferSubData", "bindBuffer", "bindBuffer"]);
  });

  it("does not reuse buffers from a lost generation of a restored context", () => {
    const { gl, b } = setup();
    expect(finishRenderer(b, true)).toBe(true);
    gl.loseContext();
    gl.log = [];
    expect(finishRenderer(b, true)).toBe(true);
    expect(names(gl).filter((name) => name === "createBuffer")).toHaveLength(2);
  });

  it("reports a native completion error and still restores the bindings", () => {
    const { gl, b, guestRead, guestWrite } = setup();
    gl.copyError = 0x505;
    expect(finishRenderer(b, true)).toBe(false);
    expect(b.errors).toContain(0x505);
    expect(gl.bindings.get(COPY_READ)).toBe(guestRead);
    expect(gl.bindings.get(COPY_WRITE)).toBe(guestWrite);
  });

  it("fails loudly when the renderer is lost during completion", () => {
    const { gl, b } = setup();
    gl.loseOnRead = true;
    expect(finishRenderer(b, true)).toBe(false);
    expect(b.errors).toContain(0x502);
    gl.log = [];
    expect(finishRenderer(b, true)).toBe(false);
    expect(names(gl)).toEqual([]);
  });

  it("answers QOP_FINISH through the same completion", () => {
    const { gl, b } = setup();
    // Node has no AppleWebKit user agent, so the native finish completes.
    expect(runGlQuery(b, O.QOP_FINISH, new Uint8Array(), new Uint8Array())).toBe(0);
    expect(names(gl)).toEqual(["finish"]);
  });
});
