import type { LazyDownloadEvent } from "./kernel-host";

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
