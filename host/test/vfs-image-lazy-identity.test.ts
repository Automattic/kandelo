import { describe, expect, it } from "vitest";

import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { encodeKernelLazySection } from "../src/vfs/kernel-lazy-section";

/**
 * A lazy file's linkage survives a save/restore ONLY while the inode identity
 * recorded in the image's JSON still names the same inode in the image's body.
 *
 * This matters far beyond a hand-edited image. The W chain is moving image
 * WRITING into the kernel, and the kernel's SFFS writer assigns its own inode
 * numbers — they have no reason to match the ones the host carries forward in
 * its lazy JSON, which it copies from the base image because URLs, transports,
 * integrity digests and activation modes are host authority the kernel
 * deliberately does not hold (see `crates/runtime-core/src/klzy.rs`).
 *
 * The existing `KLZY`-versus-JSON gate does not cover this. That gate compares
 * the image's two DESCRIPTIONS of its deferred files against each other; both
 * can agree perfectly and still both disagree with the body. These tests pin
 * the difference, because the two failures look identical from the outside and
 * are nothing alike: one is loud, and the other quietly turns a 4 KiB file into
 * an empty one that can never be fetched again.
 */

/** VFSI header: magic, version, flags, body length. */
const VFS_IMAGE_HEADER_SIZE = 16;

interface ImageSections {
  readonly lazyOffset: number;
  readonly lazyLength: number;
  readonly entries: Array<Record<string, unknown>>;
}

function readLazySections(image: Uint8Array): ImageSections {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const bodyLength = view.getUint32(12, true);
  const lazyOffset = VFS_IMAGE_HEADER_SIZE + bodyLength;
  const lazyLength = view.getUint32(lazyOffset, true);
  const json = new TextDecoder().decode(
    image.subarray(lazyOffset + 4, lazyOffset + 4 + lazyLength),
  );
  return { lazyOffset, lazyLength, entries: JSON.parse(json) };
}

/** Rebuild an image's trailing sections the way `saveImage` does. */
function withLazyEntries(
  image: Uint8Array,
  lazyOffset: number,
  entries: readonly Record<string, unknown>[],
  options: { readonly deriveKernelSection: boolean },
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(entries));
  const kernelSection = options.deriveKernelSection
    ? encodeKernelLazySection(entries as never, [])
    : encodeKernelLazySection([], []);
  const head = image.subarray(0, lazyOffset);
  const tail = new Uint8Array(4 + json.byteLength + 4 + kernelSection.byteLength);
  const view = new DataView(tail.buffer);
  view.setUint32(0, json.byteLength, true);
  tail.set(json, 4);
  view.setUint32(4 + json.byteLength, kernelSection.byteLength, true);
  tail.set(kernelSection, 4 + json.byteLength + 4);
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(tail, head.byteLength);
  return out;
}

function imageWithOneLazyFile(): Uint8Array | Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(256 * 1024));
  fs.registerLazyFile("/big.bin", "https://example.invalid/big.bin", 4242, 0o644);
  return fs.saveImage();
}

describe("VFS image lazy-file inode identity", () => {
  it("restores a lazy file whose recorded identity matches the body", async () => {
    const image = await imageWithOneLazyFile();
    const restored = MemoryFileSystem.fromImage(image);

    const entry = restored.getLazyEntry("/big.bin");
    expect(entry).not.toBeNull();
    expect(entry?.size).toBe(4242);
    expect(entry?.url).toBe("https://example.invalid/big.bin");
    // The stub reports the file's REAL size, which is the whole point: the
    // bytes are absent but the file is not empty.
    expect(Number(restored.stat("/big.bin").size)).toBe(4242);
  });

  it("loses a lazy file SILENTLY when its recorded inode misses the body", async () => {
    // This is the shape a kernel-written image has today: the JSON and the
    // KLZY section agree with EACH OTHER, and both name an inode the body
    // does not have. Nothing throws, and the deferred backing is simply gone.
    const image = await imageWithOneLazyFile();
    const { lazyOffset, entries } = readLazySections(image);
    expect(entries).toHaveLength(1);
    const drifted = [{ ...entries[0], ino: (entries[0].ino as number) + 1 }];

    const mutated = withLazyEntries(image, lazyOffset, drifted, {
      deriveKernelSection: true,
    });

    const restored = MemoryFileSystem.fromImage(mutated);
    expect(restored.getLazyEntry("/big.bin")).toBeNull();
    // The file is still there, and it is empty for good: its 4242 bytes have
    // no URL attached to them any more, so nothing can ever fetch them.
    expect(Number(restored.stat("/big.bin").size)).toBe(0);
  });

  it("loses a lazy file SILENTLY when its generation or data sequence drifts", async () => {
    // Identity is all three fields, not just the inode number. A writer that
    // preserved inode numbers but re-derived the slot generation, or that
    // stamped a different data-mutation count on the stub, loses the file
    // exactly as completely.
    const image = await imageWithOneLazyFile();
    const { lazyOffset, entries } = readLazySections(image);

    for (const field of ["generation", "dataSequence"] as const) {
      const drifted = [
        { ...entries[0], [field]: (entries[0][field] as number) + 1 },
      ];
      const mutated = withLazyEntries(image, lazyOffset, drifted, {
        deriveKernelSection: true,
      });
      const restored = MemoryFileSystem.fromImage(mutated);
      expect(
        restored.getLazyEntry("/big.bin"),
        `drifting ${field} must not be tolerated silently`,
      ).toBeNull();
      expect(Number(restored.stat("/big.bin").size)).toBe(0);
    }
  });

  it("throws LOUDLY when the JSON and KLZY sections disagree with each other", async () => {
    // The contrast that makes the tests above worth having. The existing gate
    // is real and it works — it just guards a different axis. Here the JSON
    // moves and the KLZY section does not, so the image's two descriptions of
    // itself conflict and the restore refuses.
    const image = await imageWithOneLazyFile();
    const { lazyOffset, entries } = readLazySections(image);
    const drifted = [{ ...entries[0], ino: (entries[0].ino as number) + 1 }];

    const mutated = withLazyEntries(image, lazyOffset, drifted, {
      deriveKernelSection: false,
    });

    expect(() => MemoryFileSystem.fromImage(mutated)).toThrow(
      /kernel lazy linkage|KLZY/i,
    );
  });
});
