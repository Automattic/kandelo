import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tryResolveBinaries } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { prepareRunExampleRootfs } from "../../examples/run-example-rootfs";

vi.mock("../src/binary-resolver", () => ({ tryResolveBinaries: vi.fn() }));
const directories: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function imageWithSources(sources: Array<{ url: string; size: number }>) {
  const fs = KandeloImageFs.create();
  fs.mkdir("/bin", 0o755);
  sources.forEach(({ url, size }, index) => {
    fs.registerLazyFile(`/bin/tool-${index}`, url, size, 0o755);
  });
  return fs.saveImage();
}

describe("isolated runner rootfs transport", () => {
  it("reads transport hints without constructing shared memory", async () => {
    const image = await imageWithSources([
      { url: "binaries/programs/wasm32/bash.wasm", size: 4 },
    ]);
    vi.stubGlobal("SharedArrayBuffer", class {
      constructor() { throw new Error("main-thread VFS allocation"); }
    });
    expect(KandeloImageFs.readImageLazyFileSources(image)).toEqual([
      { url: "binaries/programs/wasm32/bash.wasm", size: 4 },
    ]);
  });

  it("accepts an image with no deferred files without package resolution", async () => {
    const image = await imageWithSources([]);
    expect(prepareRunExampleRootfs(image).rootfsLazyAssets).toEqual([]);
    expect(tryResolveBinaries).not.toHaveBeenCalled();
  });

  it.each([false, true])("binds local bytes once per URL (compressed=%s)", async (compressed) => {
    const bytes = new Uint8Array([0, 97, 115, 109]);
    const directory = mkdtempSync(join(tmpdir(), "kandelo-runner-assets-"));
    directories.push(directory);
    const path = join(directory, "bash.wasm");
    writeFileSync(path, bytes);
    vi.mocked(tryResolveBinaries).mockReturnValue([path]);
    const url = "binaries/programs/wasm32/bash.wasm";
    const image = await imageWithSources([{ url, size: 4 }, { url, size: 4 }]);
    const supplied = compressed ? new Uint8Array(zstdCompressSync(image)) : image;
    const prepared = prepareRunExampleRootfs(supplied);

    expect(tryResolveBinaries).toHaveBeenCalledWith(["programs/wasm32/bash.wasm"]);
    expect(prepared.rootfsLazyAssets).toEqual([{
      url: "https://kandelo-runner.invalid/binaries/programs/wasm32/bash.wasm",
      size: 4,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    }]);
    expect(prepared.rootfsImage).toEqual(supplied);
    expect(prepared.rootfsImage).not.toBe(supplied);
    expect(KandeloImageFs.readImageLazyFileSources(prepared.rootfsImage)).toEqual([
      { url, size: 4 }, { url, size: 4 },
    ]);
  });

  it("fails before boot when the local package artifact is absent", async () => {
    vi.mocked(tryResolveBinaries).mockReturnValue([null]);
    const image = await imageWithSources([
      { url: "binaries/programs/wasm32/bash.wasm", size: 4 },
    ]);
    expect(() => prepareRunExampleRootfs(image)).toThrow(/lazy artifact is missing/);
  });

  it("rejects an image paired with a different artifact size", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-runner-assets-"));
    directories.push(directory);
    const path = join(directory, "bash.wasm");
    writeFileSync(path, new Uint8Array([0, 97, 115, 109]));
    vi.mocked(tryResolveBinaries).mockReturnValue([path]);
    const image = await imageWithSources([
      { url: "binaries/programs/wasm32/bash.wasm", size: 5 },
    ]);
    expect(() => prepareRunExampleRootfs(image)).toThrow(/artifact size mismatch/);
  });

  it.each([
    "binaries/programs/wasm32/../../host-file",
    "file:///usr/bin/bash",
    "https://example.com/bash.wasm",
  ])("rejects unsupported transport %s before resolving artifacts", async (url) => {
    const image = await imageWithSources([{ url, size: 4 }]);
    expect(() => prepareRunExampleRootfs(image)).toThrow(/unsupported lazy file URL/);
    expect(tryResolveBinaries).not.toHaveBeenCalled();
  });

  it("rejects conflicting declarations for one transport", async () => {
    const url = "binaries/programs/wasm32/bash.wasm";
    const image = await imageWithSources([{ url, size: 4 }, { url, size: 5 }]);
    expect(() => prepareRunExampleRootfs(image)).toThrow(/conflicting sizes/);
    expect(tryResolveBinaries).not.toHaveBeenCalled();
  });

  it("rejects an oversized closure before retaining artifact bytes", async () => {
    const image = await imageWithSources([
      { url: "binaries/programs/wasm32/bash.wasm", size: 512 * 1024 * 1024 + 1 },
    ]);
    expect(() => prepareRunExampleRootfs(image)).toThrow(/transport budget/);
    expect(tryResolveBinaries).not.toHaveBeenCalled();
  });
});
