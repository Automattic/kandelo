import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { resolveLazyUrl } from "../src/vfs/lazy-url";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
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

    const module = KandeloImageFs.create();
    module.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      (at, dest) => module.imageRead(BigInt(at), dest),
    );

    // BY ADDRESS, NOT BY PATH, and the change is the record's rather than the
    // test's. A host does one thing with a deferred body — fetch it and check
    // what came back — so the record is an address, its mirrors and a length.
    // The path was carried because the wire shape it replaced carried
    // everything; no consumer looked at it.
    const expected = Object.fromEntries(
      source.exportLazyEntries().map((e) => [e.url, e.size]),
    );
    const actual = Object.fromEntries(
      baseImage.deferredFiles().map((b) => [b.address, b.bytes]),
    );

    expect(actual).toEqual(expected);
    // Guards the guard: an adapter returning [] would satisfy `toEqual` if the
    // incumbent also returned [], and this image has two lazy files.
    expect(Object.keys(actual).length).toBe(2);
    expect(Object.keys(actual)[0]).toContain("https://example.test/");
  });

  it("serves the same image window bytes as the body-holding backend", async () => {
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.mkdirWithOwner("/d", 0o755, 0, 0);
    source.createFileWithOwner("/d/f", 0o644, 0, 0, new Uint8Array(9000).fill(0x5a));
    const container = await source.saveImage();

    const restored = MemoryFileSystem.fromImage(container);
    const incumbent = bodyWindowOracle(restored);

    const module = KandeloImageFs.create();
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

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
    );

    // THE EXPECTATIONS ARE THE ORACLE NOW, and they always were the part that
    // could fail. This compared `baseImage` against a restored
    // `MemoryFileSystem` that had been rebased with `rewriteLazyFileUrls` —
    // "parity with the incumbent", which the worker entries used to perform.
    // The comparison never decided anything the three literals below do not:
    // an implementation that rebased nothing matched an incumbent that also
    // rebased nothing, which is why the literals were written in the first
    // place. Keeping it would have kept a production method alive to serve a
    // test.
    // The three literals ARE the oracle, as they were before; what changed is
    // that they are now keyed by nothing, because the record is the address.
    // The image declares one relative, one absolute and one rooted URL, and
    // which of the three a given path had was never what this asserts.
    expect(baseImage.deferredFiles().map((b) => b.address).sort()).toEqual([
      "/already/rooted.bin",
      "/kandelo/assets/rel.bin",
      "https://cdn.test/abs.bin",
    ]);
    // Each address is also its own single transport: a lazy file declares no
    // mirrors, and a record whose transport list disagreed with its address
    // would fetch from somewhere the image never named.
    for (const body of baseImage.deferredFiles()) {
      expect(body.transports).toEqual([body.address]);
    }
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

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
    );

    const actual = baseImage.deferredArchives();
    // Same as above: the incumbent comparison went, and what it was standing
    // in front of stayed. An image with no archives would have satisfied the
    // equality, and one carrying only the legacy shape would never reach the
    // branch where the address is DERIVED from the first transport — so the
    // count and the four literals were doing the work either way.
    expect(actual.length).toBe(2);
    const derived = actual.find((a) => a.transports.length > 1)!;
    const legacy = actual.find((a) => a.transports.length === 1)!;
    expect(legacy.address).toBe("/kandelo/archives/vim.zip");
    expect(derived.transports).toEqual([
      "/kandelo/archives/tree.zip",
      "/kandelo/mirrors/tree.zip",
    ]);
    expect(derived.address).toBe("/kandelo/archives/tree.zip");
  });

  it("reads a section-carried archive's declared length and digest", async () => {
    // THE OTHER CARRIER's identity fields, which nothing else here asserts.
    // A legacy image records an archive's bytes and digest in its host-side
    // JSON — under `content` for a v3 tree and `integrity` for the older shape
    // — and the Pages asset closure stages every referenced body by exactly
    // those two values. A reader that returned them as `undefined` would make
    // the closure report an archive "without byte integrity" for an image that
    // declares it, and the transport table would hold no policy for a
    // perfectly well-described archive.
    const source = MemoryFileSystem.createFresh(4 * 1024 * 1024);
    source.registerLazyArchiveFromEntries(
      "archives/legacy.zip",
      [zipEntry()],
      "/",
      undefined,
      { sha256: "c".repeat(64), bytes: 1234 },
    );
    const container = await source.saveImage();

    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
    );
    const [archive] = baseImage.deferredArchives();
    expect(archive.address).toBe("archives/legacy.zip");
    expect(archive.bytes).toBe(1234);
    expect(archive.sha256).toBe("c".repeat(64));
  });

  it("reads a module-built image's deferred URLs, which its sections do not carry", async () => {
    // A bridge-built image: the URL lives in the KLZY descriptor and there are
    // no host-side JSON sections at all. Reading only the sections would give
    // an empty list for an image that has a deferred file, which is a load
    // failure reported as a successful load of nothing.
    const module = KandeloImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyFile("/opt/one.bin", "assets/one.bin", 11, 0o644);
    const container = await module.saveImage();

    const blind = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
    );
    // Without the module source, the sections are genuinely empty. This is the
    // state step 5 would have shipped.
    expect(blind.baseImage.deferredFiles()).toEqual([]);

    const reader = KandeloImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
      () => reader.lazyEntries(),
    );
    const bodies = baseImage.deferredFiles();
    expect(bodies.length).toBe(1);
    expect(bodies[0].bytes).toBe(11);
    // The deployment base applies to a module-sourced URL exactly as it does
    // to a section-sourced one.
    expect(bodies[0].address).toBe("/kandelo/assets/one.bin");
  });

  it("does not mistake an archive MEMBER for a standalone deferred file", async () => {
    // Both kinds in one image. A member's bytes come from its archive, and its
    // descriptor is not a URL — reporting it as a standalone lazy file would
    // hand the pipe a fetch target that is not one.
    const module = KandeloImageFs.create();
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

    const reader = KandeloImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      undefined,
      () => reader.lazyEntries(),
    );

    // ONE body, and it is the standalone's address. A member reported as a
    // standalone file would arrive with the member's own `uri`, which is empty
    // — a fetch target that is not one.
    expect(baseImage.deferredFiles().map((b) => b.address))
      .toEqual(["assets/one.bin"]);
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

    const reader = KandeloImageFs.create();
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
    const bodies = baseImage.deferredFiles();
    expect(bodies.length).toBe(1);
    expect(bodies[0].address).toBe("/kandelo/assets/one.bin");
  });

  it("reads a module-built image's archives as an address, a length and a digest", async () => {
    const module = KandeloImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyArchive({
      url: "archives/tool.zip",
      entries: [zipEntry()],
      mountPrefix: "/opt",
      integrity: { sha256: "b".repeat(64), bytes: 4242 },
    });
    const container = await module.saveImage();

    const reader = KandeloImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
      () => reader.lazyEntries(),
    );

    const [archive] = baseImage.deferredArchives();
    expect(archive).toBeDefined();
    expect(archive.address).toBe("/kandelo/archives/tool.zip");
    expect(archive.bytes).toBe(4242);
    expect(archive.sha256).toBe("b".repeat(64));

    // RETIRED WITH THE FIELDS THEY READ: `mountPrefix` and the member list.
    //
    // This asserted both, and the mount-prefix case said losing it "is not
    // cosmetic — it is a wrong manifest". That was true while a host WROTE the
    // kernel's lazy manifest, encoding the prefix and the members into `KLZY`.
    // A module-built image carries `SDEF` and the kernel reads its own
    // manifest out of it, so the host writes none — the reconstruction existed
    // to fill a record that was then reduced back to this line, and nothing in
    // between ever looked at either field. The reader no longer JSON-parses an
    // archive's descriptor to recover the prefix, which is why two refusal
    // cases below it went as well.

    // And the whole point: the consumer accepts it. The wiring reports no
    // manifest -- the kernel parses its own section -- so the observable result
    // is that asking for the archive's ADDRESS starts a fetch, and starts it at
    // the rebased URL rather than the raw one the image recorded.
    const { buildRootfsLazyWiring } =
      await import("../src/vfs/rootfs-lazy-archives");
    const fetched: string[] = [];
    const { deferredProvider } = buildRootfsLazyWiring(
      baseImage.deferredArchives(),
      async (url) => {
        fetched.push(url);
        return new Uint8Array(4242);
      },
    );
    // -11 is EAGAIN: a fetch began. Asserting the address that was FETCHED is
    // what makes this a test — a provider handed any address at all answers
    // EAGAIN, so the return value alone would pass without the reconstruction
    // being right.
    expect(deferredProvider("/kandelo/archives/tool.zip", 0n, new Uint8Array(8)))
      .toBe(-11);
    expect(fetched).toEqual(["/kandelo/archives/tool.zip"]);
  });

  it("keeps two archives apart, and standalone files out of both", async () => {
    // TWO archives plus a standalone file. With one archive, a grouping bug is
    // invisible: everything lands in the only bucket there is. The members
    // themselves are no longer reported — see the retirement note above — so
    // what this now holds is that each archive keeps its OWN address, length
    // and digest, and that the loose file is in neither list.
    const module = KandeloImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyFile("/opt/loose.bin", "assets/loose.bin", 3, 0o644);
    module.registerLazyArchive({
      url: "archives/one.zip",
      entries: [zipEntry("one/a")],
      mountPrefix: "/opt",
      integrity: { sha256: "1".repeat(64), bytes: 11 },
    });
    module.registerLazyArchive({
      url: "archives/two.zip",
      entries: [zipEntry("two/b")],
      mountPrefix: "/opt",
      integrity: { sha256: "2".repeat(64), bytes: 22 },
    });
    const container = await module.saveImage();

    const reader = KandeloImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      undefined,
      () => reader.lazyEntries(),
    );

    const archives = baseImage.deferredArchives();
    expect(archives.map((a) => ({ address: a.address, bytes: a.bytes, sha256: a.sha256 })))
      .toEqual([
        { address: "archives/one.zip", bytes: 11, sha256: "1".repeat(64) },
        { address: "archives/two.zip", bytes: 22, sha256: "2".repeat(64) },
      ]);
    // The standalone file belongs to neither.
    expect(archives.map((a) => a.address)).not.toContain("assets/loose.bin");
    expect(baseImage.deferredFiles().map((b) => b.address))
      .toEqual(["assets/loose.bin"]);
  });

  // RETIRED 2026-09-17, two cases: "refuses a descriptor that is not the shape
  // this reader knows" and "refuses a module-built archive whose descriptor it
  // cannot parse".
  //
  // Both asserted refusals this reader can no longer make, because it no
  // longer opens an archive's descriptor. It opened one to recover
  // `mountPrefix`, the single field that was not typed — which meant a boot
  // JSON-parsed an opaque blob, on input that can arrive from a shared link,
  // to fill a slot no consumer read. The envelope check went with it: the seal
  // half is authenticated by `rootfs::load_image`, and the descriptor half is
  // "whatever the producer writes", which this reader now passes over rather
  // than parsing.
  //
  // What is NOT retired is the refusal below. An archive with no address is
  // still a refusal, and it is the one that matters: the address is the whole
  // of what says where the bytes come from, so accepting one without it mounts
  // an image whose archives silently never activate.

  it("refuses a module-built archive that declares no address", async () => {
    // The address is the whole of what says where an archive's bytes come
    // from. It used to live inside the descriptor, where this reader had to
    // parse a blob the image format says nobody parses — and parse it on
    // untrusted input, since an image can arrive from a shared link. Now it is
    // a typed field the section decoder already checked, and its absence is a
    // refusal rather than an archive that mounts and silently never activates.
    const module = KandeloImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerArchiveMember({
      path: "/opt/member",
      archiveId: 1,
      sourcePath: "member",
      size: 1,
      mode: 0o644,
      ino: 4244,
      archiveBytes: 7,
      // A descriptor that is otherwise complete, so the missing address is the
      // only fault and no other rule can be the one that refuses.
      archiveDescriptor: new TextEncoder().encode('{"mountPrefix":"/opt"}'),
    });
    const container = await module.saveImage();

    const reader = KandeloImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      undefined,
      () => reader.lazyEntries(),
    );
    expect(() => baseImage.deferredArchives())
      .toThrow(/declares no address/);
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
    expect(baseImage.deferredFiles()[0].address).toBe("assets/rel.bin");
  });
});

/** The minimal ZIP member a legacy archive registration accepts. */
function zipEntry(fileName = "bin/vim") {
  return {
    fileName,
    fileNameBytes: new TextEncoder().encode(fileName),
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
