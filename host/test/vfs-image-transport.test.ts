/**
 * The container's transport and header rules, tested where they LIVE.
 *
 * `host/src/vfs/vfs-image-transport.ts` is 363 lines with seventeen exports
 * and, until this file, no test of its own. Everything it guards was reached
 * through `MemoryFileSystem.fromImage`, which is the class lane V exists to
 * delete — and the module is not deleted with it: `module-base-image.ts` reads
 * a container's host-side sections through `parseImageHeader`, and
 * `images/vfs/lib/kandelo-image-fs.ts` decompresses through
 * `maybeDecompressImage`, so both survive.
 *
 * The one that matters most is the decompression bound. A zstd frame declares
 * its own content size, so thirteen bytes can announce two gigabytes; the
 * frame walk refuses that BEFORE a decompressor is asked to produce it. A
 * guard whose only test is deleted alongside an unrelated class is a guard
 * that is gone, and nothing about the deletion would say so.
 *
 * These claims are MOVED, not invented. Each has a counterpart in
 * `vfs-image.test.ts` driven through `MemoryFileSystem`; here they are driven
 * through the module directly, and the decompression path is additionally
 * driven through `KandeloImageFs.loadImage` so the surviving caller is the one
 * proved to reach the bound.
 */

import { describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";

import {
  VFS_IMAGE_HEADER_SIZE,
  VFS_IMAGE_MAGIC,
  VFS_IMAGE_MAX_DECOMPRESSED_BYTES,
  VFS_IMAGE_VERSION,
  maybeDecompressImage,
  parseImageHeader,
} from "../src/vfs/vfs-image-transport";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

/** A single-segment zstd frame header declaring `bytes` of content and no more. */
function frameDeclaring(bytes: bigint): Uint8Array {
  const frame = new Uint8Array(13);
  frame.set([0x28, 0xb5, 0x2f, 0xfd], 0);
  // Frame_Header_Descriptor: Frame_Content_Size_flag = 3 (eight bytes),
  // Single_Segment_flag set, so the size field follows immediately.
  frame[4] = 0xe0;
  new DataView(frame.buffer).setBigUint64(5, bytes, true);
  return frame;
}

function header(
  magic: number,
  version: number,
  flags: number,
  sabLen: number,
  totalBytes = VFS_IMAGE_HEADER_SIZE,
): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, version, true);
  view.setUint32(8, flags, true);
  view.setUint32(12, sabLen, true);
  return bytes;
}

describe("VFS image transport", () => {
  describe("decompression bound", () => {
    it("refuses a frame that DECLARES more than the bound, before decompressing", () => {
      // Thirteen bytes announcing two gigabytes. Nothing here can produce that
      // payload, so a reader that decompressed first and measured afterwards
      // would have already allocated it.
      expect(() => maybeDecompressImage(frameDeclaring(2n * 1024n * 1024n * 1024n)))
        .toThrow(/zstd.*decompressed.*bound/i);
    });

    it("sums CONCATENATED frames rather than judging each alone", () => {
      // A `.vfs.zst` is not always one frame. Each of these is a quarter of
      // the payload and every one of them is far inside the bound; only the
      // SUM crosses it. A walk that reset its running total per frame would
      // take the whole thing.
      const payload = new Uint8Array(64 * 1024);
      for (let index = 0; index < payload.length; index++) {
        payload[index] = (index * 31 + (index >>> 7)) & 0xff;
      }
      const chunk = 16 * 1024;
      const frames: Uint8Array[] = [];
      for (let at = 0; at < payload.length; at += chunk) {
        frames.push(new Uint8Array(zstdCompressSync(payload.subarray(at, at + chunk))));
      }
      expect(frames.length).toBe(4);
      const joined = new Uint8Array(
        frames.reduce((total, frame) => total + frame.byteLength, 0),
      );
      let at = 0;
      for (const frame of frames) {
        joined.set(frame, at);
        at += frame.byteLength;
      }

      // Accepted at exactly the sum, refused one byte below it -- with every
      // individual frame a quarter of that either way.
      expect(maybeDecompressImage(joined, payload.byteLength)).toEqual(payload);
      expect(() => maybeDecompressImage(joined, payload.byteLength - 1))
        .toThrow(/zstd.*decompressed.*bound/i);
    });

    it("honours a narrower caller-owned bound, and accepts the exact size", () => {
      const plain = header(VFS_IMAGE_MAGIC, VFS_IMAGE_VERSION, 0, 0, 64);
      const compressed = new Uint8Array(zstdCompressSync(plain));
      expect(() => maybeDecompressImage(compressed, plain.byteLength - 1))
        .toThrow(/zstd.*decompressed.*bound/i);
      expect(maybeDecompressImage(compressed, plain.byteLength))
        .toEqual(plain);
    });

    it("rejects a bound that is not a usable size", () => {
      for (const bad of [-1, 1.5, Number.NaN, VFS_IMAGE_HEADER_SIZE - 1]) {
        expect(() => maybeDecompressImage(new Uint8Array(32), bad))
          .toThrow("VFS image decompressed byte bound is invalid");
      }
      expect(() =>
        maybeDecompressImage(new Uint8Array(32), VFS_IMAGE_MAX_DECOMPRESSED_BYTES + 1)
      ).toThrow("VFS image decompressed byte bound is invalid");
    });

    it("bounds an UNCOMPRESSED image too, so the check is not a zstd-only rule", () => {
      expect(() => maybeDecompressImage(new Uint8Array(4096), 4095))
        .toThrow("VFS image exceeds its decompressed byte bound");
    });

    it("passes plain bytes through untouched", () => {
      const plain = header(VFS_IMAGE_MAGIC, VFS_IMAGE_VERSION, 0, 0, 32);
      expect(maybeDecompressImage(plain)).toBe(plain);
    });

    it("is the same bound the surviving image reader enforces", () => {
      // `MemoryFileSystem` is not the only caller and will not be a caller at
      // all; `KandeloImageFs.loadImage` decompresses through this function, so
      // the guard has to hold from there.
      const fs = KandeloImageFs.create();
      expect(() => fs.loadImage(frameDeclaring(2n * 1024n * 1024n * 1024n)))
        .toThrow(/zstd.*decompressed.*bound/i);
    });
  });

  describe("header refusals", () => {
    it("rejects bytes too short to hold a header", () => {
      expect(() => parseImageHeader(new Uint8Array(4))).toThrow("VFS image too small");
    });

    it("rejects a container whose magic is not VFSI", () => {
      expect(() => parseImageHeader(header(0xdeadbeef, VFS_IMAGE_VERSION, 0, 0, 32)))
        .toThrow("Bad VFS image magic");
    });

    it("rejects a version this reader does not implement", () => {
      expect(() => parseImageHeader(header(VFS_IMAGE_MAGIC, 99, 0, 0, 32)))
        .toThrow("Unsupported VFS image version");
    });

    it("rejects a body the container claims but does not carry", () => {
      // The header declares a megabyte of filesystem and the buffer is the
      // header alone. Accepting it would read past the end of what arrived.
      expect(() => parseImageHeader(header(VFS_IMAGE_MAGIC, VFS_IMAGE_VERSION, 0, 1_000_000)))
        .toThrow("VFS image truncated");
    });

    it("returns the flags and body length a well-formed header carries", () => {
      const bytes = header(VFS_IMAGE_MAGIC, VFS_IMAGE_VERSION, 0b101, 8, VFS_IMAGE_HEADER_SIZE + 8 + 4);
      const parsed = parseImageHeader(bytes);
      expect(parsed.flags).toBe(0b101);
      expect(parsed.sabLen).toBe(8);
      expect(parsed.image).toBe(bytes);
    });
  });
});
