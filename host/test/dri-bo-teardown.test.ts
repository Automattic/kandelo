/*
 * A GBM bo owns the foreign textures a compositor bound from it, so they
 * must be dropped however the bo is destroyed: the guest's GEM_CLOSE
 * (`host_gbm_bo_destroy`) or a process teardown releasing its last owner
 * (`releaseProcessViews`, the crash / force-terminate path). Only the first
 * was wired, so every crashed client leaked its textures into the
 * compositor's GL context.
 */
import { describe, expect, it, vi } from "vitest";

import { createWasmPosixKernelTestHarness, WasmPosixKernel } from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

function harness(): {
  kernel: WasmPosixKernel & Record<string, any>;
  imports: { env: Record<string, (...args: any[]) => any> };
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: {} as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  }) as WasmPosixKernel & Record<string, any>;
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel, imports };
}

const bo = (pid: number, bo_id: number) =>
  ({ pid, bo_id, size: 4096, w: 16, h: 16, stride: 64 });

describe("GBM bo teardown drops the bo's foreign textures", () => {
  it("on the guest's GEM_CLOSE", () => {
    const { kernel, imports } = harness();
    const drop = vi.spyOn(kernel.gl, "dropForeignTexturesForBo");
    kernel.bos.create(bo(10, 1));
    imports.env.host_gbm_bo_destroy(10, 1);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(1);
  });

  it("when a crashed or force-terminated process releases the last owner", () => {
    const { kernel } = harness();
    const drop = vi.spyOn(kernel.gl, "dropForeignTexturesForBo");
    kernel.bos.create(bo(10, 1));
    kernel.releaseProcessViews(10);
    expect(drop).toHaveBeenCalledWith(1);
  });

  it("not while another process still owns the bo", () => {
    const { kernel } = harness();
    const drop = vi.spyOn(kernel.gl, "dropForeignTexturesForBo");
    kernel.bos.create(bo(10, 1));
    kernel.bos.bind(20, 1, 0, 4096);   // an importer holds it too
    kernel.releaseProcessViews(10);
    expect(drop).not.toHaveBeenCalled();
    kernel.releaseProcessViews(20);
    expect(drop).toHaveBeenCalledWith(1);
  });
});
