import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { KernelVfsDirEntry, KernelVfsReader } from "../../../../../web-libs/kandelo-session/src/kernel-host";

const CHUNK_SIZE = 256 * 1024;
const ZIP_LIMIT = 0xffffffff;
export const BUFFERED_ZIP_LIMIT = 256 * 1024 * 1024;
export const EXCLUDED_EXPORT_PATHS = ["/dev", "/proc", "/sys"];

export function excludedExportPath(path: string): boolean {
  return EXCLUDED_EXPORT_PATHS.some(root => path === root || path.startsWith(`${root}/`));
}

export function exportChildPath(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || /[\0/\\]/u.test(name)) throw new Error(`Cannot export an unsafe filename: ${name}`);
  return `${parent === "/" ? "" : parent}/${name}`;
}

export interface ExportProgress { path: string; files: number; bytes: number; skipped: number; unchanged: number }
export interface ExportSink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Walk the live namespace through its owner; never follow symlinks or read devices. */
export async function exportFilesZip(
  reader: KernelVfsReader, root: string, sink: ExportSink, signal: AbortSignal,
  onProgress: (progress: ExportProgress) => void,
  reference?: KernelVfsReader,
): Promise<ExportProgress> {
  const progress: ExportProgress = { path: root, files: 0, bytes: 0, skipped: 0, unchanged: 0 };
  let entries = 0;
  let outputBytes = 0;
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.length) pending.push(chunk);
  });
  const check = () => signal.throwIfAborted();
  const read = async <T>(operation: Promise<T>): Promise<T> => {
    check();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    // The worker may still finish its current read; cancellation prevents
    // retaining its result or waiting for lazy-file I/O before aborting the ZIP.
    try { return await Promise.race([operation, cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  };
  const flush = async () => {
    if (zipError) throw zipError;
    for (const chunk of pending) {
      check();
      outputBytes += chunk.length;
      if (outputBytes >= ZIP_LIMIT) throw new Error("This export exceeds the ZIP format's 4 GB limit. Export smaller folders.");
      await sink.write(chunk);
      check();
    }
    pending = [];
  };
  const add = (name: string, metadata: KernelVfsDirEntry, directory: boolean) => {
    if (++entries >= 65535) throw new Error("This export has too many entries for a ZIP. Export smaller folders.");
    // Synchronous compression of bounded chunks lets flush() enforce sink
    // backpressure before the next read, without queuing a file in a worker.
    const entry = directory || (metadata.mode & 0xf000) === 0xa000
      ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 1 });
    entry.os = 3;
    entry.attrs = ((metadata.mode << 16) | (directory ? 16 : 0)) >>> 0;
    zip.add(entry);
    return entry;
  };
  const sameMetadata = (current: KernelVfsDirEntry, original?: KernelVfsDirEntry): boolean => original !== undefined
    && current.mode === original.mode && current.uid === original.uid && current.gid === original.gid;
  const sameContents = async (path: string, size: number): Promise<boolean> => {
    for (let offset = 0; offset < size || offset === 0; offset += CHUNK_SIZE) {
      check();
      const length = Math.max(1, Math.min(CHUNK_SIZE, size - offset));
      const [current, original] = await read(Promise.all([
        reader.readRange(path, offset, length), reference!.readRange(path, offset, length),
      ]));
      check();
      const expected = Math.min(length, size - offset);
      if (!current || !original || current.length !== expected || original.length !== expected) throw new Error(`Cannot compare file: ${path}. It may have changed during export.`);
      progress.bytes += current.length;
      onProgress({ ...progress });
      if (current.some((byte, index) => byte !== original[index])) return false;
      if (size === 0) break;
    }
    return true;
  };
  const walk = async (path: string, relative: string, depth: number, hasReferenceFolder: boolean): Promise<void> => {
    check();
    if (depth > 256) throw new Error(`Directory nesting is too deep: ${path}`);
    const children = await read(reader.readDir(path));
    check();
    if (!children) throw new Error(`Cannot read folder: ${path}`);
    const originals = hasReferenceFolder ? await read(reference!.readDir(path)) : [];
    if (!originals) throw new Error(`Cannot read reference folder: ${path}`);
    const originalByName = new Map(originals.map(entry => [entry.name, entry]));
    for (const child of children) {
      check();
      if (child.name === "." || child.name === "..") continue;
      const fullPath = exportChildPath(path, child.name);
      progress.path = fullPath;
      const kind = child.mode & 0xf000;
      if (excludedExportPath(fullPath) || ![0x4000, 0x8000, 0xa000].includes(kind)) {
        progress.skipped++;
        onProgress({ ...progress });
        continue;
      }
      const name = relative + child.name;
      const original = originalByName.get(child.name);
      const originalKind = original === undefined ? 0 : original.mode & 0xf000;
      if (new TextEncoder().encode(name).length > 65534) throw new Error(`Filename is too long for a ZIP: ${fullPath}`);
      if (kind === 0x4000) {
        const before = entries;
        await walk(fullPath, `${name}/`, depth + 1, reference !== undefined && originalKind === 0x4000);
        if (!reference || !sameMetadata(child, original) || entries > before) {
          add(`${name}/`, child, true).push(new Uint8Array(0), true);
          await flush();
        }
      } else if (kind === 0xa000) {
        if (child.target === undefined) throw new Error(`Cannot read symbolic link: ${fullPath}`);
        if (reference && sameMetadata(child, original) && original?.target === child.target) {
          progress.unchanged++;
          onProgress({ ...progress });
          continue;
        }
        add(name, child, false).push(new TextEncoder().encode(child.target), true);
        await flush();
        progress.files++;
      } else {
        if (!Number.isSafeInteger(child.size) || child.size < 0 || child.size >= ZIP_LIMIT) throw new Error(`File is too large for a ZIP: ${fullPath}`);
        if (reference && sameMetadata(child, original) && original?.size === child.size && await sameContents(fullPath, child.size)) {
          progress.unchanged++;
          onProgress({ ...progress });
          continue;
        }
        const entry = add(name, child, false);
        for (let offset = 0; offset < child.size;) {
          check();
          const length = Math.min(CHUNK_SIZE, child.size - offset);
          const bytes = await read(reader.readRange(fullPath, offset, length));
          check();
          if (!bytes || bytes.length !== length) throw new Error(`Cannot finish reading ${fullPath}. It may have changed during export.`);
          offset += bytes.length;
          progress.bytes += bytes.length;
          entry.push(bytes, false);
          await flush();
          onProgress({ ...progress });
        }
        // Observe empty files too: listing a file does not prove it is readable.
        if (child.size === 0 && await read(reader.readRange(fullPath, 0, 1)) === null) throw new Error(`Cannot read file: ${fullPath}`);
        check();
        entry.push(new Uint8Array(0), true);
        await flush();
        progress.files++;
      }
      onProgress({ ...progress });
      // Compression and in-memory sinks must still yield to Cancel and repaint.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  };
  try {
    if (!root.startsWith("/") || root.includes("\0") || root.split("/").some(part => part === "." || part === "..") || excludedExportPath(root)) throw new Error("Choose a regular folder inside Kandelo.");
    let hasReferenceFolder = reference !== undefined;
    let referencePath = "/";
    if (reference) {
      // Resolve each selected path component without following a reference
      // symlink: a replaced directory is an entirely new tree at that path.
      for (const part of root.split("/").filter(Boolean)) {
        const originalParent = await read(reference.readDir(referencePath));
        if (!originalParent) throw new Error(`Cannot read reference folder: ${referencePath}`);
        const entry = originalParent.find(child => child.name === part);
        if (!entry || (entry.mode & 0xf000) !== 0x4000) { hasReferenceFolder = false; break; }
        referencePath = exportChildPath(referencePath, part);
      }
    }
    await walk(root, "", 0, hasReferenceFolder);
    check();
    zip.end();
    await flush();
    check();
    await sink.close();
    return progress;
  } catch (error) {
    zip.terminate();
    pending = [];
    await sink.abort().catch(() => {});
    throw error;
  }
}

type SaveFilePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
  createWritable(): Promise<WritableStream<Uint8Array<ArrayBuffer>>>;
}>;

export function supportsStreamingExport(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker === "function";
}

/** Call from the download gesture, before filesystem work consumes activation. */
export async function createExportSink(name: string, signal: AbortSignal): Promise<ExportSink> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName: name, types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }] });
    signal.throwIfAborted();
    const writer = (await handle.createWritable()).getWriter();
    const abort = () => { void writer.abort(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      write: async chunk => { signal.throwIfAborted(); await writer.write(chunk); },
      close: async () => { try { await writer.close(); } finally { signal.removeEventListener("abort", abort); } },
      abort: async () => { signal.removeEventListener("abort", abort); await writer.abort(); },
    };
  }
  let chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  return {
    write: async chunk => {
      signal.throwIfAborted();
      length += chunk.length;
      if (length > BUFFERED_ZIP_LIMIT) throw new Error("This browser can buffer up to 256 MB per export. Export smaller folders, or use a browser with a streaming save picker.");
      chunks.push(chunk);
    },
    close: async () => {
      signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob(chunks, { type: "application/zip" }));
      chunks = [];
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => { chunks = []; },
  };
}
