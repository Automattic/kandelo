import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeImageReader } from "../src/vfs/node-image-reader";
import {
  isStagedRootfsImageIntegrity,
  writeAndVerifyRootfsImage,
} from "../src/vfs/staged-rootfs-image";

const CHUNK_BYTES = 1024 * 1024;

describe("staged rootfs image verification", () => {
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

  it("hashes chunk boundaries independently of export writes", () => {
    const source = new Uint8Array(CHUNK_BYTES + 19);
    for (let index = 0; index < source.length; index++) source[index] = index % 251;
    const staged = new Uint8Array(source.length);
    let size = 0;
    const integrity = writeAndVerifyRootfsImage(
      (visit) => {
        for (let offset = 0; offset < source.length; offset += 300_000) {
          visit(offset, source.subarray(offset, offset + 300_000));
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
    );
    expect(integrity).toEqual({
      length: source.length,
      chunkBytes: CHUNK_BYTES,
      chunkSha256: [
        createHash("sha256").update(source.subarray(0, CHUNK_BYTES)).digest("hex"),
        createHash("sha256").update(source.subarray(CHUNK_BYTES)).digest("hex"),
      ],
    });
    expect(isStagedRootfsImageIntegrity(integrity)).toBe(true);
    expect(isStagedRootfsImageIntegrity({ ...integrity, chunkSha256: ["bad"] })).toBe(false);
  });

  it("rejects a staged byte changed before read-back verification", () => {
    const staged = new Uint8Array(8);
    let size = 0;
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
    )).toThrow("rootfs export staging file failed read-back verification");
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
    expect(integrity.chunkSha256).toEqual([
      createHash("sha256").update(source.subarray(0, CHUNK_BYTES)).digest("hex"),
      createHash("sha256").update(source.subarray(CHUNK_BYTES, CHUNK_BYTES * 2)).digest("hex"),
      createHash("sha256").update(source.subarray(CHUNK_BYTES * 2)).digest("hex"),
    ]);
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
