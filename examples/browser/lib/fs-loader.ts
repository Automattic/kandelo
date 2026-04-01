/**
 * Filesystem loader — populate MemoryFileSystem from fetched data.
 */
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

/**
 * A file entry to load into the filesystem.
 * Provide either `url` (fetched at load time) or `data` (inline content).
 */
export interface FileEntry {
  path: string;
  url?: string;
  data?: Uint8Array | string;
  mode?: number;
}

/**
 * Ensure all parent directories exist for a given path.
 */
function ensureParentDirs(memfs: MemoryFileSystem, filePath: string): void {
  const parts = filePath.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current += "/" + parts[i];
    try {
      memfs.mkdir(current, 0o755);
    } catch {
      // Directory may already exist
    }
  }
}

/**
 * Load a list of files into a MemoryFileSystem.
 * Files with `url` are fetched in parallel.
 */
export async function loadFiles(
  memfs: MemoryFileSystem,
  files: FileEntry[],
): Promise<void> {
  // Separate URL-based and inline files
  const urlFiles = files.filter((f) => f.url);
  const inlineFiles = files.filter((f) => f.data !== undefined);

  // Write inline files first
  for (const file of inlineFiles) {
    ensureParentDirs(memfs, file.path);
    const data =
      typeof file.data === "string"
        ? new TextEncoder().encode(file.data)
        : file.data!;
    const fd = memfs.open(file.path, 0o1101, file.mode ?? 0o644); // O_WRONLY | O_CREAT | O_TRUNC
    memfs.write(fd, data, 0, data.length);
    memfs.close(fd);
  }

  // Fetch URL-based files in parallel
  if (urlFiles.length > 0) {
    const results = await Promise.all(
      urlFiles.map(async (file) => {
        const resp = await fetch(file.url!);
        if (!resp.ok)
          throw new Error(`Failed to fetch ${file.url}: ${resp.status}`);
        const data = new Uint8Array(await resp.arrayBuffer());
        return { path: file.path, data, mode: file.mode };
      }),
    );

    for (const { path, data, mode } of results) {
      ensureParentDirs(memfs, path);
      const fd = memfs.open(path, 0o1101, mode ?? 0o644); // O_WRONLY | O_CREAT | O_TRUNC
      memfs.write(fd, data, 0, data.length);
      memfs.close(fd);
    }
  }
}

/**
 * Load a tar archive (uncompressed) into a MemoryFileSystem.
 * Useful for loading entire directory trees (nginx config, WordPress, etc.)
 */
export async function loadTar(
  memfs: MemoryFileSystem,
  url: string,
  stripPrefix?: string,
): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch tar ${url}: ${resp.status}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  extractTar(memfs, data, stripPrefix);
}

/**
 * Extract a tar archive into a MemoryFileSystem.
 */
function extractTar(
  memfs: MemoryFileSystem,
  data: Uint8Array,
  stripPrefix?: string,
): void {
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset + 512 <= data.length) {
    // Check for end-of-archive (two zero blocks)
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    // Parse tar header
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const modeStr = decoder
      .decode(header.subarray(100, 108))
      .replace(/\0.*$/, "")
      .trim();
    const sizeStr = decoder
      .decode(header.subarray(124, 136))
      .replace(/\0.*$/, "")
      .trim();
    const typeFlag = header[156];

    const mode = parseInt(modeStr, 8) || 0o644;
    const size = parseInt(sizeStr, 8) || 0;

    let filePath = name.startsWith("./") ? name.slice(1) : "/" + name;
    if (stripPrefix && filePath.startsWith(stripPrefix)) {
      filePath = filePath.slice(stripPrefix.length);
    }
    if (!filePath.startsWith("/")) filePath = "/" + filePath;
    // Remove trailing slash for directories
    if (filePath.endsWith("/") && filePath.length > 1) {
      filePath = filePath.slice(0, -1);
    }

    offset += 512; // Move past header

    if (typeFlag === 53 || name.endsWith("/")) {
      // Directory
      ensureParentDirs(memfs, filePath + "/dummy");
      try {
        memfs.mkdir(filePath, mode);
      } catch {
        // Already exists
      }
    } else if (typeFlag === 0 || typeFlag === 48) {
      // Regular file (type '0' or '\0')
      ensureParentDirs(memfs, filePath);
      const fileData = data.subarray(offset, offset + size);
      const fd = memfs.open(filePath, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
      memfs.write(fd, fileData, 0, fileData.length);
      memfs.close(fd);
    }
    // Skip symlinks, hardlinks, etc. for now

    // Advance past data blocks (512-byte aligned)
    offset += Math.ceil(size / 512) * 512;
  }
}
