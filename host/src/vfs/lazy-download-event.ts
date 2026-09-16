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
