import * as React from "react";
import type { LazyDownloadEvent } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { lazyDownloadAssetLabel } from "../../../../../web-libs/kandelo-session/src/lazy-download";

export const LazyDownloadToasts: React.FC<{
  downloads: LazyDownloadEvent[];
}> = ({ downloads }) => {
  const [dismissed, setDismissed] = React.useState<Map<string, string>>(() => new Map());
  const visibleDownloads = React.useMemo(
    () => downloads.filter((download) => !dismissed.has(download.id) ||
      ((download.status === "error" || download.status === "started") &&
        dismissed.get(download.id) !== downloadIdentity(download))),
    [dismissed, downloads],
  );

  React.useEffect(() => {
    setDismissed((current) => {
      if (current.size === 0) return current;
      const latest = new Map(downloads.map((download) => [download.id, download]));
      let changed = false;
      const next = new Map<string, string>();
      for (const [id, acknowledged] of current) {
        const download = latest.get(id);
        // WHY: dismissal acknowledges one observed failure/attempt. A new
        // attempt or later rejection must not inherit that acknowledgement.
        if (download && !((download.status === "started" || download.status === "error") &&
          acknowledged !== downloadIdentity(download))) next.set(id, acknowledged);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [downloads]);

  const dismiss = React.useCallback((id: string) => {
    const download = downloads.find((item) => item.id === id);
    if (download) setDismissed((current) => new Map(current).set(id, downloadIdentity(download)));
  }, [downloads]);

  if (visibleDownloads.length === 0) return null;

  return (
    <aside className="kdownload-toasts" aria-label="Download status" aria-live="polite">
      {visibleDownloads.slice(0, 3).map((download) => (
        <LazyDownloadToast key={download.id} download={download} onDismiss={dismiss} />
      ))}
      {visibleDownloads.length > 3 && (
        <div className="kdownload-toast kdownload-toast-overflow">
          <span className="kdownload-toast-title">More downloads</span>
          <span className="kdownload-toast-detail">+{visibleDownloads.length - 3} active</span>
        </div>
      )}
    </aside>
  );
};

const LazyDownloadToast: React.FC<{
  download: LazyDownloadEvent;
  onDismiss: (id: string) => void;
}> = ({ download, onDismiss }) => {
  const pct = download.totalBytes && download.totalBytes > 0
    ? Math.min(100, Math.max(0, (download.loadedBytes / download.totalBytes) * 100))
    : null;
  const terminal = download.status === "complete" || download.status === "error";
  const indeterminate = pct === null && !terminal;
  const label = lazyDownloadAssetLabel(download);
  const progressLabel = downloadProgressLabel(download, pct);
  const title = `${downloadStatusVerb(download)} ${label}`;
  const detail = `${humanBytes(download.loadedBytes)}${
    download.totalBytes ? ` / ${humanBytes(download.totalBytes)}` : ""
  }`;

  return (
    <div
      className={`kdownload-toast kdownload-toast-${download.status}`}
      role={download.status === "error" ? "alert" : undefined}
      title={download.error ? `${title}: ${download.error}` : `${title} (${detail})`}
    >
      <div className="kdownload-toast-top">
        <span className="kdownload-toast-title">{title}</span>
        <span className="kdownload-toast-progress-label">{progressLabel}</span>
        <button
          type="button"
          className="kdownload-toast-close"
          aria-label={`Dismiss ${label} download status`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss(download.id);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 3l6 6" />
            <path d="M9 3 3 9" />
          </svg>
        </button>
      </div>
      <div className="kdownload-toast-detail">
        {download.error ?? detail}
      </div>
      <div className={`kdownload-toast-bar${indeterminate ? " indeterminate" : ""}`} aria-hidden="true">
        <span style={{ width: terminal ? "100%" : pct === null ? "44%" : `${pct}%` }} />
      </div>
    </div>
  );
};

function downloadStatusVerb(event: LazyDownloadEvent): string {
  switch (event.status) {
    case "complete": return "Downloaded";
    case "error": return "Failed";
    default: return "Downloading";
  }
}

function downloadProgressLabel(event: LazyDownloadEvent, pct: number | null): string {
  if (event.status === "complete") return "OK";
  if (event.status === "error") return "ERR";
  return pct === null ? "..." : `${Math.round(pct)}%`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

function downloadIdentity(download: LazyDownloadEvent & { eventCount?: number; notificationGeneration?: number }): string {
  // A retry can fail at the same wall-clock time. The host summary's sequence
  // distinguishes that new failure from the one the operator acknowledged.
  return `${download.notificationGeneration ?? 0}:${download.status}:${download.eventCount ?? download.t}`;
}
