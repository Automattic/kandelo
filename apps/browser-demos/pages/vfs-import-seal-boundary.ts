import { BrowserKernel } from "../../../host/src/browser-kernel-host";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { ensureImageWriterInstalled } from "../lib/kernel-owned-boot";

/**
 * Exercise the real BrowserKernel -> worker init path with explicit bytes.
 * BrowserKernel loads its default artifacts only when a caller requests them,
 * so this boundary proof does not depend on unrelated demo binaries.
 *
 * WHAT THIS PROVES: a rejected image leaves no kernel worker alive. It does
 * not prove that the rejection PRECEDED a worker — nothing on the main thread
 * inspects the image, and the check that rejects it runs inside the worker.
 * What makes the assertion pass is `bootWorker`'s catch, which tears down its
 * half-created worker before rethrowing.
 *
 * The image is one the KERNEL refuses, because the kernel is what judges an
 * image. It declares a kernel ABI it was not built for — a stale or
 * foreign artifact, which `image_policy::check_declared_abi` refuses with
 * EPROTO. Forged cohort seals are refused by the same loader and asserted in
 * `runtime-core` on a genuine exported container, because the image writer
 * refuses to emit a forged seal and TypeScript therefore cannot build one.
 */
export async function rejectRefusedImageAtBrowserWorkerInit(
  declaredAbi: number,
): Promise<{ error: string; workerStartedAfterRejection: boolean }> {
  // `KandeloImageFs.create()` is synchronous and a fetch is not, so a browser
  // page installs the image-writer module bytes once before the first create.
  // Node reads them off disk; the browser cannot.
  await ensureImageWriterInstalled();
  const fs = KandeloImageFs.create();
  fs.mkdir("/etc", 0o755);
  fs.writeFile("/etc/hostname", new TextEncoder().encode("kandelo\n"), 0o644);
  const image = await fs.saveImage({
    metadata: { version: 1, kernelAbi: declaredAbi },
  });
  // A REAL KERNEL: the kernel judges the image, so it has to exist to do it.
  // That puts the Rust image loader, rather than host code, in front of
  // untrusted image bytes.
  const kernel = new BrowserKernel({ kernelOwnedFs: true });
  try {
    await kernel.initFromImage({ vfsImage: image });
    throw new Error("refused VFS image unexpectedly passed browser worker init");
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
