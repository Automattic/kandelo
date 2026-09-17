import type { DirEntry, FileSystemBackend } from "../../src/vfs/types";
import type { StatResult, StatfsResult } from "../../src/types";

/** One entry in a backend that answers about a fixed set of paths. */
export interface FixedEntry {
  /** Full mode, type bits included: 0o100000 for a file, 0o040000 for a dir. */
  mode: number;
  uid?: number;
  gid?: number;
  ino: number;
  size?: number;
}

/**
 * A `FileSystemBackend` over a tree the test writes out, not over storage.
 *
 * WHY A FAKE RATHER THAN A FILESYSTEM. The tests that need this are about
 * MOUNT POLICY and FILE IDENTITY — whether `nosuid` strips a set-ID bit,
 * whether two mounts of one backend name the same object — and a real
 * filesystem answers those only incidentally. `MemoryFileSystem` served the
 * role because it existed; what the role actually needs is an object that
 * reports a stat the test chose, including an inode number it chose, which no
 * real filesystem lets you pick.
 *
 * Everything outside that role throws ENOSYS rather than pretending. A test
 * that started depending on one of those would say so, instead of passing
 * quietly over a stub that returned something plausible.
 */
export class FixedTreeBackend implements FileSystemBackend {
  #nextHandle = 1;
  readonly #handles = new Map<number, string>();
  readonly #entries: Map<string, FixedEntry>;

  constructor(entries: Record<string, FixedEntry>) {
    this.#entries = new Map(Object.entries(entries));
    if (!this.#entries.has("/")) {
      this.#entries.set("/", { mode: 0o040755, ino: 1 });
    }
  }

  #entry(path: string): FixedEntry {
    const entry = this.#entries.get(path === "" ? "/" : path);
    if (entry === undefined) {
      const error = new Error(`no such file: ${path}`) as Error & { code: number };
      error.code = -2; // ENOENT
      throw error;
    }
    return entry;
  }

  #statOf(path: string): StatResult {
    const entry = this.#entry(path);
    return {
      dev: 1,
      ino: entry.ino,
      mode: entry.mode,
      nlink: 1,
      uid: entry.uid ?? 0,
      gid: entry.gid ?? 0,
      size: entry.size ?? 0,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
    };
  }

  #unsupported(name: string): never {
    const error = new Error(`FixedTreeBackend does not implement ${name}`) as
      Error & { code: number };
    error.code = -38; // ENOSYS
    throw error;
  }

  open(path: string): number {
    this.#entry(path);
    const handle = this.#nextHandle++;
    this.#handles.set(handle, path);
    return handle;
  }

  close(handle: number): number {
    this.#handles.delete(handle);
    return 0;
  }

  stat(path: string): StatResult {
    return this.#statOf(path);
  }

  lstat(path: string): StatResult {
    return this.#statOf(path);
  }

  fstat(handle: number): StatResult {
    const path = this.#handles.get(handle);
    if (path === undefined) this.#unsupported("fstat on an unknown handle");
    return this.#statOf(path);
  }

  /**
   * Asked on every open, for the mount's `ST_NOSUID` flag — so it is part of
   * opening a file rather than an operation a test opted into. The numbers are
   * plausible and unread; what callers use is the flags word, which
   * `VirtualPlatformIO` sets from the MOUNT rather than from here.
   */
  statfs(): StatfsResult {
    return {
      type: 0,
      bsize: 4096,
      blocks: 1024,
      bfree: 1024,
      bavail: 1024,
      files: 1024,
      ffree: 1023,
      fsid: 0,
      namelen: 255,
      frsize: 4096,
      flags: 0,
    };
  }

  read(): number { this.#unsupported("read"); }
  write(): number { this.#unsupported("write"); }
  append(): never { this.#unsupported("append"); }
  seek(): never { this.#unsupported("seek"); }
  fpathconf(): never { this.#unsupported("fpathconf"); }
  ftruncate(): void { this.#unsupported("ftruncate"); }
  fsync(): void { this.#unsupported("fsync"); }
  fchmod(): void { this.#unsupported("fchmod"); }
  fchown(): void { this.#unsupported("fchown"); }
  pathconf(): never { this.#unsupported("pathconf"); }
  mkdir(): void { this.#unsupported("mkdir"); }
  rmdir(): void { this.#unsupported("rmdir"); }
  unlink(): void { this.#unsupported("unlink"); }
  rename(): void { this.#unsupported("rename"); }
  link(): void { this.#unsupported("link"); }
  symlink(): void { this.#unsupported("symlink"); }
  readlink(): string { this.#unsupported("readlink"); }
  chmod(): void { this.#unsupported("chmod"); }
  chown(): void { this.#unsupported("chown"); }
  lchown(): void { this.#unsupported("lchown"); }
  utimensat(): void { this.#unsupported("utimensat"); }
  opendir(): number { this.#unsupported("opendir"); }
  readdir(): DirEntry | null { this.#unsupported("readdir"); }
  closedir(): void { this.#unsupported("closedir"); }
}
