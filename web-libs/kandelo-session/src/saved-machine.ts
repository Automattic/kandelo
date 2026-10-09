// Saved machines — the files of each saved machine's home directory, kept in
// this browser profile's IndexedDB.
//
// One record per directory, file, or symlink, keyed by [machine id, path], so
// a machine's records sort parent before child and one key range holds them
// all. Every change lands in one transaction: a reader sees the home before or
// after a save, never part of one. The browser clears the database with this
// origin's site data; nothing here syncs, verifies, or shares it.

import type { VfsTreeEntry } from "./kernel-host";

const DATABASE_NAME = "kandelo-saved-machines";
const DATABASE_VERSION = 1;
const STORE = "entries";

interface SavedMachineNode {
  readonly path: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/** One entry of a saved home, path relative to the home directory. */
export type SavedMachineEntry =
  | (SavedMachineNode & { readonly kind: "directory" })
  | (SavedMachineNode & { readonly kind: "file"; readonly mtimeMs: number; readonly bytes: Uint8Array })
  | (SavedMachineNode & { readonly kind: "symlink"; readonly target: string });

export interface SavedMachineChanges {
  readonly put: readonly SavedMachineEntry[];
  readonly remove: readonly string[];
}

export class SavedMachines {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB): Promise<SavedMachines> {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    return new SavedMachines(await settled(request));
  }

  /** The machine's home, a directory before its children. */
  async load(id: string): Promise<SavedMachineEntry[]> {
    const transaction = this.database.transaction(STORE, "readonly");
    const entries = await settled(transaction.objectStore(STORE).getAll(homeRange(id)));
    return entries as SavedMachineEntry[];
  }

  /** Make the machine's home hold exactly `entries`. */
  async replace(id: string, entries: readonly SavedMachineEntry[]): Promise<void> {
    await this.write((store) => {
      store.delete(homeRange(id));
      for (const entry of entries) store.put(entry, [id, entry.path]);
    });
  }

  async apply(id: string, changes: SavedMachineChanges): Promise<void> {
    await this.write((store) => {
      for (const path of changes.remove) store.delete([id, path]);
      for (const entry of changes.put) store.put(entry, [id, entry.path]);
    });
  }

  async delete(id: string): Promise<void> {
    await this.write((store) => store.delete(homeRange(id)));
  }

  private write(fill: (store: IDBObjectStore) => void): Promise<void> {
    const transaction = this.database.transaction(STORE, "readwrite", { durability: "strict" });
    fill(transaction.objectStore(STORE));
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("saving the home was aborted"));
    });
  }
}

/** A saved home as the tree a boot writes into the machine's home directory. */
export function savedMachineSeed(entries: readonly SavedMachineEntry[]): VfsTreeEntry[] {
  return entries.map((entry) => entry.kind === "file" ? { ...entry, fingerprint: "" } : entry);
}

/** Every [id, path] key: an array sorts after every string, so [id, []] follows them all. */
function homeRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id], [id, []]);
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
