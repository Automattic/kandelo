/**
 * Vim runtime filesystem bundle loader.
 *
 * Loads a pre-built Vim runtime bundle (syntax files, filetype detection,
 * defaults) into the kernel's MemoryFileSystem under /usr/share/vim/vim91/.
 *
 * Bundle format: { files: Array<{ path: string, data: string }> }
 * where data is base64-encoded file contents.
 */
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

interface BundleEntry {
  path: string;
  data: string; // base64
}

interface Bundle {
  files: BundleEntry[];
}

const b64Chars =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(str: string): Uint8Array {
  const pad = str.endsWith("==") ? 2 : str.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(((str.length * 3) / 4) - pad);
  let pos = 0;
  for (let i = 0; i < str.length; i += 4) {
    const a = b64Chars.indexOf(str[i]);
    const b = b64Chars.indexOf(str[i + 1]);
    const c = b64Chars.indexOf(str[i + 2]);
    const d = b64Chars.indexOf(str[i + 3]);
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    bytes[pos++] = (triplet >> 16) & 0xff;
    if (pos < bytes.length) bytes[pos++] = (triplet >> 8) & 0xff;
    if (pos < bytes.length) bytes[pos++] = triplet & 0xff;
  }
  return bytes;
}

function ensureParentDirs(fs: MemoryFileSystem, filePath: string): void {
  const parts = filePath.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current += "/" + parts[i];
    try {
      fs.mkdir(current, 0o755);
    } catch {
      /* already exists */
    }
  }
}

/**
 * Load the Vim runtime bundle into the virtual filesystem.
 *
 * @param fs       — MemoryFileSystem instance
 * @param bundleUrl — URL to the vim-runtime-bundle.json file
 * @returns Number of files loaded
 */
export async function loadVimRuntime(
  fs: MemoryFileSystem,
  bundleUrl: string,
): Promise<number> {
  const resp = await fetch(bundleUrl);
  if (!resp.ok) {
    console.warn(`Failed to fetch Vim runtime bundle: ${resp.status}`);
    return 0;
  }

  const bundle: Bundle = await resp.json();

  for (const entry of bundle.files) {
    const data = base64Decode(entry.data);
    ensureParentDirs(fs, entry.path);

    const fd = fs.open(entry.path, 0x241, 0o644); // O_WRONLY | O_CREAT | O_TRUNC
    fs.write(fd, data, null, data.length);
    fs.close(fd);
  }

  return bundle.files.length;
}
