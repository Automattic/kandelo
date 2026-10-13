import { describe, expect, it } from "vitest";
import { OpfsImageReader } from "../src/vfs/opfs-image-reader";

const PAGE_BYTES = 64 * 1024;

describe("OpfsImageReader", () => {
  it("retries short reads and evicts least-recently-used clean pages", async () => {
    const bytes = Uint8Array.from(
      { length: PAGE_BYTES * 65 + 17 },
      (_, index) => index % 251,
    );
    let reads = 0;
    let closed = false;
    const access = {
      getSize: () => bytes.byteLength,
      read(destination: Uint8Array, options: { at: number }) {
        if (closed) throw new Error("closed");
        const count = Math.min(destination.byteLength, 4096, bytes.byteLength - options.at);
        destination.set(bytes.subarray(options.at, options.at + count));
        reads++;
        return count;
      },
      close: () => { closed = true; },
    } as unknown as FileSystemSyncAccessHandle;
    const file = {
      createSyncAccessHandle: async () => access,
    } as unknown as FileSystemFileHandle;
    const reader = await OpfsImageReader.open(file);
    expect(reader.length).toBe(bytes.byteLength);
    const sample = new Uint8Array(19);
    expect(reader.readAt(PAGE_BYTES - 5, sample)).toBe(19);
    expect(sample).toEqual(bytes.subarray(PAGE_BYTES - 5, PAGE_BYTES + 14));
    const cachedReads = reads;
    expect(reader.readAt(PAGE_BYTES - 5, sample)).toBe(19);
    expect(reads).toBe(cachedReads);
    for (let page = 2; page <= 65; page++) {
      expect(reader.readAt(page * PAGE_BYTES, sample)).toBe(Math.min(19, bytes.byteLength - page * PAGE_BYTES));
    }
    const afterEviction = reads;
    expect(reader.readAt(0, sample)).toBe(19);
    expect(reads).toBeGreaterThan(afterEviction);
    expect(reader.readAt(-1, sample)).toBe(-22);
    expect(reader.readAt(bytes.byteLength, sample)).toBe(0);
    reader.close();
    expect(closed).toBe(true);
  });

  it("rejects an empty image and reports read failures", async () => {
    let closed = false;
    const emptyFile = {
      createSyncAccessHandle: async () => ({
        getSize: () => 0,
        close: () => { closed = true; },
      }),
    } as unknown as FileSystemFileHandle;
    await expect(OpfsImageReader.open(emptyFile)).rejects.toThrow("invalid length");
    expect(closed).toBe(true);
    const failingFile = {
      createSyncAccessHandle: async () => ({
        getSize: () => 1,
        read: () => 0,
        close: () => {},
      }),
    } as unknown as FileSystemFileHandle;
    const reader = await OpfsImageReader.open(failingFile);
    expect(reader.readAt(0, new Uint8Array(1))).toBe(-5);
    reader.close();
  });

  it("verifies saved chunk digests before exposing an OPFS image", async () => {
    const bytes = Uint8Array.from({ length: PAGE_BYTES + 3 }, (_, index) => index % 251);
    let closed = false;
    const file = {
      createSyncAccessHandle: async () => ({
        getSize: () => bytes.byteLength,
        read(destination: Uint8Array, options: { at: number }) {
          const count = Math.min(destination.byteLength, bytes.byteLength - options.at);
          destination.set(bytes.subarray(options.at, options.at + count));
          return count;
        },
        close: () => { closed = true; },
      }),
    } as unknown as FileSystemFileHandle;
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const integrity = { length: bytes.byteLength, chunkBytes: bytes.byteLength, chunkSha256: [digest] };
    const reader = await OpfsImageReader.open(file, integrity);
    reader.close();
    expect(closed).toBe(true);
    closed = false;
    await expect(OpfsImageReader.open(file, {
      ...integrity,
      chunkSha256: ["0".repeat(64)],
    })).rejects.toThrow("damaged");
    expect(closed).toBe(true);
  });

  it("reads sparse offsets beyond the 32-bit range without allocating the image", async () => {
    const length = 8 * 1024 * 1024 * 1024 + 17;
    const positions: number[] = [];
    const file = {
      createSyncAccessHandle: async () => ({
        getSize: () => length,
        read(destination: Uint8Array, options: { at: number }) {
          positions.push(options.at);
          destination.fill(options.at % 251);
          return destination.byteLength;
        },
        close: () => {},
      }),
    } as unknown as FileSystemFileHandle;
    const reader = await OpfsImageReader.open(file);
    const data = new Uint8Array(17);
    const offset = 4 * 1024 * 1024 * 1024 + 5;
    expect(reader.readAt(offset, data)).toBe(17);
    expect(positions).toContain(4 * 1024 * 1024 * 1024);
    expect(data.every((byte) => byte === (4 * 1024 * 1024 * 1024) % 251)).toBe(true);
    expect(reader.readAt(length - 3, data)).toBe(3);
    expect(positions).toContain(8 * 1024 * 1024 * 1024);
    reader.close();
  });
});
