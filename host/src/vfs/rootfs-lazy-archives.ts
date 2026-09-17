/**
 * The host's whole remaining byte job for the kernel-owned `/`: serve the
 * resources the `/` image does NOT carry.
 *
 * The kernel owns the `/` tree and reads an image-backed file's content out of
 * the image itself, through its own KIFS reader. What is left over is one
 * shape — fetch from a host transport, serve positioned bytes, report `EAGAIN`
 * while the fetch is in flight — behind one import,
 * `host_fetch_deferred(uri, offset, dest)`.
 *
 * # One address, no kinds
 *
 * There used to be two kinds of deferred resource here, a URL-backed lazy file
 * addressed by its INODE and a lazy archive addressed by its image-assigned
 * ARCHIVE ID, and this module's real content was the two tables that turned
 * those numbers back into URLs. Those tables were a second author for where a
 * file's bytes live, with the image as the first: the image said a file was
 * deferred, and the host said where it actually came from. Nothing made the two
 * agree, and when they disagreed the kernel fetched bytes the image never
 * described — or, for an SDEF image, found an EMPTY table and fetched nothing
 * at all, which is defect B43.
 *
 * A URI is a complete address, so the tables have no identity left to hold. The
 * kernel reads the address the image recorded and hands it over; this module
 * fetches it. A base file's blob and a lazy archive's raw bytes stop being
 * different requests, and the `kind` discriminator that distinguished them has
 * nothing left to discriminate.
 *
 * # What the host still decides, which is less than it looks
 *
 * How to fetch an address is the host's business — its fetcher may go through
 * a CORS proxy, a closed asset store, or a deployment's hashed paths. WHICH
 * address to fetch is not, and for a while a table here held both: alternate
 * URLs for an address, and a declared length to judge a mirror's answer by.
 *
 * Both are gone as of 2026-09-17, because neither had a producer. An image
 * records ONE uri per archive, so there are no alternates to list; and the
 * kernel checks the fetched bytes against the image's DIGEST when it
 * materializes them, which is the check that decides — a length is a hint that
 * happens to be cheap. What is left is a pipe, and a pipe with no table in
 * front of it has nowhere for a second opinion about identity to live.
 */

import type { LazyDownloadEvent } from "./lazy-download-event";

/** Total byte size of a lazy archive, recorded in the trailing archive table
 * so the kernel can validate/plan reads before the archive is fetched. */
export interface RootfsLazyArchive {
  readonly archiveId: number;
  readonly size: number | bigint;
}

const EAGAIN = -11;
const EIO = -5;
const ENOENT = -2;
const ENOSYS = -38;

/**
 * What the in-kernel rootfs overlay needs from the host's `/` image.
 *
 * `configureRootfsOverlayFromImage` was typed against `MemoryFileSystem`, the
 * 8,000-line class lane V is retiring. It once asked for six methods; it now
 * asks for TWO, and the four that went are the point of the pipe. The overlay
 * used to need `open`/`read`/`close` so it could pull bytes THROUGH a
 * filesystem that tracked whether they had arrived. It no longer does: the
 * pipe fetches a URL and the kernel owns materialization, so nothing behind
 * this interface has to be a filesystem at all. What is left is metadata the
 * image declared.
 */
// `RootfsOverlayBaseImage` AND `DeferredBody` MOVED OUT, 2026-09-17, to
// `images/vfs/lib/module-base-image.ts`. They described what a reader can ask
// an IMAGE about the bodies it does not carry, and the host asked none of it
// once the transport table went: the kernel names an address and this module
// fetches it. Their one remaining reader is the Pages asset closure, a build
// script — so the shapes live beside the reader that answers them rather than
// in the runtime that no longer asks.

/**
 * Serve container-offset reads straight from the container bytes.
 *
 * The peer of {@link imageReadFromBody}, and the simpler one: a caller holding
 * the whole container answers in container coordinates without subtracting
 * anything. Both worker entries already hold those bytes — they are what the
 * kernel is handed as `imageBytes` — so nothing has to be a filesystem for the
 * overlay to read its own image.
 */
export function imageReadFromContainer(
  container: Uint8Array,
): (at: number, dest: Uint8Array) => number {
  return (at, dest) => {
    if (!Number.isSafeInteger(at) || at < 0) return EIO;
    if (at >= container.byteLength) return 0; // end of image
    const n = Math.min(dest.byteLength, container.byteLength - at);
    dest.set(container.subarray(at, at + n));
    return n;
  };
}

/** Fetch bytes for a URL. The whole of what a dumb pipe needs to be able to do. */
export type DeferredUrlFetch = (url: string) => Promise<Uint8Array>;

/**
 * Report transfer progress.
 *
 * Progress belongs to the pipe and not to the kernel, and the distinction is
 * worth stating because it is easy to collapse: how many bytes have ARRIVED is
 * a property of the fetch, which is the host's job. Whether a file is
 * MATERIALIZED is a property of the filesystem, which is the kernel's. Moving
 * status to the kernel does not mean going silent about the transfer.
 */
export type DeferredProgress = (event: LazyDownloadEvent) => void;

function report(
  onProgress: DeferredProgress | undefined,
  event: Omit<LazyDownloadEvent, "t">,
): void {
  if (onProgress === undefined) return;
  try {
    onProgress({ ...event, t: Date.now() });
  } catch {
    // A listener must never break byte resolution.
  }
}

/**
 * Build the `host_fetch_deferred` provider: fetch a URI, cache it, serve
 * positioned bytes of it.
 *
 * # A DUMB PIPE, and the table that used to sit in front of it
 *
 * This took a list of archives and built transport POLICY from it — which
 * alternate URLs may stand in for an address, and what length a mirror's
 * answer had to have to be believed. **Both halves had no producer left.** A
 * module-written image records ONE uri per archive, so there are no alternates
 * to list; and the length check was a weaker duplicate of the digest the
 * kernel verifies on materialization, which is the check that actually decides
 * whether the bytes are the right ones.
 *
 * So the pipe is what the name says: the kernel names an address, this fetches
 * it, caches it, and serves positioned bytes. It holds no opinion about which
 * resource an address names, because an address IS the identity — that is the
 * whole of what the URI relay bought, and a table in front of the pipe was the
 * last place a second opinion could live.
 *
 * `fetcher` is the exact transport already wired for lazy assets (closed-asset
 * fetcher, CORS-proxy fetcher, etc.); this module never invents its own. A
 * deployment that serves an image's addresses from hashed paths maps them
 * THERE, in the fetcher, which is where `imageOwnedRuntimeUrlTable` already
 * does it.
 *
 * A fetch in flight is `EAGAIN` — the same answer the kernel's own byte source
 * gives, and the guest retry loop is already built for it. A failed fetch is
 * `EIO` once and stays failed, because a pipe that silently retries forever is
 * a hang rather than a failure.
 */
export function buildRootfsLazyWiring(
  fetcher: (url: string) => Promise<Uint8Array>,
  onProgress?: DeferredProgress,
): {
  deferredProvider: (
    uri: string,
    offset: bigint,
    dest: Uint8Array,
  ) => number;
} {
  type Slot =
    | { state: "pending" }
    | { state: "ready"; bytes: Uint8Array }
    | { state: "failed" };
  const slots = new Map<string, Slot>();

  const deferredProvider = (
    uri: string,
    offset: bigint,
    dest: Uint8Array,
  ): number => {
    // An empty address is the kernel telling us the image declared none. There
    // is no table left to guess from, and guessing is what this change exists
    // to remove, so it is a refusal rather than a lookup.
    if (uri === "") return EIO;

    const slot = slots.get(uri);
    if (slot === undefined) {
      slots.set(uri, { state: "pending" });
      const base = {
        id: uri,
        // ONE KIND, because the pipe cannot tell and will not guess. It used to
        // read `"archive"` out of transport-table membership, which was a
        // second opinion about identity dressed as a fact — and the table is
        // gone. What reaches this function is an address and nothing else:
        // `host_fetch_deferred(uri, offset, dest)` carries no kind, and the
        // kernel that knows does not send one.
        //
        // The field stays because `LazyDownloadEvent` is a shared protocol the
        // session library consumes; whether it should carry a kind at all is a
        // protocol question for that library's owner, filed in the master plan.
        // Its one consumer, `lazyDownloadAssetLabel`, already ends at the URL
        // for both values, because the host has no path to offer either.
        kind: "file" as const,
        url: uri,
      };
      report(onProgress, { ...base, status: "started", loadedBytes: 0 });
      void fetchDeferred(uri, fetcher).then((bytes) => {
        if (bytes === undefined) {
          slots.set(uri, { state: "failed" });
          report(onProgress, {
            ...base,
            status: "error",
            loadedBytes: 0,
            error: `fetching ${uri} did not return usable bytes`,
          });
          return;
        }
        slots.set(uri, { state: "ready", bytes });
        report(onProgress, {
          ...base,
          status: "complete",
          loadedBytes: bytes.byteLength,
        });
      });
      return EAGAIN;
    }
    if (slot.state === "pending") return EAGAIN;
    if (slot.state === "failed") return EIO;

    const at = Number(offset);
    if (!Number.isSafeInteger(at) || at < 0) return EIO;
    if (at >= slot.bytes.byteLength) return 0; // end of resource
    const n = Math.min(dest.byteLength, slot.bytes.byteLength - at);
    dest.set(slot.bytes.subarray(at, at + n));
    return n;
  };

  return { deferredProvider };
}

/**
 * Fetch the address, and return nothing if it does not answer.
 *
 * ONE ADDRESS, NO ALTERNATES. This walked a transport list and compared each
 * answer's length against a declared size, trying the next on a mismatch.
 * Neither half has a producer: an image records one uri per archive, and the
 * bytes are checked against the image's DIGEST by the kernel when it
 * materializes them — which is a real check, where a length is only a hint
 * that happens to be cheap.
 */
async function fetchDeferred(
  uri: string,
  fetcher: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  try {
    return await fetcher(uri);
  } catch {
    return undefined;
  }
}
