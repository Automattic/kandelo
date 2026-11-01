/*
 * The kernel retires DRI/GL objects at close, munmap, exit and RMFB, then asks
 * the host to release the host-side state. Each cleanup import answers with
 * its real outcome (wasm_posix_shared::dri_cleanup_status) so the kernel can
 * record a refusal or a lost writeback instead of counting it as success.
 */
import { describe, expect, it, vi } from "vitest";

import { createWasmPosixKernelTestHarness, WasmPosixKernel } from "../src/kernel";
import { DRI_CLEANUP_COMPLETE, DRI_CLEANUP_HOST_RETAINED } from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const EIO = -5;
const EBUSY = -16;
const EINVAL = -22;

function harness() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const onHostDiagnostic = vi.fn();
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: { onHostDiagnostic } as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  }) as WasmPosixKernel & Record<string, any>;
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  return { kernel, env: imports.env, onHostDiagnostic };
}

const bo = (pid: number, bo_id: number) =>
  ({ pid, bo_id, size: 4096, w: 16, h: 16, stride: 64 });

describe("host_gbm_bo_destroy", () => {
  it("reports completion once the BO and its native views are gone", () => {
    const { kernel, env } = harness();
    kernel.bos.create(bo(10, 1));
    expect(env.host_gbm_bo_destroy(10, 1)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.bos.get(10, 1)).toBeUndefined();
    // An already-destroyed BO has nothing left to free.
    expect(env.host_gbm_bo_destroy(10, 1)).toBe(DRI_CLEANUP_COMPLETE);
  });

  it("reports host retention while native views stay journaled for retry", () => {
    const { kernel, env } = harness();
    kernel.bos.create(bo(10, 1));
    vi.spyOn(kernel.gl, "dropForeignTexturesForBo").mockReturnValue(false);
    expect(env.host_gbm_bo_destroy(10, 1)).toBe(DRI_CLEANUP_HOST_RETAINED);
    expect(kernel.gl.hasForeignRetirements()).toBe(true);
  });

  it("runs every step after a fault and reports the refusal", () => {
    const { kernel, env, onHostDiagnostic } = harness();
    kernel.bos.create(bo(10, 1));
    vi.spyOn(kernel.kms, "retireCursorBo").mockImplementation(() => { throw new Error("cursor fault"); });
    const retire = vi.spyOn(kernel.gl, "retireForeignBo");
    expect(env.host_gbm_bo_destroy(10, 1)).toBe(EIO);
    expect(kernel.bos.get(10, 1)).toBeUndefined();
    expect(retire).toHaveBeenCalledWith(1);
    expect(onHostDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      pid: 10, source: "DRI cleanup", message: "GBM BO 1 destroy: cursor fault" }));
  });
});

describe("host_gbm_bo_unbind", () => {
  it("reports completion when the unmapped range detaches", () => {
    const { kernel, env } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    expect(env.host_gbm_bo_unbind(10, 1, 0, 4096)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.bos.get(10, 1)?.binding).toBeNull();
  });

  it("reports EIO when the range detached but its final writeback was lost", () => {
    const { kernel, env } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    vi.spyOn(kernel.bos as any, "flushMemoryToSab").mockReturnValue(false);
    expect(env.host_gbm_bo_unbind(10, 1, 0, 4096)).toBe(EIO);
    expect(kernel.bos.get(10, 1)?.binding).toBeNull();
    expect(kernel.bos.publicationLost(1)).toHaveLength(1);
  });

  it("reports EBUSY, not success, when the binding could not detach", () => {
    const { kernel, env } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    (kernel.bos as any).mutating = true;
    expect(env.host_gbm_bo_unbind(10, 1, 0, 4096)).toBe(EBUSY);
    (kernel.bos as any).mutating = false;
    expect(kernel.bos.get(10, 1)?.binding).toEqual({ addr: 0, len: 4096 });
  });

  it("reports EBUSY when staging faults before the detach commits", () => {
    const { kernel, env } = harness();
    kernel.bos.create(bo(10, 1));
    expect(kernel.bos.bind(10, 1, 0, 4096)).toBe(0);
    vi.spyOn(kernel.bos as any, "stageLineages").mockImplementation(() => { throw new Error("staging fault"); });
    expect(env.host_gbm_bo_unbind(10, 1, 0, 4096)).toBe(EBUSY);
    expect(kernel.bos.get(10, 1)?.binding).toEqual({ addr: 0, len: 4096 });
  });
});

describe("host_gl_unbind", () => {
  it("reports completion with no live session", () => {
    const { env } = harness();
    expect(env.host_gl_unbind(7, 11)).toBe(DRI_CLEANUP_COMPLETE);
  });

  it("reports host retention when accepted execution keeps the context's native objects", () => {
    const { kernel, env } = harness();
    vi.spyOn(kernel.gl, "unbind").mockReturnValue(false);
    expect(env.host_gl_unbind(7, 11)).toBe(DRI_CLEANUP_HOST_RETAINED);
  });

  it("still retires the session after an earlier step faults, and reports EIO", () => {
    const { kernel, env, onHostDiagnostic } = harness();
    kernel.gl.bind({ pid: 7, sessionId: 11, displayFileId: 1n, cmdbufAddr: 0, cmdbufLen: 4096 });
    vi.spyOn(kernel as any, "releaseClaimedKmsCanvas").mockImplementation(() => { throw new Error("canvas fault"); });
    expect(env.host_gl_unbind(7, 11)).toBe(EIO);
    expect(kernel.gl.get(7, 11)).toBeUndefined();
    expect(onHostDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      pid: 7, source: "DRI cleanup", message: "GL session 11 unbind: canvas fault" }));
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
    const { kernel, env } = harness();
    kernel.kms.setMaster(10, 1n, 1n);
    kernel.kms.setMaster(10, 1n, 2n);
    expect(env.host_kms_drop_master(10, 1n, 1n)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.kms.getMasterLeaseId()).toBe(2n);
    expect(env.host_kms_drop_master(10, 1n, 2n)).toBe(DRI_CLEANUP_COMPLETE);
    expect(kernel.kms.getMasterFileId()).toBeNull();
  });

  it("drop_master refuses an identity the kernel never issues", () => {
    const { env } = harness();
    expect(env.host_kms_drop_master(10, 0n, 1n)).toBe(EINVAL);
  });
});
