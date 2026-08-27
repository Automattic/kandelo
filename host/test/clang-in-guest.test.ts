/**
 * End-to-end proof that `cc` compiles and runs a C program inside a booted
 * Kandelo guest, where the C/C++ toolchain (clang/wasm-ld/llvm-ar/sysroot)
 * is delivered as the `kandelo-sdk.zip` lazy VFS archive rather than being
 * baked into the rootfs image.
 *
 * Mirrors the offline `file://` lazy-transport technique from the second
 * case in `node-lazy-archive-runtime.test.ts`: no HTTP server, the archive
 * bytes are read straight off disk by the Node host's default lazy fetcher
 * when it sees a `file://` URL.
 *
 * The base rootfs image (`host/wasm/rootfs.vfs`) already carries bash,
 * coreutils, grep, and sed (see `images/rootfs/PACKAGES.toml`), so this
 * test registers the real, package-built `kandelo-sdk.zip` onto that image
 * in-test — exactly the same `registerLazyArchiveFromEntries` call the
 * production shell-image builder makes (see
 * `images/vfs/scripts/shell-lazy-archives.ts`) — rather than reinventing
 * the archive layout or symlink handling.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { IMAGE_MEMFS_MAX_BYTES } from "../src/vfs/default-mounts";
import { MemoryFileSystem, type LazyDownloadEvent } from "../src/vfs/memory-fs";
import {
  SHELL_LAZY_ARCHIVE_SPECS,
  loadDeclaredShellLazyArchive,
} from "../../images/vfs/scripts/shell-lazy-archives";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "../..");

// Kernel wasm: same candidate order as node-lazy-archive-runtime.test.ts,
// plus host/wasm/kandelo-kernel.wasm — the location run.sh's `kernel` step
// and the "installed package" binary-resolver tier both use.
const kernelCandidates = [
  join(repoRoot, "local-binaries/kernel.wasm"),
  join(repoRoot, "host/wasm/kandelo-kernel.wasm"),
  join(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
];
const kernelPath = kernelCandidates.find(existsSync) ?? kernelCandidates[0]!;

// Base rootfs image: uncompressed `.vfs` (not `.vfs.zst`), built by
// `./run.sh rootfs`. It already carries bash + coreutils + grep + sed.
const rootfsImagePath = join(repoRoot, "host/wasm/rootfs.vfs");

// kandelo-sdk.zip: prefer the resolver mirror; fall back to the newest
// package-cache generation on disk (matches the declared
// kandelo-sdk-browser-bundle package output installed by
// packages/registry/kandelo-sdk-browser-bundle/build-kandelo-sdk-browser-bundle.sh).
function kandeloBinaryCacheRoot(): string {
  const explicit = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  if (explicit !== undefined) {
    return isAbsolute(explicit) ? resolve(explicit) : resolve(repoRoot, explicit);
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome !== undefined) return resolve(xdgCacheHome, "kandelo");
  const home = process.env.HOME;
  if (home !== undefined) return resolve(home, ".cache", "kandelo");
  return "/tmp/kandelo";
}

function newestKandeloSdkZipFromCache(): string | null {
  const programsRoot = join(kandeloBinaryCacheRoot(), "programs");
  if (!existsSync(programsRoot)) return null;
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(programsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("kandelo-sdk-browser-bundle-")) continue;
    const candidate = join(programsRoot, entry.name, "kandelo-sdk.zip");
    if (!existsSync(candidate)) continue;
    const mtimeMs = statSync(candidate).mtimeMs;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs };
  }
  return newest?.path ?? null;
}

const kandeloSdkZipPath =
  [join(repoRoot, "local-binaries/programs/wasm32/kandelo-sdk.zip")].find(existsSync)
  ?? newestKandeloSdkZipFromCache();

const haveKernel = existsSync(kernelPath);
const haveRootfs = existsSync(rootfsImagePath);
const haveKandeloSdkZip = kandeloSdkZipPath !== null;
const available = haveKernel && haveRootfs && haveKandeloSdkZip;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe.skipIf(!available)("in-guest clang toolchain (Node, lazy kandelo-sdk.zip)", () => {
  it("cc compiles and runs a C program in-guest through the lazy toolchain archive", async () => {
    const rootfsBytes = new Uint8Array(readFileSync(rootfsImagePath));
    // maxByteLength headroom: registering the additional kandelo-sdk lazy
    // tree adds deferred-inode metadata for every archive entry on top of
    // whatever this image already carries. The production boot path
    // (restoreVerifiedImageMounts) always restores with this same
    // IMAGE_MEMFS_MAX_BYTES ceiling regardless of what a saved image
    // declares, so requesting it here too keeps this in-test restore
    // consistent with what NodeKernelHost does at boot.
    const fs = MemoryFileSystem.fromImage(rootfsBytes, {
      maxByteLength: IMAGE_MEMFS_MAX_BYTES,
    });

    const spec = SHELL_LAZY_ARCHIVE_SPECS.find((entry) => entry.id === "kandelo-sdk");
    if (!spec) {
      throw new Error("kandelo-sdk lazy archive spec is missing from SHELL_LAZY_ARCHIVE_SPECS");
    }
    // resolveArtifact ignores resolverPath/dependency: this test already
    // located the exact on-disk kandelo-sdk.zip above. loadDeclaredShellLazyArchive
    // still performs its production sanity check that the archive contains
    // exactly one regular bin/wasm32posix-cc executable.
    const archive = loadDeclaredShellLazyArchive(spec, () => kandeloSdkZipPath!);

    // Use the exact on-disk kandelo-sdk.zip path as the archive URL (a
    // file:// URL) instead of the relative "kandelo-sdk.zip" the real image
    // builder uses. The Node host's default lazy fetcher reads file:// URLs
    // straight off disk, so this needs no rootfsLazyUrlBase and no HTTP
    // server — the same offline technique as node-lazy-archive-runtime.test.ts.
    fs.registerLazyArchiveFromEntries(
      pathToFileURL(kandeloSdkZipPath!).href,
      archive.entries,
      spec.mountPrefix,
      archive.symlinkTargets,
      { sha256: archive.integrity.sha256, bytes: archive.integrity.compressedBytes },
    );

    const image = await fs.saveImage();
    const kernelBytes = new Uint8Array(readFileSync(kernelPath));

    let stdout = "";
    let stderr = "";
    const lazyDownloads: LazyDownloadEvent[] = [];
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
      onStderr: (_pid, bytes) => {
        stderr += new TextDecoder().decode(bytes);
      },
      onLazyDownload: (event) => {
        lazyDownloads.push(event);
      },
    });

    try {
      await host.init(arrayBuffer(kernelBytes));

      const command = [
        "set -eu",
        "printf '#include <stdio.h>\\nint main(void) { puts(\"hello from in-guest clang\"); return 0; }\\n' > /tmp/hello.c",
        "cc /tmp/hello.c -o /tmp/hello",
        "/tmp/hello",
      ].join("\n");

      const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-lc", command], {
        env: ["PATH=/usr/bin:/bin", "HOME=/root", "USER=root", "TMPDIR=/tmp"],
        cwd: "/tmp",
        uid: 0,
        gid: 0,
        stdin: new Uint8Array(),
      });
      const code = await exit;

      expect(
        code,
        `guest cc/run exited ${code}; stderr=${JSON.stringify(stderr)} ` +
          `stdout=${JSON.stringify(stdout)} lazyDownloads=${JSON.stringify(lazyDownloads)}`,
      ).toBe(0);
      expect(stdout).toContain("hello from in-guest clang");
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 180_000);
});
