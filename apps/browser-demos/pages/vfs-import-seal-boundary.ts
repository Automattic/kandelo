import { BrowserKernel } from "../../../host/src/browser-kernel-host";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { ensureImageWriterInstalled } from "../lib/kernel-owned-boot";

/**
 * Exercise the real BrowserKernel -> worker init path with explicit bytes.
 * BrowserKernel loads its default artifacts only when a caller requests them,
 * so this boundary proof does not depend on unrelated demo binaries.
 *
 * WHAT THIS PROVES, and it is narrower than its old name suggested: a rejected
 * image leaves no kernel worker alive. It never proved that the rejection
 * PRECEDED a worker — nothing on the main thread inspects the image, and the
 * check that rejected it ran inside the worker. What made the assertion pass
 * is `bootWorker`'s catch, which tears down its half-created worker before
 * rethrowing.
 *
 * The image is one the KERNEL refuses, because the kernel is what judges an
 * image now. It declares a kernel ABI it was not built for — a stale or
 * foreign artifact, which `image_policy::check_declared_abi` refuses with
 * EPROTO. The cohort-seal refusal it used to use is asserted in
 * `runtime-core`, on a genuine exported container, because the producer
 * refuses to emit a forged one and TypeScript therefore cannot build it.
 */
export async function rejectRefusedImageAtBrowserWorkerInit(
  declaredAbi: number,
): Promise<{ error: string; workerStartedAfterRejection: boolean }> {
  // `KandeloImageFs.create()` is synchronous and a fetch is not, so a browser
  // page installs the image-writer module bytes once before the first create.
  // Node reads them off disk; the browser cannot, and the bridge says so by
  // name rather than falling back to a reader that cannot see an `SDEF`
  // section — which is what defect B45 was.
  await ensureImageWriterInstalled();
  const fs = KandeloImageFs.create();
  fs.mkdir("/etc", 0o755);
  fs.writeFile("/etc/hostname", new TextEncoder().encode("kandelo\n"), 0o644);
  const image = await fs.saveImage({
    metadata: { version: 1, kernelAbi: declaredAbi },
  });
  // A REAL KERNEL, and that is the visible half of the inversion. This used to
  // pass `new ArrayBuffer(0)` deliberately, because the host authenticated the
  // image before a kernel was ever compiled. The kernel judges the image now,
  // so it has to exist to do it — the ordering "authenticate before compiling"
  // is retired, and the ordering that replaces it puts the hardened Rust
  // loader, rather than a TypeScript filesystem, in front of untrusted bytes.
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
