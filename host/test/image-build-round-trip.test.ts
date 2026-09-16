import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { overlayEtcFromRootfs } from "../src/vfs/rootfs-overlay";

/**
 * What a HOST does to an image before handing it to the kernel, and whether the
 * image survives it.
 *
 * `apps/browser-demos/.../live-setup.ts` fetches `rootfs.vfs`, loads it,
 * mutates the tree (demo homes, `/etc` config, a staged init program) and
 * re-saves it. That round trip is the browser's boot path, and defect B45 is
 * that it was being done with a writer that cannot express half the format.
 *
 * These tests are the Node peer of that path. They exist because B45 was found
 * by reading code and confirmed by a throwaway script — neither of which a
 * suite can run again tomorrow.
 */
const repoRoot = resolve(import.meta.dirname, "../..");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs");

describe.skipIf(!existsSync(rootfsImage))("a build-time image round trip", () => {
  const bytes = () => new Uint8Array(readFileSync(rootfsImage));

  /** Every deferred file the KERNEL would see, which is the only view that
   *  decides whether a lazy binary works. */
  function asTheKernelSeesIt(image: Uint8Array) {
    const fs = KandeloImageFs.create();
    fs.loadImage(image);
    const { files, archives } = fs.lazyEntries() as {
      files: { uri: string; digest: Uint8Array }[];
      archives: unknown[];
    };
    return {
      files: files.length,
      archives: archives.length,
      addressed: files.filter((f) => f.uri.length > 0).length,
      digested: files.filter((f) => f.digest.some((b) => b !== 0)).length,
    };
  }

  it("the shipped image has deferred files, and every one is addressed and digested", () => {
    const before = asTheKernelSeesIt(bytes());
    // Not a fixed number: the rootfs grows. What must hold is that there ARE
    // deferred files (otherwise the rest of this file tests nothing) and that
    // none of them is missing the two fields the kernel acts on.
    expect(before.files).toBeGreaterThan(0);
    expect(before.addressed).toBe(before.files);
    expect(before.digested).toBe(before.files);
  });

  it("survives a mutate-and-re-save through the Rust writer, addresses and digests intact", async () => {
    const before = asTheKernelSeesIt(bytes());

    // The same SHAPE of work the browser does between load and re-save.
    const build = KandeloImageFs.create();
    build.loadImage(bytes());
    // A path the shipped rootfs does not already carry, so the mutation is a
    // real write and not an EEXIST the test would have to forgive.
    build.mkdirWithOwner("/home/round-trip-probe", 0o750, 1000, 1000);
    build.writeFile("/etc/demo.conf", new TextEncoder().encode("demo=1\n"), 0o644);
    const rebuilt = await build.saveImage();

    const after = asTheKernelSeesIt(rebuilt);
    expect(after.files).toBe(before.files);
    expect(after.archives).toBe(before.archives);
    expect(after.addressed).toBe(before.files);
    expect(after.digested).toBe(before.files);
    // And the mutations actually landed, so this is not passing by not working.
    const check = KandeloImageFs.create();
    check.loadImage(rebuilt);
    expect(check.lstat("/home/round-trip-probe").uid).toBe(1000);
    expect(check.lstat("/etc/demo.conf").size).toBe(7);
  });

  // Defect B45, pinned as a property of the LEGACY writer rather than as a
  // browser symptom, because the browser cannot be reached from here and this
  // is the half that actually loses the data.
  //
  // It does not fail loudly. The re-saved image declares no deferred files at
  // all, so each one becomes a zero-byte file marked NOT deferred — a shape the
  // kernel reads as "present and complete" and never tries to fetch. The
  // user-visible result is ENOEXEC from exec'ing an empty binary.
  //
  // DELETE THIS TEST WITH `memory-fs.ts`. It is not describing something to fix
  // in that writer; it is recording why nothing may route an image through it.
  it("is DESTROYED by the legacy writer, which is why nothing may route an image through it", async () => {
    const before = asTheKernelSeesIt(bytes());
    expect(before.files).toBeGreaterThan(0);

    const legacy = MemoryFileSystem.fromImage(bytes());
    expect(
      legacy.exportLazyEntries().length,
      "the legacy reader cannot see an SDEF section at all",
    ).toBe(0);

    const resaved = await legacy.saveImage();
    const after = asTheKernelSeesIt(resaved);
    expect(after.files, "every deferred file is gone from the re-saved image").toBe(0);

    // The shape of the loss, which is worse than the count. Pick any file the
    // original declared deferred: it still EXISTS, is still executable, and now
    // claims to be zero bytes long and fully present.
    const original = KandeloImageFs.create();
    original.loadImage(bytes());
    const [sample] = (original.lazyEntries() as { files: { path: string; size: number }[] }).files;
    expect(sample!.size).toBeGreaterThan(0);

    const wrecked = KandeloImageFs.create();
    wrecked.loadImage(resaved);
    const st = wrecked.lstat(sample!.path) as { size: number; mode: number; deferred?: boolean };
    expect(st.size, `${sample!.path} became an empty file`).toBe(0);
    expect(st.mode & 0o111, "and kept its executable bits, so it still looks runnable").not.toBe(0);
    expect(st.deferred, "and is marked COMPLETE, so nothing will ever fetch it").toBeFalsy();
  });
});

describe("overlaying /etc onto a fresh image", () => {
  // This is the browser's `createBuildFsWithEtc`, reduced to the part that
  // broke: copy `/etc` out of the canonical rootfs into an image that does not
  // have one yet.
  //
  // It failed 59 browser tests with `ENOENT: lstat /etc` — not because the
  // path was missing, which is the ordinary and expected case, but because the
  // "is this ENOENT?" check could never say yes. `vfs-errors.ts` numbers
  // errnos NEGATIVELY (`ENOENT === -2`) while the bridge raises the POSITIVE
  // errno (`2`), so the comparison was silently always-false and the ordinary
  // case escaped its own catch.
  //
  // A sign mismatch is invisible to the typechecker and invisible to a reader
  // who does not already know both conventions, so it is asserted here.
  it("copies /etc in rather than treating a missing target path as fatal", async () => {
    const source = KandeloImageFs.create();
    source.mkdir("/etc", 0o755);
    source.writeFile("/etc/hostname", new TextEncoder().encode("kandelo\n"), 0o644);
    const sourceImage = await source.saveImage();

    // A fresh target: `/` and nothing else, so `/etc` is absent exactly as it
    // is on the browser's build filesystem.
    const target = KandeloImageFs.create();
    await overlayEtcFromRootfs(target, sourceImage);

    expect(target.lstat("/etc").mode & 0o7777).toBe(0o755);
    expect(target.lstat("/etc/hostname").size).toBe(8);
  });

  it("is idempotent, because a path that IS present is the other branch", async () => {
    const source = KandeloImageFs.create();
    source.mkdir("/etc", 0o755);
    source.writeFile("/etc/hostname", new TextEncoder().encode("kandelo\n"), 0o644);
    const sourceImage = await source.saveImage();

    const target = KandeloImageFs.create();
    await overlayEtcFromRootfs(target, sourceImage);
    // Twice. The second pass takes the "target path exists" branch for every
    // entry, which is the branch the broken check never reached.
    await overlayEtcFromRootfs(target, sourceImage);
    expect(target.lstat("/etc/hostname").size).toBe(8);
  });
});
