import { describe, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";

function harness(callbacks = {}) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: { getProcessMemory: () => memory, ...callbacks },
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  });
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel,
    memory, imports: imports.env,
    setMaster: (pid: number) => imports.env.host_kms_set_master(pid),
    create: (pid: number, id = 1, sessionId?: number) =>
      imports.env.host_gl_create_context(pid, id, 0, 0, sessionId),
  };
}

describe("context creation acknowledgement", () => {
  it("routes command buffers and context retirement independently within one process", () => {
    const { kernel, imports, create, memory } = harness();
    let color: number[] = [];
    const rendered: number[][] = [];
    const gl = new Proxy({
      isContextLost: () => false, getExtension: () => null, getParameter: () => null,
      getError: () => 0, clearColor: (...value: number[]) => { color = value; },
      clear: () => rendered.push([...color]),
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) });
    kernel.gl.attachCanvas(7, { width: 16, height: 16, getContext: () => gl } as unknown as OffscreenCanvas);
    for (const [index, sessionId] of [11, 12].entries()) {
      const addr = 128 + index * 64;
      imports.host_gl_bind(7, addr, 64, sessionId);
      expect(create(7, 21 + index, sessionId)).toBe(0);
      const words = new DataView(memory.buffer, addr, 28);
      words.setUint16(0, 2, true); words.setUint16(2, 16, true); // clear color
      [index, 1 - index, 0, 1].forEach((value, at) => words.setFloat32(4 + at * 4, value, true));
      words.setUint16(20, 1, true); words.setUint16(22, 4, true); // clear
      words.setUint32(24, 0x4000, true);
      expect(imports.host_gl_submit(7, 0, 28, sessionId)).toBe(0);
    }
    expect(imports.host_gl_present(7)).toBe(-5); // ambiguous process-only request
    expect(imports.host_gl_present(7, 99)).toBe(-5); // unknown session
    expect(imports.host_gl_submit(7, 20, 8, 11)).toBe(0);
    expect(rendered).toEqual([[0, 1, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1]]);
    imports.host_gl_unbind(7, 11);
    expect(kernel.gl.get(7, 11)).toBeUndefined();
    expect(kernel.gl.get(7, 12)!.contextId).toBe(22);
    expect(imports.host_gl_submit(7, 20, 8, 12)).toBe(0);
    expect(rendered.at(-1)).toEqual([1, 0, 0, 1]);
  });

  it("does not claim a KMS canvas on failure and claims it on retry", () => {
    let available = false;
    const claims: number[] = [];
    const gl = new Proxy({
      getExtension: () => null, isContextLost: () => false,
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) });
    const canvas = { width: 16, height: 16, getContext: () => available ? gl : null };
    const { kernel, create, setMaster } = harness({
      getKmsCanvas: () => canvas, getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: (id: number) => claims.push(id),
    });
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    setMaster(7);
    expect(create(7)).toBe(-19);
    expect(kernel.gl.get(7)!.canvas).toBeNull();
    expect(claims).toEqual([]);
    available = true;
    expect(create(7)).toBe(0);
    expect(kernel.gl.get(7)!.claimedKmsCrtc).toBe(1);
    expect(claims).toEqual([1]);
  });

  it("fails without a renderer and leaves creation retryable", () => {
    const { kernel, create } = harness();
    expect(create(7)).toBe(-5);
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    const b = kernel.gl.get(7)!;
    expect(create(7)).toBe(-19); // ENODEV
    expect(b.contextId).toBeNull();
    expect(b.gl).toBeNull();
    const gl = { getExtension: () => null, isContextLost: () => false };
    kernel.gl.attachCanvas(7, {
      width: 16, height: 16, getContext: () => gl,
    } as unknown as OffscreenCanvas);
    expect(create(7, 2)).toBe(0);
    expect(b.contextId).toBe(2);
    expect(b.gl).toBe(gl);
    expect(create(7, 3)).toBe(-16); // EBUSY
    expect(b.contextId).toBe(2);
  });

  it.each(["unavailable", "lost", "throwing"])("rejects a %s native context", mode => {
    const { kernel, create } = harness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    kernel.gl.attachCanvas(7, {
      width: 16, height: 16,
      getContext: () => {
        if (mode === "throwing") throw new Error("allocation failed");
        return mode === "unavailable" ? null : {
          getExtension: () => null, isContextLost: () => true,
        };
      },
    } as unknown as OffscreenCanvas);
    expect(create(7)).toBeLessThan(0);
    const b = kernel.gl.get(7)!;
    expect(b.contextId).toBeNull();
    expect(b.gl).toBeNull();
    expect(b.claimedKmsCrtc).toBeNull();
  });

  it("publishes a forwarded context only after a successful acknowledgement", () => {
    const { kernel, create } = harness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
    let rc = -12;
    kernel.gl.attachMainForward(7, {
      onCreateContext: () => rc, onDestroyContext() {}, onSubmit() {},
    });
    const b = kernel.gl.get(7)!;
    expect(create(7)).toBe(-12);
    expect(b.contextId).toBeNull();
    rc = 0;
    expect(create(7)).toBe(0);
    expect(b.contextId).toBe(1);
  });
});
