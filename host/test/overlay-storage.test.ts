import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostFileSystem } from "../src/vfs/host-fs";
import { OpfsOverlayStorageFile, OverlayStorageFile, OverlayStorageUnexpectedEofError } from "../src/vfs/overlay-storage";
import type { FileSystemBackend } from "../src/vfs/types";
import { StorageCloseLedger } from "../src/storage-close-ledger";

describe("OverlayStorageFile", () => {
  it("reopens a flushed journal through the Node backend", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-overlay-storage-"));
    try {
      const backend = new HostFileSystem(root);
      const first = OverlayStorageFile.open(backend, "/overlay.log");
      expect(first.len()).toBe(0);
      first.writeAllAt(0, Uint8Array.of(1, 2, 3, 4));
      first.flush();
      first.close();

      const second = OverlayStorageFile.open(backend, "/overlay.log");
      const bytes = new Uint8Array(4);
      second.readExactAt(0, bytes);
      expect([...bytes]).toEqual([1, 2, 3, 4]);
      second.truncate(2);
      second.flush();
      second.close();
      expect([...readFileSync(join(root, "overlay.log"))]).toEqual([1, 2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries short positioned reads and writes without moving the offset", () => {
    let bytes = new Uint8Array(0);
    let flushes = 0;
    const backend = {
      open: () => 7,
      close: () => 0,
      fstat: () => ({ size: bytes.byteLength }),
      ftruncate: (_handle: number, length: number) => {
        bytes = bytes.slice(0, length);
      },
      fsync: () => { flushes++; },
      write: (_handle: number, source: Uint8Array, offset: number, length: number) => {
        const count = Math.min(2, length);
        const expanded = new Uint8Array(Math.max(bytes.byteLength, offset + count));
        expanded.set(bytes);
        expanded.set(source.subarray(0, count), offset);
        bytes = expanded;
        return count;
      },
      read: (_handle: number, destination: Uint8Array, offset: number, length: number) => {
        const count = Math.min(2, length, bytes.byteLength - offset);
        if (count <= 0) return 0;
        destination.set(bytes.subarray(offset, offset + count));
        return count;
      },
    } as unknown as FileSystemBackend;
    const storage = OverlayStorageFile.open(backend, "/overlay.log");
    storage.writeAllAt(3n, Uint8Array.of(5, 6, 7, 8, 9));
    storage.flush();
    expect(flushes).toBe(1);
    expect(storage.len()).toBe(8);
    const destination = new Uint8Array(5);
    storage.readExactAt(3n, destination);
    expect([...destination]).toEqual([5, 6, 7, 8, 9]);
    expect(() => storage.readExactAt(7, new Uint8Array(2))).toThrow(OverlayStorageUnexpectedEofError);
    expect(() => storage.writeAllAt(2 ** 53, Uint8Array.of(1))).toThrow(/EOVERFLOW/);
    storage.close();
    expect(() => storage.len()).toThrow(/EBADF/);
  });

  it("preserves ENOSPC after a partial Node journal write or failed flush", () => {
    const quotaFailure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    let written = 0;
    const backend = {
      open: () => 7,
      close: () => 0,
      write: (_handle: number, _source: Uint8Array, offset: number, length: number) => {
        if (offset !== 0) throw quotaFailure;
        written = Math.min(128, length);
        return written;
      },
      fsync: () => { throw quotaFailure; },
    } as unknown as FileSystemBackend;
    const storage = OverlayStorageFile.open(backend, "/overlay.log");
    let writeFailure: unknown;
    try {
      storage.writeAllAt(0, new Uint8Array(256));
    } catch (error) {
      writeFailure = error;
    }
    expect(writeFailure).toBe(quotaFailure);
    expect(written).toBe(128);
    let flushFailure: unknown;
    try {
      storage.flush();
    } catch (error) {
      flushFailure = error;
    }
    expect(flushFailure).toBe(quotaFailure);
    storage.close();
  });
});

describe("OpfsOverlayStorageFile", () => {
  it("opens an already-selected OPFS image without resolving a namespace or taking publication ownership", async () => {
    const ledger = new StorageCloseLedger();
    const close = vi.fn();
    const file = { createSyncAccessHandle: vi.fn(async () => ({ getSize: () => 17, close })) };
    const storage = await OpfsOverlayStorageFile.openHandle(file as unknown as FileSystemFileHandle, ledger);
    expect(storage.len()).toBe(17);
    expect(file.createSyncAccessHandle).toHaveBeenCalledOnce();
    ledger.closeAll();
    storage.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not close a refused image registration twice when the ledger already owns cleanup", async () => {
    const ledger = new StorageCloseLedger();
    await ledger.beginRetirement();
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 0, close }) };
    await expect(OpfsOverlayStorageFile.openHandle(file as unknown as FileSystemFileHandle, ledger)).rejects.toThrow(/retiring/);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["journal", "index", "seal"] as const)("retains provisional %s handles before generation publication", async (suffix) => {
    const ledger = new StorageCloseLedger();
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 0, close }) };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({
      getDirectoryHandle: async () => ({ getFileHandle: async () => file }),
    }) } });
    try {
      const storage = await OpfsOverlayStorageFile.openFile("provisional", "g0", suffix, true, ledger);
      expect(storage).not.toBeNull();
      ledger.closeAll();
      storage!.close();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])("retains native close failures even if a provisional wrapper is forgotten (retiring=%s)", async (retiring) => {
    const ledger = new StorageCloseLedger();
    if (retiring) await ledger.beginRetirement();
    const close = vi.fn(() => { throw new Error("native journal close refused"); });
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 0, close }) };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({
      getDirectoryHandle: async () => ({ getFileHandle: async () => file }),
    }) } });
    try {
      if (retiring) {
        await expect(OpfsOverlayStorageFile.openFile("provisional", "g0", "journal", true, ledger)).rejects.toThrow();
      } else {
        const storage = await OpfsOverlayStorageFile.openFile("provisional", "g0", "journal", true, ledger);
        expect(() => storage!.close()).toThrow("native journal close refused");
      }
      expect(() => ledger.closeAll()).toThrow(AggregateError);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["root", "directory", "file", "access handle"] as const)(
    "preserves ENOSPC when OPFS %s opening exhausts quota",
    async (stage) => {
      const quotaFailure = new DOMException("quota exhausted", "QuotaExceededError");
      const file = {
        createSyncAccessHandle: async () => {
          if (stage === "access handle") throw quotaFailure;
          return { close: () => {} } as FileSystemSyncAccessHandle;
        },
      };
      const directory = {
        getFileHandle: async () => {
          if (stage === "file") throw quotaFailure;
          return file;
        },
      };
      const root = {
        getDirectoryHandle: async () => {
          if (stage === "directory") throw quotaFailure;
          return directory;
        },
      };
      vi.stubGlobal("navigator", {
        storage: {
          getDirectory: async () => {
            if (stage === "root") throw quotaFailure;
            return root;
          },
        },
      });
      try {
        await expect(OpfsOverlayStorageFile.openFile("quota-test", "g0", "journal", true))
          .rejects.toMatchObject({ code: "ENOSPC" });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("treats only an absent file as a missing generation", async () => {
    const notFound = new DOMException("file disappeared", "NotFoundError");
    let missing = true;
    const directory = {
      getFileHandle: async () => {
        if (missing) throw notFound;
        return { createSyncAccessHandle: async () => { throw notFound; } };
      },
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
    });
    try {
      await expect(OpfsOverlayStorageFile.openFile("missing", "g0", "journal", false))
        .resolves.toBeNull();
      missing = false;
      await expect(OpfsOverlayStorageFile.openFile("missing", "g0", "journal", false))
        .rejects.toThrow(/access handle/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps OPFS quota failures to ENOSPC", async () => {
    const quotaFailure = new DOMException("quota exhausted", "QuotaExceededError");
    const access = {
      getSize: () => 0,
      write: () => { throw quotaFailure; },
      flush: () => { throw quotaFailure; },
      truncate: () => { throw quotaFailure; },
      close: () => {},
    } as unknown as FileSystemSyncAccessHandle;
    const file = { createSyncAccessHandle: async () => access };
    const directory = { getFileHandle: async () => file };
    const root = { getDirectoryHandle: async () => directory };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    try {
      const storage = await OpfsOverlayStorageFile.open("quota-test");
      for (const operation of [
        () => storage.writeAllAt(0, Uint8Array.of(1)),
        () => storage.flush(),
        () => storage.truncate(0),
      ]) {
        expect(operation).toThrowError(/ENOSPC/);
      }
      storage.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
