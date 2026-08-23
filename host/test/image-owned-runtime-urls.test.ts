import { describe, expect, it } from "vitest";
import {
  bindImageOwnedRuntimeUrls,
  normalizeImageOwnedLazyReference,
} from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import type { ZipEntry } from "../src/vfs/zip";

describe("image-owned grouped runtime URLs", () => {
  it("binds legacy lazy files and every archive mirror from the group manifest directory", () => {
    const fs = groupedFixture();

    bindImageOwnedRuntimeUrls(fs, authority());

    expect(fs.exportLazyEntries().map(({ path, url }) => ({ path, url }))).toEqual([
      {
        path: "/bin/program",
        url: "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
      },
      {
        path: "/bin/lazy-program",
        url: "https://demo.invalid/a/assets-group/assets/programs/wasm32/lazy-program.wasm",
      },
    ]);
    expect(
      fs.exportLazyArchiveEntries().map((entry) => entry.content!.transports),
    ).toEqual([
      [
        "https://demo.invalid/a/assets-group/assets/programs/wasm32/vim.zip",
        "https://demo.invalid/a/assets-group/assets/programs/wasm32/vim-mirror.zip",
      ],
      [
        "https://demo.invalid/a/assets-group/assets/programs/wasm32/nethack.zip",
      ],
    ]);
  });

  it("binds /a/ and /candidate-b/ to their own exact manifest directories", () => {
    const primary = groupedFixture();
    bindImageOwnedRuntimeUrls(primary, authority());

    const candidate = groupedFixture();
    bindImageOwnedRuntimeUrls(candidate, {
      deploymentBase: "/candidate-b/",
      directoryUrl: "https://demo.invalid/candidate-b/assets-group/",
      manifestUrl: "https://demo.invalid/candidate-b/assets-group/manifest.json",
    });

    expect(primary.getLazyEntry("/bin/program")!.url).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
    expect(candidate.getLazyEntry("/bin/program")!.url).toBe(
      "https://demo.invalid/candidate-b/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  it("rejects a malformed grouped transport without mutating a preceding valid transport", () => {
    const fs = groupedFixture();
    fs.rewriteLazyFileUrls((url, path) =>
      path === "/bin/lazy-program" ? "https://demo.invalid/a/forged.wasm" : url,
    );
    const before = transportSnapshot(fs);

    expect(() => bindImageOwnedRuntimeUrls(fs, authority())).toThrow(
      /reference is invalid/,
    );
    expect(transportSnapshot(fs)).toEqual(before);
  });

  it.each([
    ["mismatched directory", { directoryUrl: "https://demo.invalid/a/other/" }],
    ["cross-origin directory", { directoryUrl: "https://other.invalid/a/assets-group/" }],
    ["outside deployment base", {
      directoryUrl: "https://demo.invalid/other/assets-group/",
      manifestUrl: "https://demo.invalid/other/assets-group/manifest.json",
    }],
    ["manifest query", {
      manifestUrl: "https://demo.invalid/a/assets-group/manifest.json?x=1",
    }],
    ["manifest fragment", {
      manifestUrl: "https://demo.invalid/a/assets-group/manifest.json#part",
    }],
  ])("rejects %s authority before any transport mutation", (_label, patch) => {
    const fs = groupedFixture();
    const before = transportSnapshot(fs);

    expect(() => bindImageOwnedRuntimeUrls(fs, { ...authority(), ...patch })).toThrow(
      /authority is invalid/,
    );
    expect(transportSnapshot(fs)).toEqual(before);
  });

  it("does not retain caller-mutable authority after binding", () => {
    const fs = groupedFixture();
    const supplied = authority();

    bindImageOwnedRuntimeUrls(fs, supplied);
    supplied.directoryUrl = "https://demo.invalid/a/forged/";
    supplied.manifestUrl = "https://demo.invalid/a/forged/manifest.json";

    expect(fs.getLazyEntry("/bin/program")!.url).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  it("retains exact grouped files and every archive transport through save and restore", async () => {
    const fs = groupedFixture();
    bindImageOwnedRuntimeUrls(fs, authority());
    const before = transportSnapshot(fs);

    const restored = MemoryFileSystem.fromImage(await fs.saveImage());

    expect(transportSnapshot(restored)).toEqual(before);
  });

  it("binds a legacy archive entry URL when it has no transport content", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    fs.registerLazyArchiveFromEntries("vim.zip", [legacyArchiveEntry()], "/");

    bindImageOwnedRuntimeUrls(fs, authority());

    const [archive] = fs.exportLazyArchiveEntries();
    expect(archive!.content).toBeUndefined();
    expect(archive!.url).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/vim.zip",
    );
  });

  it.each([
    "/a/assets/programs/wasm32/program.wasm",
    "//demo.invalid/a/assets/programs/wasm32/program.wasm",
    "https://demo.invalid/a/assets/programs/wasm32/program.wasm",
    "binaries/programs/wasm32/../program.wasm",
    "binaries/programs/wasm32/program%2fwrapper.wasm",
    "binaries/programs/wasm32/program%252fwrapper.wasm",
    "binaries/programs/wasm32/program.wasm?version=1",
    "binaries/programs/wasm32/program.wasm#fragment",
    "binaries\\programs\\wasm32\\program.wasm",
    "kandelo-lazy:programs/../program.wasm",
    "kandelo-lazy:programs/program%2fwrapper.wasm",
    "kandelo-lazy:programs/program.wasm?version=1",
    "program.zip",
    "vim.zip#fragment",
    "nethack.zip\0",
  ])("rejects unsafe grouped legacy reference %j", (reference) => {
    expect(() => normalizeImageOwnedLazyReference(reference)).toThrow(
      /reference is invalid|path is invalid/,
    );
  });
});

function authority() {
  return {
    deploymentBase: "/a/",
    directoryUrl: "https://demo.invalid/a/assets-group/",
    manifestUrl: "https://demo.invalid/a/assets-group/manifest.json",
  };
}

function groupedFixture(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  fs.registerLazyFile(
    "/bin/program",
    "binaries/programs/wasm32/program.wasm",
    1,
  );
  fs.registerLazyFile(
    "/bin/lazy-program",
    "kandelo-lazy:programs/lazy-program.wasm",
    1,
  );
  fs.registerLazyTree(
    lazyTree("vim.zip", ["vim.zip", "binaries/programs/wasm32/vim-mirror.zip"]),
    [entry("/opt/vim")],
  );
  fs.registerLazyTree(lazyTree("nethack.zip", ["nethack.zip"]), [entry("/opt/nethack")]);
  return fs;
}

function lazyTree(url: string, transports: string[]) {
  return {
    decoder: "zip-v1" as const,
    mediaType: "application/zip" as const,
    sha256: "a".repeat(64),
    bytes: 1,
    expandedBytes: 1,
    sourceEntryCount: 1,
    transports,
  };
}

function entry(vfsPath: string) {
  return {
    vfsPath,
    sourcePath: vfsPath.slice(1),
    type: "file" as const,
    mode: 0o755,
    size: 1,
    inodeGroup: vfsPath,
  };
}

function transportSnapshot(fs: MemoryFileSystem) {
  return {
    archives: fs.exportLazyArchiveEntries().map((entry) => ({
      transports: entry.content?.transports ?? [entry.url],
      url: entry.url,
    })),
    files: fs.exportLazyEntries().map(({ path, url }) => ({ path, url })),
  };
}

function legacyArchiveEntry(): ZipEntry {
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
