import { describe, expect, it, vi } from "vitest";

import {
  CentralizedKernelWorker,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { WasmPosixKernel } from "../src/kernel";
import { GlContextRegistry } from "../src/webgl/registry";

type TestableCentralizedKernelWorker = CentralizedKernelWorker & {
  releaseProcessViews(
    pid: number,
    expectedMemory: WebAssembly.Memory,
    transition?: "exit" | "exec",
  ): boolean;
};

describe("process-owned device view teardown", () => {
  it("drops every device alias that can retain an exiting process generation", () => {
    const removePid = vi.fn();
    const framebufferUnbind = vi.fn();
    const releaseBos = vi.fn();
    const dropMaster = vi.fn();
    const retirePresenter = vi.fn();
    const markKmsCanvasGlReleased = vi.fn();
    // Both sessions belong to the exiting generation and claim one canvas.
    const gl = new GlContextRegistry();
    const bindings = [1, 7].map((sessionId) => {
      gl.bind({ pid: 41, sessionId, cmdbufAddr: 0, cmdbufLen: 16 });
      const binding = gl.get(41, sessionId)!;
      binding.claimedKmsCrtc = 1;
      binding.canvas = {} as HTMLCanvasElement;
      binding.cmdbufView = new Uint8Array(16);
      return binding;
    });
    const glUnbind = vi.spyOn(gl, "unbind");
    const kernel = Object.assign(
      Object.create(WasmPosixKernel.prototype),
      {
        callbacks: { markKmsCanvasGlReleased },
        gl_submit_queue: { removePid },
        gl,
        gl_muxers: new Map(),
        framebuffers: { unbind: framebufferUnbind },
        bos: { releaseProcess: releaseBos },
        kms: {
          retirePresenter,
          dropMaster,
        },
      },
    ) as WasmPosixKernel;

    kernel.releaseProcessViews(41);

    expect(removePid).toHaveBeenCalledWith(41);
    expect(glUnbind).toHaveBeenCalledWith(41);
    expect(framebufferUnbind).toHaveBeenCalledWith(41);
    expect(releaseBos).toHaveBeenCalledWith(41);
    expect(dropMaster).not.toHaveBeenCalled();
    expect(retirePresenter).toHaveBeenCalledExactlyOnceWith(41);
    // The claimed canvas goes back to the vblank pump before the unbind that
    // would otherwise make the claim unreachable.
    expect(markKmsCanvasGlReleased).toHaveBeenCalledExactlyOnceWith(1);
    expect(gl.list()).toEqual([]);
    for (const binding of bindings) {
      expect(binding.claimedKmsCrtc).toBeNull();
      expect(binding.canvas).toBeNull();
      expect(binding.cmdbufView).toBeNull();
    }
  });

  it("refuses stale pid-only teardown after exec installs a new Memory", () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1 });
    const newMemory = new WebAssembly.Memory({ initial: 1 });
    const releaseProcessViews = vi.fn();
    const worker = createCentralizedKernelWorkerTestDouble();
    Object.assign(worker, {
      processes: new Map([
        [41, { pid: 41, memory: newMemory, channels: [] }],
      ]),
    });
    const kernel = new WasmPosixKernel({}, {});
    vi.spyOn(kernel, "releaseProcessViews").mockImplementation(
      releaseProcessViews,
    );
    worker.testAuthority.replaceKernelForScratchBoundaryTest(kernel);
    const testable = worker as unknown as TestableCentralizedKernelWorker;

    expect(testable.releaseProcessViews(41, oldMemory)).toBe(false);
    expect(releaseProcessViews).not.toHaveBeenCalled();

    expect(testable.releaseProcessViews(41, newMemory)).toBe(true);
    expect(releaseProcessViews).toHaveBeenCalledWith(41, "exit");

    releaseProcessViews.mockClear();
    expect(testable.releaseProcessViews(41, oldMemory, "exec")).toBe(false);
    expect(releaseProcessViews).not.toHaveBeenCalled();
    expect(testable.releaseProcessViews(41, newMemory, "exec")).toBe(true);
    expect(releaseProcessViews).toHaveBeenCalledWith(41, "exec");
  });
});
