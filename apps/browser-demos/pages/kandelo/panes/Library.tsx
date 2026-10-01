// The library drawer: find something for a machine to load.
//
// Everything it offers comes from the image's `library` block — the groups
// it searches, the featured items, the files the image already carries.
// Whatever the visitor picks is loaded through the profile's `ingest`, the
// same path a dropped file takes. The drawer's one extra job is recording
// where the file came from, so a later link can name it: an Internet Archive
// file as a resolver boot input the opener fetches and verifies again, an
// image file by its path.
//
// The drawer is hidden, never unmounted, while its machine runs, so a search,
// an opened item and an opened ZIP are all still there when it reopens.

import * as React from "react";
import { pageCorsProxyFetch } from "../kernel-host/browser-cors-proxy-config";
import { useKernelHost } from "../kernel-host/react";
import type {
  DemoIngestConfig,
  DemoLibraryBundledConfig,
  DemoLibraryConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import type {
  BootInput,
  DemoIngestSource,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  archiveLocatorJson,
  downloadArchiveFile,
  downloadArchiveThumbnail,
  getArchiveItem,
  INTERNET_ARCHIVE_RESOLVER,
  readArchiveNestedZip,
  readArchiveZip,
  readArchiveZipMember,
  readNestedZipMember,
  searchArchive,
  zipMemberProblem,
  type ArchiveFile,
  type ArchiveItem,
  type ArchiveLocator,
  type ArchiveSearchItem,
  type NestedZip,
} from "../../../../../web-libs/kandelo-session/src/internet-archive";
import type { RemoteZipDirectory, ZipEntry } from "../../../../../host/src/vfs/zip";
import { filterAndPage, matchesQuery, type FilteredPage } from "./library-filter";

/** What the drawer hands the ingest path: a name, the bytes, their origin. */
export interface LibraryPick {
  name: string;
  bytes: Uint8Array;
  source: DemoIngestSource;
  /** The library group it was found in, when there is one. */
  group?: string;
}

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_ROWS = 24;

interface Card extends ArchiveSearchItem {
  note?: string;
}

/** Loads one picked file, reporting progress; shared by every row. */
interface PickContext {
  ingest: DemoIngestConfig;
  library: DemoLibraryConfig;
  /** Set while a pick is downloading or loading. */
  busy: boolean;
  disabled: boolean;
  pickArchive(
    item: ArchiveItem,
    locator: ArchiveLocator,
    read: (signal: AbortSignal) => Promise<Uint8Array>,
  ): Promise<void>;
}

const PickContext = React.createContext<PickContext | null>(null);

function usePick(): PickContext {
  const context = React.useContext(PickContext);
  if (!context) throw new Error("library rows must be inside the drawer");
  return context;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const slash = name.lastIndexOf("/");
  return dot > slash ? name.slice(dot).toLowerCase() : "";
}

function isZip(name: string): boolean {
  return extensionOf(name) === ".zip";
}

function fileName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

function baseName(name: string): string {
  // A boot input's filename must be a safe basename.
  return fileName(name).replace(/[\x00-\x1f\x7f\\]/g, "_").slice(0, 200) || "file";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function itemPage(identifier: string): string {
  return `https://archive.org/details/${encodeURIComponent(identifier)}`;
}

/** Runs one cancellable step at a time for a component, with truthful state. */
function useOperation() {
  const controllerRef = React.useRef<AbortController | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => () => controllerRef.current?.abort(), []);
  const run = React.useCallback(async (
    label: string,
    step: (signal: AbortSignal) => Promise<void>,
  ) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setProgress(label);
    setError(null);
    try {
      await step(controller.signal);
    } catch (err) {
      if (!isAbort(err, controller.signal)) setError(errorMessage(err));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setProgress(null);
      }
    }
  }, []);
  return { run, progress, error, setProgress };
}

export const LibraryDrawer: React.FC<{
  open: boolean;
  library: DemoLibraryConfig;
  ingest: DemoIngestConfig;
  /** Group to show first, e.g. the one the running content came from. */
  group?: string;
  /** Set while the machine is already loading something. */
  disabled: boolean;
  onPick: (pick: LibraryPick) => Promise<void>;
  onClose: () => void;
}> = ({ open, library, ingest, group: preferredGroup, disabled, onPick, onClose }) => {
  const host = useKernelHost();
  const drawerRef = React.useRef<HTMLElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [group, setGroup] = React.useState(
    () => library.groups.find((entry) => entry.label === preferredGroup)?.label
      ?? library.groups[0].label,
  );
  const [query, setQuery] = React.useState("");
  const [remote, setRemote] = React.useState<{ key: string; items: Card[]; total: number } | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState<string | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  const itemCache = React.useRef(new Map<string, ArchiveItem>());

  // Opening on the running content's group is a convenience for the first
  // open only; after that the visitor's own choice stands.
  const openedRef = React.useRef(false);
  React.useEffect(() => {
    if (!open || openedRef.current) return;
    openedRef.current = true;
    const preferred = library.groups.find((entry) => entry.label === preferredGroup);
    if (preferred) setGroup(preferred.label);
  }, [library.groups, open, preferredGroup]);

  // Focus, Escape and a focus trap, as a modal drawer needs.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) window.requestAnimationFrame(() => previous.focus());
    };
  }, [onClose, open]);

  const clause = library.groups.find((entry) => entry.label === group)!.query;
  const normalized = query.trim().replace(/\s+/g, " ");
  const searchKey = `${group}\n${normalized.toLowerCase()}`;

  // Search as the visitor types, once they pause. Search and item metadata
  // are public CORS endpoints; only file bytes go through the CORS proxy.
  React.useEffect(() => {
    if (!open || !normalized || remote?.key === searchKey) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      searchArchive(normalized, clause, { rows: SEARCH_ROWS, signal: controller.signal })
        .then((found) => setRemote({ key: searchKey, items: found.items, total: found.total }))
        .catch((err: unknown) => {
          if (!isAbort(err, controller.signal)) setSearchError(errorMessage(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [clause, normalized, open, remote?.key, searchKey]);

  const moreResults = async () => {
    if (!remote || remote.key !== searchKey) return;
    setSearching(true);
    setSearchError(null);
    try {
      const page = Math.floor(remote.items.length / SEARCH_ROWS) + 1;
      const found = await searchArchive(normalized, clause, { page, rows: SEARCH_ROWS });
      setRemote((current) => current && current.key === searchKey
        ? { ...current, items: [...current.items, ...found.items], total: found.total }
        : current);
    } catch (err) {
      setSearchError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const inGroup = <T extends { group?: string }>(entries: readonly T[] | undefined) =>
    (entries ?? []).filter((entry) => entry.group === undefined || entry.group === group);

  const bundled = inGroup(library.bundled).filter((entry) => matchesQuery(entry.title, normalized));
  const featured: Card[] = inGroup(library.featured)
    .filter((entry) => matchesQuery(`${entry.title} ${entry.item}`, normalized))
    .map((entry) => ({ identifier: entry.item, title: entry.title, ...(entry.note ? { note: entry.note } : {}) }));
  const cards: Card[] = React.useMemo(() => {
    const merged = new Map<string, Card>();
    for (const card of featured) merged.set(card.identifier, card);
    if (normalized && remote?.key === searchKey) {
      for (const item of remote.items) {
        const known = merged.get(item.identifier);
        merged.set(item.identifier, known ? { ...item, note: known.note } : item);
      }
    }
    return Array.from(merged.values());
    // `featured` is derived from these inputs on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, normalized, remote, searchKey, library]);

  const loadPick = React.useCallback(async (label: string, pick: () => Promise<LibraryPick>) => {
    setPicking(label);
    setPickError(null);
    try {
      await onPick(await pick());
    } catch (err) {
      setPickError(errorMessage(err));
      throw err;
    } finally {
      setPicking(null);
    }
  }, [onPick]);

  const pickContext: PickContext = React.useMemo(() => ({
    ingest,
    library,
    busy: picking !== null,
    disabled,
    pickArchive: (item, locator, read) => loadPick(
      `Loading ${baseName(locator.inner ?? locator.member ?? locator.file)}…`,
      async () => {
        const bytes = await read(new AbortController().signal);
        const name = baseName(locator.inner ?? locator.member ?? locator.file);
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
        return { name, bytes, source: { kind: "input", input }, group };
      },
    ),
  }), [disabled, group, ingest, library, loadPick, picking]);

  const pickBundled = (entry: DemoLibraryBundledConfig) => void loadPick(
    `Loading ${entry.title}…`,
    async () => ({
      name: baseName(entry.path),
      bytes: await host.readFile(entry.path),
      source: { kind: "image", path: entry.path },
      ...(entry.group ? { group: entry.group } : {}),
    }),
  ).catch(() => {});

  const showingSearch = normalized.length > 0;
  const remoteCount = remote?.key === searchKey ? remote.total : null;

  return (
    <div className="krl-overlay" hidden={!open}>
      <div className="krl-backdrop" aria-hidden="true" onMouseDown={onClose} />
      <section
        ref={drawerRef}
        className="krl-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="krl-title"
        tabIndex={-1}
        data-testid="library-drawer"
      >
        <header className="krl-header">
          <div>
            <div className="krl-eyebrow">Internet Archive</div>
            <h2 id="krl-title">Library</h2>
          </div>
          <button type="button" className="krl-icon-button" onClick={onClose} aria-label="Close library">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="krl-toolbar">
          {library.groups.length > 1 && (
            <div
              className="krl-system-picker"
              role="group"
              aria-label="Search in"
              style={{ gridTemplateColumns: `repeat(${Math.min(library.groups.length, 4)}, 1fr)` }}
            >
              {library.groups.map((entry) => (
                <button
                  type="button"
                  key={entry.label}
                  className="krl-chip"
                  aria-pressed={group === entry.label}
                  data-testid={`library-group-${entry.label}`}
                  onClick={() => { setGroup(entry.label); setSelected(null); }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <label className="krl-search">
            <span className="krl-visually-hidden">Search the Internet Archive</span>
            <span className="krl-search-icon" aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              data-testid="library-query"
              value={query}
              maxLength={120}
              placeholder={`Search the Internet Archive for ${group}`}
              autoComplete="off"
              onChange={(event) => { setQuery(event.target.value); setSelected(null); }}
            />
          </label>
        </div>

        <div className="krl-results-heading" aria-live="polite">
          <span>{showingSearch ? "Search results" : "Starting points"}</span>
          <span data-testid="library-count">
            {searching
              ? "Searching…"
              : showingSearch && remoteCount !== null
                ? `${remoteCount} on the Internet Archive`
                : `${cards.length + bundled.length} item${cards.length + bundled.length === 1 ? "" : "s"}`}
          </span>
        </div>

        <PickContext.Provider value={pickContext}>
          <div className="krl-results">
            {picking && <div className="krl-progress" data-testid="library-busy" aria-live="polite">{picking}</div>}
            {pickError && <div className="krl-inline-error" data-testid="library-error" role="alert">{pickError}</div>}
            {searchError && (
              <div className="krl-message krl-message-error" role="alert">
                <strong>Search failed</strong>
                <span>{searchError}</span>
              </div>
            )}
            {bundled.length > 0 && (
              <article className="krl-item" data-testid="library-bundled">
                <div className="krl-item-summary">
                  <div className="krl-thumbnail" aria-hidden="true"><span>{group.slice(0, 4).toUpperCase()}</span></div>
                  <div className="krl-item-copy">
                    <strong className="krl-item-title">Included with this machine</strong>
                    <span className="krl-item-meta">Already in the image; nothing is downloaded.</span>
                  </div>
                </div>
                <div className="krl-item-files">
                  {bundled.map((entry) => (
                    <div className="krl-file-block" key={entry.path}>
                      <div className="krl-file-row">
                        <div className="krl-file-copy">
                          <strong title={entry.path}>{entry.title}</strong>
                          <span>{fileName(entry.path)}</span>
                        </div>
                        <button
                          type="button"
                          className="krl-play"
                          aria-label={`Play ${entry.title}`}
                          disabled={disabled || picking !== null}
                          onClick={() => pickBundled(entry)}
                        >
                          Play
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            )}
            {!searching && !searchError && showingSearch && cards.length === 0 && bundled.length === 0
              && remoteCount !== null && (
              <div className="krl-message">
                <strong>No matching items</strong>
                <span>Try fewer words or another group.</span>
              </div>
            )}
            <div data-testid={showingSearch ? "library-results" : "library-featured"}>
              {cards.map((card) => (
                <ItemCard
                  key={`${group}:${card.identifier}`}
                  card={card}
                  open={open}
                  selected={selected === card.identifier}
                  onToggle={() => setSelected((current) =>
                    current === card.identifier ? null : card.identifier)}
                  cache={itemCache.current}
                />
              ))}
            </div>
            {showingSearch && remote?.key === searchKey && remote.items.length < remote.total && (
              <button
                type="button"
                className="krl-secondary-button krl-more"
                disabled={searching}
                onClick={() => void moreResults()}
              >
                More results
              </button>
            )}
          </div>
        </PickContext.Provider>

        <footer className="krl-footer">
          Search and metadata come from archive.org. Files are fetched when
          picked, capped at {formatBytes(ingest.maxBytes)}, and kept only in
          this machine.
        </footer>
      </section>
    </div>
  );
};

const ItemCard: React.FC<{
  card: Card;
  open: boolean;
  selected: boolean;
  onToggle: () => void;
  cache: Map<string, ArchiveItem>;
}> = ({ card, open, selected, onToggle, cache }) => {
  const { ingest } = usePick();
  const [item, setItem] = React.useState<ArchiveItem | null>(() => cache.get(card.identifier) ?? null);
  const { run, progress, error } = useOperation();
  const [thumbnail, setThumbnail] = React.useState<string | null>(null);
  const [fileQuery, setFileQuery] = React.useState("");
  const [filePage, setFilePage] = React.useState(1);

  React.useEffect(() => {
    if (!open || !selected || item) return;
    void run("Reading item…", async (signal) => {
      const next = await getArchiveItem(card.identifier, { signal });
      cache.set(card.identifier, next);
      setItem(next);
    });
  }, [cache, card.identifier, item, open, run, selected]);

  // Thumbnails come through the CORS proxy, so only for an opened card.
  React.useEffect(() => {
    if (!selected || thumbnail) return;
    const controller = new AbortController();
    downloadArchiveThumbnail(card.identifier, { fetch: pageCorsProxyFetch, signal: controller.signal })
      .then((blob) => setThumbnail(URL.createObjectURL(blob)))
      .catch(() => { /* the placeholder tile stays */ });
    return () => controller.abort();
  }, [card.identifier, selected, thumbnail]);
  React.useEffect(() => () => { if (thumbnail) URL.revokeObjectURL(thumbnail); }, [thumbnail]);

  const loadable = React.useMemo(
    () => item?.files.filter((file) => ingest.accept.includes(extensionOf(file.name)) || isZip(file.name)) ?? [],
    [ingest.accept, item],
  );
  const files = filterAndPage(loadable, fileQuery, filePage, (file) => file.name);
  const meta = card.downloads !== undefined ? `${card.downloads.toLocaleString()} downloads` : null;

  return (
    <article
      className="krl-item"
      data-selected={selected ? "true" : "false"}
      data-testid={`library-item-${card.identifier}`}
    >
      <div className="krl-item-summary">
        <div className="krl-thumbnail" aria-hidden="true">
          {thumbnail ? <img src={thumbnail} alt="" /> : <span>IA</span>}
        </div>
        <div className="krl-item-copy">
          <a href={itemPage(card.identifier)} target="_blank" rel="noreferrer">{item?.title ?? card.title}</a>
          {card.creator && <span className="krl-item-creator">{card.creator}</span>}
          {card.note && <span className="krl-item-note">{card.note}</span>}
          {item
            ? <span className="krl-item-meta">{loadable.length} loadable of {item.files.length} file{item.files.length === 1 ? "" : "s"}</span>
            : meta && <span className="krl-item-meta">{meta}</span>}
        </div>
        <button
          type="button"
          className="krl-secondary-button krl-item-select"
          aria-expanded={selected}
          aria-label={`${selected ? "Hide files for" : "Open"} ${card.title}`}
          onClick={onToggle}
        >
          {progress && selected ? "Opening…" : selected ? "Hide files" : "Open item"}
        </button>
      </div>

      {selected && error && (
        <div className="krl-inline-error" role="alert">
          Could not read this item: {error}. Hide and reopen it to retry.
        </div>
      )}

      {selected && item && (
        <div className="krl-item-files" data-testid="library-files">
          {loadable.length > 8 && (
            <label className="krl-entry-search krl-file-search">
              <span>Filter files in this item</span>
              <input
                type="search"
                data-testid="library-file-filter"
                value={fileQuery}
                maxLength={120}
                placeholder="Filter by name"
                autoComplete="off"
                onChange={(event) => { setFileQuery(event.target.value); setFilePage(1); }}
              />
            </label>
          )}
          <Pagination label="Files" page={files} onPage={setFilePage} />
          {files.items.map((file) => isZip(file.name) && !ingest.accept.includes(".zip")
            ? <ZipBlock key={file.name} item={item} file={file} autoOpen={loadable.length === 1} />
            : <FileRow key={file.name} item={item} file={file} />)}
          {files.totalMatches === 0 && (
            <div className="krl-file-note">
              {loadable.length === 0
                ? "This item has no files this machine can load."
                : "No file names match the filter."}
            </div>
          )}
        </div>
      )}
    </article>
  );
};

const FileRow: React.FC<{ item: ArchiveItem; file: ArchiveFile }> = ({ item, file }) => {
  const { ingest, busy, disabled, pickArchive } = usePick();
  const tooLarge = file.size !== undefined && file.size > ingest.maxBytes;
  return (
    <div className="krl-file-block">
      <div className="krl-file-row">
        <div className="krl-file-copy">
          <strong title={file.name}>{fileName(file.name)}</strong>
          <span>
            {formatBytes(file.size)}
            {tooLarge ? ` · over the ${formatBytes(ingest.maxBytes)} limit` : ""}
          </span>
        </div>
        <button
          type="button"
          className="krl-play"
          aria-label={`Play ${file.name}`}
          disabled={disabled || busy || tooLarge}
          onClick={() => void pickArchive(
            item,
            { item: item.identifier, file: file.name },
            (signal) => downloadArchiveFile(item, file.name, {
              fetch: pageCorsProxyFetch,
              maxBytes: ingest.maxBytes,
              signal,
            }),
          ).catch(() => {})}
        >
          Play
        </button>
      </div>
    </div>
  );
};

const ZipBlock: React.FC<{ item: ArchiveItem; file: ArchiveFile; autoOpen: boolean }> = ({
  item,
  file,
  autoOpen,
}) => {
  const { ingest, library, busy, disabled, pickArchive } = usePick();
  const { run, progress, error } = useOperation();
  const [expanded, setExpanded] = React.useState(false);
  const [directory, setDirectory] = React.useState<RemoteZipDirectory | null>(null);
  const [nested, setNested] = React.useState<NestedZip | null>(null);
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [nestedQuery, setNestedQuery] = React.useState("");
  const [nestedPage, setNestedPage] = React.useState(1);

  const download = { fetch: pageCorsProxyFetch, maxArchiveBytes: library.maxArchiveBytes };

  const toggle = React.useCallback(() => {
    if (expanded && directory) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (directory) return;
    void run("Reading the ZIP's directory…", async (signal) => {
      setDirectory(await readArchiveZip(item, file.name, { ...download, signal }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, expanded, file.name, item, run]);

  // Deferred a frame: React's development double-run of effects unmounts
  // once in between, which would abort a read started synchronously here.
  const autoOpened = React.useRef(false);
  React.useEffect(() => {
    if (!autoOpen || autoOpened.current) return;
    const frame = window.requestAnimationFrame(() => {
      autoOpened.current = true;
      toggle();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoOpen, toggle]);

  const accepted = (name: string) => ingest.accept.includes(extensionOf(name));
  const candidates = React.useMemo(
    () => directory?.entries.filter((entry) =>
      !entry.isDirectory && (accepted(entry.fileName) || isZip(entry.fileName))) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [directory, ingest.accept],
  );
  const outer = filterAndPage(candidates, query, page, (entry) => entry.fileName);
  const nestedCandidates = React.useMemo(
    () => nested?.entries.filter((entry) => !entry.isDirectory && accepted(entry.fileName)) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nested, ingest.accept],
  );
  const inner = filterAndPage(nestedCandidates, nestedQuery, nestedPage, (entry) => entry.fileName);

  const openNested = (entry: ZipEntry) => void run(`Opening ${fileName(entry.fileName)}…`, async (signal) => {
    if (!directory) return;
    const opened = await readArchiveNestedZip(item, file.name, directory, entry.fileName, { ...download, signal });
    setNestedQuery("");
    setNestedPage(1);
    setNested(opened);
  });

  const playMember = (entry: ZipEntry) => {
    if (!directory) return;
    void pickArchive(
      item,
      { item: item.identifier, file: file.name, member: entry.fileName },
      (signal) => readArchiveZipMember(item, file.name, directory, entry.fileName, {
        ...download,
        maxBytes: ingest.maxBytes,
        signal,
      }),
    ).catch(() => {});
  };

  const playInner = (entry: ZipEntry) => {
    if (!nested) return;
    void pickArchive(
      item,
      { item: item.identifier, file: file.name, member: nested.name, inner: entry.fileName },
      async () => readNestedZipMember(nested, entry.fileName, ingest.maxBytes),
    ).catch(() => {});
  };

  const entryRow = (entry: ZipEntry, action: "play" | "open", onClick: () => void) => {
    const problem = action === "play"
      ? zipMemberProblem(entry, ingest.maxBytes)
      : zipMemberProblem(entry, library.maxArchiveBytes ?? ingest.maxBytes);
    return (
      <div className="krl-entry" key={entry.fileName}>
        <div className="krl-entry-copy">
          <strong title={entry.fileName}>{fileName(entry.fileName)}</strong>
          <span>{action === "open" ? "ZIP" : "file"} · {formatBytes(entry.uncompressedSize)}</span>
        </div>
        <div className="krl-entry-action">
          {problem && <span className="krl-entry-issue">{problem}</span>}
          <button
            type="button"
            className={action === "open" ? "krl-secondary-button" : "krl-play"}
            aria-label={`${action === "open" ? "Open" : "Play"} ${entry.fileName}`}
            disabled={disabled || busy || progress !== null || problem !== null}
            onClick={onClick}
          >
            {action === "open" ? "Open" : "Play"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="krl-file-block krl-zip-block">
      <div className="krl-file-row">
        <div className="krl-file-copy">
          <strong title={file.name}>{fileName(file.name)}</strong>
          <span>ZIP · {formatBytes(file.size)}</span>
        </div>
        <button
          type="button"
          className="krl-secondary-button"
          aria-expanded={expanded}
          aria-label={`${directory && expanded ? "Hide" : "Browse"} ${file.name}`}
          disabled={progress !== null && !directory}
          onClick={toggle}
        >
          {progress && !directory ? "Reading…" : directory ? (expanded ? "Hide" : "Browse") : error ? "Retry" : "Browse"}
        </button>
      </div>
      {progress && <div className="krl-progress" aria-live="polite">{progress}</div>}
      {error && <div className="krl-inline-error" role="alert">{error}</div>}

      {expanded && directory && !nested && (
        <div className="krl-zip-entries" data-testid="library-members">
          <div className="krl-zip-summary">
            <span>{candidates.length} loadable entr{candidates.length === 1 ? "y" : "ies"}</span>
            <span>{formatBytes(directory.totalSize)} archive</span>
          </div>
          <label className="krl-entry-search">
            <span>Filter this ZIP</span>
            <input
              type="search"
              data-testid="library-member-filter"
              value={query}
              maxLength={120}
              placeholder="Filter by name"
              autoComplete="off"
              onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            />
          </label>
          <Pagination label="ZIP entries" page={outer} onPage={setPage} />
          {outer.items.map((entry) => isZip(entry.fileName) && !accepted(entry.fileName)
            ? entryRow(entry, "open", () => openNested(entry))
            : entryRow(entry, "play", () => playMember(entry)))}
          {outer.totalMatches === 0 && (
            <div className="krl-file-note">
              {candidates.length === 0 ? "This ZIP has nothing this machine can load." : "No entry names match the filter."}
            </div>
          )}
        </div>
      )}

      {expanded && directory && nested && (
        <div className="krl-nested" data-testid="library-nested">
          <nav className="krl-zip-breadcrumbs" aria-label="ZIP path">
            <button
              type="button"
              aria-label={`Back to ${fileName(file.name)}`}
              disabled={progress !== null}
              onClick={() => setNested(null)}
            >
              <span aria-hidden="true">←</span>
              <span>{fileName(file.name)}</span>
            </button>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{fileName(nested.name)}</span>
          </nav>
          <label className="krl-entry-search">
            <span>Filter this nested ZIP</span>
            <input
              type="search"
              data-testid="library-nested-filter"
              value={nestedQuery}
              maxLength={120}
              placeholder="Filter by name"
              autoComplete="off"
              autoFocus
              onChange={(event) => { setNestedQuery(event.target.value); setNestedPage(1); }}
            />
          </label>
          <Pagination label="Nested ZIP entries" page={inner} onPage={setNestedPage} />
          {inner.items.map((entry) => entryRow(entry, "play", () => playInner(entry)))}
          {inner.totalMatches === 0 && (
            <div className="krl-file-note">
              {nestedCandidates.length === 0 ? "This nested ZIP has nothing this machine can load." : "No entry names match the filter."}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Pagination: React.FC<{
  label: string;
  page: FilteredPage<unknown>;
  onPage: (page: number) => void;
}> = ({ label, page, onPage }) => {
  if (page.pageCount <= 1) return null;
  return (
    <nav className="krl-pagination" aria-label={`${label} pages`}>
      <button type="button" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>‹ Prev</button>
      <span>
        Page {page.page} of {page.pageCount} · {page.totalMatches} match{page.totalMatches === 1 ? "" : "es"}
      </span>
      <button type="button" disabled={page.page >= page.pageCount} onClick={() => onPage(page.page + 1)}>Next ›</button>
    </nav>
  );
};
