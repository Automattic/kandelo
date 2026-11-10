import type { LazyDownloadEvent, LazyDownloadSummary } from "./kernel-host";

/** Collapse one raw transport event into an asset's authoritative state. */
export function advanceLazyDownloadSummary(
  previous: LazyDownloadSummary | undefined,
  event: LazyDownloadEvent,
): LazyDownloadSummary {
  return {
    ...event,
    path: event.path ?? previous?.path,
    mountPrefix: event.mountPrefix ?? previous?.mountPrefix,
    totalBytes: event.totalBytes ?? previous?.totalBytes,
    firstSeenAt: previous?.firstSeenAt ?? event.t,
    startedAt: event.status === "started"
      ? event.t
      : previous?.startedAt ?? event.t,
    eventCount: (previous?.eventCount ?? 0) + 1,
  };
}

/** Latest non-terminal assets, newest first, for transient download UI. */
export function activeLazyDownloadSummaries(
  summaries: Iterable<LazyDownloadSummary>,
): LazyDownloadSummary[] {
  return Array.from(summaries)
    .filter(({ status }) => status !== "complete" && status !== "error")
    .sort((a, b) => b.t - a.t);
}

/** Unfinished transfers and unresolved failures, with failures first. */
export function visibleLazyDownloadSummaries(
  summaries: Iterable<LazyDownloadSummary>,
): LazyDownloadSummary[] {
  // WHY: libraries can recover from EIO by omitting fonts or other data.
  // Completing the transfer or unmounting a pane cannot acknowledge its
  // later integrity failure; keep that failure visible until explicit dismissal
  // or a new attempt updates its authoritative summary.
  return Array.from(summaries)
    .filter(({ status }) => status !== "complete")
    .sort((a, b) => Number(b.status === "error") - Number(a.status === "error") || b.t - a.t);
}

/**
 * Human-readable identity for one lazy download. Archive and tree events
 * describe a whole transport payload, so their immutable URL is more useful
 * than a shared mount point such as `/`. File events retain their VFS path.
 */
export function lazyDownloadAssetLabel(event: LazyDownloadEvent): string {
  const raw = event.kind === "file"
    ? event.path ?? event.mountPrefix ?? event.url
    : event.url;
  const clean = raw.split(/[?#]/, 1)[0]!.replace(/\/+$/, "");
  return clean.split("/").pop() || event.kind;
}
