import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { OpfsImageReader } from "../src/vfs/opfs-image-reader";
import { StorageCloseLedger } from "../src/storage-close-ledger";

const PAGE_BYTES = 64 * 1024;

describe("OpfsImageReader", () => {
  it("uses one ordinary bounce buffer without read caching or startup scans in raw mode", async () => {
    const source = Uint8Array.from({ length: 2 * PAGE_BYTES + 17 }, (_, index) => index % 251);
    const buffers = new Set<ArrayBufferLike>();
    const read = vi.fn((destination: Uint8Array, { at }: { at: number }) => {
      expect(destination.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      buffers.add(destination.buffer);
      const count = Math.min(7, destination.byteLength, source.length - at);
      destination.set(source.subarray(at, at + count));
      return count;
    });
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({ getSize: () => source.length, read, close }) } as unknown as FileSystemFileHandle;
    const reader = await OpfsImageReader.open(file, undefined, undefined, true);
    try {
      expect(read).not.toHaveBeenCalled();
      const destination = new Uint8Array(new SharedArrayBuffer(2 * PAGE_BYTES));
      expect(reader.readAt(3, destination)).toBe(7);
      expect(destination.subarray(0, 7)).toEqual(source.subarray(3, 10));
      source[3] ^= 1;
      expect(reader.readAt(3, destination)).toBe(7);
      expect(destination[0]).toBe(source[3]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(buffers.size).toBe(1);
      expect(read.mock.calls.every(([destination]) => destination.byteLength <= PAGE_BYTES)).toBe(true);
    } finally { reader.close(); }
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses whole-image integrity metadata in raw mode before opening a handle", async () => {
    const open = vi.fn();
    const file = { createSyncAccessHandle: open } as unknown as FileSystemFileHandle;
    await expect(OpfsImageReader.open(file, { length: 1, chunkBytes: 1, imageSha256: "00".repeat(32) }, undefined, true)).rejects.toThrow("raw image transport");
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])("verifies a whole-image streaming digest and partial tail before publication (damaged=%s)", async damaged => {
    const source = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 251);
    const imageSha256 = createHash("sha256").update(source).digest("hex");
    if (damaged) source[source.length - 1]! ^= 1;
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({
      getSize: () => source.length,
      read(destination: Uint8Array, { at }: { at: number }) {
        destination.set(source.subarray(at, at + destination.length));
        return destination.length;
      }, close,
    }) } as unknown as FileSystemFileHandle;
    const opening = OpfsImageReader.open(file, { length: source.length, chunkBytes: 1024 * 1024, imageSha256 });
    if (damaged) await expect(opening).rejects.toThrow("damaged; refusing to boot");
    else {
      const reader = await opening;
      const tail = new Uint8Array(17);
      expect(reader.readAt(source.length - 17, tail)).toBe(17);
      expect(tail).toEqual(source.subarray(-17));
      reader.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses mixed whole/chunk integrity metadata before reading bytes", async () => {
    const read = vi.fn();
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 1, read, close }) } as unknown as FileSystemFileHandle;
    await expect(OpfsImageReader.open(file, {
      length: 1, chunkBytes: 1, imageSha256: "a".repeat(64), chunkSha256: ["b".repeat(64)],
    } as never)).rejects.toThrow("integrity metadata is invalid");
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("tracks validation cleanup before reader publication (close failure=%s)", async (closeFails) => {
    const ledger = new StorageCloseLedger();
    const close = vi.fn(() => {
      if (closeFails) throw new Error("image close refused");
    });
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 0, close }) } as unknown as FileSystemFileHandle;
    await expect(OpfsImageReader.open(file, undefined, ledger)).rejects.toThrow(
      closeFails ? AggregateError : "invalid length",
    );
    expect(close).toHaveBeenCalledOnce();
    if (closeFails) expect(() => ledger.closeAll()).toThrow(AggregateError);
    else expect(() => ledger.closeAll()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("accounts for an acquired image handle when retirement refuses registration (close failure=%s)", async (closeFails) => {
    const ledger = new StorageCloseLedger();
    await ledger.beginRetirement();
    const close = vi.fn(() => {
      if (closeFails) throw new Error("image close refused");
    });
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 16, close }) } as unknown as FileSystemFileHandle;
    await expect(OpfsImageReader.open(file, undefined, ledger)).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
    if (closeFails) expect(() => ledger.closeAll()).toThrow(AggregateError);
    else expect(() => ledger.closeAll()).not.toThrow();
  });

  it("retains an unpublished successful reader until explicit storage retirement", async () => {
    const ledger = new StorageCloseLedger();
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({ getSize: () => 16, close }) } as unknown as FileSystemFileHandle;
    const reader = await OpfsImageReader.open(file, undefined, ledger);
    ledger.closeAll();
    reader.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("verifies all integrity chunks and a partial tail with one reusable hash window", async () => {
    const chunkBytes = 1024 * 1024;
    const source = Uint8Array.from({ length: chunkBytes * 2 + 17 }, (_, index) => index % 251);
    const chunkSha256 = Array.from({ length: 3 }, (_, index) => createHash("sha256")
      .update(source.subarray(index * chunkBytes, (index + 1) * chunkBytes)).digest("hex"));
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const backings = new Set<ArrayBufferLike>();
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, bytes) => {
      backings.add(ArrayBuffer.isView(bytes) ? bytes.buffer : bytes);
      return originalDigest(algorithm, bytes);
    });
    try {
      const reader = await OpfsImageReader.open({ createSyncAccessHandle: async () => ({
        getSize: () => source.byteLength,
        read(destination: Uint8Array, { at }: { at: number }) {
          destination.set(source.subarray(at, at + destination.byteLength));
          return destination.byteLength;
        },
        close: () => {},
      }) } as unknown as FileSystemFileHandle, { length: source.byteLength, chunkBytes, chunkSha256 });
      expect(digest).toHaveBeenCalledTimes(3);
      expect(backings.size).toBe(1);
      reader.close();
    } finally { digest.mockRestore(); }
  });

  it("reuses at most 64 page backings across a large clean working set and failed refills", async () => {
    const backings = new Set<ArrayBufferLike>();
    let failPage = -1;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reader = await OpfsImageReader.open({ createSyncAccessHandle: async () => ({
        getSize: () => PAGE_BYTES * 256 + 7,
        read(destination: Uint8Array, { at }: { at: number }) {
          backings.add(destination.buffer);
          const page = Math.floor(at / PAGE_BYTES);
          if (page === failPage) throw new Error("refill failed");
          destination.fill(page % 251);
          return destination.byteLength;
        },
        close: () => {},
      }) } as unknown as FileSystemFileHandle);
      const sample = new Uint8Array(4);
      for (let page = 0; page < 64; page += 1) expect(reader.readAt(page * PAGE_BYTES, sample)).toBe(4);
      failPage = 64;
      expect(reader.readAt(64 * PAGE_BYTES, sample)).toBe(-5);
      failPage = -1;
      expect(reader.readAt(0, sample)).toBe(4);
      expect([...sample]).toEqual([0, 0, 0, 0]);
      for (let page = 64; page <= 256; page += 1) {
        expect(reader.readAt(page * PAGE_BYTES, sample)).toBe(4);
        expect([...sample]).toEqual(Array(4).fill(page % 251));
      }
      expect(backings.size).toBe(64);
      reader.close();
    } finally { warning.mockRestore(); }
  });

  it("reports the first underlying read failure without changing its errno or flooding diagnostics", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reader = await OpfsImageReader.open({ createSyncAccessHandle: async () => ({
        getSize: () => PAGE_BYTES,
        read: () => { throw new Error("injected OPFS failure"); },
        close: () => {},
      }) } as unknown as FileSystemFileHandle);
      expect(reader.readAt(7, new Uint8Array(19))).toBe(-5);
      expect(reader.readAt(9, new Uint8Array(21))).toBe(-5);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("byte 7 for 19 bytes: Error: injected OPFS failure"));
      reader.close();
    } finally { warning.mockRestore(); }
  });

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
