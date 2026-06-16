import { describe, expect, it, vi } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { SubmitQueue } from "../src/webgl/submit-queue.js";
import { drainSubmitQueue } from "../src/webgl/submit-drain.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { OP_CLEAR } from "../src/webgl/ops.js";

const FRAME_LEN = 8;
const FRAME = { memorySab: new SharedArrayBuffer(0), off: 0, len: FRAME_LEN };

class RecordingGl {
  log: Array<[string, unknown[]]> = [];
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  viewport(...a: number[]) { this.log.push(["viewport", a]); }
  scissor(...a: number[]) { this.log.push(["scissor", a]); }
  enable(c: number) { this.log.push(["enable", [c]]); }
  disable(c: number) { this.log.push(["disable", [c]]); }
  clearColor(...a: number[]) { this.log.push(["clearColor", a]); }
  clear(m: number) { this.log.push(["clear", [m]]); }
  depthFunc(f: number) { this.log.push(["depthFunc", [f]]); }
  blendFuncSeparate(...a: number[]) { this.log.push(["blendFuncSeparate", a]); }
  cullFace(m: number) { this.log.push(["cullFace", [m]]); }
  frontFace(m: number) { this.log.push(["frontFace", [m]]); }
  useProgram(p: unknown) { this.log.push(["useProgram", [p]]); }
  activeTexture(u: number) { this.log.push(["activeTexture", [u]]); }
  pixelStorei(p: number, v: number) { this.log.push(["pixelStorei", [p, v]]); }
}

function setupBinding(
  reg: GlContextRegistry,
  pid: number,
  gl: RecordingGl,
  color: [number, number, number, number],
): GlBinding {
  reg.bind({ pid, cmdbufAddr: 0, cmdbufLen: FRAME_LEN });
  const b = reg.get(pid)!;
  b.cmdbufView = new Uint8Array(FRAME_LEN);
  b.gl = gl as unknown as WebGL2RenderingContext;
  b.shadow.clearColor = color;
  const view = new DataView(b.cmdbufView.buffer);
  view.setUint16(0, OP_CLEAR, true);
  view.setUint16(2, 4, true);
  view.setUint32(4, 0x4000, true);
  return b;
}

function fbWriteSequence(gl: RecordingGl): Array<[number, number, number, number]> {
  return gl.log
    .filter((r) => r[0] === "clearColor")
    .map((r) => r[1] as [number, number, number, number]);
}

describe("dri multiplex — two-pid interleaved submits (plan 3 §B8)", () => {
  it("two clients sharing one GL context drain in submit order, switchTo fires per pid", () => {
    const reg = new GlContextRegistry();
    const gl = new RecordingGl();
    const b10 = setupBinding(reg, 10, gl, [1, 0, 0, 1]);
    const b11 = setupBinding(reg, 11, gl, [0, 0, 1, 1]);

    const queue = new SubmitQueue();
    queue.enqueue(b10, FRAME);
    queue.enqueue(b11, FRAME);

    const mux = new GlMuxer(gl as unknown as WebGL2RenderingContext);
    const switchSpy = vi.spyOn(mux, "switchTo");

    drainSubmitQueue(queue, () => mux, decodeAndDispatch);

    expect(switchSpy.mock.calls.map((c) => (c[0] as GlBinding).pid)).toEqual([10, 11]);
    expect(fbWriteSequence(gl)).toEqual([[1, 0, 0, 1], [0, 0, 1, 1]]);
  });

  it("compositor (pid=2) drains before pid-11 even when pid-11 was enqueued first", () => {
    const reg = new GlContextRegistry();
    const gl = new RecordingGl();
    const b10 = setupBinding(reg, 10, gl, [0.1, 0, 0, 1]);
    const b11 = setupBinding(reg, 11, gl, [0, 0, 0.1, 1]);
    const b2 = setupBinding(reg, 2, gl, [0, 0.1, 0, 1]);

    const queue = new SubmitQueue();
    queue.enqueue(b10, FRAME);
    queue.enqueue(b11, FRAME);
    queue.enqueue(b2, FRAME);

    const mux = new GlMuxer(gl as unknown as WebGL2RenderingContext);
    const switchSpy = vi.spyOn(mux, "switchTo");

    drainSubmitQueue(queue, () => mux, decodeAndDispatch);

    expect(switchSpy.mock.calls.map((c) => (c[0] as GlBinding).pid)).toEqual([2, 10, 11]);
    expect(fbWriteSequence(gl)).toEqual([
      [0, 0.1, 0, 1],
      [0.1, 0, 0, 1],
      [0, 0, 0.1, 1],
    ]);
  });
});
