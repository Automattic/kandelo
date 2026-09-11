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
import type { LazyFileEntry, SerializedLazyArchiveEntry } from "./memory-fs";
import type { FileSystemBackend } from "./types";

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
const O_RDONLY = 0;

/**
 * Convert a kernel-facing absolute path (e.g. "/usr/bin") to the string the
 * backend's own methods expect (mount-relative). The `/` mount's convention is
 * injected so this module stays backend-agnostic and unit-testable.
 */
export type ToBackendPath = (absolutePath: string) => string;

/** Map a backend exception to a negative errno.
 *
 * A not-yet-materialized lazy file makes the backend's `open`/`read` throw an
 * error tagged `code === "EAGAIN"` (see
 * `MemoryFileSystem.guardSynchronousLazyAccess`, which also kicks the async
 * fetch off). Propagate that as EAGAIN so the kernel parks the read and
 * retries — the same park/retry an outstanding archive fetch uses — instead of
 * surfacing a spurious EIO. Every other failure is EIO. */
function deferredFileErrno(error: unknown): number {
  return (error as { code?: unknown })?.code === "EAGAIN" ? EAGAIN : EIO;
}

/**
 * Build the `HOST_DEFERRED_KIND_FILE` half of the provider: positioned reads of
 * a URL-backed lazy file, addressed by its inode number.
 *
 * The inode-to-path map comes from the lazy table itself, which is the only
 * place a URL-backed lazy file exists — no tree walk. That is a consequence of
 * the kernel serving image-backed bytes from the image: the host used to need
 * a path for EVERY regular file in the image, because any of them could be
 * asked for, and now it needs one only for the handful the image does not
 * carry (65 in the base image, 79 in every derived one).
 *
 * Hard links share one inode and therefore one entry, which is correct: the
 * bytes are the same bytes.
 *
 * Opens per call for now; an fd cache keyed by inode is a deliberate later
 * optimization (called out, not silently adopted) once the read path is
 * measured.
 */
export function createDeferredFileReader(
  backend: FileSystemBackend,
  lazyEntries: readonly LazyFileEntry[],
  toBackendPath: ToBackendPath,
): (ino: number, offset: bigint, dest: Uint8Array) => number {
  const paths = new Map<number, string>();
  for (const entry of lazyEntries) {
    paths.set(entry.ino, toBackendPath(entry.path));
  }
  return (ino, offset, dest) => {
    const path = paths.get(ino);
    if (path === undefined) {
      // The kernel only asks for inodes the image declared URL-backed lazy, and
      // this map is built from the same lazy table the image was written from.
      // An unknown inode is a contract violation between the two, not a missing
      // file.
      return ENOENT;
    }
    let handle: number;
    try {
      // A not-yet-materialized leaf throws EAGAIN here (open kicks the fetch
      // off).
      handle = backend.open(path, O_RDONLY, 0);
    } catch (error) {
      return deferredFileErrno(error);
    }
    if (handle < 0) {
      return handle;
    }
    try {
      return backend.read(handle, dest, Number(offset), dest.length);
    } catch (error) {
      return deferredFileErrno(error);
    } finally {
      try {
        backend.close(handle);
      } catch {
        // A close failure does not change the bytes already read.
      }
    }
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
 * {@link createDeferredFileReader}. Omitting it is the no-URL-lazy boot: such
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
