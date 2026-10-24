import { MAX_DEFERRED_IO_BYTES, type DeferredByteStorage } from "./deferred-byte-spool";

const DIRECTORY = "kandelo-deferred-bytes";
const CLEANUP_LOCK = "kandelo-deferred-bytes-cleanup";
const SPOOL_NAME = /^spool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

function ownerLock(name: string): string {
  return `kandelo-deferred-byte-owner:${name}`;
}

async function acquireOwner(name: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  let fail!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const holding = navigator.locks.request(ownerLock(name), { mode: "exclusive", ifAvailable: true }, async lock => {
    if (lock === null) throw new Error("Deferred byte storage already has an owner");
    ready();
    await released;
  });
  void holding.catch(fail);
  await acquired;
  return async () => { release(); await holding; };
}

export async function openOpfsDeferredByteStorage(): Promise<DeferredByteStorage> {
  if (!navigator.locks) throw new Error("Deferred OPFS byte storage requires Web Locks");
  return navigator.locks.request(CLEANUP_LOCK, { mode: "exclusive" }, async () => {
    const directory = await (await navigator.storage.getDirectory())
      .getDirectoryHandle(DIRECTORY, { create: true });
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind !== "file" || !SPOOL_NAME.test(name)) continue;
      await navigator.locks.request(ownerLock(name), { mode: "exclusive", ifAvailable: true }, async lock => {
        if (lock === null) return;
        try {
          await directory.removeEntry(name);
        } catch (error) {
          if (!isNamedError(error, "NotFoundError") && !isNamedError(error, "NoModificationAllowedError")
            && !isNamedError(error, "InvalidStateError")) throw error;
        }
      });
    }
    const buffer = new Uint8Array(MAX_DEFERRED_IO_BYTES);
    const name = `spool-${crypto.randomUUID()}`;
    const releaseOwner = await acquireOwner(name);
    let handle: FileSystemSyncAccessHandle | null;
    try {
      const file = await directory.getFileHandle(name, { create: true });
      handle = await file.createSyncAccessHandle();
    } catch (error) {
      await directory.removeEntry(name).catch(() => {});
      await releaseOwner();
      throw error;
    }
    let closing: Promise<void> | undefined;
    const live = () => {
      if (handle === null) throw new Error("Deferred OPFS byte storage is closed");
      return handle;
    };
    return {
      readAt: (offset, destination) => {
        const chunk = buffer.subarray(0, Math.min(buffer.byteLength, destination.byteLength));
        const count = live().read(chunk, { at: offset });
        if (!Number.isInteger(count) || count < 0 || count > chunk.byteLength) {
          throw new Error("Deferred OPFS byte storage returned an invalid read");
        }
        destination.set(chunk.subarray(0, count));
        return count;
      },
      writeAt: (offset, source) => {
        const chunk = buffer.subarray(0, Math.min(buffer.byteLength, source.byteLength));
        chunk.set(source.subarray(0, chunk.byteLength));
        return live().write(chunk, { at: offset });
      },
      close: () => {
        if (closing === undefined) {
          const closingHandle = handle;
          handle = null;
          closing = Promise.resolve().then(async () => {
            try {
              closingHandle?.close();
              await navigator.locks.request(CLEANUP_LOCK, { mode: "exclusive" }, async () => {
                try { await directory.removeEntry(name); } catch (error) {
                  if (!isNamedError(error, "NotFoundError")) throw error;
                }
              });
            } finally {
              await releaseOwner();
            }
          });
        }
        return closing;
      },
    };
  });
}
