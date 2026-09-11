import { describe, expect, it } from "vitest";

import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { encodeKernelLazySection } from "../src/vfs/kernel-lazy-section";
import { parseZipCentralDirectory } from "../src/vfs/zip";
import { zipSync } from "fflate";

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

/**
 * Rebuild an image's tail with new archive groups, preserving every section
 * that follows.
 *
 * Carrying the trailing sections through verbatim is the whole trick: the
 * first version of the production-image control rebuilt a tail without them
 * and died on a JSON parse error, so it "caught" the drift on the wrong axis
 * and would have reported a working gate on the strength of an error that
 * proved nothing.
 */
function withArchiveGroups(
  image: Uint8Array,
  lazyOffset: number,
  archiveOffset: number,
  groups: readonly unknown[],
): Uint8Array {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const oldArchiveLength = view.getUint32(archiveOffset, true);
  const tailStart = archiveOffset + 4 + oldArchiveLength;
  const json = new TextEncoder().encode(JSON.stringify(groups));
  // Everything after the archive section (metadata, KLZY) moves as a block.
  const trailing = image.subarray(tailStart);
  const head = image.subarray(0, archiveOffset);
  const out = new Uint8Array(
    head.byteLength + 4 + json.byteLength + trailing.byteLength,
  );
  out.set(head, 0);
  new DataView(out.buffer).setUint32(head.byteLength, json.byteLength, true);
  out.set(json, head.byteLength + 4);
  out.set(trailing, head.byteLength + 4 + json.byteLength);
  void lazyOffset;
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

  it("refuses an image whose recorded inode misses the body", async () => {
    // This is the shape a kernel-written image has: the JSON and the KLZY
    // section agree with EACH OTHER, and both name an inode the body does not
    // have. Before the identity gate this restored happily and emptied the
    // file; the whole point of the gate is that this case is now unshippable.
    const image = await imageWithOneLazyFile();
    const { lazyOffset, entries } = readLazySections(image);
    expect(entries).toHaveLength(1);
    const drifted = [{ ...entries[0], ino: (entries[0].ino as number) + 1 }];

    const mutated = withLazyEntries(image, lazyOffset, drifted, {
      deriveKernelSection: true,
    });

    expect(() => MemoryFileSystem.fromImage(mutated)).toThrow(
      /inode identity does not exist in the image's own filesystem body/,
    );
  });

  it("refuses an image whose generation or data sequence drifts", async () => {
    // Identity is all three fields, not just the inode number. A writer that
    // preserved inode numbers but re-derived the slot generation, or stamped a
    // different data-mutation count on the stub, loses the file exactly as
    // completely — so the gate must cover all three.
    const image = await imageWithOneLazyFile();
    const { lazyOffset, entries } = readLazySections(image);

    for (const field of ["generation", "dataSequence"] as const) {
      const drifted = [
        { ...entries[0], [field]: (entries[0][field] as number) + 1 },
      ];
      const mutated = withLazyEntries(image, lazyOffset, drifted, {
        deriveKernelSection: true,
      });
      expect(
        () => MemoryFileSystem.fromImage(mutated),
        `drifting ${field} must be refused, not tolerated`,
      ).toThrow(/inode identity does not exist/);
    }
  });

  it("names every unresolvable file, so the failure is diagnosable", async () => {
    // A gate that fires without saying what it lost sends the reader back to
    // the image with a hex editor. The message has to carry the paths.
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(256 * 1024));
    fs.registerLazyFile("/a.bin", "https://example.invalid/a", 11, 0o644);
    fs.registerLazyFile("/b.bin", "https://example.invalid/b", 22, 0o644);
    const image = await fs.saveImage();
    const { lazyOffset, entries } = readLazySections(image);
    const drifted = entries.map((e) => ({ ...e, ino: (e.ino as number) + 50 }));

    const mutated = withLazyEntries(image, lazyOffset, drifted, {
      deriveKernelSection: true,
    });

    expect(() => MemoryFileSystem.fromImage(mutated)).toThrow(
      /declares 2 deferred file\(s\)[\s\S]*\/a\.bin[\s\S]*\/b\.bin/,
    );
  });

  it("refuses an image whose ARCHIVE members miss the body", async () => {
    // The archive path carries roughly a hundred times what the per-file path
    // does — production images hold 79 lazy files against ~7,467 archive
    // members — and every archive in every production image is the
    // non-generic shape, which is the one that dropped silently. Generic
    // trees already threw; production ships none of them.
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(256 * 1024));
    fs.mkdir("/opt", 0o755);
    const archive = zipSync({
      "a.txt": new TextEncoder().encode("aaaa"),
      "b.txt": new TextEncoder().encode("bbbbbb"),
    });
    fs.registerLazyArchiveFromEntries(
      "https://example.invalid/pkg.zip",
      parseZipCentralDirectory(archive),
      "/opt/pkg",
    );
    const image = await fs.saveImage();

    // Baseline: the archive members restore.
    const clean = MemoryFileSystem.fromImage(image);
    expect(clean.exportLazyArchiveEntries().length).toBe(1);

    // Now shift every member's declared inode, leaving everything else — the
    // same defect shape as the per-file case.
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const bodyLength = view.getUint32(12, true);
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + bodyLength;
    const lazyLength = view.getUint32(lazyOffset, true);
    const archiveOffset = lazyOffset + 4 + lazyLength;
    const archiveLength = view.getUint32(archiveOffset, true);
    const groups = JSON.parse(
      new TextDecoder().decode(
        image.subarray(archiveOffset + 4, archiveOffset + 4 + archiveLength),
      ),
    );
    for (const group of groups) {
      for (const entry of group.entries) entry.ino = entry.ino + 100;
    }

    const drifted = withArchiveGroups(image, lazyOffset, archiveOffset, groups);
    expect(() => MemoryFileSystem.fromImage(drifted)).toThrow(
      /lazy archive member\(s\) whose inode identity does not exist/,
    );
  });

  it("still throws on the OTHER axis, when JSON and KLZY disagree", async () => {
    // The contrast that makes the tests above worth having, isolated so it
    // actually tests what it claims. The JSON entry here is left correct, so
    // it resolves in the body and the identity gate has nothing to say; only
    // the KLZY section is wrong. If both axes were perturbed at once the
    // identity gate would fire first — `restoreParsedImage` deliberately runs
    // import validation before the section comparison — and this test would
    // pass while proving nothing about the section comparison at all.
    const image = await imageWithOneLazyFile();
    const { lazyOffset, entries } = readLazySections(image);

    const mutated = withLazyEntries(image, lazyOffset, entries, {
      deriveKernelSection: false,
    });

    expect(() => MemoryFileSystem.fromImage(mutated)).toThrow(
      /kernel lazy linkage|KLZY/i,
    );
  });
});
