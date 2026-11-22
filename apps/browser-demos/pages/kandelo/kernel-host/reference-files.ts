import type { KernelLike, ReferenceVfsReader } from "../../../../../web-libs/kandelo-session/src/kernel-host";

/** Own a temporary, unstarted reference machine through its normal host API. */
export async function openReferenceFiles<Kernel extends Pick<KernelLike, "readDirFromVfs" | "readFileRangeFromVfs"> & { destroy(): Promise<void>; hasUnconfirmedKernelQuiescence?(): boolean }>(
  create: () => Kernel,
  initialize: (kernel: Kernel) => Promise<void>,
  signal: AbortSignal,
  assertCurrent: () => void,
  releaseSource: () => Promise<void>,
): Promise<ReferenceVfsReader> {
  let kernel: Kernel;
  try { kernel = create(); }
  catch (error) { await releaseSource(); throw error; }
  let disposed = false;
  let closing: Promise<void> | undefined;
  let initializing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    disposed = true;
    signal.removeEventListener("abort", abort);
    closing = (async () => {
      // Source handles can only be removed after the reference worker releases
      // them. Keep destruction and source cleanup ordered on every exit path.
      await initializing?.catch(() => {});
      await kernel.destroy();
      if (kernel.hasUnconfirmedKernelQuiescence?.()) throw new Error("Reference worker shutdown is unconfirmed; its staged source has been retained.");
      await releaseSource();
    })();
    return closing;
  };
  const check = () => {
    signal.throwIfAborted();
    assertCurrent();
    if (disposed) throw new Error("Reference reader is closed");
  };
  const abort = () => { void dispose().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    initializing = initialize(kernel);
    await initializing;
    check();
    if (!kernel.readDirFromVfs || !kernel.readFileRangeFromVfs) throw new Error("Reference image cannot be read");
    return {
      readDir: async path => {
        check();
        const result = await kernel.readDirFromVfs!(path);
        check();
        return result;
      },
      readRange: async (path, offset, length) => {
        check();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 262144) throw new Error("Invalid reference read range");
        const result = await kernel.readFileRangeFromVfs!(path, offset, length);
        check();
        if (result && result.length > length) throw new Error("Reference read exceeded its requested size");
        return result;
      },
      dispose,
    };
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Reference image read and cleanup failed"); }
    throw error;
  }
}
