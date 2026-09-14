import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { SffsImageFs } from "../../images/vfs/lib/sffs-image-fs";
import { createModuleBaseImage } from "../src/vfs/module-base-image";
import { imageReadFromBody } from "../src/vfs/rootfs-lazy-archives";

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
    const { baseImage } = createModuleBaseImage(module, container);

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
    const { imageRead } = createModuleBaseImage(module, container);

    // The kernel addresses in CONTAINER coordinates and never below the header.
    for (const at of [16, 4096, 8192]) {
      const a = new Uint8Array(64);
      const b = new Uint8Array(64);
      const na = incumbent(at, a);
      const nb = imageRead(at, b);
      expect(nb).toBe(na);
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });
});
