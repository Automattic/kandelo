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
 * # What the host still decides
 *
 * How to fetch an address is still the host's business, and that is the one
 * table that survives: a URI may have alternate transports (a CORS proxy, a
 * mirror) and a declared length to sanity-check a mirror against. That is
 * transport POLICY, not identity — it never decides WHICH resource is being
 * read, only how to go and get the one the kernel named. An address with no
 * policy entry is fetched directly, which is the courier contract working
 * rather than a gap in a table.
 */

import { reduceLazyArchiveGroups } from "./kernel-lazy-section";
import type {
  LazyFileEntry,
  SerializedLazyArchiveEntry,
} from "./memory-fs";
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
export interface RootfsOverlayBaseImage {
  exportLazyEntries(): LazyFileEntry[];
  exportLazyArchiveEntries(): SerializedLazyArchiveEntry[];
  // NOT `imageBodyBytes()`. A backend holding the whole CONTAINER cannot
  // answer that — it would be off by the header and carry the trailing
  // sections — so the reader is supplied alongside this by whoever knows which
  // backend they have.
}

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
 * `entries` is not an identity table. It is read once for transport POLICY —
 * which alternate URLs may stand in for an address, and what length a mirror's
 * answer must have to be believed — keyed by the address the image recorded.
 * An address absent from it is fetched directly.
 *
 * `fetcher` is the exact transport already wired for lazy assets (closed-asset
 * fetcher, CORS-proxy fetcher, etc.); this module never invents its own.
 *
 * A fetch in flight is `EAGAIN` — the same answer the kernel's own byte source
 * gives, and the guest retry loop is already built for it. A failed fetch is
 * `EIO` once and stays failed, because a pipe that silently retries forever is
 * a hang rather than a failure.
 */
export function buildRootfsLazyWiring(
  entries: SerializedLazyArchiveEntry[],
  fetcher: (url: string) => Promise<Uint8Array>,
  onProgress?: DeferredProgress,
): {
  deferredProvider: (
    uri: string,
    offset: bigint,
    dest: Uint8Array,
  ) => number;
} {
  // Transport policy, keyed by ADDRESS. Built from the archive groups because
  // they are the only deferred resources that carry alternates today; a lazy
  // file has one URL and needs no entry.
  const policy = new Map<string, { transports: string[]; size: number }>();
  for (const group of reduceLazyArchiveGroups(entries)) {
    const [address] = group.transports;
    if (address === undefined) continue;
    policy.set(address, {
      transports: group.transports,
      size: group.archiveBytes,
    });
  }

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
      const known = policy.get(uri);
      slots.set(uri, { state: "pending" });
      const base = {
        id: uri,
        // Policy entries exist only for archives, so this reports what the
        // host actually knows rather than a kind it would have to invent.
        kind: (known === undefined ? "file" : "archive") as "file" | "archive",
        url: uri,
        totalBytes: known?.size,
      };
      report(onProgress, { ...base, status: "started", loadedBytes: 0 });
      void fetchDeferred(uri, known, fetcher).then((bytes) => {
        if (bytes === undefined) {
          slots.set(uri, { state: "failed" });
          report(onProgress, {
            ...base,
            status: "error",
            loadedBytes: 0,
            error: `no transport for ${uri} returned usable bytes`,
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
 * Try the address, then any alternate transports policy allows, and return the
 * first answer that is usable. A declared length that does not match is treated
 * as a failed mirror rather than a fatal error, so the next transport gets a
 * chance. `undefined` means every transport failed.
 *
 * Never throws: a transport error is a value here, because the provider that
 * observes it is synchronous.
 */
async function fetchDeferred(
  uri: string,
  known: { transports: string[]; size: number } | undefined,
  fetcher: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  const transports = known?.transports ?? [uri];
  for (const url of transports) {
    try {
      const bytes = await fetcher(url);
      // A length is checked only where one was declared. An address with no
      // policy entry has nothing to check against, and inventing a check would
      // mean inventing the expectation.
      if (known !== undefined && bytes.length !== known.size) continue;
      return bytes;
    } catch {
      // Failed transport: fall through and try the next one.
    }
  }
  return undefined;
}
