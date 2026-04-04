/**
 * Python stdlib filesystem bundle loader.
 *
 * Loads a pre-built Python stdlib bundle (JSON manifest + file data) into
 * the kernel's MemoryFileSystem. Same format as wp-bundle.
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
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    bytes[pos++] = (n >> 16) & 0xff;
    if (pos < bytes.length) bytes[pos++] = (n >> 8) & 0xff;
    if (pos < bytes.length) bytes[pos++] = n & 0xff;
  }
  return bytes;
}

/**
 * Load a Python stdlib bundle into the given MemoryFileSystem.
 */
export async function loadPythonBundle(
  fs: MemoryFileSystem,
  bundleUrl: string,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to load Python stdlib bundle from ${bundleUrl} (${response.status}). ` +
      `Run: bash examples/browser/scripts/build-python-bundle.sh`
    );
  }
  const bundle: Bundle = await response.json();

  const createdDirs = new Set<string>();

  function ensureDir(dirPath: string) {
    if (createdDirs.has(dirPath) || dirPath === "/" || dirPath === "") return;
    const parent = dirPath.substring(0, dirPath.lastIndexOf("/")) || "/";
    ensureDir(parent);
    if (!createdDirs.has(dirPath)) {
      try {
        fs.mkdir(dirPath, 0o755);
      } catch {
        /* exists */
      }
      createdDirs.add(dirPath);
    }
  }

  let loaded = 0;
  for (const entry of bundle.files) {
    const dir = entry.path.substring(0, entry.path.lastIndexOf("/"));
    ensureDir(dir);

    const data = base64Decode(entry.data);
    const fd = fs.open(entry.path, 0o102, 0o644); // O_WRONLY | O_CREAT
    fs.write(fd, data, 0, data.length);
    fs.close(fd);

    loaded++;
    if (onProgress && loaded % 50 === 0) {
      onProgress(loaded, bundle.files.length);
    }
  }

  if (onProgress) onProgress(loaded, bundle.files.length);
  return loaded;
}
