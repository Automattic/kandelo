import { describe, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import * as O from "../src/webgl/ops.js";

const ENODEV = -19;

/** A WebGL renderer whose loss state and canvas loss events the test drives,
 * as a GPU reset or GPU-process crash would. */
function renderer() {
  const listeners: (() => void)[] = [];
  const state = { lost: false, calls: [] as string[] };
  const canvas = {
    width: 4, height: 4,
    addEventListener: (type: string, listener: () => void) => { if (type === "webglcontextlost") listeners.push(listener); },
    getContext: () => gl,
  };
  const gl = new Proxy({
    canvas, getError: () => 0, isContextLost: () => state.lost, getExtension: () => null,
    getParameter: () => null, checkFramebufferStatus: () => 0x8cd5,
  }, { get: (target, key) => Reflect.get(target, key) ?? (String(key).startsWith("create")
    ? () => ({}) : () => { state.calls.push(String(key)); return null; }) }) as unknown as WebGL2RenderingContext;
  return { gl, canvas, state, lose: () => { state.lost = true; listeners.forEach(listener => listener()); } };
}

function harness() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  });
  const env = (kernel.testAuthority.buildImportObject(memory) as { env: Record<string, (...args: any[]) => any> }).env;
  const { gl, canvas, state, lose } = renderer();
  const open = (session: number, context: number, share = 0) => {
    kernel.gl.bind({ displayFileId: 1n, pid: 7, sessionId: session, cmdbufAddr: 0, cmdbufLen: 0 });
    kernel.gl.attachCanvas(7, canvas as unknown as OffscreenCanvas);
    new Uint32Array(memory.buffer, 256, 4).set([2, share, 0, 0]);
    return env.host_gl_create_context(7, context, 256, 16, session) as number;
  };
  const contact = (session: number, context: number) => ({
    submit: env.host_gl_submit(7, 0, 0, session) as number,
    query: env.host_gl_query(7, O.QOP_GET_ERROR, 0, 0, 512, 4, session) as number,
    present: env.host_gl_present(7, session) as number,
    makeCurrent: env.host_gl_make_current(7, context, 0, 0, session) as number,
  });
  return { kernel, env, gl, state, lose, open, contact };
}

describe("a lost WebGL renderer is a graphics reset", () => {
  it("fails submit, ordinary queries, present and make-current with ENODEV and executes nothing", () => {
    const { kernel, state, lose, open, contact } = harness();
    expect(open(11, 21)).toBe(0);
    expect(kernel.gl.get(7, 11)!.gl).not.toBeNull();
    expect(contact(11, 21).submit).toBe(0);
    lose();
    state.calls.length = 0;
    expect(contact(11, 21)).toEqual({ submit: ENODEV, query: ENODEV, present: ENODEV, makeCurrent: ENODEV });
    expect(state.calls).toEqual([]);
  });

  it("stays reset after the same context object is restored", () => {
    const { state, lose, open, contact } = harness();
    expect(open(11, 21)).toBe(0);
    expect(contact(11, 21).submit).toBe(0);
    lose();
    state.lost = false; // webglcontextrestored: every earlier native object is gone
    expect(contact(11, 21)).toEqual({ submit: ENODEV, query: ENODEV, present: ENODEV, makeCurrent: ENODEV });
  });

  it("refuses to share with a reset context, and a new independent context works", () => {
    const { lose, state, open, contact } = harness();
    expect(open(11, 21)).toBe(0);
    lose();
    state.lost = false;
    expect(open(12, 22, 21)).toBe(ENODEV);
    expect(open(13, 23)).toBe(0);
    expect(contact(13, 23).submit).toBe(0);
    expect(contact(13, 23).makeCurrent).toBe(0);
  });
});
