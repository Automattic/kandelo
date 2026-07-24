import type { BigIntStats } from "node:fs";
import type { StatResult } from "../types";

const MODE_CHANGE_MASK = 0o7777;
const UID_GID_UNCHANGED = 0xffffffff;
const SET_ID_BITS = 0o6000;
const EXECUTE_BITS = 0o111;
const X_OK = 0o1;
const W_OK = 0o2;
const R_OK = 0o4;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function overflow(field: string): Error & { code: string } {
  const error = new Error(
    `EOVERFLOW: ${field} is not exactly representable as a JavaScript number`,
  ) as Error & { code: string };
  error.code = "EOVERFLOW";
  return error;
}

function checkedNumber(value: bigint, field: string): number {
  if (value < MIN_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
    throw overflow(field);
  }
  return Number(value);
}

function checkedMilliseconds(valueNs: bigint, field: string): number {
  const wholeMilliseconds = valueNs / NANOSECONDS_PER_MILLISECOND;
  if (
    wholeMilliseconds < MIN_SAFE_INTEGER ||
    wholeMilliseconds > MAX_SAFE_INTEGER
  ) {
    throw overflow(field);
  }
  const fractionalMilliseconds = valueNs % NANOSECONDS_PER_MILLISECOND;
  return Number(wholeMilliseconds) + Number(fractionalMilliseconds) / 1_000_000;
}

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

  toStatResult(s: BigIntStats): StatResult {
    const nativeAtimeMs = checkedMilliseconds(s.atimeNs, "st_atime");
    const nativeMtimeMs = checkedMilliseconds(s.mtimeNs, "st_mtime");
    const nativeCtimeMs = checkedMilliseconds(s.ctimeNs, "st_ctime");
    const metadata = this.entries.get(this.key(s));
    if (metadata !== undefined) {
      this.reconcileNativeTimes(
        metadata,
        nativeAtimeMs,
        nativeMtimeMs,
        nativeCtimeMs,
      );
    }
    // On hosts that don't expose POSIX permission bits (Windows), replace the
    // native permission bits with synthesized ones so a privilege-dropped guest
    // can traverse and write host-backed mounts. Type bits are untouched, and a
    // guest chmod (metadata.mode) still wins.
    const nativeMode = checkedNumber(s.mode, "st_mode");
    const baseMode = SYNTHESIZE_POSIX_MODE
      ? synthesizePosixMode(nativeMode)
      : nativeMode;
    return {
      dev: s.dev,
      ino: s.ino,
      mode: metadata?.mode === undefined
        ? baseMode
        : (baseMode & ~MODE_CHANGE_MASK) | (metadata.mode & MODE_CHANGE_MASK),
      nlink: checkedNumber(s.nlink, "st_nlink"),
      uid: metadata?.uid ?? this.defaultUid,
      gid: metadata?.gid ?? this.defaultGid,
      size: checkedNumber(s.size, "st_size"),
      atimeMs: metadata?.atimeMs ?? nativeAtimeMs,
      mtimeMs: metadata?.mtimeMs ?? nativeMtimeMs,
      ctimeMs: metadata?.ctimeMs === undefined
        ? nativeCtimeMs
        : Math.max(metadata.ctimeMs, nativeCtimeMs),
    };
  }

  chmod(s: BigIntStats, mode: number): void {
    const metadata = this.metadataFor(s);
    metadata.mode = mode & MODE_CHANGE_MASK;
    metadata.ctimeMs = Date.now();
  }

  chown(s: BigIntStats, uid: number, gid: number): void {
    const metadata = this.metadataFor(s);
    if (uid !== UID_GID_UNCHANGED) metadata.uid = uid;
    if (gid !== UID_GID_UNCHANGED) metadata.gid = gid;
    const mode = metadata.mode ?? (checkedNumber(s.mode, "st_mode") & MODE_CHANGE_MASK);
    if (s.isFile() && (mode & EXECUTE_BITS) !== 0) {
      metadata.mode = mode & ~SET_ID_BITS;
    }
    metadata.ctimeMs = Date.now();
  }

  utimens(
    s: BigIntStats,
    atimeMs: number,
    mtimeMs: number,
    nativeAfter: BigIntStats,
  ): void {
    const metadata = this.metadataFor(s);
    const nativeAtimeMs = checkedMilliseconds(nativeAfter.atimeNs, "st_atime");
    const nativeMtimeMs = checkedMilliseconds(nativeAfter.mtimeNs, "st_mtime");
    const nativeCtimeMs = checkedMilliseconds(nativeAfter.ctimeNs, "st_ctime");
    metadata.atimeMs = atimeMs;
    metadata.mtimeMs = mtimeMs;
    metadata.nativeAtimeMs = nativeAtimeMs;
    metadata.nativeMtimeMs = nativeMtimeMs;
    metadata.nativeCtimeMs = nativeCtimeMs;
    metadata.ctimeMs = Math.max(metadata.ctimeMs ?? 0, nativeCtimeMs);
  }

  noteNativeContentChange(s: BigIntStats): void {
    const metadata = this.entries.get(this.key(s));
    if (metadata === undefined) return;
    this.clearTimeOverrides(metadata);
  }

  forget(s: BigIntStats): void {
    this.entries.delete(this.key(s));
  }

  access(s: BigIntStats, amode: number): void {
    const mode = this.toStatResult(s).mode;
    if ((amode & R_OK) !== 0 && (mode & 0o444) === 0) throw new Error("EACCES");
    if ((amode & W_OK) !== 0 && (mode & 0o222) === 0) throw new Error("EACCES");
    if ((amode & X_OK) !== 0 && (mode & 0o111) === 0) throw new Error("EACCES");
  }

  private metadataFor(s: BigIntStats): VirtualMetadata {
    const key = this.key(s);
    let metadata = this.entries.get(key);
    if (metadata === undefined) {
      metadata = {};
      this.entries.set(key, metadata);
    }
    return metadata;
  }

  private reconcileNativeTimes(
    metadata: VirtualMetadata,
    nativeAtimeMs: number,
    nativeMtimeMs: number,
    nativeCtimeMs: number,
  ): void {
    if (metadata.nativeCtimeMs === undefined) return;

    const nativeMetadataChanged = nativeCtimeMs !== metadata.nativeCtimeMs;
    if (
      nativeMetadataChanged ||
      (metadata.nativeAtimeMs !== undefined && nativeAtimeMs !== metadata.nativeAtimeMs)
    ) {
      delete metadata.atimeMs;
      delete metadata.nativeAtimeMs;
    }
    if (
      nativeMetadataChanged ||
      (metadata.nativeMtimeMs !== undefined && nativeMtimeMs !== metadata.nativeMtimeMs)
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

  private key(s: BigIntStats): string {
    return `${s.dev}:${s.ino}`;
  }
}
