import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import { ENOENT } from "../../../host/src/vfs/vfs-errors";
import { hasVfsErrorCode } from "../../../host/src/vfs/image-helpers";

const DIRECTORY = 0o040000;
const TYPE_MASK = 0o170000;

/** Inspect names and metadata only, including deferred files; never fetch data. */
export function assertKandeloFilesystemLayout(fs: VfsImageFilesystem): void {
  const failures: string[] = [];
  function exists(path: string): boolean {
    try { fs.lstat(path); return true; } catch (error) {
      if (hasVfsErrorCode(error, ENOENT)) return false;
      throw error;
    }
  }
  function entries(path: string): string[] {
    if (!exists(path)) return [];
    const handle = fs.opendir(path);
    const names: string[] = [];
    try {
      for (let entry = fs.readdir(handle); entry; entry = fs.readdir(handle)) {
        if (entry.name !== "." && entry.name !== "..") names.push(entry.name);
      }
    } finally { fs.closedir(handle); }
    return names;
  }
  function local(path: string): void {
    for (const name of entries(path)) {
      const child = `${path}/${name}`;
      if ((fs.lstat(child).mode & TYPE_MASK) === DIRECTORY) local(child);
      else failures.push(`${child}: /usr/local is reserved for the administrator`);
    }
  }
  local("/usr/local");
  function staticTree(path: string): void {
    for (const name of entries(path)) {
      const child = `${path}/${name}`;
      const stat = fs.lstat(child);
      if ((stat.mode & TYPE_MASK) === DIRECTORY) {
        if ((stat.mode & 0o002) !== 0) failures.push(`${child}: mutable data must not use a world-writable directory in /usr`);
        staticTree(child);
      }
    }
  }
  staticTree("/usr");
  for (const [essential, ordinary] of [["/bin", "/usr/bin"], ["/sbin", "/usr/sbin"]]) {
    for (const name of entries(essential)) {
      if (exists(`${ordinary}/${name}`)) failures.push(`${essential}/${name} duplicates ${ordinary}/${name}`);
    }
  }
  for (const path of ["/data", "/sqlite", "/php-src", "/mysql-test", "/var/www", "/usr/wasm32posix"]) {
    if (exists(path)) failures.push(`${path}: use the documented FHS location`);
  }
  if (failures.length) throw new Error(`Invalid Kandelo image layout:\n${failures.join("\n")}`);
}
