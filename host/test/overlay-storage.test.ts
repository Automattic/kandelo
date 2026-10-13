import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostFileSystem } from "../src/vfs/host-fs";
import { OverlayStorageFile } from "../src/vfs/overlay-storage";
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
