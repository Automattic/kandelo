/**
 * Probe for the single-writer OPFS workspace boundary: while one kernel
 * holds a workspace, a second kernel booting the same workspace on the
 * same origin must fail loudly instead of racing its writes.
 *
 * Imported by apps/browser-demos/test/opfs-mount-boot.spec.ts via a page
 * module URL; runs entirely in the page realm.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import {
  createBuildFsWithEtc,
  finalizeKernelOwnedImage,
} from "../../lib/kernel-owned-boot";
import kernelWasmUrl from "@kernel-wasm?url";

async function buildMinimalImage(): Promise<Uint8Array> {
  // The lock probe never spawns a process, so an /etc-only image suffices.
  const buildFs = await createBuildFsWithEtc();
  return finalizeKernelOwnedImage(buildFs);
}

export async function probeWorkspaceLockConflict(
  workspace: string,
): Promise<{ firstBooted: boolean; secondError: string }> {
  const kernelWasm = await fetch(kernelWasmUrl).then((r) => r.arrayBuffer());
  const holder = new BrowserKernel({ kernelOwnedFs: true });
  let firstBooted = false;
  let secondError = "";
  try {
    await holder.initFromImage({
      kernelWasm,
      vfsImage: await buildMinimalImage(),
      opfsMounts: [{ path: "/persist", name: workspace }],
    });
    firstBooted = true;

    const contender = new BrowserKernel({ kernelOwnedFs: true });
    try {
      await contender.initFromImage({
        kernelWasm,
        vfsImage: await buildMinimalImage(),
        opfsMounts: [{ path: "/persist", name: workspace }],
      });
    } catch (error) {
      secondError = error instanceof Error ? error.message : String(error);
    } finally {
      await contender.destroy();
    }
  } finally {
    await holder.destroy();
  }
  return { firstBooted, secondError };
}

/**
 * Probe for request validation ahead of lock acquisition: two entries that
 * share a mount path must be rejected before any workspace lock is taken or
 * any proxy worker is started, so a retry with one of those workspaces boots.
 */
export async function probeDuplicateMountPath(
  workspace: string,
): Promise<{ duplicateError: string; lockHeldAfterFailure: boolean; retryBooted: boolean }> {
  const kernelWasm = await fetch(kernelWasmUrl).then((r) => r.arrayBuffer());
  const first = `${workspace}-a`;
  const second = `${workspace}-b`;
  let duplicateError = "";
  const rejected = new BrowserKernel({ kernelOwnedFs: true });
  try {
    await rejected.initFromImage({
      kernelWasm,
      vfsImage: await buildMinimalImage(),
      opfsMounts: [
        { path: "/persist", name: first },
        { path: "/persist", name: second },
      ],
    });
  } catch (error) {
    duplicateError = error instanceof Error ? error.message : String(error);
  } finally {
    await rejected.destroy();
  }

  const held = await navigator.locks.query();
  const lockHeldAfterFailure = (held.held ?? []).some((lock) =>
    lock.name === `kandelo-opfs-workspace:${first}`
    || lock.name === `kandelo-opfs-workspace:${second}`
  );

  let retryBooted = false;
  const retry = new BrowserKernel({ kernelOwnedFs: true });
  try {
    await retry.initFromImage({
      kernelWasm,
      vfsImage: await buildMinimalImage(),
      opfsMounts: [{ path: "/persist", name: first }],
    });
    retryBooted = true;
  } finally {
    await retry.destroy();
  }
  return { duplicateError, lockHeldAfterFailure, retryBooted };
}
