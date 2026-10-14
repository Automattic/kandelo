import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isStagedRootfsImageIntegrity,
  writeAndVerifyRootfsImage,
} from "../src/vfs/staged-rootfs-image";

const CHUNK_BYTES = 1024 * 1024;

describe("staged rootfs image verification", () => {
  it("hashes chunk boundaries independently of export writes", () => {
    const source = new Uint8Array(CHUNK_BYTES + 19);
    for (let index = 0; index < source.length; index++) source[index] = index % 251;
    const staged = new Uint8Array(source.length);
    const integrity = writeAndVerifyRootfsImage(
      (visit) => {
        for (let offset = 0; offset < source.length; offset += 300_000) {
          visit(offset, source.subarray(offset, offset + 300_000));
        }
        return source.length;
      },
      {
        writeAllAt: (offset, bytes) => staged.set(bytes, offset),
        readExactAt: (offset, bytes) => bytes.set(staged.subarray(offset, offset + bytes.length)),
        flush: () => {},
        getSize: () => staged.length,
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
    expect(() => writeAndVerifyRootfsImage(
      (visit) => {
        visit(0, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
        return 8;
      },
      {
        writeAllAt: (offset, bytes) => staged.set(bytes, offset),
        readExactAt: (offset, bytes) => bytes.set(staged.subarray(offset, offset + bytes.length)),
        flush: () => { staged[3] = staged[3]! ^ 1; },
        getSize: () => staged.length,
      },
    )).toThrow("rootfs export staging file failed read-back verification");
  });

  it("rejects gaps and truncated staged files", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const storage = {
      writeAllAt: () => {},
      readExactAt: () => {},
      flush: () => {},
      getSize: () => 2,
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
});
