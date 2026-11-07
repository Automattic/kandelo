/*
 * The kernel retires DRI/GL objects at close, munmap, exit and RMFB, then asks
 * the host to release the host-side state. The kernel has already moved on:
 * it reuses the address range or identity the object named. A host that
 * cannot finish the release (a lost final writeback, a mapping it cannot
 * detach, a native object it cannot delete, a refused request) holds state
 * nothing can release again, so it is a fatal host fault: the import throws
 * with a diagnostic naming the operation, pid, object and reason, and the
 * fault is latched through onHostFault, which the kernel worker turns into
 * its kernel-fatal shutdown on Node and in the browser alike.
 */
import { describe, expect, it, vi } from "vitest";

import { createWasmPosixKernelTestHarness, WasmPosixKernel } from "../src/kernel";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { DRI_CLEANUP_COMPLETE } from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

function harness() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const onHostFault = vi.fn();
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: { onHostFault } as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  }) as WasmPosixKernel & Record<string, any>;
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel, env: imports.env, onHostFault };
}

const bo = (pid: number, bo_id: number) =>
  ({ pid, bo_id, size: 4096, w: 16, h: 16, stride: 64 });

/** Run `call`, require it to throw, and require the same error to have been
 * latched through onHostFault before it propagated. */
function expectFatal(onHostFault: ReturnType<typeof vi.fn>, call: () => unknown, message: RegExp): Error {
  let thrown: unknown;
  try { call(); } catch (error) { thrown = error; }
  expect(thrown, "the cleanup reported an outcome instead of a fatal fault").toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(message);
  expect(onHostFault).toHaveBeenCalledWith(thrown);
  return thrown as Error;
}

describe("host_gbm_bo_destroy", () => {
  it("reports completion once the BO and its native views are gone", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expect(env.host_gbm_bo_destroy(10, 1)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.bos.get(10, 1)).toBeUndefined();
    // An already-destroyed BO has nothing left to free.
    expect(env.host_gbm_bo_destroy(10, 1)).toBe(DRI_CLEANUP_COMPLETE);
    expect(onHostFault).not.toHaveBeenCalled();
  });

  it("is fatal when a native view of the BO could not be deleted", () => {
    // Nothing guarantees a later retry: the journal is only revisited before
    // later GL work, and only a refused native deletion can leave it pending.
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    vi.spyOn(kernel.gl, "dropForeignTexturesForBo").mockReturnValue(false);
    expectFatal(onHostFault, () => env.host_gbm_bo_destroy(10, 1),
      /^DRI cleanup fault: gbm_bo_destroy of BO 1 for pid 10: .*native/);
  });

  it("is fatal when a release step faults", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    vi.spyOn(kernel.kms, "retireCursorBo").mockImplementation(() => { throw new Error("cursor fault"); });
    expectFatal(onHostFault, () => env.host_gbm_bo_destroy(10, 1),
      /^DRI cleanup fault: gbm_bo_destroy of BO 1 for pid 10: cursor fault$/);
  });
});

describe("host_gbm_bo_unbind", () => {
  it("reports completion when the unmapped range detaches", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    expect(env.host_gbm_bo_unbind(10, 1, 0, 4096)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.bos.get(10, 1)?.binding).toBeNull();
    expect(onHostFault).not.toHaveBeenCalled();
  });

  it("is fatal when the final writeback of the unmapped range is lost", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    vi.spyOn(kernel.bos as any, "flushMemoryToSab").mockImplementation(() => { throw new Error("copy failed"); });
    expectFatal(onHostFault, () => env.host_gbm_bo_unbind(10, 1, 0, 4096),
      /GBM BO 1: the final writeback of pid 10's unmapped range 0x0\+4096 could not be published: copy failed/);
  });

  it("is fatal when the binding cannot detach during another registry mutation", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    (kernel.bos as any).mutating = true;
    expectFatal(onHostFault, () => env.host_gbm_bo_unbind(10, 1, 0, 4096),
      /GBM BO 1: pid 10's unmapped range 0x0\+4096 cannot detach during another mapping mutation/);
  });

  it("is fatal when staging faults before the detach commits", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    vi.spyOn(kernel.bos as any, "stageLineages").mockImplementation(() => { throw new Error("staging fault"); });
    expectFatal(onHostFault, () => env.host_gbm_bo_unbind(10, 1, 0, 4096),
      /GBM BO 1: pid 10's unmapped range 0x0\+4096 could not detach: staging fault/);
  });

  it("is fatal when the kernel names a range that is not a process address span", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expectFatal(onHostFault, () => env.host_gbm_bo_unbind(10, 1, -1, 4096),
      /^DRI cleanup fault: gbm_bo_unbind of BO 1 for pid 10: /);
  });
});

describe("host_gl_unbind", () => {
  it("reports completion with no live session", () => {
    const { env, onHostFault } = harness();
    expect(env.host_gl_unbind(7, 11)).toBe(DRI_CLEANUP_COMPLETE);
    expect(onHostFault).not.toHaveBeenCalled();
  });

  it("is fatal when an execution whose cleanup failed still holds the context", () => {
    // After removeSession discards the session's queued frames, only a frame
    // whose own native cleanup was refused can still hold the context.
    const { kernel, env, onHostFault } = harness();
    vi.spyOn(kernel.gl, "unbind").mockReturnValue(false);
    expectFatal(onHostFault, () => env.host_gl_unbind(7, 11),
      /^DRI cleanup fault: gl_unbind of GL session 11 for pid 7: .*execution/);
  });

  it("is fatal when a release step faults", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.gl.bind({ pid: 7, sessionId: 11, displayFileId: 1n, cmdbufAddr: 0, cmdbufLen: 4096 });
    vi.spyOn(kernel as any, "releaseClaimedKmsCanvas").mockImplementation(() => { throw new Error("canvas fault"); });
    expectFatal(onHostFault, () => env.host_gl_unbind(7, 11),
      /^DRI cleanup fault: gl_unbind of GL session 11 for pid 7: canvas fault$/);
  });
});

describe("host_kms_* cleanup", () => {
  it("rmfb reports completion", () => {
    const { kernel, env } = harness();
    kernel.kms.addFb({ fb_id: 3, bo_id: 1, width: 16, height: 16, pixel_format: 0, pitch: 64 });
    expect(env.host_kms_rmfb(10, 3)).toBe(DRI_CLEANUP_COMPLETE);
    expect((kernel.kms as any).fbs.has(3)).toBe(false);
  });

  it("drop_master completes for the current grant and for a superseded one", () => {
    const { kernel, env, onHostFault } = harness();
    kernel.kms.setMaster(10, 1n, 1n);
    kernel.kms.setMaster(10, 1n, 2n);
    expect(env.host_kms_drop_master(10, 1n, 1n)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.kms.getMasterLeaseId()).toBe(2n);
    expect(env.host_kms_drop_master(10, 1n, 2n)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.kms.getMasterFileId()).toBeNull();
    expect(onHostFault).not.toHaveBeenCalled();
  });

  it("drop_master of an identity the kernel never issues is fatal", () => {
    const { env, onHostFault } = harness();
    expectFatal(onHostFault, () => env.host_kms_drop_master(10, 0n, 1n),
      /^DRI cleanup fault: kms_drop_master of master grant 1 \(file 0\) for pid 10: Missing DRM release file identity$/);
  });
});

describe("exec and exit device-view release", () => {
  it("is fatal when an exec loses a mapping's final writeback", () => {
    const { kernel, onHostFault } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    vi.spyOn(kernel.bos as any, "flushMemoryToSab").mockImplementation(() => { throw new Error("copy failed"); });
    expectFatal(onHostFault, () => kernel.releaseProcessViews(10, "exec"),
      /GBM BO 1: the final writeback of pid 10's unmapped range 0x0\+4096 could not be published: copy failed/);
  });

  it("is fatal when an exit leaves a GL context held by a failed execution", () => {
    const { kernel, onHostFault } = harness();
    vi.spyOn(kernel.gl, "unbind").mockReturnValue(false);
    expectFatal(onHostFault, () => kernel.releaseProcessViews(10, "exit"),
      /^DRI cleanup fault: exit device-view release of every GL session and GBM mapping for pid 10: .*execution/);
  });
});

describe("kernel worker", () => {
  it("turns a host DRI fault into its kernel-fatal shutdown", async () => {
    const onKernelFatal = vi.fn();
    const worker = createCentralizedKernelWorkerTestDouble({ callbacks: { onKernelFatal } }) as any;
    worker.bos.create(bo(10, 1));
    expect(worker.bos.bind(10, 1, 0, 4096)).toBe(0);
    vi.spyOn(worker.bos as any, "flushMemoryToSab").mockImplementation(() => { throw new Error("copy failed"); });
    expect(() => worker.bos.unbind(10, 1, 0, 4096)).toThrow(/could not be published: copy failed/);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    await Promise.resolve();
    expect(onKernelFatal).toHaveBeenCalledOnce();
    expect(onKernelFatal.mock.calls[0][0].message)
      .toMatch(/GBM BO 1: the final writeback of pid 10's unmapped range 0x0\+4096 could not be published: copy failed/);
  });
});
