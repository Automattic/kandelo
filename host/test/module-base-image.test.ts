import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { resolveLazyUrl } from "../src/vfs/lazy-url";
import { SffsImageFs } from "../../images/vfs/lib/sffs-image-fs";
import { createBaseImageFromContainer } from "../src/vfs/module-base-image";
import {
  imageReadFromBody,
  imageReadFromContainer,
} from "../src/vfs/rootfs-lazy-archives";

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
    const incumbent = imageReadFromBody(restored);

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
