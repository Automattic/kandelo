import { describe, expect, it, vi } from "vitest";

import { CentralizedKernelWorker } from "../src/kernel-worker";
import { WasmPosixKernel } from "../src/kernel";

describe("process-owned device view teardown", () => {
  it("drops every device alias that can retain an exiting process generation", () => {
    const removePid = vi.fn();
    const glUnbind = vi.fn();
    const framebufferUnbind = vi.fn();
    const releaseBos = vi.fn();
    const dropMaster = vi.fn();
    const kernel = Object.assign(
      Object.create(WasmPosixKernel.prototype),
      {
        gl_submit_queue: { removePid },
        gl: { unbind: glUnbind },
        framebuffers: { unbind: framebufferUnbind },
        bos: { releaseProcess: releaseBos },
        kms: {
          isMasterPid: (pid: number) => pid === 41,
          dropMaster,
        },
      },
    ) as WasmPosixKernel;

    kernel.releaseProcessViews(41);

    expect(removePid).toHaveBeenCalledWith(41);
    expect(glUnbind).toHaveBeenCalledWith(41);
    expect(framebufferUnbind).toHaveBeenCalledWith(41);
    expect(releaseBos).toHaveBeenCalledWith(41);
    expect(dropMaster).toHaveBeenCalledOnce();
  });

  it("refuses stale pid-only teardown after exec installs a new Memory", () => {
    const oldMemory = new WebAssembly.Memory({ initial: 1 });
    const newMemory = new WebAssembly.Memory({ initial: 1 });
    const releaseProcessViews = vi.fn();
    const worker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        processes: new Map([
          [41, { pid: 41, memory: newMemory, channels: [] }],
        ]),
        kernel: { releaseProcessViews },
      },
    ) as CentralizedKernelWorker;

    expect(
      (worker as any).releaseProcessViews(41, oldMemory),
    ).toBe(false);
    expect(releaseProcessViews).not.toHaveBeenCalled();

    expect(
      (worker as any).releaseProcessViews(41, newMemory),
    ).toBe(true);
    expect(releaseProcessViews).toHaveBeenCalledWith(41);
  });
});
