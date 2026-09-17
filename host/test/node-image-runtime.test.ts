import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_BINARY_SPEC } from "../../images/vfs/lib/init/shell-binaries";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

const NODE_BYTES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const BASH_PATH = "/usr/bin/bash";

describe("image-owned Node demo runtime", () => {
  it("preserves embedded Node bytes, aliases and deferred trees through assembly", async () => {
    const fs = runtimeImage();
    const nodeIdentity = fileIdentity(fs, NODE_BINARY_SPEC.vfsPath);
    const aliasIdentities = new Map(
      NODE_BINARY_SPEC.symlinks.map((path) => [
        path,
        fileIdentity(fs, path, true),
      ]),
    );
    const deferredBefore = fs.lazyEntries().files.map((file) => file.path).sort();

    // `bindImageOwnedRuntimeUrls(fs)` was here, and the assertions below were
    // what proved it rewrote ONLY lazy URLs: the embedded Node binary stayed
    // resident and byte-identical, its aliases kept their identities, and the
    // deferred trees were otherwise untouched.
    //
    // Nothing rewrites the image now, so the guarantee is stronger and cheaper
    // — it holds because no write happens rather than because the write was
    // careful. The assertions stay, because what they check is that ASSEMBLY
    // preserves these things, and assembly still runs.

    expect(readVfsFile(fs, NODE_BINARY_SPEC.vfsPath)).toEqual(NODE_BYTES);
    expect(fileIdentity(fs, NODE_BINARY_SPEC.vfsPath)).toEqual(nodeIdentity);
    expect(fs.isPathDeferred(NODE_BINARY_SPEC.vfsPath)).toBe(false);
    expect(fs.lazyEntries().files.map((file) => file.path).sort())
      .toEqual(deferredBefore);
    for (const path of NODE_BINARY_SPEC.symlinks) {
      expect(fs.readlink(path)).toBe(NODE_BINARY_SPEC.vfsPath);
      expect(fileIdentity(fs, path, true)).toEqual(aliasIdentities.get(path));
    }

    const restored = KandeloImageFs.create();
    restored.loadImage(await fs.saveImage());
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
    expect(liveSetup).toContain("loadVfsImage(profile)");

    // INVERTED, deliberately. This used to pin that `bindImageOwnedRuntimeUrls`
    // ran, and ran BEFORE `finalizeKernelOwnedImage`, so no image was
    // serialized with unbound URLs. Binding rewrote the image's deferred half,
    // which the writer underneath silently erased once `SDEF` arrived — defect
    // B45, 65 lazy binaries emptied. There is nothing to bind now and nothing
    // to order, so the property worth pinning is the opposite one: this path
    // must not write to the image's deferred half at all.
    // The CALL form, so this file's own prose explaining what was removed does
    // not read as the thing it removed.
    for (const rewriting of [
      "bindImageOwnedRuntimeUrls(",
      "rewriteLazyFileUrls(",
      "rewriteLazyArchiveUrls(",
      "assertShellLazyUrlsResolved(",
    ]) {
      expect(liveSetup, `${rewriting} rewrites the image's deferred half`)
        .not.toContain(rewriting);
    }
    // And the mapping it replaced is computed, so this is a MOVE rather than a
    // deletion: the addresses still reach the deployment, beside the image.
    expect(liveSetup).toContain("imageOwnedRuntimeUrlTable(loadedVfs.lazyAssets)");

    // The image writer is installed BEFORE the first use of the bridge.
    //
    // This is an ordering rule, and an ordering rule nobody checks is how the
    // flagship demos spent a browser cycle failing to boot with
    // "KandeloImageFs.create() has no module bytes". The install was present and
    // sat 36 lines too late, because `readImageMetadata` and
    // `readImageCapacity` look like pure readers and each instantiates the
    // module to read the image.
    //
    // Asserted on the source text because the cheap alternative — trusting a
    // comment — is exactly what failed. A bridge call added above the install
    // now fails here, in milliseconds, instead of in a 90-minute browser cycle.
    // Line-by-line, skipping comments: the explanation above the install in
    // live-setup QUOTES the error text, so a naive text search finds the prose
    // that documents the rule and reports it as the rule being broken.
    const codeLines = liveSetup.split("\n").map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        const t = line.trim();
        return t.length > 0 && !t.startsWith("//") && !t.startsWith("*")
          && !t.startsWith("/*");
      });
    const installLine = codeLines.find(({ line }) =>
      line.includes("await ensureImageWriterInstalled()")
    );
    const firstCallLine = codeLines.find(({ line }) =>
      /KandeloImageFs\.(create|readImage[A-Za-z]+)\(/.test(line)
    );
    expect(installLine, "live-setup must install the image writer").toBeDefined();
    expect(firstCallLine, "live-setup must call the bridge at all").toBeDefined();
    expect(
      installLine!.index,
      "ensureImageWriterInstalled() must precede the first KandeloImageFs call; "
        + "readImageMetadata and readImageCapacity instantiate the module too",
    ).toBeLessThan(firstCallLine!.index);
  });
});

function runtimeImage(): KandeloImageFs {
  const fs = KandeloImageFs.create();
  for (const path of [
    "/bin",
    "/usr/bin",
    "/usr/local/bin",
  ]) {
    ensureDirRecursive(fs, path);
  }

  writeVfsBinary(fs, BASH_PATH, NODE_BYTES, 0o755);
  fs.symlink(BASH_PATH, "/bin/bash");
  // A DEFERRED ARCHIVE through the module's own call. This was
  // `registerLazyTree`, the legacy v3 form with an activation spec; the module
  // describes the same thing as an archive with members, and the activation
  // half was never read here — what this case is about is that assembly
  // leaves the deferred set alone.
  fs.registerArchiveMember({
    path: "/bin/dash",
    archiveId: 1,
    sourcePath: "bin/dash",
    size: 4,
    mode: 0o755,
    ino: 4101,
    archiveBytes: 10,
    archiveDescriptor: new TextEncoder().encode('{"mountPrefix":"/"}'),
    archiveUri: "https://example.invalid/shell-runtime.zip",
  });
  fs.registerArchiveMember({
    path: "/bin/coreutils",
    archiveId: 1,
    sourcePath: "bin/coreutils",
    size: 4,
    mode: 0o755,
    ino: 4102,
    archiveBytes: 10,
    archiveDescriptor: new TextEncoder().encode('{"mountPrefix":"/"}'),
    archiveUri: "https://example.invalid/shell-runtime.zip",
  });
  writeVfsBinary(fs, NODE_BINARY_SPEC.vfsPath, NODE_BYTES, 0o755);
  for (const path of NODE_BINARY_SPEC.symlinks) {
    fs.symlink(NODE_BINARY_SPEC.vfsPath, path);
  }
  return fs;
}

/**
 * What identifies a file here, and what no longer can.
 *
 * `generation` and `dataSequence` are gone from this record. They are
 * `SharedFS`'s inode-reuse counters — a second and third axis of identity that
 * exists because several host instances share one buffer and must notice when
 * an inode has been recycled underneath them. One producer writing one image
 * has no such race, and the module reports `ino` alone.
 */
function fileIdentity(
  fs: KandeloImageFs,
  path: string,
  noFollow = false,
): {
  ino: number;
  mode: number;
  size: number;
} {
  const stat = noFollow ? fs.lstat(path) : fs.stat(path);
  return { ino: stat.ino, mode: stat.mode, size: stat.size };
}

function readVfsFile(fs: KandeloImageFs, path: string): Uint8Array {
  return fs.readFile(path);
}
