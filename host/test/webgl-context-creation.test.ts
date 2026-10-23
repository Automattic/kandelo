import { describe, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";

function harness(callbacks = {}) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  });
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel,
    setMaster: (pid: number) => imports.env.host_kms_set_master(pid),
    create: (pid: number, id = 1) => imports.env.host_gl_create_context(pid, id, 0, 0),
  };
}

describe("context creation acknowledgement", () => {
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
