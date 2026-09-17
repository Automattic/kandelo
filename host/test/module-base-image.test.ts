import { describe, it, expect } from "vitest";
import { resolveLazyUrl } from "../src/vfs/lazy-url";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { createBaseImageFromContainer } from "../src/vfs/module-base-image";
import { imageReadFromContainer } from "../src/vfs/rootfs-lazy-archives";

/**
 * WHAT THESE TEST NOW THAT THERE IS NO INCUMBENT.
 *
 * They were parity tests against `MemoryFileSystem`, deliberately, because an
 * internals test passes whenever the implementation is self-consistent — which
 * is how an earlier version of this adapter looked correct while returning
 * empty URLs for every lazy file. That oracle is gone with the class, so each
 * case now states the ANSWER rather than comparing two readers: an address, a
 * length, a digest, or a refusal, written out as literals a wrong reader
 * cannot satisfy by being consistently wrong.
 */
describe("a module-backed base image", () => {
  // RETIRED 2026-09-17 WITH THE SECTION-READING BRANCH, five cases: the
  // parity export, the deployment base applied to section URLs, an archive's
  // transports and derived address, the sections winning over the module, and
  // the untouched-URL case.
  //
  // Each built its fixture with `MemoryFileSystem`, because the branch they
  // exercised reads host-side JSON sections only that writer emits. Every
  // builder writes `SDEF` now, so the branch had no producer: it answered "no
  // deferred files" for every shipped image, which is why nothing but a test
  // reached it.
  //
  // What they were ABOUT survives where it now happens: the deployment base is
  // asserted on the module path by "reads a module-built image's deferred
  // URLs", and a rebased archive by "reads a module-built image's archives as
  // an address, a length and a digest". The parity claim has no second
  // implementation left to be parity WITH, which is the whole point of the
  // lane.


  it("serves the same image window bytes as the container array itself", async () => {
    // TWO SUPPLIERS, not three. The third was `MemoryFileSystem`'s body view
    // through `bodyWindowOracle` — a `SharedFS` buffer is the bare image body,
    // so container offset `at` is body offset `at - 16`, and comparing against
    // it proved the module's window was in CONTAINER coordinates. The two that
    // remain are independent in the way that matters: one is the module's Rust
    // reader over a loaded image, the other a TypeScript slice of the array,
    // and both worker entries use the second.
    const source = KandeloImageFs.create();
    source.mkdir("/d", 0o755);
    source.writeFile("/d/f", new Uint8Array(9000).fill(0x5a), 0o644);
    const container = await source.saveImage();

    const module = KandeloImageFs.create();
    module.loadImage(container);
    const { imageRead } = createBaseImageFromContainer(
      container,
      (at, dest) => module.imageRead(BigInt(at), dest),
    );

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

  it("applies the deployment base to a relative address and to no other kind", async () => {
    // RESTORED ON THE MODULE PATH, 2026-09-17, because retiring the section
    // version left a mutant alive: `rebaseUrl` prepending the base to every
    // address — absolute and rooted included — survived the trial run, which
    // is the harness saying the claim had lost its test rather than its
    // subject. A deployment base pasted onto `https://cdn.test/abs.bin` is a
    // URL that fetches nothing, and onto `/already/rooted.bin` one that
    // fetches the wrong thing.
    const module = KandeloImageFs.create();
    module.mkdir("/opt", 0o755);
    module.registerLazyFile("/opt/rel.bin", "assets/rel.bin", 11, 0o644);
    module.registerLazyFile("/opt/abs.bin", "https://cdn.test/abs.bin", 22, 0o644);
    module.registerLazyFile("/opt/root.bin", "/already/rooted.bin", 33, 0o644);
    const container = await module.saveImage();

    const reader = KandeloImageFs.create();
    reader.loadImage(container);
    const { baseImage } = createBaseImageFromContainer(
      container,
      imageReadFromContainer(container),
      "/kandelo/",
      () => reader.lazyEntries(),
    );

    expect(baseImage.deferredFiles().map((body) => body.address).sort())
      .toEqual([
        "/already/rooted.bin",
        "/kandelo/assets/rel.bin",
        "https://cdn.test/abs.bin",
      ]);
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
    // THE PIPE TAKES NO ARCHIVE LIST since 2026-09-17 — it fetches the address
    // the kernel names. What this still shows is that the address the reader
    // produced is the one a fetch goes to, rebased and all.
    const { deferredProvider } = buildRootfsLazyWiring(async (url) => {
      fetched.push(url);
      return new Uint8Array(4242);
    });
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
