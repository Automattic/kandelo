/**
 * Dropping and picking files onto a machine: collect what the browser hands
 * over and offer it to the machine through Kandelo exchange as one batch.
 *
 * Folders are walked through `webkitGetAsEntry` (every browser that drags
 * folders implements it), keeping their structure. The walk stops at the
 * kernel's batch limits; the kernel remains the authority and refuses
 * anything past them.
 */
import * as React from "react";
import type { ExchangeOfferItem } from "../../../../../web-libs/kandelo-session/src/exchange-session";
import { useExchangeConsumer, useKernelHost } from "../kernel-host/react";

/** The kernel's batch limits (crates/runtime-core/src/exchange/batches.rs). */
const MAX_ENTRIES = 1024;
const MAX_DEPTH = 16;

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAll(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, dirs: string[], out: ExchangeOfferItem[]): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    out.push(itemFor(file, dirs));
    return;
  }
  if (!entry.isDirectory || dirs.length >= MAX_DEPTH - 1) return;
  const children = await readAll(entry as FileSystemDirectoryEntry);
  const inside = [...dirs, entry.name];
  if (children.length === 0) {
    out.push({ name: entry.name, ...(dirs.length ? { dirs } : {}) }); // an empty folder
    return;
  }
  for (const child of children) await walk(child, inside, out);
}

function itemFor(file: File, dirs: readonly string[] = []): ExchangeOfferItem {
  return {
    name: file.name,
    ...(dirs.length ? { dirs } : {}),
    source: file,
    ...(file.type ? { mimeType: file.type } : {}),
    modifiedMs: file.lastModified,
  };
}

/**
 * What a drop carries, as exchange items: files and whole folders.
 *
 * Everything is read from the transfer before the first await, because the
 * browser empties it once the drop event returns. A dropped file is taken
 * as the transfer's own File; only folders are walked through entries. A
 * file entry's `file()` needs a backing path, which WebKit lacks for files
 * a page adds to a DataTransfer itself (it fails with NotFoundError).
 */
export async function collectDroppedItems(transfer: DataTransfer): Promise<ExchangeOfferItem[]> {
  const dropped = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }));
  const files = [...transfer.files];
  if (dropped.length === 0) return files.map((file) => itemFor(file));
  const out: ExchangeOfferItem[] = [];
  for (const { entry, file } of dropped) {
    if (out.length >= MAX_ENTRIES) break;
    if (entry?.isDirectory) await walk(entry, [], out);
    else if (file) out.push(itemFor(file));
  }
  return out;
}

/** Files chosen with a file picker. */
export function pickedItems(files: FileList | readonly File[]): ExchangeOfferItem[] {
  return [...files].map((file) => itemFor(file));
}

function carriesFiles(event: React.DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

/**
 * Drop handlers for a machine surface; `enabled` false (the machine is not
 * running) leaves drops to the browser.
 */
export function useExchangeDrop(enabled = true): {
  dragActive: boolean;
  refused: boolean;
  handlers: Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">;
} {
  const host = useKernelHost();
  const consumer = useExchangeConsumer();
  const [dragActive, setDragActive] = React.useState(false);
  const refused = consumer?.state === "unavailable";
  const handlers = React.useMemo(() => {
    if (!enabled) return {};
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = refused ? "none" : "copy";
        setDragActive(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      },
      onDrop: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragActive(false);
        if (refused) return;
        const exchange = host.getExchange();
        collectDroppedItems(event.dataTransfer).then(
          (items) => { if (items.length > 0) void exchange.offer(items, "drop"); },
          (error) => exchange.reportUnreadable(error instanceof Error ? error.message : String(error)),
        );
      },
    };
  }, [enabled, host, refused]);
  return { dragActive: enabled && dragActive, refused, handlers };
}
