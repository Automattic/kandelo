/**
 * The dialog behind the dock's "Download files" button: browse the machine's
 * filesystem and save one file to the user's disk.
 *
 * It reads through the same `KernelHost` VFS calls as the Inspector, so it
 * sees what the kernel holds, not what a guest account may read. The page
 * already has that authority over its own machine.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import type { KernelHost, VfsDirent } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { useKernelHost } from "../kernel-host/react";
import { machineHome } from "../app/machine-home";
import { saveFile } from "../app/save-file";

type Listing =
  | { kind: "loading" }
  | { kind: "ready"; entries: VfsDirent[] }
  | { kind: "error"; message: string };

function childPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function pathSegments(path: string): { name: string; path: string }[] {
  const segments = [{ name: "/", path: "/" }];
  for (const name of path.split("/").filter(Boolean)) {
    segments.push({ name, path: childPath(segments[segments.length - 1]!.path, name) });
  }
  return segments;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sorted(entries: VfsDirent[]): VfsDirent[] {
  return entries.slice().sort((a, b) => {
    if (a.kind === "d" && b.kind !== "d") return -1;
    if (a.kind !== "d" && b.kind === "d") return 1;
    return a.name.localeCompare(b.name);
  });
}

function fileStream(host: KernelHost, path: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(await host.readFile(path));
      controller.close();
    },
  });
}

export const DownloadDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const host = useKernelHost();
  const [path, setPath] = React.useState<string | null>(null);
  const [listing, setListing] = React.useState<Listing>({ kind: "loading" });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const heading = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  React.useEffect(() => {
    let live = true;
    machineHome(host).catch(() => "/").then(home => { if (live) setPath(home); });
    return () => { live = false; };
  }, [host]);

  React.useEffect(() => {
    if (path === null) return;
    let live = true;
    setListing({ kind: "loading" });
    setSelected(null);
    host.readDir(path).then(
      entries => { if (live) setListing({ kind: "ready", entries: sorted(entries) }); },
      cause => { if (live) setListing({ kind: "error", message: message(cause) }); },
    );
    return () => { live = false; };
  }, [host, path]);

  const download = async (name: string) => {
    if (path === null) return;
    setSaving(true);
    setError(null);
    try {
      if (await saveFile(name, undefined, () => fileStream(host, childPath(path, name)))) onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  const open = async (entry: VfsDirent) => {
    if (path === null) return;
    const target = childPath(path, entry.name);
    setError(null);
    if (entry.kind === "d") return setPath(target);
    if (entry.kind === "f") return setSelected(entry.name);
    if (entry.kind !== "l") return setError(`${entry.name} is not a regular file`);
    const resolved = await host.stat(target).catch(() => null);
    if (resolved?.kind === "d") return setPath(target);
    if (resolved?.kind === "f") return setSelected(entry.name);
    setError(resolved ? `${entry.name} does not point to a regular file` : `${entry.name} points to nothing`);
  };

  return createPortal(<div className="kshare-backdrop"
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <div className="kshare kdownload-dialog" role="dialog" aria-modal="true" aria-labelledby="kdownload-dialog-title" data-testid="machine-download-dialog">
      <div className="kshare-hd">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--k-accent)" strokeWidth="1.2" aria-hidden="true">
          <path d="M8 3v8M5 8l3 3 3-3" />
          <path d="M3 10v2.5h10V10" />
        </svg>
        <div className="kshare-title" id="kdownload-dialog-title" ref={heading} tabIndex={-1}>Download a file from this machine</div>
        <button className="kshare-x" onClick={onClose} title="Close" aria-label="Close">✕</button>
      </div>
      <nav className="kdownload-dialog-path" aria-label="Directory">
        <button type="button" disabled={path === null || path === "/"} onClick={() => path && setPath(parentPath(path))} title="Parent directory" aria-label="Parent directory">..</button>
        {path !== null && pathSegments(path).map(segment => (
          <button type="button" key={segment.path} onClick={() => setPath(segment.path)} aria-current={segment.path === path ? "location" : undefined}>
            {segment.name}
          </button>
        ))}
      </nav>
      <div className="kshare-body kdownload-dialog-body">
        {listing.kind === "loading" && <div className="kdownload-dialog-note">Loading…</div>}
        {listing.kind === "error" && <div className="kdownload-dialog-note" role="alert">{listing.message}</div>}
        {listing.kind === "ready" && listing.entries.length === 0 && <div className="kdownload-dialog-note">Empty directory.</div>}
        {listing.kind === "ready" && listing.entries.length > 0 && (
          <ul className="kdownload-dialog-list" aria-label="Files">
            {listing.entries.map(entry => (
              <li key={entry.name}>
                <button
                  type="button"
                  aria-pressed={selected === entry.name}
                  data-testid="machine-download-entry"
                  data-name={entry.name}
                  onClick={() => void open(entry)}
                  onDoubleClick={() => { if (entry.kind === "f") void download(entry.name); }}
                >
                  <span className="kdownload-dialog-name">
                    {entry.kind === "d" ? `${entry.name}/` : entry.name}
                    {entry.target !== undefined && <span className="kdownload-dialog-target"> → {entry.target}</span>}
                  </span>
                  {entry.kind !== "d" && <span className="kdownload-dialog-size">{entry.size}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="kshare-actions">
        <span className="kdownload-dialog-error" role={error ? "alert" : undefined}>{error}</span>
        <button type="button" className="kshare-btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="kshare-btn kshare-btn-primary"
          disabled={selected === null || saving}
          onClick={() => selected && void download(selected)}
          data-testid="machine-download-save"
        >
          {saving ? "Saving…" : "Download"}
        </button>
      </div>
    </div>
  </div>, document.body);
};
