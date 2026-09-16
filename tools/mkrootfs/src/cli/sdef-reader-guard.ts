import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";

/**
 * Refuse an image whose deferred files this tool cannot see.
 *
 * `MemoryFileSystem` reads `KLZY`; the builder writes `SDEF`. A memfs reader
 * handed an SDEF image finds NO deferred files and reports each one as a
 * zero-length ordinary file — which `inspect` would print, `extract` would
 * write to disk, and `add` would save back, silently turning a rootfs full of
 * lazy binaries into an image with none.
 *
 * So the truth is read with the reader that knows, and the two are compared.
 * Refusing is the whole point: a wrong answer here is indistinguishable from a
 * right one, and the shapes this catches are exactly the shapes nobody would
 * check by eye.
 *
 * It also closes a vacuous check. These verbs call
 * `verifyImportedLazyAtomicGroupSeals` first, and on an SDEF image that reader
 * finds no lazy archives — so the seal verification passes by having nothing to
 * verify. A security check that succeeds because it looked at an empty list is
 * worse than one that is absent, because it reads as evidence.
 *
 * This is a boundary, not a fix. The fix is for these verbs to read with
 * `KandeloImageFs` throughout — blocked because the seal verification they
 * perform has no module entry point, and adding one breaches
 * `sffsModuleEntryPoints` (ceiling 22, slack 0).
 */
export function refuseImageThisReaderCannotSee(
  bytes: Uint8Array,
  mfs: { exportLazyEntries(): readonly unknown[] },
): void {
  const seenByThisReader = mfs.exportLazyEntries().length;
  if (seenByThisReader > 0) return;
  const truth = KandeloImageFs.create();
  truth.loadImage(bytes);
  const actual = truth.lazyEntries().files.length;
  if (actual === 0) return;
  throw new Error(
    `this image describes ${actual} deferred file(s) in a section this reader does not ` +
      "understand (SDEF), so every one of them would be reported as an empty ordinary " +
      "file. Refusing rather than answering wrongly.",
  );
}
