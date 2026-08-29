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
