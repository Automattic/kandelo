/**
 * What a deferred-bytes transfer reports about itself.
 *
 * Lives here rather than in `memory-fs.ts`, where it used to, because it is not
 * about that filesystem — or any filesystem. It describes a FETCH: which
 * address, how many bytes so far, and whether it finished. Four files in
 * `host/src` imported `memory-fs.ts` for this one type and nothing else, so a
 * transport-progress shape was the sole reason the kernel protocols depended on
 * a filesystem implementation that lane V exists to delete.
 *
 * Progress belongs to the pipe and not to the kernel, and the distinction is
 * worth keeping in the file layout too: how many bytes have ARRIVED is a
 * property of the fetch, which is the host's job. Whether a file is
 * MATERIALIZED is a property of the filesystem, which is the kernel's.
 */

/**
 * The host-supplied transport a deferred file's bytes arrive through.
 *
 * Declared here for the reason the progress event above is: it describes a
 * FETCH. It was declared twice -- privately in `memory-fs.ts` and again,
 * identically, in `browser-lazy-fetcher.ts` -- and reached from three more
 * files as `Parameters<MemoryFileSystem["setLazyFetcher"]>[0]`, which is a
 * type-level import of an entire filesystem in order to name a function that
 * takes a URL and returns a `Response`.
 */
export type LazyFetch =
  (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type LazyDownloadKind = "file" | "tree" | "archive";
export type LazyDownloadStatus = "started" | "progress" | "complete" | "error";

export interface LazyDownloadEvent {
  id: string;
  kind: LazyDownloadKind;
  status: LazyDownloadStatus;
  url: string;
  path?: string;
  mountPrefix?: string;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
  t: number;
}

export type LazyDownloadListener = (event: LazyDownloadEvent) => void;
