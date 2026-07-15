import type { Stats } from "node:fs";
import type { StatResult } from "../types";

const MODE_CHANGE_MASK = 0o7777;
const UID_GID_UNCHANGED = 0xffffffff;
const X_OK = 0o1;
const W_OK = 0o2;
const R_OK = 0o4;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/**
 * Windows has no POSIX permission model: `fs.statSync` reports every entry as
 * `0o666` (writable) or `0o444` (read-only), with no owner/group/other split
 * and no execute/search bit on directories, and `chmod` cannot set an execute
 * bit on a directory or otherwise express POSIX bits. Two things break for a
 * guest process that drops privileges (e.g. a php-fpm worker running as a
 * non-root uid):
 *
 *   - Directory lookup enforces `X_OK` on every path component, so with no
 *     search bit the worker can't traverse any host-backed directory.
 *   - The worker often has to *write* into the mount (WordPress writes its
 *     SQLite database, uploads, and cache under the mounted tree). Hosts grant
 *     this by `chmod`-ing those directories world-writable — a no-op on Windows
 *     that also never reaches this overlay, so the intent is invisible here.
 *
 * This is a host-platform boundary, not a POSIX gap in the kernel: Windows ACLs
 * don't map to POSIX bits, so the kernel can't enforce them anyway. Represent
 * host-backed entries as world-accessible — `0o777` directories, `0o666` files
 * — so a privilege-dropped guest can both traverse and write the sandbox it was
 * given, while still honoring the one attribute Windows does expose by mapping
 * read-only entries to `0o555`/`0o444`. Type bits come from the native mode, and
 * a genuine host-level read-only file still fails its write at the native fs
 * layer. Guest `chmod`/`chown` continue to override through the overlay.
 */
const SYNTHESIZE_POSIX_MODE = process.platform === "win32";

export function synthesizePosixMode(nativeMode: number): number {
  const type = nativeMode & S_IFMT;
  // Node sets the owner-write bit (0o200) only when the entry is not
  // read-only; use it to carry the read-only attribute across.
  const writable = (nativeMode & 0o200) !== 0;
  let perms: number;
  if (type === S_IFDIR) perms = writable ? 0o777 : 0o555;
  else if (type === S_IFLNK) perms = 0o777;
  else perms = writable ? 0o666 : 0o444;
  return type | perms;
}

interface VirtualMetadata {
  mode?: number;
  uid?: number;
  gid?: number;
  atimeMs?: number;
  mtimeMs?: number;
  nativeAtimeMs?: number;
  nativeMtimeMs?: number;
  nativeCtimeMs?: number;
  ctimeMs?: number;
}

/**
 * Metadata overlay for Node-backed files.
 *
 * The host filesystem stores bytes and directory entries, but guest chmod/chown
 * must not mutate native permission or ownership bits. Entries are keyed by the
 * native dev/ino pair so path and fd operations observe the same virtual inode.
 */
export class NativeMetadataOverlay {
  private readonly entries = new Map<string, VirtualMetadata>();

  constructor(
    private readonly defaultUid = 0,
    private readonly defaultGid = 0,
  ) {}

  toStatResult(s: Stats): StatResult {
    const metadata = this.entries.get(this.key(s));
    if (metadata !== undefined) this.reconcileNativeTimes(metadata, s);
    // On hosts that don't expose POSIX permission bits (Windows), replace the
    // native permission bits with synthesized ones so a privilege-dropped guest
    // can traverse and write host-backed mounts. Type bits are untouched, and a
    // guest chmod (metadata.mode) still wins.
    const baseMode = SYNTHESIZE_POSIX_MODE ? synthesizePosixMode(s.mode) : s.mode;
    return {
      dev: s.dev,
      ino: s.ino,
      mode: metadata?.mode === undefined
        ? baseMode
        : (baseMode & ~MODE_CHANGE_MASK) | (metadata.mode & MODE_CHANGE_MASK),
      nlink: s.nlink,
      uid: metadata?.uid ?? this.defaultUid,
      gid: metadata?.gid ?? this.defaultGid,
      size: s.size,
      atimeMs: metadata?.atimeMs ?? s.atimeMs,
      mtimeMs: metadata?.mtimeMs ?? s.mtimeMs,
      ctimeMs: metadata?.ctimeMs === undefined
        ? s.ctimeMs
        : Math.max(metadata.ctimeMs, s.ctimeMs),
    };
  }

  chmod(s: Stats, mode: number): void {
    const metadata = this.metadataFor(s);
    metadata.mode = mode & MODE_CHANGE_MASK;
    metadata.ctimeMs = Date.now();
  }

  chown(s: Stats, uid: number, gid: number): void {
    const metadata = this.metadataFor(s);
    if (uid !== UID_GID_UNCHANGED) metadata.uid = uid;
    if (gid !== UID_GID_UNCHANGED) metadata.gid = gid;
    metadata.ctimeMs = Date.now();
  }

  utimens(
    s: Stats,
    atimeMs: number,
    mtimeMs: number,
    nativeAfter: Stats,
  ): void {
    const metadata = this.metadataFor(s);
    metadata.atimeMs = atimeMs;
    metadata.mtimeMs = mtimeMs;
    metadata.nativeAtimeMs = nativeAfter.atimeMs;
    metadata.nativeMtimeMs = nativeAfter.mtimeMs;
    metadata.nativeCtimeMs = nativeAfter.ctimeMs;
    metadata.ctimeMs = Math.max(metadata.ctimeMs ?? 0, nativeAfter.ctimeMs);
  }

  noteNativeContentChange(s: Stats): void {
    const metadata = this.entries.get(this.key(s));
    if (metadata === undefined) return;
    this.clearTimeOverrides(metadata);
  }

  forget(s: Stats): void {
    this.entries.delete(this.key(s));
  }

  access(s: Stats, amode: number): void {
    const mode = this.toStatResult(s).mode;
    if ((amode & R_OK) !== 0 && (mode & 0o444) === 0) throw new Error("EACCES");
    if ((amode & W_OK) !== 0 && (mode & 0o222) === 0) throw new Error("EACCES");
    if ((amode & X_OK) !== 0 && (mode & 0o111) === 0) throw new Error("EACCES");
  }

  private metadataFor(s: Stats): VirtualMetadata {
    const key = this.key(s);
    let metadata = this.entries.get(key);
    if (metadata === undefined) {
      metadata = {};
      this.entries.set(key, metadata);
    }
    return metadata;
  }

  private reconcileNativeTimes(metadata: VirtualMetadata, s: Stats): void {
    if (metadata.nativeCtimeMs === undefined) return;

    const nativeMetadataChanged = s.ctimeMs !== metadata.nativeCtimeMs;
    if (
      nativeMetadataChanged ||
      (metadata.nativeAtimeMs !== undefined && s.atimeMs !== metadata.nativeAtimeMs)
    ) {
      delete metadata.atimeMs;
      delete metadata.nativeAtimeMs;
    }
    if (
      nativeMetadataChanged ||
      (metadata.nativeMtimeMs !== undefined && s.mtimeMs !== metadata.nativeMtimeMs)
    ) {
      delete metadata.mtimeMs;
      delete metadata.nativeMtimeMs;
    }

    if (metadata.atimeMs === undefined && metadata.mtimeMs === undefined) {
      delete metadata.nativeCtimeMs;
    }
  }

  private clearTimeOverrides(metadata: VirtualMetadata): void {
    delete metadata.atimeMs;
    delete metadata.mtimeMs;
    delete metadata.nativeAtimeMs;
    delete metadata.nativeMtimeMs;
    delete metadata.nativeCtimeMs;
  }

  private key(s: Stats): string {
    return `${s.dev}:${s.ino}`;
  }
}
