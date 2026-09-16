/**
 * The VFS image's kernel-facing lazy-linkage section ("KLZY").
 *
 * Two things are proven here.
 *
 * 1. The section's framing, from the writer's side: what `encodeKernelLazySection`
 *    emits, what it refuses to emit, what `decodeKernelLazySection` rejects, and
 *    that `saveImage` appends it where no existing reader can see it.
 *
 * 2. EQUIVALENCE, on every production image in the worktree: the lazy facts the
 *    image's own binary section carries must exactly equal the lazy facts the
 *    host reconstructs today by loading the image's JSON and walking the
 *    restored filesystem. The oracle is the RTFS v3 boot manifest — the byte
 *    stream `rootfs::load_manifest` actually consumes — so the comparison is
 *    against what the kernel is told today, not against a paraphrase of it.
 *
 * Why the RTFS manifest is a real oracle and not a tautology: its per-file
 * `size` comes from `MemoryFileSystem.lstat` -> `adaptStatWithLazySize`, which
 * resolves a lazy inode's size through the live `lazyFiles` /
 * `lazyArchiveInodes` maps rebuilt during restore. `KLZY`'s sizes come from the
 * serialized entries. Those are different code paths over different data
 * structures, and the manifest additionally reaches its entries by walking the
 * SFFS tree rather than by reading the JSON array. So an image whose stubs and
 * whose metadata disagree fails this test.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { MemoryFileSystem } from "../src/vfs/memory-fs";
import type {
  LazyFileEntry,
  SerializedLazyArchiveEntry,
} from "../src/vfs/memory-fs";
import {
  decodeKernelLazySection,
  encodeKernelLazySection,
  KERNEL_LAZY_FILE_HEADER_SIZE,
  KERNEL_LAZY_GROUP_HEADER_SIZE,
  KERNEL_LAZY_HEADER_SIZE,
  VFS_IMAGE_FLAG_HAS_KERNEL_LAZY,
} from "../src/vfs/kernel-lazy-section";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";
import { parseZipCentralDirectory } from "../src/vfs/zip";
import { emitRootfsManifest } from "./support/rootfs-manifest-oracle";
import {
  decodeRootfsManifest,
  RTFS_KIND_FILE,
  RTFS_KIND_LAZY_FILE,
} from "./fixtures/rtfs-manifest-decode";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const imageDir = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32");

/**
 * Every production image the repo builds. Named explicitly rather than
 * globbed: a glob that silently matched two images would let this gate pass
 * while proving almost nothing, and the grounding pass measured exactly these
 * nine.
 */
const PRODUCTION_IMAGES = [
  "rootfs.vfs",
  "shell.vfs.zst",
  "wordpress.vfs.zst",
  "lamp.vfs.zst",
  "nginx-php-vfs.vfs.zst",
  "nginx-vfs.vfs.zst",
  "node-vfs.vfs.zst",
  "kandelo-sdk.vfs.zst",
  "mariadb-test.vfs.zst",
] as const;

function member(
  ino: number,
  size: number,
  sourcePath: string,
  mountPrefix: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    vfsPath: `${mountPrefix}/${sourcePath}`,
    ino,
    generation: 1,
    dataSequence: 1,
    size,
    isSymlink: false,
    deleted: false,
    archivePath: sourcePath,
    sourcePath,
    type: "file" as const,
    inodeGroup: sourcePath,
    ...overrides,
  };
}

function group(
  mountPrefix: string,
  archiveBytes: number | undefined,
  entries: ReturnType<typeof member>[],
  overrides: Record<string, unknown> = {},
): SerializedLazyArchiveEntry {
  return {
    kind: "kandelo-legacy-zip-v1",
    url: "https://example.invalid/archive.zip",
    mountPrefix,
    ...(archiveBytes === undefined ? {} : { integrity: { bytes: archiveBytes } }),
    materialized: false,
    entries,
    ...overrides,
  } as unknown as SerializedLazyArchiveEntry;
}

function lazyFile(ino: number, size: number, path: string): LazyFileEntry {
  return {
    ino,
    generation: 1,
    dataSequence: 1,
    path,
    paths: [path],
    url: `https://example.invalid${path}`,
    size,
  };
}

describe("KLZY section framing", () => {
  it("round-trips groups and files, and assigns archive ids in group order", () => {
    const section = encodeKernelLazySection(
      [lazyFile(10, 4242, "/var/single")],
      [
        group("/usr", 4096, [member(11, 12, "bin/one", "/usr")]),
        group("/opt", 8192, [member(12, 34, "lib/two", "/opt")]),
      ],
    );
    const decoded = decodeKernelLazySection(section);
    expect(decoded.archives).toEqual([
      { archiveId: 1, archiveBytes: 4096, mountPrefix: "/usr" },
      { archiveId: 2, archiveBytes: 8192, mountPrefix: "/opt" },
    ]);
    expect(decoded.files).toEqual([
      { ino: 10, size: 4242, archiveId: 0, sourcePath: "" },
      { ino: 11, size: 12, archiveId: 1, sourcePath: "bin/one" },
      { ino: 12, size: 34, archiveId: 2, sourcePath: "lib/two" },
    ]);
    expect(section.byteLength).toBe(
      KERNEL_LAZY_HEADER_SIZE +
        2 * KERNEL_LAZY_GROUP_HEADER_SIZE +
        "/usr".length +
        "/opt".length +
        3 * KERNEL_LAZY_FILE_HEADER_SIZE +
        "bin/one".length +
        "lib/two".length,
    );
  });

  it("encodes an empty section rather than nothing when an image has no lazy state", () => {
    const decoded = decodeKernelLazySection(encodeKernelLazySection([], []));
    expect(decoded).toEqual({ archives: [], files: [] });
  });

  it("skips groups that cannot be fetched or validated, and their members with them", () => {
    // No declared archive size: the fetched bytes could not be validated, so
    // the group is a truthful gap rather than a guess. Same for a group with
    // no transport at all. Neither may consume an archive id, or the ids in
    // the image would not match the ids the host mints for its fetch table.
    const section = encodeKernelLazySection(
      [],
      [
        group("/a", undefined, [member(21, 1, "x", "/a")]),
        group("/b", 16, [member(22, 2, "y", "/b")], { url: "" }),
        group("/c", 32, [member(23, 3, "z", "/c")]),
      ],
    );
    const decoded = decodeKernelLazySection(section);
    expect(decoded.archives).toEqual([
      { archiveId: 1, archiveBytes: 32, mountPrefix: "/c" },
    ]);
    expect(decoded.files).toEqual([
      { ino: 23, size: 3, archiveId: 1, sourcePath: "z" },
    ]);
  });

  it("skips members that are not byte ranges in the archive", () => {
    const decoded = decodeKernelLazySection(
      encodeKernelLazySection(
        [],
        [
          group("/usr", 64, [
            member(31, 1, "kept", "/usr"),
            member(32, 1, "deleted", "/usr", { deleted: true }),
            member(33, 1, "symlink", "/usr", { isSymlink: true }),
            member(34, 1, "hardlink", "/usr", { type: "hardlink" }),
            member(35, 1, "", "/usr"),
          ]),
        ],
      ),
    );
    expect(decoded.files.map((f) => f.sourcePath)).toEqual(["kept"]);
  });

  it("refuses to encode two deferred backings for one inode", () => {
    // The kernel keys deferred backing by inode; two records for one inode
    // would leave the image unable to say which size `stat` should report.
    expect(() =>
      encodeKernelLazySection(
        [lazyFile(41, 1, "/a")],
        [group("/usr", 8, [member(41, 2, "b", "/usr")])],
      ),
    ).toThrow(/more than one deferred backing/);
  });

  it("refuses names that would truncate in a path resolver", () => {
    expect(() =>
      encodeKernelLazySection([], [group("/us\0r", 8, [])]),
    ).toThrow(/NUL byte/);
  });

  it("rejects every framing violation the Rust decoder rejects", () => {
    const good = encodeKernelLazySection(
      [lazyFile(10, 4242, "/var/single")],
      [group("/usr", 4096, [member(11, 12, "bin/one", "/usr")])],
    );
    const mutate = (fn: (bytes: Uint8Array, view: DataView) => void) => {
      const copy = good.slice();
      fn(copy, new DataView(copy.buffer, copy.byteOffset, copy.byteLength));
      return copy;
    };
    const cases: Array<[string, Uint8Array]> = [
      ["truncated header", good.subarray(0, KERNEL_LAZY_HEADER_SIZE - 1)],
      ["invalid magic", mutate((b) => void (b[0] ^= 0xff))],
      ["unsupported version", mutate((_, v) => v.setUint16(4, 2, true))],
      ["unsupported header size", mutate((_, v) => v.setUint16(6, 24, true))],
      ["reserved header field is nonzero", mutate((_, v) => v.setUint32(16, 1, true))],
      [
        "unknown group flag",
        mutate((_, v) => v.setUint16(KERNEL_LAZY_HEADER_SIZE + 16, 1, true)),
      ],
      [
        "reserved group field is nonzero",
        mutate((_, v) => v.setUint16(KERNEL_LAZY_HEADER_SIZE + 18, 1, true)),
      ],
      [
        "zero, duplicated, or unordered archive id",
        mutate((_, v) => v.setUint32(KERNEL_LAZY_HEADER_SIZE + 4, 0, true)),
      ],
      [
        "inconsistent group record size",
        mutate((_, v) => v.setUint32(KERNEL_LAZY_HEADER_SIZE, 999, true)),
      ],
      ["trailing bytes", new Uint8Array([...good, 0])],
    ];
    for (const [why, bytes] of cases) {
      expect(() => decodeKernelLazySection(bytes), why).toThrow(
        new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });

  it("rejects an undeclared archive id and a source path that does not match its archive", () => {
    // These cannot be produced by the encoder, so build them by hand the way
    // a corrupt or hostile image would.
    const hand = (
      archiveCount: number,
      ino: number,
      archiveId: number,
      sourcePath: string,
    ) => {
      const path = new TextEncoder().encode(sourcePath);
      const bytes = new Uint8Array(
        KERNEL_LAZY_HEADER_SIZE +
          archiveCount * (KERNEL_LAZY_GROUP_HEADER_SIZE + 4) +
          KERNEL_LAZY_FILE_HEADER_SIZE +
          path.length,
      );
      const v = new DataView(bytes.buffer);
      bytes.set([0x4b, 0x4c, 0x5a, 0x59], 0);
      v.setUint16(4, 1, true);
      v.setUint16(6, KERNEL_LAZY_HEADER_SIZE, true);
      v.setUint32(8, archiveCount, true);
      v.setUint32(12, 1, true);
      let at = KERNEL_LAZY_HEADER_SIZE;
      for (let i = 0; i < archiveCount; i++) {
        v.setUint32(at, KERNEL_LAZY_GROUP_HEADER_SIZE + 4, true);
        v.setUint32(at + 4, i + 1, true);
        v.setBigUint64(at + 8, 64n, true);
        v.setUint32(at + 20, 4, true);
        bytes.set(new TextEncoder().encode("/usr"), at + KERNEL_LAZY_GROUP_HEADER_SIZE);
        at += KERNEL_LAZY_GROUP_HEADER_SIZE + 4;
      }
      v.setUint32(at, KERNEL_LAZY_FILE_HEADER_SIZE + path.length, true);
      v.setUint32(at + 4, ino, true);
      v.setBigUint64(at + 8, 1n, true);
      v.setUint32(at + 16, archiveId, true);
      v.setUint32(at + 20, path.length, true);
      bytes.set(path, at + KERNEL_LAZY_FILE_HEADER_SIZE);
      return bytes;
    };
    expect(() => decodeKernelLazySection(hand(1, 5, 9, "x"))).toThrow(
      /undeclared archive id 9/,
    );
    expect(() => decodeKernelLazySection(hand(1, 5, 1, ""))).toThrow(
      /archive member without a source path/,
    );
    expect(() => decodeKernelLazySection(hand(0, 5, 0, "x"))).toThrow(
      /source path without an archive/,
    );
    expect(() => decodeKernelLazySection(hand(0, 0, 0, ""))).toThrow(/inode 0/);
  });
});

describe("KLZY section in the image container", () => {
  async function imageWithLazyState(): Promise<Uint8Array> {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.mkdir("/var", 0o755);
    fs.registerLazyFile(
      "/var/deferred",
      "https://example.invalid/deferred.bin",
      1234,
      0o644,
    );
    return await fs.saveImage();
  }

  it("appends the section, announces it in bit 4, and leaves older readers unaffected", async () => {
    const image = await imageWithLazyState();
    const flags = new DataView(
      image.buffer,
      image.byteOffset,
      image.byteLength,
    ).getUint32(8, true);
    expect(flags & VFS_IMAGE_FLAG_HAS_KERNEL_LAZY).toBe(
      VFS_IMAGE_FLAG_HAS_KERNEL_LAZY,
    );

    const linkage = MemoryFileSystem.readImageKernelLazyLinkage(image);
    expect(linkage).not.toBeNull();
    expect(linkage!.archives).toEqual([]);
    expect(linkage!.files).toHaveLength(1);
    expect(linkage!.files[0].size).toBe(1234);
    expect(linkage!.files[0].archiveId).toBe(0);

    // The JSON sections a pre-section reader consumes are untouched, and
    // restoring still yields the same lazy state.
    const restored = MemoryFileSystem.fromImage(image);
    const exported = restored.exportLazyEntries();
    expect(exported).toHaveLength(1);
    expect(exported[0].size).toBe(1234);
    expect(exported[0].ino).toBe(linkage!.files[0].ino);
    // Truncating the image to where a pre-section reader stops must still
    // parse: that is the property that makes the section invisible to them.
    expect(
      MemoryFileSystem.readImageMetadata(image.subarray(0, image.byteLength)),
    ).toBeNull();
  });

  it("reports no linkage for an image written before the section existed", async () => {
    const image = await imageWithLazyState();
    const stripped = image.slice();
    const view = new DataView(
      stripped.buffer,
      stripped.byteOffset,
      stripped.byteLength,
    );
    view.setUint32(
      8,
      view.getUint32(8, true) & ~VFS_IMAGE_FLAG_HAS_KERNEL_LAZY,
      true,
    );
    expect(MemoryFileSystem.readImageKernelLazyLinkage(stripped)).toBeNull();
  });

  it("survives a save/restore/save cycle with the same linkage", async () => {
    const first = await imageWithLazyState();
    const restored = MemoryFileSystem.fromImage(first);
    const second = await restored.saveImage();
    expect(MemoryFileSystem.readImageKernelLazyLinkage(second)).toEqual(
      MemoryFileSystem.readImageKernelLazyLinkage(first),
    );
  });

  /**
   * The cycle above uses a URL-backed lazy file, whose linkage the JSON lazy
   * section carries directly. The linkage that can actually be LOST across a
   * cycle is an archive member's, because it lives in the archive section's
   * `entries[]` and nowhere else the host reads back. So the cycle is repeated
   * here over archive-backed state, and then deliberately broken.
   */
  describe("archive-backed linkage across a save/restore/save cycle", () => {
    async function imageWithArchiveState(): Promise<Uint8Array> {
      const archive = zipSync({
        "alpha.bin": new TextEncoder().encode("alpha bytes"),
        "nested/beta.bin": new TextEncoder().encode("beta"),
      });
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", archive.slice()),
      );
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
      fs.registerLazyArchiveFromEntries(
        "https://example.invalid/archive.zip",
        parseZipCentralDirectory(archive),
        "/runtime",
        undefined,
        {
          sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
            "",
          ),
          bytes: archive.byteLength,
        },
      );
      return await fs.saveImage();
    }

    /** Section extents of a container written by `saveImage`. */
    function sections(image: Uint8Array): {
      flags: number;
      lazy: [number, number];
      archive: [number, number];
      rest: number;
    } {
      const view = new DataView(
        image.buffer,
        image.byteOffset,
        image.byteLength,
      );
      const flags = view.getUint32(8, true);
      const sabLen = view.getUint32(12, true);
      const lazyOffset = 16 + sabLen;
      const lazyLen = view.getUint32(lazyOffset, true);
      const archiveOffset = lazyOffset + 4 + lazyLen;
      const archiveLen = view.getUint32(archiveOffset, true);
      return {
        flags,
        lazy: [lazyOffset + 4, lazyLen],
        archive: [archiveOffset + 4, archiveLen],
        rest: archiveOffset + 4 + archiveLen,
      };
    }

    /**
     * Rewrite only the archive JSON section, leaving every other byte — the
     * header flags, the filesystem, and the binary `KLZY` section — exactly as
     * the writer emitted them. This is the shape of the hazard: a producer
     * that narrows what the JSON says while the binary section still describes
     * the full image.
     */
    function withArchiveJson(
      image: Uint8Array,
      transform: (groups: unknown[]) => unknown[],
    ): Uint8Array {
      const s = sections(image);
      const groups = JSON.parse(
        new TextDecoder().decode(
          image.subarray(s.archive[0], s.archive[0] + s.archive[1]),
        ),
      ) as unknown[];
      const json = new TextEncoder().encode(
        JSON.stringify(transform(groups)),
      );
      const head = s.archive[0] - 4;
      const tailLength = image.byteLength - s.rest;
      const out = new Uint8Array(head + 4 + json.byteLength + tailLength);
      out.set(image.subarray(0, head));
      new DataView(out.buffer).setUint32(head, json.byteLength, true);
      out.set(json, head + 4);
      out.set(image.subarray(s.rest), head + 4 + json.byteLength);
      return out;
    }

    it("keeps every archive member's linkage across the cycle", async () => {
      const first = await imageWithArchiveState();
      const before = MemoryFileSystem.readImageKernelLazyLinkage(first);
      expect(before!.archives).toHaveLength(1);
      expect(before!.files).toHaveLength(2);

      const second = await MemoryFileSystem.fromImage(first).saveImage();
      expect(MemoryFileSystem.readImageKernelLazyLinkage(second)).toEqual(
        before,
      );
    });

    it("refuses an image whose archive JSON dropped every member", async () => {
      // The existing serialized-archive contract already refuses a group with
      // no members at all, so this loss is loud without the equality check.
      // Asserted so the boundary between the two checks stays visible: only
      // the PARTIAL loss below needs the new one.
      const image = await imageWithArchiveState();
      expect(() =>
        MemoryFileSystem.fromImage(
          withArchiveJson(image, (groups) =>
            groups.map((group) => ({
              ...(group as Record<string, unknown>),
              entries: [],
            })),
          ),
        ),
      ).toThrow(/Serialized legacy lazy archive entries/);
    });

    it("refuses an image whose archive JSON lost a member its KLZY declares", async () => {
      const image = await imageWithArchiveState();
      const stripped = withArchiveJson(image, (groups) =>
        groups.map((group) => ({
          ...(group as Record<string, unknown>),
          entries: [(group as { entries: unknown[] }).entries[0]],
        })),
      );

      // The image still LOOKS correct to a reader of the binary section
      // alone — which is why the loss is invisible without this check.
      expect(
        MemoryFileSystem.readImageKernelLazyLinkage(stripped)!.files,
      ).toHaveLength(2);

      // Without the restore-time equality check this restored cleanly, and the
      // NEXT save wrote a well-formed KLZY with an empty file table: every
      // archive-backed stub silently became a 0-byte regular file to the
      // kernel. It is a loud refusal instead.
      expect(() => MemoryFileSystem.fromImage(stripped)).toThrow(
        /kernel lazy linkage \(KLZY\) does not match its JSON lazy sections/,
      );
    });

    it("refuses an image whose archive JSON gained a member its KLZY does not declare", async () => {
      const image = await imageWithArchiveState();
      const grown = withArchiveJson(image, (groups) =>
        groups.map((group) => {
          const g = group as { entries: unknown[] };
          const first = g.entries[0] as Record<string, unknown>;
          return {
            ...(group as Record<string, unknown>),
            entries: [
              ...g.entries,
              { ...first, vfsPath: "/runtime/extra.bin", ino: 4242 },
            ],
          };
        }),
      );
      // This DIRECTION is now shadowed, and the expectation says so rather
      // than pretending otherwise. A member the JSON gained is necessarily
      // either unresolvable in the body — caught by the inode-identity gate,
      // which runs during the import and so reports first — or a duplicate of
      // a real one, caught by the duplicate check. There is no longer a way to
      // gain a member that reaches the KLZY comparison, so pinning that
      // message here would only be pinning check ORDER.
      //
      // The KLZY membership comparison itself is still pinned, by the sibling
      // test above: a member the JSON LOST is present in KLZY and resolves in
      // the body, so no earlier check has anything to say about it. That test
      // is where this axis lives now.
      expect(() => MemoryFileSystem.fromImage(grown)).toThrow(
        /kernel lazy linkage \(KLZY\) does not match its JSON lazy sections|lazy archive member\(s\) whose inode identity does not exist|duplicate/,
      );
    });
  });
});

/**
 * The gate. For every production image: decode the lazy facts from the
 * image's own `KLZY` section and from the RTFS v3 manifest the host emits
 * today, and require the two sets to be equal.
 */
describe("KLZY equivalence with the host-emitted RTFS manifest", () => {
  const available = existsSync(imageDir);

  it("finds every production image", () => {
    // Deliberately a FAILURE, not a skip. This suite is the equivalence gate
    // for the KLZY section: if it cannot read the production images it has
    // proved nothing, and a green run would be a false assurance. Per the
    // build contract, a missing artifact is a provisioning step
    // (`./run.sh setup`), not a boundary to pass over silently.
    expect(
      available,
      `${imageDir} is not built, so the KLZY equivalence gate cannot run. ` +
        "Run ./run.sh setup to produce the production images.",
    ).toBe(true);
    const missing = PRODUCTION_IMAGES.filter(
      (name) => !existsSync(join(imageDir, name)),
    );
    expect(missing, "image directory exists but images are missing").toEqual([]);
  });

  for (const name of PRODUCTION_IMAGES) {
    it(
      `carries the same lazy facts as the manifest for ${name}`,
      async () => {
        const path = join(imageDir, name);
        // Same reasoning as above: an unreadable image fails the gate rather
        // than quietly passing it.
        expect(
          available && existsSync(path),
          `${path} is missing; run ./run.sh setup before this gate can prove anything.`,
        ).toBe(true);

        const raw = new Uint8Array(readFileSync(path));
        const fs = MemoryFileSystem.fromImagePreservingCapacity(raw);
        await fs.verifyImportedLazyAtomicGroupSeals();

        // Left-hand side: the image's own binary section, re-emitted through
        // the real writer so this exercises `saveImage`, not just the encoder.
        const reemitted = await fs.saveImage();
        const linkage = MemoryFileSystem.readImageKernelLazyLinkage(reemitted);
        expect(linkage, `${name} declares no KLZY section`).not.toBeNull();

        // Right-hand side: what the kernel is told today. `buildRootfsLazyWiring`
        // reduces the JSON; `emitRootfsManifest` walks the restored tree and
        // takes every size from `lstat`.
        const { lazyInput } = buildRootfsLazyWiring(
          fs.exportLazyArchiveEntries(),
          async () => {
            throw new Error("no fetch during equivalence checking");
          },
        );
        const { buffer } = emitRootfsManifest(
          fs,
          (p) => p,
          lazyInput,
        );
        const manifest = decodeRootfsManifest(buffer);

        // Archive tables must match exactly, ids included: the ids in the
        // image and the ids the host mints must be the same ids.
        expect(
          linkage!.archives.map((a) => ({
            archiveId: a.archiveId,
            size: a.archiveBytes,
          })),
        ).toEqual(
          manifest.archives.map((a) => ({
            archiveId: a.archiveId,
            size: Number(a.archiveSize),
          })),
        );

        // Archive members: (ino, size, archiveId, sourcePath) from both sides.
        const key = (f: {
          ino: number;
          size: number;
          archiveId: number;
          sourcePath: string;
        }) => `${f.ino}|${f.size}|${f.archiveId}|${f.sourcePath}`;
        const fromSection = linkage!.files
          .filter((f) => f.archiveId !== 0)
          .map(key)
          .sort();
        const fromManifest = manifest.entries
          .filter((e) => e.kind === RTFS_KIND_LAZY_FILE)
          .map((e) =>
            key({
              ino: Number(e.ino),
              size: Number(e.size),
              archiveId: e.archiveId!,
              sourcePath: e.sourcePath!,
            }),
          )
          .sort();
        expect(fromSection, `${name} archive members`).toEqual(fromManifest);

        // URL-backed lazy files reach the kernel as ordinary files carrying
        // their lazy-adjusted size, so check (ino, size) against those.
        const manifestSizeByIno = new Map<number, number>();
        for (const entry of manifest.entries) {
          if (entry.kind !== RTFS_KIND_FILE) continue;
          manifestSizeByIno.set(Number(entry.ino), Number(entry.size));
        }
        const urlBacked = linkage!.files.filter((f) => f.archiveId === 0);
        expect(urlBacked.length, `${name} url-backed lazy files`).toBe(
          fs.exportLazyEntries().length,
        );
        for (const file of urlBacked) {
          expect(
            manifestSizeByIno.get(file.ino),
            `${name} inode ${file.ino} size`,
          ).toBe(file.size);
        }

        // Report the measured cost of the binary section against the JSON it
        // replaces, so the size claim in the plan is evidence, not an estimate.
        const view = new DataView(
          reemitted.buffer,
          reemitted.byteOffset,
          reemitted.byteLength,
        );
        const sabLen = view.getUint32(12, true);
        const lazyLen = view.getUint32(16 + sabLen, true);
        let jsonBytes = lazyLen;
        const archiveFlag = view.getUint32(8, true) & (1 << 1);
        if (archiveFlag) {
          jsonBytes += view.getUint32(16 + sabLen + 4 + lazyLen, true);
        }
        const sectionBytes =
          KERNEL_LAZY_HEADER_SIZE +
          linkage!.archives.reduce(
            (n, a) =>
              n +
              KERNEL_LAZY_GROUP_HEADER_SIZE +
              new TextEncoder().encode(a.mountPrefix).length,
            0,
          ) +
          linkage!.files.reduce(
            (n, f) =>
              n +
              KERNEL_LAZY_FILE_HEADER_SIZE +
              new TextEncoder().encode(f.sourcePath).length,
            0,
          );
        console.log(
          `KLZY ${name}: ${linkage!.archives.length} archives, ` +
            `${linkage!.files.length} files, ${sectionBytes} B ` +
            `vs ${jsonBytes} B of lazy JSON`,
        );
      },
      600_000,
    );
  }
});
