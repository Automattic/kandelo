/**
 * The host's whole remaining byte job for the kernel-owned `/`: serve the
 * resources the `/` image does NOT carry.
 *
 * The kernel owns the `/` tree and reads an image-backed file's content out of
 * the image itself, through its own SFFS reader. Two things are left over, and
 * they are the same shape — fetch from a host transport, serve positioned
 * bytes, report `EAGAIN` while the fetch is in flight — so one provider answers
 * both behind one import, `host_fetch_deferred(kind, id, offset, dest)`:
 *
 *  - `HOST_DEFERRED_KIND_ARCHIVE`: a lazy archive, addressed by the
 *    image-assigned `archive_id`. Fetched whole, once, and cached; the kernel
 *    decodes the zip and extracts the member.
 *  - `HOST_DEFERRED_KIND_FILE`: a URL-backed lazy file, addressed by its inode
 *    number. The image records only its real size (`KLZY`, `archive_id == 0`),
 *    and the fetch is the `MemoryFileSystem`'s own materialization — opening
 *    the path starts it and throws `EAGAIN` until it lands.
 *
 * `buildRootfsLazyWiring` consumes `MemoryFileSystem.exportLazyArchiveEntries()`
 * output and produces, from one pass over the groups:
 *  - a `deferredProvider` closure (fed to `configureRootfsOverlay`) — the
 *    production output, and
 *  - a `RootfsLazyInput`, the linkage the host used to feed to the RTFS
 *    manifest walker. Since the boot cutover the kernel learns which files are
 *    lazy from the image's own `KLZY` section, so this half has no production
 *    consumer left; it survives because the differential gates in
 *    `host/test/support/rootfs-manifest-oracle.ts` compare the image's section
 *    against exactly this reconstruction.
 *
 * Both outputs share ONE `Map<archiveId, ...>` and one reduction pass over
 * `entries`, so the two can never drift relative to each other — which is what
 * makes the comparison a real check rather than a tautology.
 *
 * That reduction -- which groups are fetchable, which members are byte ranges,
 * and what `archiveId` each group gets -- lives in `reduceLazyArchiveGroups`
 * (`./kernel-lazy-section`), because the image's own binary `KLZY` section
 * encodes the same ids. Sharing one definition is what makes "the image's
 * archive table and the host's fetch table are the same table" structural
 * rather than a coincidence between two copies of a filter rule.
 */

import { reduceLazyArchiveGroups } from "./kernel-lazy-section";
import type {
  LazyDownloadEvent,
  LazyFileEntry,
  SerializedLazyArchiveEntry,
} from "./memory-fs";
import { VFS_IMAGE_HEADER_SIZE } from "./vfs-image-transport";

/**
 * Which deferred resource a `host_fetch_deferred` call is about. Mirrors
 * `abi::HOST_DEFERRED_KIND_*` in `crates/shared/src/lib.rs`, which documents
 * the contract.
 */
export const HOST_DEFERRED_KIND_FILE = 0;
export const HOST_DEFERRED_KIND_ARCHIVE = 1;
/** Where a lazy (archive-backed) file's bytes live: `archive_id` identifies
 * the archive in the trailing archive table, `sourcePath` is the member's
 * path within it. Materializing those bytes is a later increment; this
 * module only records the mapping in the manifest (`KIND_LAZY_FILE`). */
export interface RootfsLazyFile {
  readonly archiveId: number;
  readonly sourcePath: string;
}

/** Total byte size of a lazy archive, recorded in the trailing archive table
 * so the kernel can validate/plan reads before the archive is fetched. */
export interface RootfsLazyArchive {
  readonly archiveId: number;
  readonly size: number | bigint;
}

/**
 * Optional description of lazy (archive-backed) files to emit as
 * `KIND_LAZY_FILE` instead of `KIND_FILE`. Keyed by the kernel-facing
 * absolute VFS path (the same `absPath` the walker already computes), so a
 * caller can mark a subset of otherwise-ordinary regular files as lazy
 * without changing how the backend tree is walked.
 */
export interface RootfsLazyInput {
  readonly files: ReadonlyMap<string, RootfsLazyFile>;
  readonly archives: readonly RootfsLazyArchive[];
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
  // backend they have. `imageReadFromBody` adapts a body-holding one.

}

/**
 * Adapt a body-holding backend to the CONTAINER-offset reader the kernel's
 * rootfs image provider asks for.
 *
 * The subtraction is a fact about the backend, not about the kernel: a
 * `SharedFS` buffer is the bare body, so container offset `at` is body offset
 * `at - VFS_IMAGE_HEADER_SIZE`. A backend that holds the whole container
 * answers the same question without subtracting, which is exactly why the
 * question is asked in container coordinates — and why this adapter lives
 * here, in a file that survives, rather than as a method on the filesystem
 * being deleted.
 */
export function imageReadFromBody(
  backend: { imageBodyBytes(): Uint8Array },
): (at: number, dest: Uint8Array) => number {
  return (at, dest) => {
    const body = backend.imageBodyBytes();
    const start = at - VFS_IMAGE_HEADER_SIZE;
    if (start >= body.byteLength) return 0; // end of image
    const n = Math.min(dest.byteLength, body.byteLength - start);
    dest.set(body.subarray(start, start + n));
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
 * A deferred-file reader that fetches URLs directly, with no filesystem behind
 * it.
 *
 * # Why this exists
 *
 * The reader this replaced went through a filesystem — a `MemoryFileSystem`
 * whose `open` kicked an async materialization and threw `EAGAIN` until it
 * landed. That put materialization STATUS in the host: a preparation state
 * machine, retry and integrity handling, progress events, abort plumbing.
 * Roughly 500 lines of it, none of which the kernel was asking for.
 *
 * The kernel already owns that status. An inode is a `LazyMember` until it is
 * written through, at which point it becomes `Regular`; `ensure_materialized`
 * is synchronous and the guest retries on `EAGAIN`. **So the host does not need
 * to track whether a file is materialized. It needs to answer "bytes for this
 * inode?" with bytes, "not yet", or "it failed".**
 *
 * That is all this does. Fetch in flight is `EAGAIN` — the same answer the
 * kernel's own byte source gives, and the guest retry loop is already built for
 * it. A failed fetch is `EIO` once and stays failed, because a pipe that
 * silently retries forever is a hang rather than a failure.
 */
export function createDeferredUrlReader(
  lazyEntries: readonly LazyFileEntry[],
  fetchBytes: DeferredUrlFetch,
  onProgress?: DeferredProgress,
): (ino: number, offset: bigint, dest: Uint8Array) => number {
  const urls = new Map<number, string>();
  const details = new Map<number, { url: string; path: string; size: number }>();
  for (const entry of lazyEntries) {
    urls.set(entry.ino, entry.url);
    details.set(entry.ino, {
      url: entry.url,
      path: entry.path,
      size: entry.size,
    });
  }

  type Slot =
    | { state: "pending" }
    | { state: "ready"; bytes: Uint8Array }
    | { state: "failed" };
  const slots = new Map<number, Slot>();

  return (ino, offset, dest) => {
    const url = urls.get(ino);
    // The kernel only asks for inodes the image declared URL-backed lazy, so an
    // unknown one is a contract violation between image and table, not a
    // missing file.
    if (url === undefined) return ENOENT;

    const slot = slots.get(ino);
    if (slot === undefined) {
      const detail = details.get(ino);
      const base = {
        id: `file:${ino}`,
        kind: "file" as const,
        url,
        path: detail?.path,
        totalBytes: detail?.size,
      };
      slots.set(ino, { state: "pending" });
      report(onProgress, { ...base, status: "started", loadedBytes: 0 });
      void fetchBytes(url).then(
        (bytes) => {
          slots.set(ino, { state: "ready", bytes });
          report(onProgress, {
            ...base,
            status: "complete",
            loadedBytes: bytes.byteLength,
          });
        },
        (error: unknown) => {
          slots.set(ino, { state: "failed" });
          report(onProgress, {
            ...base,
            status: "error",
            loadedBytes: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      return EAGAIN;
    }
    if (slot.state === "pending") return EAGAIN;
    if (slot.state === "failed") return EIO;

    const at = Number(offset);
    if (!Number.isSafeInteger(at) || at < 0) return EIO;
    if (at >= slot.bytes.byteLength) return 0; // end of file
    const n = Math.min(dest.byteLength, slot.bytes.byteLength - at);
    dest.set(slot.bytes.subarray(at, at + n));
    return n;
  };
}

type ArchiveState = "idle" | "fetching" | Uint8Array | { error: true };

interface ArchiveRecord {
  readonly transports: string[];
  readonly size: number;
  state: ArchiveState;
}

/**
 * Build the `RootfsLazyInput` (manifest linkage) and the
 * `host_fetch_deferred` provider from one export snapshot of
 * `MemoryFileSystem`'s lazy archive groups.
 *
 * `fetcher` is the exact transport already wired to
 * `MemoryFileSystem.setLazyFetcher` (closed-asset fetcher, CORS-proxy
 * fetcher, etc.) — the provider never invents its own transport.
 *
 * `deferredFileReader` answers the other kind, URL-backed lazy files; see
 * {@link createDeferredUrlReader}. Omitting it is the no-URL-lazy boot: such
 * a read is reported as the unbacked seam it is (`ENOSYS`) rather than as a
 * missing file.
 */
export function buildRootfsLazyWiring(
  entries: SerializedLazyArchiveEntry[],
  fetcher: (url: string) => Promise<Uint8Array>,
  deferredFileReader?: (
    ino: number,
    offset: bigint,
    dest: Uint8Array,
  ) => number,
): {
  lazyInput: RootfsLazyInput;
  deferredProvider: (
    kind: number,
    id: bigint,
    offset: bigint,
    dest: Uint8Array,
  ) => number;
} {
  const files = new Map<string, RootfsLazyFile>();
  const archives: RootfsLazyArchive[] = [];
  const records = new Map<number, ArchiveRecord>();

  for (const group of reduceLazyArchiveGroups(entries)) {
    const { archiveId, archiveBytes: size, transports } = group;
    archives.push({ archiveId, size });
    records.set(archiveId, { transports, size, state: "idle" });
    for (const member of group.members) {
      files.set(member.vfsPath, {
        archiveId,
        sourcePath: member.sourcePath,
      });
    }
  }

  const archiveProvider = (
    archiveId: number,
    offset: bigint,
    dest: Uint8Array,
  ): number => {
    const record = records.get(archiveId);
    if (!record) {
      // The kernel only asks for ids this builder minted; an unknown id is a
      // contract violation between the manifest and the provider.
      return EIO;
    }

    const { state } = record;
    if (state instanceof Uint8Array) {
      const start = Number(offset);
      if (start >= state.length) return 0;
      const n = Math.min(dest.length, state.length - start);
      dest.set(state.subarray(start, start + n));
      return n;
    }

    if (state === "idle") {
      record.state = "fetching";
      void fetchArchive(record, fetcher);
      return EAGAIN;
    }

    if (state === "fetching") {
      return EAGAIN;
    }

    // { error: true }
    return EIO;
  };

  const deferredProvider = (
    kind: number,
    id: bigint,
    offset: bigint,
    dest: Uint8Array,
  ): number => {
    if (kind === HOST_DEFERRED_KIND_ARCHIVE) {
      return archiveProvider(Number(id), offset, dest);
    }
    if (kind === HOST_DEFERRED_KIND_FILE) {
      if (deferredFileReader === undefined) {
        return ENOSYS; // no URL-backed lazy files were wired
      }
      return deferredFileReader(Number(id), offset, dest);
    }
    // A kind this host does not implement. Truthfully unsupported rather than
    // silently served as one of the kinds it does.
    return ENOSYS;
  };

  return { lazyInput: { files, archives }, deferredProvider };
}

/** Try each transport in order; on the first successful fetch whose length
 * matches the declared archive size, publish it as the cached raw archive.
 * A size mismatch is treated as a failed mirror, not a fatal error, so the
 * next transport gets a chance. Never throws — errors are recorded on the
 * record itself for the synchronous provider to observe. */
async function fetchArchive(
  record: ArchiveRecord,
  fetcher: (url: string) => Promise<Uint8Array>,
): Promise<void> {
  for (const url of record.transports) {
    try {
      const bytes = await fetcher(url);
      if (bytes.length === record.size) {
        record.state = bytes;
        return;
      }
      // Wrong/corrupt mirror: fall through and try the next transport.
    } catch {
      // Failed transport: fall through and try the next transport.
    }
  }
  record.state = { error: true };
}
