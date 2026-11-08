import { extractZipEntryBounded, parseZipCentralDirectory } from "../../src/vfs/zip";

/** Seed only the resolver-prepared source fixture, never host Cargo caches. */
export function rustNativeDependencyFiles(archive: Uint8Array): Record<string, string> {
  if (archive.byteLength > 8 * 1024 ** 2) throw new Error("native source fixture exceeds ZIP budget");
  const entries = parseZipCentralDirectory(archive);
  if (entries.length > 512) throw new Error("native source fixture exceeds entry budget");
  const files: Record<string, string> = {};
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const path = entry.fileName;
    if (entry.isSymlink || path.includes("\\") || path.includes("\0") ||
        path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`invalid native source fixture path: ${path}`);
    }
    total += entry.uncompressedSize;
    if (total > 16 * 1024 ** 2) throw new Error("native source fixture exceeds content budget");
    const key = `ecosystem/${path}`;
    if (Object.hasOwn(files, key)) throw new Error(`duplicate native source fixture path: ${path}`);
    files[key] = decoder.decode(extractZipEntryBounded(archive, entry, entry.uncompressedSize));
  }
  for (const path of ["Cargo.lock", "build.rs", "vendor/cc-1.2.61/Cargo.toml", ".cargo/config.toml"]) {
    if (!Object.hasOwn(files, `ecosystem/${path}`)) throw new Error(`missing native source fixture: ${path}`);
  }
  return files;
}
