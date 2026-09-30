// The library panel: find something for a machine to load.
//
// Everything it offers comes from the image's `library` block — the search
// groups, the featured items, the files the image already carries. Whatever
// the visitor picks is loaded through the profile's `ingest`, the same path a
// dropped file takes. The panel's one extra job is recording where the file
// came from, so a later share link can name it: an Internet Archive file as a
// resolver boot input the opener fetches and verifies again, an image file by
// its path.

import * as React from "react";
import { createPortal } from "react-dom";
import { useKernelHost } from "../kernel-host/react";
import { pageCorsProxyFetch } from "../kernel-host/browser-cors-proxy-config";
import type {
  DemoIngestConfig,
  DemoLibraryConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import type {
  BootInput,
  DemoIngestSource,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  archiveLocatorJson,
  downloadArchiveFile,
  getArchiveItem,
  INTERNET_ARCHIVE_RESOLVER,
  readArchiveZip,
  readArchiveZipMember,
  searchArchive,
  zipMemberProblem,
  type ArchiveItem,
  type ArchiveLocator,
  type ArchiveSearchItem,
} from "../../../../../web-libs/kandelo-session/src/internet-archive";
import type { RemoteZipDirectory } from "../../../../../host/src/vfs/zip";

/** What the panel hands the ingest path: a name, the bytes, their origin. */
export interface LibraryPick {
  name: string;
  bytes: Uint8Array;
  source: DemoIngestSource;
}

const PAGE_ROWS = 24;
const LIST_PAGE = 100;

type View =
  | { kind: "home" }
  | { kind: "item"; item: ArchiveItem }
  | { kind: "zip"; item: ArchiveItem; file: string; directory: RemoteZipDirectory };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const slash = name.lastIndexOf("/");
  return dot > slash ? name.slice(dot).toLowerCase() : "";
}

function baseName(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  // A boot input's filename must be a safe basename.
  return base.replace(/[\x00-\x1f\x7f\\]/g, "_").slice(0, 200) || "file";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export const LibraryDialog: React.FC<{
  library: DemoLibraryConfig;
  ingest: DemoIngestConfig;
  onPick: (pick: LibraryPick) => Promise<void>;
  onClose: () => void;
}> = ({ library, ingest, onPick, onClose }) => {
  const host = useKernelHost();
  const [group, setGroup] = React.useState(library.groups[0].label);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<{
    items: ArchiveSearchItem[];
    total: number;
    page: number;
  } | null>(null);
  const [view, setView] = React.useState<View>({ kind: "home" });
  const [visible, setVisible] = React.useState(LIST_PAGE);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const accepted = React.useCallback(
    (name: string) => ingest.accept.includes(extensionOf(name)),
    [ingest.accept],
  );

  /** Run one step, keeping the panel's busy/error state truthful. */
  const run = React.useCallback(async (label: string, step: (signal: AbortSignal) => Promise<void>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(label);
    setError(null);
    try {
      await step(controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (abortRef.current === controller) setBusy(null);
    }
  }, []);

  const clause = library.groups.find((entry) => entry.label === group)!.query;

  const search = (page: number) => run("Searching…", async (signal) => {
    const found = await searchArchive(query, clause, { page, rows: PAGE_ROWS, signal });
    setResults((previous) => ({
      items: page === 1 ? found.items : [...(previous?.items ?? []), ...found.items],
      total: found.total,
      page,
    }));
    setView({ kind: "home" });
  });

  const openItem = (identifier: string) => run(`Opening ${identifier}…`, async (signal) => {
    const item = await getArchiveItem(identifier, { signal });
    setVisible(LIST_PAGE);
    setView({ kind: "item", item });
  });

  const openZip = (item: ArchiveItem, file: string) => run(`Reading ${file}…`, async (signal) => {
    const directory = await readArchiveZip(item, file, {
      fetch: pageCorsProxyFetch,
      maxArchiveBytes: library.maxArchiveBytes,
      signal,
    });
    setVisible(LIST_PAGE);
    setView({ kind: "zip", item, file, directory });
  });

  const pickArchive = (item: ArchiveItem, locator: ArchiveLocator) => run(
    `Loading ${baseName(locator.member ?? locator.file)}…`,
    async (signal) => {
      const options = { fetch: pageCorsProxyFetch, maxBytes: ingest.maxBytes, signal };
      let bytes: Uint8Array;
      if (locator.member === undefined) {
        bytes = await downloadArchiveFile(item, locator.file, options);
      } else {
        const directory = view.kind === "zip" && view.file === locator.file
          ? view.directory
          : await readArchiveZip(item, locator.file, { ...options, maxArchiveBytes: library.maxArchiveBytes });
        bytes = await readArchiveZipMember(item, locator.file, directory, locator.member, options);
      }
      const name = baseName(locator.member ?? locator.file);
      const input: BootInput = {
        id: library.inputId,
        filename: name,
        byteLength: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        source: {
          kind: "resolver",
          resolver: INTERNET_ARCHIVE_RESOLVER,
          locator: archiveLocatorJson(locator),
        },
      };
      await onPick({ name, bytes, source: { kind: "input", input } });
      onClose();
    },
  );

  const pickBundled = (path: string) => run(`Loading ${baseName(path)}…`, async () => {
    const bytes = await host.readFile(path);
    await onPick({ name: baseName(path), bytes, source: { kind: "image", path } });
    onClose();
  });

  const inGroup = <T extends { group?: string }>(entries: readonly T[] | undefined) =>
    (entries ?? []).filter((entry) => entry.group === undefined || entry.group === group);

  const renderHome = () => (
    <>
      {inGroup(library.bundled).length > 0 && (
        <div>
          <div className="kshare-sect-lbl">Included with this machine</div>
          <ul className="klibrary-list" data-testid="library-bundled">
            {inGroup(library.bundled).map((entry) => (
              <li key={entry.path}>
                <button type="button" className="klibrary-row" onClick={() => void pickBundled(entry.path)}>
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {inGroup(library.featured).length > 0 && (
        <div>
          <div className="kshare-sect-lbl">Featured on the Internet Archive</div>
          <ul className="klibrary-list" data-testid="library-featured">
            {inGroup(library.featured).map((entry) => (
              <li key={entry.item}>
                <button type="button" className="klibrary-row" onClick={() => void openItem(entry.item)}>
                  {entry.title}
                  {entry.note && <span className="klibrary-dim"> · {entry.note}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {results && (
        <div>
          <div className="kshare-sect-lbl">
            {results.total} result{results.total === 1 ? "" : "s"} on the Internet Archive
          </div>
          <ul className="klibrary-list" data-testid="library-results">
            {results.items.map((item) => (
              <li key={item.identifier}>
                <button type="button" className="klibrary-row" onClick={() => void openItem(item.identifier)}>
                  {item.title}
                  <span className="klibrary-dim"> · {item.identifier}</span>
                </button>
              </li>
            ))}
          </ul>
          {results.items.length < results.total && (
            <button type="button" className="kshare-btn" onClick={() => void search(results.page + 1)}>
              More results
            </button>
          )}
        </div>
      )}
    </>
  );

  const renderItem = (item: ArchiveItem) => {
    const files = item.files.filter((file) => accepted(file.name) || extensionOf(file.name) === ".zip");
    return (
      <div>
        <div className="kshare-sect-lbl">{item.title}</div>
        {files.length === 0 && (
          <div className="klibrary-dim">This item has no files this machine can load.</div>
        )}
        <ul className="klibrary-list" data-testid="library-files">
          {files.slice(0, visible).map((file) => {
            const zip = extensionOf(file.name) === ".zip" && !accepted(file.name);
            return (
              <li key={file.name}>
                <button
                  type="button"
                  className="klibrary-row"
                  onClick={() => void (zip
                    ? openZip(item, file.name)
                    : pickArchive(item, { item: item.identifier, file: file.name }))}
                >
                  {file.name}
                  <span className="klibrary-dim"> · {zip ? "open archive" : formatSize(file.size)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {files.length > visible && (
          <button type="button" className="kshare-btn" onClick={() => setVisible((n) => n + LIST_PAGE)}>
            Show more ({files.length - visible} left)
          </button>
        )}
      </div>
    );
  };

  const renderZip = (item: ArchiveItem, file: string, directory: RemoteZipDirectory) => {
    const members = directory.entries.filter((entry) => !entry.isDirectory && accepted(entry.fileName));
    return (
      <div>
        <div className="kshare-sect-lbl">{file}</div>
        {members.length === 0 && (
          <div className="klibrary-dim">This archive has no files this machine can load.</div>
        )}
        <ul className="klibrary-list" data-testid="library-members">
          {members.slice(0, visible).map((entry, index) => {
            const problem = zipMemberProblem(entry, ingest.maxBytes);
            return (
              <li key={`${index}:${entry.fileName}`}>
                <button
                  type="button"
                  className="klibrary-row"
                  disabled={problem !== null}
                  title={problem ?? undefined}
                  onClick={() => void pickArchive(item, {
                    item: item.identifier,
                    file,
                    member: entry.fileName,
                  })}
                >
                  {entry.fileName}
                  <span className="klibrary-dim">
                    {" · "}{problem ?? formatSize(entry.uncompressedSize)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {members.length > visible && (
          <button type="button" className="kshare-btn" onClick={() => setVisible((n) => n + LIST_PAGE)}>
            Show more ({members.length - visible} left)
          </button>
        )}
      </div>
    );
  };

  return createPortal(
    <div
      className="kshare-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div className="kshare klibrary" role="dialog" aria-modal aria-label="Library" onMouseDown={(e) => e.stopPropagation()}>
        <div className="kshare-hd">
          <div className="kshare-title">Library</div>
          <button className="kshare-x" onClick={onClose} title="Close" aria-label="Close">✕</button>
        </div>
        <div className="kshare-body">
          <form
            className="klibrary-search"
            onSubmit={(event) => { event.preventDefault(); void search(1); }}
          >
            {library.groups.length > 1 && (
              <select
                aria-label="Search in"
                data-testid="library-group"
                value={group}
                onChange={(event) => { setGroup(event.target.value); setResults(null); }}
              >
                {library.groups.map((entry) => (
                  <option key={entry.label} value={entry.label}>{entry.label}</option>
                ))}
              </select>
            )}
            <input
              type="search"
              aria-label="Search the Internet Archive"
              data-testid="library-query"
              placeholder="Search the Internet Archive"
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="kshare-btn" disabled={busy !== null}>Search</button>
          </form>
          {view.kind !== "home" && (
            <button type="button" className="kshare-btn" onClick={() => setView(
              view.kind === "zip" ? { kind: "item", item: view.item } : { kind: "home" },
            )}>
              ← Back
            </button>
          )}
          {busy && <div className="klibrary-dim" data-testid="library-busy">{busy}</div>}
          {error && <div className="kshare-script-err" data-testid="library-error">{error}</div>}
          {view.kind === "home" && renderHome()}
          {view.kind === "item" && renderItem(view.item)}
          {view.kind === "zip" && renderZip(view.item, view.file, view.directory)}
        </div>
      </div>
    </div>,
    document.body,
  );
};
