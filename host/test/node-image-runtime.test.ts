import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bindImageOwnedRuntimeUrls } from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";
import { NODE_BINARY_SPEC } from "../../images/vfs/lib/init/shell-binaries";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const NODE_BYTES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const BASH_PATH = "/usr/bin/bash";

describe("image-owned Node demo runtime", () => {
  it("preserves embedded Node bytes and aliases while binding shell transports", async () => {
    const fs = runtimeImage();
    const nodeIdentity = fileIdentity(fs, NODE_BINARY_SPEC.vfsPath);
    const aliasIdentities = new Map(
      NODE_BINARY_SPEC.symlinks.map((path) => [
        path,
        fileIdentity(fs, path, true),
      ]),
    );
    const deferredTrees = structuredClone(fs.exportLazyArchiveEntries());

    bindImageOwnedRuntimeUrls(fs);

    expect(readVfsFile(fs, NODE_BINARY_SPEC.vfsPath)).toEqual(NODE_BYTES);
    expect(fileIdentity(fs, NODE_BINARY_SPEC.vfsPath)).toEqual(nodeIdentity);
    expect(fs.isPathDeferred(NODE_BINARY_SPEC.vfsPath)).toBe(false);
    expect(fs.getLazyEntry(NODE_BINARY_SPEC.vfsPath)).toBeNull();
    expect(fs.exportLazyArchiveEntries()).toEqual(deferredTrees);
    for (const path of NODE_BINARY_SPEC.symlinks) {
      expect(fs.readlink(path)).toBe(NODE_BINARY_SPEC.vfsPath);
      expect(fileIdentity(fs, path, true)).toEqual(aliasIdentities.get(path));
    }

    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    expect(readVfsFile(restored, NODE_BINARY_SPEC.vfsPath)).toEqual(NODE_BYTES);
    expect(restored.isPathDeferred(NODE_BINARY_SPEC.vfsPath)).toBe(false);
    for (const path of NODE_BINARY_SPEC.symlinks) {
      expect(restored.readlink(path)).toBe(NODE_BINARY_SPEC.vfsPath);
    }
  });

  it("does not keep a separate browser Node asset transport", () => {
    const root = resolve(import.meta.dirname, "../..");
    const liveSetup = readFileSync(
      resolve(
        root,
        "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
      ),
      "utf8",
    );
    const runtimeBinder = readFileSync(
      resolve(root, "apps/browser-demos/lib/init/image-owned-runtime-urls.ts"),
      "utf8",
    );
    const builder = readFileSync(
      resolve(root, "images/vfs/scripts/build-node-vfs-image.ts"),
      "utf8",
    );

    expect(liveSetup).not.toContain("node.wasm?url");
    expect(liveSetup).not.toContain("nodeAssetUrl");
    expect(runtimeBinder).not.toContain("nodeAssetUrl");
    expect(
      existsSync(
        resolve(root, "apps/browser-demos/lib/init/node-image-runtime.ts"),
      ),
    ).toBe(false);
    expect(builder).toContain("writeVfsBinary(");
    expect(builder).toContain("wasmArtifactPolicies:");
    expect(builder).not.toContain("registerLazyFile(");
  });

  it("routes every Kandelo demo through the single image-owned assembler", () => {
    const root = resolve(import.meta.dirname, "../..");
    const entrypoint = readFileSync(
      resolve(root, "apps/browser-demos/pages/kandelo/main.tsx"),
      "utf8",
    );
    expect(entrypoint).toContain('import("./kernel-host/live-setup")');
    expect(entrypoint).not.toContain("useSpiderMonkeyNodeHost");
    expect(
      existsSync(
        resolve(
          root,
          "apps/browser-demos/pages/kandelo/kernel-host/" +
            "live-spidermonkey-node-setup.ts",
        ),
      ),
    ).toBe(false);
    const liveSetup = readFileSync(
      resolve(
        root,
        "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
      ),
      "utf8",
    );
    expect(liveSetup).toContain(
      "bindImageOwnedRuntimeUrls(buildFs, loadedVfs.lazyAssets)",
    );
    expect(liveSetup).toContain("loadVfsImage(profile)");
    expect(
      liveSetup.indexOf("bindImageOwnedRuntimeUrls(buildFs, loadedVfs.lazyAssets)"),
    ).toBeLessThan(liveSetup.indexOf("finalizeKernelOwnedImage(buildFs)"));
    expect(liveSetup).toContain(
      "// authority copied from the authenticated product activation.\n" +
        "  bindImageOwnedRuntimeUrls(buildFs, loadedVfs.lazyAssets);\n" +
        '  tick("assembling kernel-owned VFS image...");',
    );
    expect(liveSetup).not.toContain("assertShellLazyUrlsResolved(buildFs)");
  });
});

function runtimeImage(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  for (const path of [
    "/bin",
    "/usr/bin",
    "/usr/local/bin",
  ]) {
    ensureDirRecursive(fs, path);
  }

  writeVfsBinary(fs, BASH_PATH, NODE_BYTES, 0o755);
  fs.symlink(BASH_PATH, "/bin/bash");
  fs.registerLazyTree(
    {
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: "a".repeat(64),
      bytes: 10,
      expandedBytes: 8,
      sourceEntryCount: 2,
      transports: ["https://example.invalid/shell-runtime.zip"],
    },
    [
      {
        vfsPath: "/bin/dash",
        sourcePath: "bin/dash",
        type: "file",
        mode: 0o755,
        size: 4,
        inodeGroup: "dash",
      },
      {
        vfsPath: "/bin/coreutils",
        sourcePath: "bin/coreutils",
        type: "file",
        mode: 0o755,
        size: 4,
        inodeGroup: "coreutils",
      },
    ],
    "/",
    {
      mode: "first-use",
      capabilities: ["test:shell-runtime"],
      roots: ["/bin"],
    },
  );
  writeVfsBinary(fs, NODE_BINARY_SPEC.vfsPath, NODE_BYTES, 0o755);
  for (const path of NODE_BINARY_SPEC.symlinks) {
    fs.symlink(NODE_BINARY_SPEC.vfsPath, path);
  }
  return fs;
}

function fileIdentity(
  fs: MemoryFileSystem,
  path: string,
  noFollow = false,
): {
  ino: number;
  generation: number;
  dataSequence: number;
  mode: number;
  size: number;
} {
  const stat = noFollow ? fs.lstat(path) : fs.stat(path);
  return {
    ino: stat.ino,
    generation: stat.generation,
    dataSequence: stat.dataSequence,
    mode: stat.mode,
    size: stat.size,
  };
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0 || count > bytes.byteLength - offset) {
        throw new Error(
          `incomplete VFS test read for ${path}: ${offset} of ${size}`,
        );
      }
      offset += count;
    }
    return bytes;
  } finally {
    fs.close(fd);
  }
}
