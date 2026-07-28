import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindImageOwnedNodeRuntime,
} from "../../apps/browser-demos/lib/init/node-image-runtime";
import {
  NODE_LAZY_BINARY_SPEC,
  shellLazyPlaceholderUrl,
} from "../../images/vfs/lib/init/shell-binaries";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const NODE_ASSET_URL = "/assets/node-current.wasm";
const BASH_PATH =
  "/home/linuxbrew/.linuxbrew/Cellar/bash/5.2.37/bin/bash";
const SPIDERMONKEY_NODE_ALIAS = "/usr/bin/spidermonkey-node";

describe("image-owned Node demo runtime", () => {
  it("binds only Node transport metadata and preserves every VFS identity", async () => {
    const fs = runtimeImage();
    const bashBytes = readVfsFile(fs, BASH_PATH);
    const bashIdentity = fileIdentity(fs, BASH_PATH);
    const bashAliasIdentity = fileIdentity(fs, "/bin/bash", true);
    const deferredTrees = structuredClone(fs.exportLazyArchiveEntries());
    const nodeIdentity = fs.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath)!;

    bindImageOwnedNodeRuntime(fs, NODE_ASSET_URL);

    expect(readVfsFile(fs, BASH_PATH)).toEqual(bashBytes);
    expect(fileIdentity(fs, BASH_PATH)).toEqual(bashIdentity);
    expect(fileIdentity(fs, "/bin/bash", true)).toEqual(bashAliasIdentity);
    expect(fs.exportLazyArchiveEntries()).toEqual(deferredTrees);
    expect(fs.isPathDeferred("/bin/dash")).toBe(true);
    expect(fs.isPathDeferred("/bin/coreutils")).toBe(true);
    expect(fs.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath)).toEqual({
      ...nodeIdentity,
      url: NODE_ASSET_URL,
    });
    expect(fs.isPathDeferred(NODE_LAZY_BINARY_SPEC.vfsPath)).toBe(true);
    expect(fs.readlink(SPIDERMONKEY_NODE_ALIAS)).toBe(
      NODE_LAZY_BINARY_SPEC.vfsPath,
    );

    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    expect(readVfsFile(restored, BASH_PATH)).toEqual(bashBytes);
    expect(restored.exportLazyArchiveEntries()).toEqual(deferredTrees);
    expect(restored.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath)?.url).toBe(
      NODE_ASSET_URL,
    );
    expect(restored.isPathDeferred(NODE_LAZY_BINARY_SPEC.vfsPath)).toBe(true);
    expect(restored.readlink(SPIDERMONKEY_NODE_ALIAS)).toBe(
      NODE_LAZY_BINARY_SPEC.vfsPath,
    );
  });

  it("is idempotent when a current image already owns the compatibility alias", () => {
    const fs = runtimeImage({ compatibilityAlias: true });
    const aliasIdentity = fileIdentity(fs, SPIDERMONKEY_NODE_ALIAS, true);

    bindImageOwnedNodeRuntime(fs, NODE_ASSET_URL);
    bindImageOwnedNodeRuntime(fs, NODE_ASSET_URL);

    expect(fileIdentity(fs, SPIDERMONKEY_NODE_ALIAS, true)).toEqual(
      aliasIdentity,
    );
    expect(fs.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath)?.url).toBe(
      NODE_ASSET_URL,
    );
  });

  it("rejects missing or eager Node bytes instead of staging over the image", () => {
    const missing = createFs();
    expect(() => bindImageOwnedNodeRuntime(missing, NODE_ASSET_URL)).toThrow(
      "must own deferred /usr/bin/node",
    );

    const eager = createFs();
    ensureDirRecursive(eager, "/usr/bin");
    writeVfsBinary(eager, NODE_LAZY_BINARY_SPEC.vfsPath, new Uint8Array([1]));
    expect(() => bindImageOwnedNodeRuntime(eager, NODE_ASSET_URL)).toThrow(
      "must own deferred /usr/bin/node",
    );
    expect(readVfsFile(eager, NODE_LAZY_BINARY_SPEC.vfsPath)).toEqual(
      new Uint8Array([1]),
    );
  });

  it("rejects an unexpected transport or conflicting alias without mutation", () => {
    const unexpected = runtimeImage({ nodeUrl: "/assets/stale-node.wasm" });
    const unexpectedNode = unexpected.getLazyEntry(
      NODE_LAZY_BINARY_SPEC.vfsPath,
    );
    expect(() =>
      bindImageOwnedNodeRuntime(unexpected, NODE_ASSET_URL)
    ).toThrow("unexpected URL");
    expect(unexpected.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath)).toEqual(
      unexpectedNode,
    );
    expect(() => unexpected.lstat(SPIDERMONKEY_NODE_ALIAS)).toThrow();

    const conflict = runtimeImage();
    writeVfsBinary(
      conflict,
      SPIDERMONKEY_NODE_ALIAS,
      new Uint8Array([9, 9]),
    );
    const conflictNode = conflict.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath);
    expect(() =>
      bindImageOwnedNodeRuntime(conflict, NODE_ASSET_URL)
    ).toThrow("conflicts with the image-owned Node runtime");
    expect(conflict.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath)).toEqual(
      conflictNode,
    );
    expect(readVfsFile(conflict, SPIDERMONKEY_NODE_ALIAS)).toEqual(
      new Uint8Array([9, 9]),
    );
  });

  it("routes every Kandelo demo through the single image-owned assembler", () => {
    const root = resolve(import.meta.dirname, "../..");
    const entrypoint = readFileSync(
      resolve(root, "apps/browser-demos/pages/kandelo/main.tsx"),
      "utf8",
    );
    expect(entrypoint).toContain(
      'import("./kernel-host/live-setup")',
    );
    expect(entrypoint).not.toContain("useSpiderMonkeyNodeHost");
    expect(entrypoint).not.toContain("live-spidermonkey-node-setup");
    expect(
      existsSync(
        resolve(
          root,
          "apps/browser-demos/pages/kandelo/kernel-host/" +
            "live-spidermonkey-node-setup.ts",
        ),
      ),
    ).toBe(false);
  });
});

function runtimeImage(
  options: {
    compatibilityAlias?: boolean;
    nodeUrl?: string;
  } = {},
): MemoryFileSystem {
  const fs = createFs();
  for (const path of [
    "/bin",
    "/usr/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/Cellar/bash/5.2.37/bin",
  ]) {
    ensureDirRecursive(fs, path);
  }

  writeVfsBinary(fs, BASH_PATH, new Uint8Array([0, 97, 115, 109, 1]), 0o755);
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
  fs.registerLazyFile(
    NODE_LAZY_BINARY_SPEC.vfsPath,
    options.nodeUrl ?? shellLazyPlaceholderUrl(NODE_LAZY_BINARY_SPEC),
    12_345,
    0o755,
  );
  fs.symlink(NODE_LAZY_BINARY_SPEC.vfsPath, "/bin/node");
  fs.symlink(NODE_LAZY_BINARY_SPEC.vfsPath, "/usr/local/bin/node");
  if (options.compatibilityAlias) {
    fs.symlink(
      NODE_LAZY_BINARY_SPEC.vfsPath,
      SPIDERMONKEY_NODE_ALIAS,
    );
  }
  return fs;
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
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

function readVfsFile(
  fs: MemoryFileSystem,
  path: string,
): Uint8Array {
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
      if (count <= 0) throw new Error(`short read from ${path}`);
      offset += count;
    }
    return bytes;
  } finally {
    fs.close(fd);
  }
}
