/**
 * What a deferred-bytes transfer reports about itself.
 *
 * Lives in its own module because it is not about any filesystem. It
 * describes a FETCH: which address, how many bytes so far, and whether it
 * finished. When it lived inside the TypeScript filesystem (now deleted),
 * several `host/src` files imported that whole implementation for this one
 * type, so a transport-progress shape tied the kernel protocols to a
 * filesystem they did not otherwise use.
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
 * FETCH -- a function that takes a URL and returns a `Response` -- and one
 * declaration keeps every fetcher and consumer agreeing on that shape instead
 * of each naming it through some filesystem's method signature.
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
