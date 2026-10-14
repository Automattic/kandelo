import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostFileSystem } from "../src/vfs/host-fs";
import { OpfsOverlayStorageFile, OverlayStorageFile } from "../src/vfs/overlay-storage";
import type { FileSystemBackend } from "../src/vfs/types";

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
    expect(() => storage.readExactAt(7, new Uint8Array(2))).toThrow(/EIO/);
    expect(() => storage.writeAllAt(2 ** 53, Uint8Array.of(1))).toThrow(/EOVERFLOW/);
    storage.close();
    expect(() => storage.len()).toThrow(/EBADF/);
  });
});

describe("OpfsOverlayStorageFile", () => {
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
