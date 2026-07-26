import { BrowserKernel } from "../../../host/src/browser-kernel-host";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
  type LazyAtomicSealForgery,
} from "../../../host/test/lazy-atomic-seal-fixture";

/**
 * Exercise the real BrowserKernel → worker init path with explicit bytes.
 * BrowserKernel loads its default artifacts only when a caller requests them,
 * so this boundary proof does not depend on unrelated demo binaries.
 */
export async function rejectForgedImageAtBrowserWorkerInit(
  forgery: LazyAtomicSealForgery,
): Promise<{ error: string; workerStartedAfterRejection: boolean }> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  await addSealedLazyAtomicTestTree(fs, {
    groupId: `browser-init:${forgery}`,
    member: forgery,
    root: `/sealed-${forgery}`,
  });
  const image = forgeLazyAtomicSeal(await fs.saveImage(), forgery);
  const kernel = new BrowserKernel({ kernelOwnedFs: true });
  try {
    await kernel.initFromImage({
      kernelWasm: new ArrayBuffer(0),
      vfsImage: image,
    });
    throw new Error("forged VFS image unexpectedly passed browser worker init");
  } catch (cause) {
    return {
      error: cause instanceof Error ? cause.message : String(cause),
      workerStartedAfterRejection: (
        kernel as unknown as { workerStarted: boolean }
      ).workerStarted,
    };
  } finally {
    await kernel.destroy();
  }
}
