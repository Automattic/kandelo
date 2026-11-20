// The disk the files pane of `delo config` opens: a stored computer's
// filesystem (see stored-disk.ts), held by a worker until the settings close.
// The pane holds the computer's lease the whole time, so the computer does not
// open in another tab meanwhile. When an upload changed the disk, closing
// saves it as the computer's new disk, the way `delo run` saves a pending
// configuration. A computer that boots an image has no disk of its own to replace,
// so the pane only reads it.

import { browserComputerStorageName } from "../../../../../host/src/browser-computer-storage";
import { acquireBrowserPersistenceComputerLease } from "../../../../../host/src/browser-persistence-computer-lease";
import { hasOpfsRoot, type BrowserComputerStore } from "../../../../../web-libs/kandelo-session/src/browser-computer-store";
import type { StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";
import { readStoredDisk } from "./stored-disk";
import type { DeloFilesEntry, DeloUpload } from "./files";
import type { DeloFilesAnswer, DeloFilesOperation, DeloFilesValues } from "./files-protocol";
import FilesWorker from "./files-worker.ts?worker";

export interface DeloFilesDisk {
  list(folder: string): Promise<DeloFilesEntry[]>;
  read(path: string): Promise<Uint8Array<ArrayBuffer>>;
  zip(folder: string): Promise<DeloFilesValues["zip"]>;
  close(): Promise<void>;
}

export interface DeloFilesWritableDisk extends DeloFilesDisk {
  conflicts(folder: string, paths: string[]): Promise<string[]>;
  upload(folder: string, uploads: DeloUpload[]): Promise<void>;
  /** Save the disk when an upload changed it, then let the computer open again. */
  close(): Promise<void>;
}

/** A new files worker, and the call that sends it one operation. */
function startWorker() {
  const worker = new FilesWorker();
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let next = 0;
  worker.onmessage = (event: MessageEvent<DeloFilesAnswer>) => {
    const answer = event.data;
    const pending = waiting.get(answer.id);
    waiting.delete(answer.id);
    if (answer.ok) pending?.resolve(answer.value);
    else pending?.reject(new Error(answer.message));
  };
  worker.onerror = (event) => {
    for (const pending of waiting.values()) pending.reject(new Error(event.message || "the files worker failed"));
    waiting.clear();
  };
  const call = <T extends DeloFilesOperation>(operation: T, transfer: Transferable[] = []) => {
    const id = next++;
    return new Promise<DeloFilesValues[T["type"]]>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...operation, id }, transfer);
    });
  };
  return { worker, call };
}

export async function openDeloFilesDisk(store: BrowserComputerStore, computer: StoredComputer, onState: (state: string) => void): Promise<DeloFilesDisk | DeloFilesWritableDisk> {
  onState("locking computer");
  const lease = await acquireBrowserPersistenceComputerLease(browserComputerStorageName(computer.id)).catch((err: unknown) => {
    throw /another tab/.test(String(err)) ? new Error(`${computer.title} is open in another tab. Close it, then open its files.`) : err;
  });
  const { worker, call } = startWorker();
  let changed = false;
  let released = false;
  const release = async () => {
    worker.terminate();
    if (released) return;
    released = true;
    await lease();
  };
  try {
    const image = await readStoredDisk(store, computer, lease, onState);
    onState("opening disk");
    await call({ type: "open", image }, [image.buffer]);
  } catch (err) {
    await release();
    throw err;
  }
  onState("disk open");
  const read: DeloFilesDisk = {
    list: (folder) => call({ type: "list", folder }),
    read: (path) => call({ type: "read", path }),
    zip: (folder) => call({ type: "zip", folder }),
    close: release,
  };
  if (!hasOpfsRoot(computer.descriptor)) return read;
  return {
    ...read,
    conflicts: (folder, paths) => call({ type: "conflicts", folder, paths }),
    upload: async (folder, uploads) => {
      await call({ type: "upload", folder, uploads });
      changed = true;
    },
    close: async () => {
      try {
        if (!changed) return;
        onState("saving disk");
        const image = await call({ type: "export" });
        await release();
        await store.replaceDisk(computer.id, image);
      } finally {
        await release();
      }
    },
  };
}
