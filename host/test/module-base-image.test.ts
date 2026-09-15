import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { resolveLazyUrl } from "../src/vfs/lazy-url";
import type { SerializedLazyArchiveEntry } from "../src/vfs/memory-fs";
import { SffsImageFs } from "../../images/vfs/lib/sffs-image-fs";
import { createBaseImageFromContainer } from "../src/vfs/module-base-image";
import { imageReadFromContainer } from "../src/vfs/rootfs-lazy-archives";

/**
 * The body-offset oracle, written HERE rather than imported.
 *
 * A `SharedFS` buffer is the bare image body, so container offset `at` is body
 * offset `at - 16`. This lived in the production module until its last
 * production caller went, when the overlay started reading the container
 * directly — and a parity test that imports its oracle from the module it is
 * checking compares that module against itself. An oracle the test owns cannot
 * drift with the implementation.
 */
function bodyWindowOracle(backend: { imageBodyBytes(): Uint8Array }) {
  return (at: number, dest: Uint8Array): number => {
    const body = backend.imageBodyBytes();
    const start = at - 16;
    if (start >= body.byteLength) return 0;
    const n = Math.min(dest.byteLength, body.byteLength - start);
    dest.set(body.subarray(start, start + n));
    return n;
  };
}

/**
 * PARITY tests, deliberately, against the incumbent rather than against the
 * new code's internals. An internals test passes whenever the implementation
 * is self-consistent; that is how an earlier version of this adapter looked
 * correct while returning empty URLs for every lazy file.
 */
describe("a module-backed base image", () => {
  it("exports the lazy entries MemoryFileSystem exports for the same image", async () => {
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.mkdirWithOwner("/opt", 0o755, 0, 0);
    source.registerLazyFile("/opt/one.bin", "https://example.test/one", 11, 0o644);
    source.registerLazyFile("/opt/two.bin", "https://example.test/two", 22, 0o755);
    const container = await source.saveImage();

    const module = SffsImageFs.create();
    module.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      (at, dest) => module.imageRead(BigInt(at), dest),
    );

    const shape = (e: { path: string; url: string; size: number }) =>
      ({ path: e.path, url: e.url, size: e.size });
    const expected = source.exportLazyEntries().map(shape)
      .sort((a, b) => a.path.localeCompare(b.path));
    const actual = baseImage.exportLazyEntries().map(shape)
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(actual).toEqual(expected);
    // Guards the guard: an adapter returning [] would satisfy `toEqual` if the
    // incumbent also returned [], and this image has two lazy files.
    expect(actual.length).toBe(2);
    expect(actual[0].url).toContain("https://example.test/");
  });

  it("serves the same image window bytes as the body-holding backend", async () => {
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.mkdirWithOwner("/d", 0o755, 0, 0);
    source.createFileWithOwner("/d/f", 0o644, 0, 0, new Uint8Array(9000).fill(0x5a));
    const container = await source.saveImage();

    const restored = MemoryFileSystem.fromImage(container);
    const incumbent = bodyWindowOracle(restored);

    const module = SffsImageFs.create();
    module.loadImage(container);
    const { imageRead } = createBaseImageFromContainer(
      container,
      (at, dest) => module.imageRead(BigInt(at), dest),
    );

    // The kernel addresses in CONTAINER coordinates and never below the header.
    for (const at of [16, 4096, 8192]) {
      const a = new Uint8Array(64);
      const b = new Uint8Array(64);
      const na = incumbent(at, a);
      const nb = imageRead(at, b);
      expect(nb).toBe(na);
      expect(Array.from(b)).toEqual(Array.from(a));
    }

    // The third supplier of the same window: the container array itself. Both
    // worker entries use this one, so it is the path in production, and it
    // has to agree with the module byte-for-byte or the kernel reads a
    // different image depending on who wired it.
    const direct = imageReadFromContainer(container);
    for (const at of [16, 4096, 8192]) {
      const a = new Uint8Array(64);
      const b = new Uint8Array(64);
      expect(direct(at, b)).toBe(imageRead(at, a));
      expect(Array.from(b)).toEqual(Array.from(a));
    }
    // Past the end is end-of-image, not an error, and not a short read of
    // whatever happened to be there.
    expect(direct(container.byteLength, new Uint8Array(8))).toBe(0);
  });

  it("applies the deployment base to relative URLs and leaves absolute ones alone", async () => {
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.mkdirWithOwner("/opt", 0o755, 0, 0);
    source.registerLazyFile("/opt/rel.bin", "assets/rel.bin", 11, 0o644);
    source.registerLazyFile("/opt/abs.bin", "https://cdn.test/abs.bin", 22, 0o644);
    source.registerLazyFile("/opt/root.bin", "/already/rooted.bin", 33, 0o644);
    const container = await source.saveImage();

    // PARITY with the incumbent: this is exactly what the worker entries used
    // to do by mutating a restored MemoryFileSystem before handing it over.
    const incumbent = MemoryFileSystem.fromImage(container);
    incumbent.rewriteLazyFileUrls((url) => resolveLazyUrl("/kandelo/", url));

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
    );

    const byPath = (entries: readonly { path: string; url: string }[]) =>
      Object.fromEntries(entries.map((e) => [e.path, e.url]));
    expect(byPath(baseImage.exportLazyEntries()))
      .toEqual(byPath(incumbent.exportLazyEntries()));
    // Guards the guard: an implementation that rebased nothing would match an
    // incumbent that also rebased nothing.
    expect(byPath(baseImage.exportLazyEntries())["/opt/rel.bin"])
      .toBe("/kandelo/assets/rel.bin");
    expect(byPath(baseImage.exportLazyEntries())["/opt/abs.bin"])
      .toBe("https://cdn.test/abs.bin");
    expect(byPath(baseImage.exportLazyEntries())["/opt/root.bin"])
      .toBe("/already/rooted.bin");
  });

  it("rebases an archive's transports AND the url derived from them", async () => {
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    // A legacy archive carries only a `url`; a tree archive carries ordered
    // transports whose first element IS the url. Those are rebaseArchive's two
    // branches, and an implementation that rewrote transports while leaving
    // `url` pointing at the un-based mirror would fetch from the wrong place
    // while looking rewritten.
    source.registerLazyArchiveFromEntries("archives/vim.zip", [zipEntry()], "/");
    // And a tree archive, whose ordered transports are the shape whose `url`
    // is DERIVED rather than stored. Without one, the derived-url branch is
    // never reached and a mutant that drops the derivation survives.
    source.registerLazyTree(
      {
        decoder: "zip-v1" as const,
        mediaType: "application/zip" as const,
        sha256: "a".repeat(64),
        bytes: 1,
        expandedBytes: 1,
        sourceEntryCount: 1,
        transports: ["archives/tree.zip", "mirrors/tree.zip"],
      },
      [{
        vfsPath: "/opt/tree",
        sourcePath: "opt/tree",
        type: "file" as const,
        mode: 0o755,
        size: 1,
        inodeGroup: "/opt/tree",
      }],
    );
    const container = await source.saveImage();

    const incumbent = MemoryFileSystem.fromImage(container);
    incumbent.rewriteLazyArchiveUrls((url) => resolveLazyUrl("/kandelo/", url));

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
    );

    const shape = (e: SerializedLazyArchiveEntry) =>
      ({ url: e.url, transports: e.content?.transports });
    const actual = baseImage.exportLazyArchiveEntries().map(shape);
    expect(actual).toEqual(incumbent.exportLazyArchiveEntries().map(shape));
    // Guards the guard: an image with no archives would satisfy the equality,
    // and one carrying only the legacy shape would never reach the branch
    // where `url` is derived from the first transport.
    expect(actual.length).toBe(2);
    const derived = actual.find((a) => a.transports !== undefined)!;
    const legacy = actual.find((a) => a.transports === undefined)!;
    expect(legacy.url).toBe("/kandelo/archives/vim.zip");
    expect(derived.transports).toEqual([
      "/kandelo/archives/tree.zip",
      "/kandelo/mirrors/tree.zip",
    ]);
    expect(derived.url).toBe("/kandelo/archives/tree.zip");
  });

  it("reads a module-built image's deferred URLs, which its sections do not carry", async () => {
    // A bridge-built image: the URL lives in the KLZY descriptor and there are
    // no host-side JSON sections at all. Reading only the sections would give
    // an empty list for an image that has a deferred file, which is a load
    // failure reported as a successful load of nothing.
    const module = SffsImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyFile("/opt/one.bin", "assets/one.bin", 11, 0o644);
    const container = await module.saveImage();

    const blind = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
    );
    // Without the module source, the sections are genuinely empty. This is the
    // state step 5 would have shipped.
    expect(blind.baseImage.exportLazyEntries()).toEqual([]);

    const reader = SffsImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
      () => reader.lazyEntries(),
    );
    const entries = baseImage.exportLazyEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe("/opt/one.bin");
    expect(entries[0].size).toBe(11);
    // The deployment base applies to a module-sourced URL exactly as it does
    // to a section-sourced one.
    expect(entries[0].url).toBe("/kandelo/assets/one.bin");
  });

  it("does not mistake an archive MEMBER for a standalone deferred file", async () => {
    // Both kinds in one image. A member's bytes come from its archive, and its
    // descriptor is not a URL — reporting it as a standalone lazy file would
    // hand the pipe a fetch target that is not one.
    const module = SffsImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyFile("/opt/standalone.bin", "assets/one.bin", 11, 0o644);
    module.registerArchiveMember({
      path: "/opt/member.bin",
      archiveId: 1,
      sourcePath: "member.bin",
      size: 7,
      mode: 0o644,
      ino: 4242,
      archiveBytes: 99,
      // No mountPrefix: unparseable-by-contract, because the prefix is
      // written into the kernel manifest and cannot be inferred.
      archiveDescriptor: new TextEncoder().encode('{"url":"archives/a.zip"}'),
    });
    const container = await module.saveImage();

    const reader = SffsImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      undefined,
      () => reader.lazyEntries(),
    );

    const paths = baseImage.exportLazyEntries().map((e) => e.path);
    expect(paths).toEqual(["/opt/standalone.bin"]);
  });

  it("prefers the sections over the module when an image carries both", async () => {
    // A MemoryFileSystem-built image records the URL in the sections and
    // leaves the module's descriptor EMPTY. Consulting the module anyway would
    // return an entry whose url is "", which fetches nothing and reports no
    // error — so which source wins is not a preference, it is correctness.
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.mkdirWithOwner("/opt", 0o755, 0, 0);
    source.registerLazyFile("/opt/one.bin", "assets/one.bin", 11, 0o644);
    const container = await source.saveImage();

    const reader = SffsImageFs.create();
    reader.loadImage(container);
    // Proves the premise rather than assuming it: the module really does hold
    // an empty descriptor for this image.
    expect(new TextDecoder().decode(reader.lazyEntries().files[0]!.descriptor))
      .toBe("");

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
      () => reader.lazyEntries(),
    );
    const entries = baseImage.exportLazyEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].url).toBe("/kandelo/assets/one.bin");
  });

  it("reconstructs a module-built image's archives, members included", async () => {
    const module = SffsImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyArchive({
      url: "archives/tool.zip",
      entries: [zipEntry()],
      mountPrefix: "/opt",
      integrity: { sha256: "b".repeat(64), bytes: 4242 },
    });
    const container = await module.saveImage();

    const reader = SffsImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
      () => reader.lazyEntries(),
    );

    const [archive] = baseImage.exportLazyArchiveEntries();
    expect(archive).toBeDefined();
    expect(archive.url).toBe("/kandelo/archives/tool.zip");
    // The mount prefix is written into the kernel's lazy manifest, so losing
    // it is not cosmetic — it is a wrong manifest.
    expect(archive.mountPrefix).toBe("/opt");
    expect(archive.integrity).toEqual({ sha256: "b".repeat(64), bytes: 4242 });
    // A member, with the source path the fetcher needs to find it in the zip.
    expect(archive.entries.length).toBe(1);
    expect(archive.entries[0].sourcePath).toBe("bin/vim");
    expect(archive.entries[0].vfsPath).toBe("/opt/bin/vim");

    // And the whole point: the consumer's reducer accepts it and mints a group
    // with the transports and members the deferred provider will serve from.
    const { buildRootfsLazyWiring } = await import("../src/vfs/rootfs-lazy-archives");
    const { lazyInput } = buildRootfsLazyWiring(
      baseImage.exportLazyArchiveEntries(),
      async () => new Uint8Array(),
    );
    expect(lazyInput.archives.length).toBe(1);
    expect(lazyInput.archives[0].size).toBe(4242);
  });

  it("refuses a module-built archive whose descriptor it cannot parse", async () => {
    const module = SffsImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerArchiveMember({
      path: "/opt/member",
      archiveId: 1,
      sourcePath: "member",
      size: 1,
      mode: 0o644,
      ino: 4242,
      archiveBytes: 99,
      archiveDescriptor: new TextEncoder().encode('{"url":"archives/a.zip"}'),
    });
    const container = await module.saveImage();

    const reader = SffsImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      undefined,
      () => reader.lazyEntries(),
    );
    // Refused, not half-answered. Returning [] here would mount an image whose
    // archives silently never activate.
    expect(() => baseImage.exportLazyArchiveEntries())
      .toThrow(/declares no url or no mount prefix/);
  });

  it("leaves every URL untouched when no deployment base is given", async () => {
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.mkdirWithOwner("/opt", 0o755, 0, 0);
    source.registerLazyFile("/opt/rel.bin", "assets/rel.bin", 11, 0o644);
    const container = await source.saveImage();

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
    );
    expect(baseImage.exportLazyEntries()[0].url).toBe("assets/rel.bin");
  });
});

/** The minimal ZIP member a legacy archive registration accepts. */
function zipEntry() {
  return {
    fileName: "bin/vim",
    fileNameBytes: new TextEncoder().encode("bin/vim"),
    compressedSize: 1,
    uncompressedSize: 1,
    compressionMethod: 0,
    localHeaderOffset: 0,
    mode: 0o755,
    isDirectory: false,
    isSymlink: false,
    externalAttrs: 0,
    creatorOS: 3,
  };
}
