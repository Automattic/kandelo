import { assertBrowserComputerId, browserComputerDirectory, browserComputersDirectory, browserComputerStorageName } from "../../../host/src/browser-computer-storage";
import { acquireBrowserPersistenceComputerLease } from "../../../host/src/browser-persistence-computer-lease";
import { validateBootDescriptor } from "./boot-descriptor";
import type { BootDescriptor } from "./kernel-host";
import type { ComputerRetention, StoredComputer } from "./computer-library";
import { assertComputerStorageFormat, DEFAULT_COMPUTER_RETENTION, JOURNALED_OPFS_IMAGE_STORAGE_FORMAT } from "./computer-library";
import { randomComputerName } from "./computer-name";

export const TEMPORARY_COMPUTER_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_COMPUTER_METADATA_BYTES = 128 * 1024;
const MAX_COMPUTERS = 256;

function missing(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function deletionPending(directory: FileSystemDirectoryHandle): Promise<boolean> {
  try { await directory.getDirectoryHandle("retained"); return false; }
  catch (error) { if (missing(error)) return true; throw error; }
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
  const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await writer.write(text);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export class BrowserComputerStore {
  issues: { id: string; message: string }[] = [];
  private locked<Type>(operation: () => Promise<Type>): Promise<Type> {
    if (!navigator.locks) throw new Error("Computer storage requires Web Locks");
    return navigator.locks.request("kandelo-computer-library", operation);
  }

  private async readUnlocked(id: string): Promise<StoredComputer> {
    assertBrowserComputerId(id);
    const directory = await browserComputerDirectory(id, false);
    if (await deletionPending(directory)) throw new Error("This computer is being deleted");
    const file = await (await directory.getFileHandle("computer.json")).getFile();
    if (file.size > MAX_COMPUTER_METADATA_BYTES) throw new Error("Computer metadata exceeds its size limit");
    const record = JSON.parse(await file.text()) as Omit<StoredComputer, "version" | "storageFormat"> & { version: unknown; storageFormat?: unknown };
    const storageFormat = record.version === 1 && record.storageFormat === undefined
      ? JOURNALED_OPFS_IMAGE_STORAGE_FORMAT : record.storageFormat;
    assertComputerStorageFormat(storageFormat);
    if ((record.version !== 1 && record.version !== 2) || record.id !== id || typeof record.title !== "string" || !record.title.trim()
      || record.title.length > 120 || !["saved", "temporary"].includes(record.retention)
      || (record.profileId !== null && (typeof record.profileId !== "string" || !record.profileId || record.profileId.length > 128))
      || (record.filesystemProfileId !== undefined && record.filesystemProfileId !== null
        && (typeof record.filesystemProfileId !== "string" || !record.filesystemProfileId || record.filesystemProfileId.length > 128))
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !Number.isSafeInteger(record.lastOpenedAt) || record.lastOpenedAt < record.createdAt
      || (record.retention === "saved" ? record.expiresAt !== null
        : !Number.isSafeInteger(record.expiresAt) || record.expiresAt! < record.lastOpenedAt)) {
      throw new Error(`Computer ${id} has invalid metadata`);
    }
    validateBootDescriptor(record.descriptor);
    return { ...record, version: 2, storageFormat };
  }

  private async writeUnlocked(record: StoredComputer): Promise<void> {
    const text = JSON.stringify(record);
    if (new TextEncoder().encode(text).byteLength > MAX_COMPUTER_METADATA_BYTES) throw new Error("Computer metadata exceeds its size limit");
    await writeFile(await browserComputerDirectory(record.id), "computer.json", text);
  }

  private async ids(): Promise<string[]> {
    let directory: FileSystemDirectoryHandle;
    try { directory = await browserComputersDirectory(false); }
    catch (error) { if (missing(error)) return []; throw error; }
    const ids: string[] = [];
    for await (const [id, entry] of directory.entries()) {
      if (entry.kind !== "directory") continue;
      try { assertBrowserComputerId(id); } catch { continue; }
      ids.push(id);
      if (ids.length > MAX_COMPUTERS) throw new Error(`Computer library exceeds its ${MAX_COMPUTERS}-computer limit`);
    }
    return ids;
  }

  read(id: string): Promise<StoredComputer> {
    return this.locked(() => this.readUnlocked(id));
  }

  private async listUnlocked(): Promise<StoredComputer[]> {
    const records: StoredComputer[] = [];
    this.issues = [];
    for (const id of await this.ids()) {
      const directory = await browserComputerDirectory(id, false);
      if (await deletionPending(directory)) continue;
      try { records.push(await this.readUnlocked(id)); }
      catch (error) { this.issues.push({ id, message: error instanceof Error ? error.message : String(error) }); }
    }
    return records.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  }

  list(): Promise<StoredComputer[]> {
    return this.locked(() => this.listUnlocked());
  }

  create(descriptor: BootDescriptor, retention: ComputerRetention = DEFAULT_COMPUTER_RETENTION, profileId: string | null = descriptor.id, title?: string): Promise<StoredComputer> {
    validateBootDescriptor(descriptor);
    if (profileId !== null && (typeof profileId !== "string" || !profileId || profileId.length > 128)) throw new Error("Invalid computer profile ID");
    if (descriptor.boot.inputs?.length || descriptor.boot.parameters?.runScript !== undefined) {
      throw new Error("Disk-backed computers do not yet accept boot-link inputs or scripts");
    }
    if (retention !== "saved" && retention !== "temporary") throw new Error("Invalid computer retention");
    title = title?.trim();
    if (title !== undefined && (!title || title.length > 120)) throw new Error("Computer names must contain 1–120 characters");
    return this.locked(async () => {
      if ((await this.ids()).length >= MAX_COMPUTERS) throw new Error("Delete a computer before creating another");
      const now = Date.now();
      const record: StoredComputer = {
        version: 2, id: crypto.randomUUID(), title: title ?? randomComputerName((await this.listUnlocked()).map(computer => computer.title)),
        storageFormat: JOURNALED_OPFS_IMAGE_STORAGE_FORMAT,
        descriptor: structuredClone(descriptor), profileId, retention, createdAt: now, lastOpenedAt: now,
        expiresAt: retention === "temporary" ? now + TEMPORARY_COMPUTER_LIFETIME_MS : null,
      };
      const directory = await browserComputerDirectory(record.id);
      await writeFile(directory, "creating", "1");
      await directory.getDirectoryHandle("retained", { create: true });
      await directory.getDirectoryHandle("provisioning", { create: true });
      await this.writeUnlocked(record);
      await directory.removeEntry("creating");
      return record;
    });
  }

  update(id: string, change: { title?: string; retention?: "saved"; opened?: boolean; profileId?: string }): Promise<StoredComputer> {
    return this.locked(async () => {
      const record = await this.readUnlocked(id);
      if (change.profileId !== undefined) {
        if (typeof change.profileId !== "string" || !change.profileId || change.profileId.length > 128) throw new Error("Invalid computer profile ID");
        if (record.filesystemProfileId === undefined) record.filesystemProfileId = record.profileId;
        record.profileId = change.profileId;
      }
      if (change.title !== undefined) {
        const title = change.title.trim();
        if (!title || title.length > 120) throw new Error("Computer names must contain 1–120 characters");
        record.title = title;
      }
      if (change.retention !== undefined) record.retention = change.retention;
      if (change.opened) record.lastOpenedAt = Math.max(record.lastOpenedAt, Date.now());
      record.expiresAt = record.retention === "temporary" ? record.lastOpenedAt + TEMPORARY_COMPUTER_LIFETIME_MS : null;
      await this.writeUnlocked(record);
      return record;
    });
  }

  async filesystemInitialized(id: string): Promise<boolean> {
    const directory = await browserComputerDirectory(id, false);
    try { await directory.getDirectoryHandle("provisioning"); return false; }
    catch (error) { if (missing(error)) return true; throw error; }
  }

  async markFilesystemInitialized(id: string): Promise<void> {
    const directory = await browserComputerDirectory(id, false);
    try { await directory.removeEntry("provisioning"); }
    catch (error) { if (!missing(error)) throw error; }
  }

  remove(id: string): Promise<void> {
    assertBrowserComputerId(id);
    return this.locked(() => this.removeUnlocked(id));
  }

  private async removeUnlocked(id: string): Promise<void> {
    const lease = await acquireBrowserPersistenceComputerLease(browserComputerStorageName(id));
    try {
      const directory = await browserComputerDirectory(id, false);
      try { await directory.removeEntry("retained"); }
      catch (error) { if (!missing(error)) throw error; }
      await (await browserComputersDirectory(false)).removeEntry(id, { recursive: true });
    } finally { await lease(); }
  }

  cleanup(now = Date.now(), openingId?: string | null): Promise<{ id: string; message: string }[]> {
    return this.locked(async () => {
      const failures: { id: string; message: string }[] = [];
      for (const id of await this.ids()) {
        const directory = await browserComputerDirectory(id, false);
        let creating = false;
        try { await directory.getFileHandle("creating"); creating = true; }
        catch (error) { if (!missing(error)) throw error; }
        if (creating) {
          try {
            const marker = await (await directory.getFileHandle("creating")).getFile();
            if (marker.size !== 1 || await marker.text() !== "1") continue;
          } catch (error) {
            failures.push({ id, message: `Interrupted creation inspection failed: ${String(error)}` });
            continue;
          }
          try { await directory.getFileHandle("computer.json"); }
          catch (error) {
            if (!missing(error)) {
              failures.push({ id, message: `Interrupted creation inspection failed: ${String(error)}` });
              continue;
            }
            try {
              let emptyCreation = true;
              for await (const [name, entry] of directory.entries()) {
                if (name === "creating") continue;
                if ((name !== "retained" && name !== "provisioning") || entry.kind !== "directory") {
                  emptyCreation = false;
                  break;
                }
                if (!(await (entry as FileSystemDirectoryHandle).entries().next()).done) emptyCreation = false;
              }
              if (!emptyCreation) continue;
              await this.removeUnlocked(id);
            } catch (error) { failures.push({ id, message: `Interrupted creation cleanup failed: ${String(error)}` }); }
            continue;
          }
          try { await this.readUnlocked(id); }
          catch (error) {
            failures.push({ id, message: `Incomplete computer metadata preserved: ${String(error)}` });
            continue;
          }
          await directory.removeEntry("creating");
        }
        const deleting = await deletionPending(directory);
        let record: StoredComputer | null = null;
        if (!deleting) {
          try { record = await this.readUnlocked(id); }
          catch { continue; }
        }
        if (!deleting && (id === openingId || record!.retention !== "temporary" || record!.expiresAt! > now)) continue;
        try { await this.removeUnlocked(id); }
        catch (error) {
          if (error instanceof Error && error.message.includes("already running in another tab")) continue;
          failures.push({ id, message: `Computer cleanup failed: ${String(error)}` });
        }
      }
      return failures;
    });
  }
}
