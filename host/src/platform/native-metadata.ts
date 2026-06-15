import type { Stats } from "node:fs";
import type { StatResult } from "../types";

const MODE_CHANGE_MASK = 0o7777;
const UID_GID_UNCHANGED = 0xffffffff;
const X_OK = 0o1;
const W_OK = 0o2;
const R_OK = 0o4;

interface VirtualMetadata {
  mode?: number;
  uid?: number;
  gid?: number;
  atimeMs?: number;
  mtimeMs?: number;
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

  toStatResult(s: Stats): StatResult {
    const metadata = this.entries.get(this.key(s));
    return {
      dev: s.dev,
      ino: s.ino,
      mode: metadata?.mode === undefined
        ? s.mode
        : (s.mode & ~MODE_CHANGE_MASK) | (metadata.mode & MODE_CHANGE_MASK),
      nlink: s.nlink,
      uid: metadata?.uid ?? 0,
      gid: metadata?.gid ?? 0,
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

  utimens(s: Stats, atimeMs: number, mtimeMs: number, ctimeMs = Date.now()): void {
    const metadata = this.metadataFor(s);
    metadata.atimeMs = atimeMs;
    metadata.mtimeMs = mtimeMs;
    metadata.ctimeMs = Math.max(metadata.ctimeMs ?? 0, ctimeMs);
  }

  noteNativeContentChange(s: Stats): void {
    const metadata = this.entries.get(this.key(s));
    if (metadata === undefined) return;
    delete metadata.atimeMs;
    delete metadata.mtimeMs;
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

  private key(s: Stats): string {
    return `${s.dev}:${s.ino}`;
  }
}
