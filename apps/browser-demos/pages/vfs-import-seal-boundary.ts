import { BrowserKernel } from "../../../host/src/browser-kernel-host";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
  type LazyAtomicSealForgery,
} from "../../../host/test/lazy-atomic-seal-fixture";

/**
 * Exercise the real BrowserKernel worker boundary without requiring a built
 * kernel artifact. A forged rootfs must fail before the intentionally invalid
 * kernel bytes are compiled.
 */
export async function rejectForgedImageBeforeBrowserReady(
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
  let error = "";
  try {
    await kernel.initFromImage({
      kernelWasm: new ArrayBuffer(0),
      vfsImage: image,
    });
    throw new Error("forged VFS image unexpectedly reached browser ready");
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    return {
      error,
      workerStartedAfterRejection: (
        kernel as unknown as { workerStarted: boolean }
      ).workerStarted,
    };
  } finally {
    await kernel.destroy();
  }
}
