import type { Stats } from "node:fs";
import type { StatResult } from "../types";
import { ACCESS_MODES, FILE_MODES } from "../generated/abi";

const UID_GID_UNCHANGED = 0xffffffff;
const MODE_CHANGE_MASK = FILE_MODES.S_MODE_BITS;
const READABLE_BITS =
  FILE_MODES.S_IRUSR | FILE_MODES.S_IRGRP | FILE_MODES.S_IROTH;
const WRITABLE_BITS =
  FILE_MODES.S_IWUSR | FILE_MODES.S_IWGRP | FILE_MODES.S_IWOTH;
const EXECUTABLE_BITS =
  FILE_MODES.S_IXUSR | FILE_MODES.S_IXGRP | FILE_MODES.S_IXOTH;

interface VirtualMetadata {
  mode?: number;
  uid?: number;
  gid?: number;
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
      atimeMs: s.atimeMs,
      mtimeMs: s.mtimeMs,
      ctimeMs: metadata?.ctimeMs ?? s.ctimeMs,
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

  forget(s: Stats): void {
    this.entries.delete(this.key(s));
  }

  access(s: Stats, amode: number): void {
    const mode = this.toStatResult(s).mode;
    if ((amode & ACCESS_MODES.R_OK) !== 0 && (mode & READABLE_BITS) === 0) {
      throw new Error("EACCES");
    }
    if ((amode & ACCESS_MODES.W_OK) !== 0 && (mode & WRITABLE_BITS) === 0) {
      throw new Error("EACCES");
    }
    if ((amode & ACCESS_MODES.X_OK) !== 0 && (mode & EXECUTABLE_BITS) === 0) {
      throw new Error("EACCES");
    }
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
