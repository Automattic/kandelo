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
 * at all.
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
 * An image records one URI per resource. Native metadata supplies transfer
 * bounds so the fetcher can stop oversized responses before retaining them.
 * Rust verifies content length and digest when materializing; its rejection
 * notification discards only that completed transport entry. A later explicit
 * read may fetch again. The host supplies no second filesystem or digest policy.
 */

import type { LazyDownloadEvent } from "./lazy-download-event";
import type { DeferredByteProgress } from "./lazy-fetch-bytes";

const EAGAIN = -11;
const EIO = -5;
const ENOENT = -2;
const ENOSYS = -38;

// The in-kernel rootfs overlay needs no filesystem from the host: the kernel
// owns materialization and this module only fetches URLs, so nothing here pulls
// bytes THROUGH a filesystem that tracks whether they have arrived.
//
// `RootfsOverlayBaseImage` and `DeferredBody`, which describe what a reader can
// ask an IMAGE about the bodies it does not carry, live in
// `images/vfs/lib/module-base-image.ts`. The runtime asks none of that — the
// kernel names an address and this module fetches it — so the shapes live
// beside the build-time reader that uses them.

/**
 * Serve container-offset reads straight from the container bytes.
 *
 * The only reader left, and the simplest one it could be: a caller holding
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
 * point of the kernel relaying the image's URI, and a table in front of the
 * pipe would be a place for a second opinion to live.
 *
 * `fetcher` is the exact transport already wired for lazy assets (closed-asset
 * fetcher, CORS-proxy fetcher, etc.); this module never invents its own. A
 * deployment that serves an image's addresses from hashed paths maps them
 * THERE, in the fetcher, which is where `imageOwnedRuntimeUrlTable` already
 * does it.
 *
 * A fetch in flight is `EAGAIN` — the same answer the kernel's own byte source
 * gives, and the guest retry loop is already built for it. The fetcher applies bounded retries for transient transport failures.
 * Once those attempts are exhausted, this pipe retains `EIO`; retrying a
 * failed guest read never starts an unbounded new fetch.
 */
export function buildRootfsLazyWiring(
  fetcher: (url: string, onProgress?: DeferredByteProgress) => Promise<Uint8Array>,
  onProgress?: DeferredProgress,
): {
  deferredProvider: (
    uri: string,
    offset: bigint,
    dest: Uint8Array,
  ) => number;
  /**
   * A promise that settles the next time a fetch in flight settles, or `null`
   * when none is in flight. See {@link DeferredFetchSettled}.
   */
  whenFetchSettles: DeferredFetchSettled;
  discardDeferred: (uri: string) => void;
} {
  type Slot =
    | { state: "pending" }
    | { state: "ready"; bytes: Uint8Array }
    | { state: "failed" };
  const slots = new Map<string, Slot>();
  // One promise per fetch in flight, removed once its slot has left
  // `pending`. Each resolves only after the slot is updated, so a reader that
  // awaited it and retries sees the new state rather than EAGAIN again.
  const inFlight = new Map<string, Promise<void>>();
  const whenFetchSettles: DeferredFetchSettled = () =>
    inFlight.size === 0 ? null : Promise.race(inFlight.values());

  const deferredProvider = (
    uri: string,
    offset: bigint,
    dest: Uint8Array,
  ): number => {
    // An empty address is the kernel telling us the image declared none. There
    // is no table to guess from, and guessing would make the host a second
    // author of where bytes live, so it is a refusal rather than a lookup.
    if (uri === "") return EIO;

    const slot = slots.get(uri);
    if (slot === undefined) {
      slots.set(uri, { state: "pending" });
      const base = {
        id: uri,
        // ONE KIND, because the pipe cannot tell and will not guess. What
        // reaches this function is an address and nothing else:
        // `host_fetch_deferred(uri, offset, dest)` carries no kind, and the
        // kernel that knows does not send one.
        //
        // The field stays because `LazyDownloadEvent` is a shared protocol the
        // session library (`web-libs/kandelo-session`) consumes; whether it
        // should carry a kind at all is an open question for that library.
        // Its one consumer, `lazyDownloadAssetLabel`, already ends at the URL
        // for both values, because the host has no path to offer either.
        kind: "file" as const,
        url: uri,
      };
      report(onProgress, { ...base, status: "started", loadedBytes: 0 });
      const settled = fetchDeferred(uri, fetcher, (loadedBytes, totalBytes) => {
        report(onProgress, { ...base, status: "progress", loadedBytes, totalBytes });
      }).then((bytes) => {
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
      }).finally(() => {
        inFlight.delete(uri);
      });
      inFlight.set(uri, settled);
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

  const discardDeferred = (uri: string): void => {
    // Only native validation can reject a completed transfer. Pending and
    // terminal transport failures retain their original bounded policy.
    if (slots.get(uri)?.state === "ready") slots.delete(uri);
  };
  return { deferredProvider, whenFetchSettles, discardDeferred };
}

/**
 * The next settlement of a deferred fetch in flight, or `null` when nothing is
 * in flight.
 *
 * WHY this exists: a host-side reader that gets `EAGAIN` from a deferred file
 * must wait for the fetch and read again. Waiting on a fixed timer instead
 * charged every first read of a lazy file up to one whole timer period after
 * its bytes had already arrived — on the browser that was ~10 ms added to the
 * first spawn of a lazy program, the cost the kernel-owned `/` introduced over
 * the TypeScript filesystem, which awaited the fetch directly.
 */
export type DeferredFetchSettled = () => Promise<void> | null;

/**
 * Wait until `settled` (a {@link DeferredFetchSettled} result) settles, but no
 * longer than `maxMs`.
 *
 * With nothing in flight there is nothing to wait FOR — an `EAGAIN` then came
 * from somewhere other than this pipe — so the wait is the plain `maxMs`
 * timer, which keeps the caller's retry loop yielding to the event loop
 * rather than spinning on microtasks. With a fetch in flight the timer still
 * bounds the wait, so a fetch that never settles cannot outlast the caller's
 * own deadline.
 */
export async function waitForDeferredFetch(
  settled: Promise<void> | null,
  maxMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, maxMs));
  });
  try {
    await (settled === null ? elapsed : Promise.race([settled, elapsed]));
  } finally {
    clearTimeout(timer);
  }
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
  fetcher: (url: string, onProgress?: DeferredByteProgress) => Promise<Uint8Array>,
  onProgress: DeferredByteProgress,
): Promise<Uint8Array | undefined> {
  try {
    return await fetcher(uri, onProgress);
  } catch {
    return undefined;
  }
}
