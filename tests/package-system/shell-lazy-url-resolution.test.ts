import { describe, expect, it } from "vitest";
import {
  assertShellLazyUrlsResolved,
} from "../../apps/browser-demos/lib/init/shell-lazy-url-contract";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../images/vfs/lib/init/shell-binaries";
import {
  SHELL_LAZY_ARCHIVE_SPECS,
} from "../../images/vfs/scripts/shell-lazy-archives";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import type { ZipEntry } from "../../host/src/vfs/zip";

function archiveEntry(path: string): ZipEntry {
  return {
    fileName: path,
    fileNameBytes: new TextEncoder().encode(path),
    compressedSize: 8,
    uncompressedSize: 16,
    compressionMethod: 8,
    localHeaderOffset: 0,
    mode: 0o755,
    isDirectory: false,
    isSymlink: false,
    externalAttrs: 0,
    creatorOS: 3,
  };
}

function sourceShellFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  fs.registerLazyFile(
    "/opt/rootfs-grep",
    "binaries/programs/wasm32/grep.wasm",
    100,
    0o755,
  );
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    fs.registerLazyFile(
      spec.vfsPath,
      shellLazyPlaceholderUrl(spec),
      100 + spec.id.length,
      0o755,
    );
  }
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    fs.registerLazyArchiveFromEntries(
      spec.archiveUrl,
      [archiveEntry(spec.requiredMember)],
      spec.mountPrefix,
    );
  }
  return fs;
}

describe("shell lazy deployment URL closure", () => {
  it("maps every declared shell token before product boot", () => {
    const fs = sourceShellFs();
    expect(() => assertShellLazyUrlsResolved(fs)).toThrow(
      /binaries\/programs\/wasm32\/grep\.wasm/,
    );

    fs.rewriteLazyArchiveUrls((url) => `/assets/${url.replace(".", "-abc.")}`);
    fs.rewriteLazyFileUrls((url) => {
      const name = url.split("/").at(-1)?.replace(".wasm", "-abc.wasm");
      return `/assets/${name}`;
    });
    expect(() => assertShellLazyUrlsResolved(fs)).not.toThrow();
    expect(
      fs.exportLazyEntries().some((entry) =>
        entry.url.startsWith("binaries/") ||
        entry.url.startsWith("kandelo-lazy:")
      ),
    ).toBe(false);
    expect(
      fs.exportLazyArchiveEntries().some((entry) =>
        entry.url === "vim.zip" || entry.url === "nethack.zip"
      ),
    ).toBe(false);
  });

  it("rejects unknown build-time file and archive tokens", () => {
    const files = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    files.registerLazyFile(
      "/bin/unknown",
      "kandelo-lazy:programs/unknown.wasm",
      10,
      0o755,
    );
    expect(() => assertShellLazyUrlsResolved(files)).toThrow(
      /kandelo-lazy:programs\/unknown\.wasm/,
    );

    const archives = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    archives.registerLazyArchiveFromEntries(
      "vim.zip",
      [archiveEntry("bin/vim")],
      "/usr/",
    );
    expect(() => assertShellLazyUrlsResolved(archives)).toThrow(/vim\.zip/);
  });
});
