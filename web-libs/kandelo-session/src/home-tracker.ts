// Home tracker — what changed in a running machine's home directory since its
// last save.
//
// Each read of the home lists every entry. A file whose fingerprint (inode,
// size, modification and change time) the tracker already holds comes back
// without bytes and is unchanged. Any other file is read whole and compared
// with the saved copy by content, so a file read again for safety is not
// saved again. A file modified less than RECENT_CHANGE_MS ago is always read:
// two writes within one clock tick can leave its fingerprint as it was, the
// race git's index calls "racily clean".
//
// The saved state travels without bytes: a tracker built from another
// tracker's `states()` diffs a home against a saved copy kept elsewhere.

import type { VfsTreeEntry, VfsTreeFingerprints } from "./kernel-host";
import type { SavedMachineChanges, SavedMachineEntry } from "./saved-machine";

export const RECENT_CHANGE_MS = 1000;

export type SavedState =
  | { readonly kind: "directory"; readonly mode: number; readonly uid: number; readonly gid: number }
  | {
      readonly kind: "file";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
      readonly mtimeMs: number;
      readonly digest: string;
    }
  | {
      readonly kind: "symlink";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
      readonly target: string;
    };

interface Fingerprint {
  readonly fingerprint: string;
  readonly mtimeMs: number;
}

export interface HomeDiff extends SavedMachineChanges {
  /** Paths a saved home cannot hold: devices, pipes, sockets. */
  readonly skipped: readonly string[];
  readonly fingerprints: ReadonlyMap<string, Fingerprint>;
}

export class HomeTracker {
  private constructor(
    private readonly saved: Map<string, SavedState>,
    private fingerprints: ReadonlyMap<string, Fingerprint>,
  ) {}

  /** A tracker whose saved copy is `entries`. */
  static async from(entries: readonly SavedMachineEntry[]): Promise<HomeTracker> {
    const saved = new Map<string, SavedState>();
    for (const entry of entries) saved.set(entry.path, await savedState(entry));
    return new HomeTracker(saved, new Map());
  }

  /** A tracker whose saved copy `states` describes; it trusts no fingerprint yet. */
  static fromStates(states: readonly (readonly [string, SavedState])[]): HomeTracker {
    return new HomeTracker(new Map(states), new Map());
  }

  /** The saved copy, one state per path, with no bytes. */
  states(): [string, SavedState][] {
    return [...this.saved];
  }

  /** The fingerprints a read at `nowMs` may trust. */
  known(nowMs: number): VfsTreeFingerprints {
    const known: Record<string, string> = {};
    for (const [path, { fingerprint, mtimeMs }] of this.fingerprints) {
      if (nowMs - mtimeMs >= RECENT_CHANGE_MS) known[path] = fingerprint;
    }
    return known;
  }

  /** What `listing`, a read made with `known()`, changes in the saved copy. */
  async diff(listing: readonly VfsTreeEntry[]): Promise<HomeDiff> {
    const put: SavedMachineEntry[] = [];
    const skipped: string[] = [];
    const fingerprints = new Map<string, Fingerprint>();
    const listed = new Set<string>();
    for (const entry of listing) {
      if (entry.kind === "other") {
        skipped.push(entry.path);
        continue;
      }
      listed.add(entry.path);
      const node = { path: entry.path, mode: entry.mode, uid: entry.uid, gid: entry.gid };
      const saved = this.saved.get(entry.path);
      if (entry.kind === "directory") {
        if (!sameNode(saved, entry)) put.push({ ...node, kind: "directory" });
        continue;
      }
      if (entry.kind === "symlink") {
        if (!sameNode(saved, entry) || saved?.kind !== "symlink" || saved.target !== entry.target) {
          put.push({ ...node, kind: "symlink", target: entry.target });
        }
        continue;
      }
      fingerprints.set(entry.path, { fingerprint: entry.fingerprint, mtimeMs: entry.mtimeMs });
      if (entry.bytes === null) continue;
      const unchanged = sameNode(saved, entry) && saved?.kind === "file" &&
        saved.mtimeMs === entry.mtimeMs && saved.digest === await digest(entry.bytes);
      if (!unchanged) put.push({ ...node, kind: "file", mtimeMs: entry.mtimeMs, bytes: entry.bytes });
    }
    const remove = [...this.saved.keys()].filter((path) => !listed.has(path));
    return { put, remove, skipped, fingerprints };
  }

  /** Record that the saved copy now holds `diff`. */
  async commit(diff: HomeDiff): Promise<void> {
    for (const path of diff.remove) this.saved.delete(path);
    for (const entry of diff.put) this.saved.set(entry.path, await savedState(entry));
    this.fingerprints = diff.fingerprints;
  }
}

function sameNode(saved: SavedState | undefined, entry: VfsTreeEntry): boolean {
  return saved !== undefined && saved.kind === entry.kind && saved.mode === entry.mode &&
    saved.uid === entry.uid && saved.gid === entry.gid;
}

async function savedState(entry: SavedMachineEntry): Promise<SavedState> {
  const node = { mode: entry.mode, uid: entry.uid, gid: entry.gid };
  if (entry.kind === "file") {
    return { ...node, kind: "file", mtimeMs: entry.mtimeMs, digest: await digest(entry.bytes) };
  }
  return entry.kind === "symlink" ? { ...node, kind: "symlink", target: entry.target } : { ...node, kind: "directory" };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
