import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeImageReader } from "../src/vfs/node-image-reader";
import {
  isStagedRootfsImageIntegrity,
  writeAndVerifyRootfsImage,
  type StagedRootfsImageProgress,
} from "../src/vfs/staged-rootfs-image";

const CHUNK_BYTES = 1024 * 1024;

describe("staged rootfs image verification", () => {
  it("keeps raw Node reads bounded and uncached without a startup digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-node-raw-image-"));
    const path = join(directory, "image");
    const bytes = new Uint8Array(2 * CHUNK_BYTES);
    bytes[19] = 1;
    writeFileSync(path, bytes);
    try {
      const reader = NodeImageReader.open(path, undefined, true);
      try {
        const destination = new Uint8Array(128 * 1024);
        expect(reader.readAt(0, destination)).toBe(64 * 1024);
        expect(destination[19]).toBe(1);
        bytes[19] = 2;
        writeFileSync(path, bytes);
        expect(reader.readAt(0, destination)).toBe(64 * 1024);
        expect(destination[19]).toBe(2);
      } finally { reader.close(); }
      expect(() => NodeImageReader.open(path, { length: bytes.length, chunkBytes: CHUNK_BYTES, imageSha256: "00".repeat(32) }, true)).toThrow("raw image transport");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("opens a whole-digest Node image and refuses corruption before publication", () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-node-global-digest-"));
    const path = join(directory, "image.vfs");
    const bytes = Uint8Array.from({ length: CHUNK_BYTES + 19 }, (_, index) => index % 251);
    const integrity = { length: bytes.length, chunkBytes: CHUNK_BYTES,
      imageSha256: createHash("sha256").update(bytes).digest("hex") };
    try {
      writeFileSync(path, bytes);
      const reader = NodeImageReader.open(path, integrity);
      const tail = new Uint8Array(19);
      expect(reader.readAt(CHUNK_BYTES, tail)).toBe(19);
      expect(tail).toEqual(bytes.subarray(CHUNK_BYTES));
      reader.close();
      bytes[bytes.length - 1]! ^= 1;
      writeFileSync(path, bytes);
      expect(() => NodeImageReader.open(path, integrity)).toThrow("damaged; refusing to boot");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("bounds progress notifications instead of queueing one for every image chunk", () => {
    const chunk = new Uint8Array(CHUNK_BYTES);
    const length = 129 * CHUNK_BYTES;
    const progress: StagedRootfsImageProgress[] = [];
    let size = 0;
    const integrity = writeAndVerifyRootfsImage(visit => {
      for (let offset = 0; offset < length; offset += chunk.length) visit(offset, chunk);
      return length;
    }, {
      writeAllAt: () => { throw new Error("zero-filled snapshot should remain sparse"); },
      readExactAt: (_offset, bytes) => bytes.fill(0),
      setSize: length => { size = length; },
      flush: () => {},
      getSize: () => size,
    }, event => progress.push(event));
    expect(progress.length).toBeLessThan(100);
    expect(progress.at(-1)).toEqual({ phase: "verifying", completed: length, total: length });
    expect(Object.keys(integrity).sort()).toEqual(["chunkBytes", "imageSha256", "length"]);
    expect(JSON.stringify(integrity).length).toBeLessThan(160);
  });

  it("opens only regular positioned files and closes its reader", () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-node-image-reader-"));
    const path = join(directory, "image.vfs");
    const link = join(directory, "link.vfs");
    try {
      writeFileSync(path, Uint8Array.of(1, 2, 3));
      symlinkSync(path, link);
      expect(() => NodeImageReader.open(link)).toThrow();
      expect(() => NodeImageReader.open(directory)).toThrow();
      expect(() => NodeImageReader.open(path, {
        length: 4,
        chunkBytes: CHUNK_BYTES,
        chunkSha256: [createHash("sha256").update(Uint8Array.of(1, 2, 3)).digest("hex")],
      })).toThrow("rootfs image file integrity metadata is invalid");
      const reader = NodeImageReader.open(path);
      const bytes = new Uint8Array(4);
      expect(reader.readAt(1, bytes)).toBe(2);
      expect(bytes.subarray(0, 2)).toEqual(Uint8Array.of(2, 3));
      expect(reader.readAt(-1, bytes)).toBe(-22);
      reader.close();
      expect(reader.readAt(0, bytes)).toBe(-5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hashes the whole image independently of export writes", () => {
    const source = new Uint8Array(CHUNK_BYTES + 19);
    for (let index = 0; index < source.length; index++) source[index] = index % 251;
    const staged = new Uint8Array(source.length);
    let size = 0;
    const progress: StagedRootfsImageProgress[] = [];
    const integrity = writeAndVerifyRootfsImage(
      (visit) => {
        const scratch = new Uint8Array(300_000);
        for (let offset = 0; offset < source.length; offset += scratch.byteLength) {
          const chunk = source.subarray(offset, offset + scratch.byteLength);
          scratch.set(chunk);
          visit(offset, scratch.subarray(0, chunk.byteLength));
        }
        return source.length;
      },
      {
        writeAllAt: (offset, bytes) => {
          staged.set(bytes, offset);
          size = Math.max(size, offset + bytes.length);
        },
        readExactAt: (offset, bytes) => bytes.set(staged.subarray(offset, offset + bytes.length)),
        setSize: (length) => { size = length; },
        flush: () => {},
        getSize: () => size,
      },
      event => progress.push(event),
    );
    expect(progress[0]).toEqual({ phase: "writing", completed: 0 });
    expect(progress).toContainEqual({ phase: "writing", completed: source.length, total: source.length });
    expect(progress).toContainEqual({ phase: "flushing", completed: 0 });
    expect(progress.at(-1)).toEqual({ phase: "verifying", completed: source.length, total: source.length });
    expect(progress.every(event => Object.values(event).every(value => typeof value === "string" || typeof value === "number"))).toBe(true);
    expect(integrity).toEqual({
      length: source.length,
      chunkBytes: CHUNK_BYTES,
      imageSha256: createHash("sha256").update(source).digest("hex"),
    });
    expect(isStagedRootfsImageIntegrity(integrity)).toBe(true);
    expect(isStagedRootfsImageIntegrity({ ...integrity, chunkSha256: ["bad"] })).toBe(false);
  });

  it("rejects a staged byte changed before read-back verification", () => {
    const staged = new Uint8Array(8);
    let size = 0;
    const progress: StagedRootfsImageProgress[] = [];
    expect(() => writeAndVerifyRootfsImage(
      (visit) => {
        visit(0, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
        return 8;
      },
      {
        writeAllAt: (offset, bytes) => {
          staged.set(bytes, offset);
          size = Math.max(size, offset + bytes.length);
        },
        readExactAt: (offset, bytes) => bytes.set(staged.subarray(offset, offset + bytes.length)),
        setSize: (length) => { size = length; },
        flush: () => { staged[3] = staged[3]! ^ 1; },
        getSize: () => size,
      },
      event => progress.push(event),
    )).toThrow("rootfs export staging file failed read-back verification");
    expect(progress.at(-1)).toEqual({ phase: "verifying", completed: 0, total: 8 });
  });

  it("rejects gaps and truncated staged files", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    let size = 0;
    const storage = {
      writeAllAt: () => {},
      readExactAt: () => {},
      setSize: () => { size = 2; },
      flush: () => {},
      getSize: () => size,
    };
    expect(() => writeAndVerifyRootfsImage((visit) => {
      visit(1, bytes);
      return 4;
    }, storage)).toThrow("rootfs export has an invalid chunk boundary");
    expect(() => writeAndVerifyRootfsImage((visit) => {
      visit(0, bytes);
      return 3;
    }, storage)).toThrow("rootfs export staging file has an invalid length");
  });

  it("skips zero writes, extends the staged file, and verifies the holes", () => {
    const source = new Uint8Array(CHUNK_BYTES * 2 + 5);
    source[0] = 7;
    source[source.length - 1] = 9;
    const staged = new Uint8Array(source.length);
    const writes: number[] = [];
    let size = 0;
    const integrity = writeAndVerifyRootfsImage(
      (visit) => {
        for (let offset = 0; offset < source.length; offset += 64 * 1024) {
          visit(offset, source.subarray(offset, offset + 64 * 1024));
        }
        return source.length;
      },
      {
        writeAllAt(offset, bytes) {
          staged.set(bytes, offset);
          writes.push(offset);
          size = Math.max(size, offset + bytes.length);
        },
        readExactAt: (offset, bytes) => bytes.set(staged.subarray(offset, offset + bytes.length)),
        setSize: (length) => { size = length; },
        flush: () => {},
        getSize: () => size,
      },
    );
    expect(writes).toEqual([0, CHUNK_BYTES * 2]);
    expect(size).toBe(source.length);
    expect(integrity.imageSha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(integrity.chunkSha256).toBeUndefined();
  });

  it("rejects a nonzero byte read back from an unwritten hole", () => {
    const staged = new Uint8Array(CHUNK_BYTES + 1);
    let size = 0;
    expect(() => writeAndVerifyRootfsImage(
      (visit) => {
        visit(0, staged);
        return staged.length;
      },
      {
        writeAllAt: () => { throw new Error("zero bytes must not be written"); },
        readExactAt: (offset, bytes) => bytes.set(staged.subarray(offset, offset + bytes.length)),
        setSize: (length) => { size = length; },
        flush: () => { staged[CHUNK_BYTES] = 1; },
        getSize: () => size,
      },
    )).toThrow("rootfs export staging file failed read-back verification");
  });

  it("rejects a nonempty staging file before exporting over stale bytes", () => {
    expect(() => writeAndVerifyRootfsImage(
      () => { throw new Error("must not stream"); },
      {
        writeAllAt: () => {},
        readExactAt: () => {},
        setSize: () => {},
        flush: () => {},
        getSize: () => 1,
      },
    )).toThrow("rootfs export requires an empty staging file");
  });
});
