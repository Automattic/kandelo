/** Actual ZIP planner and Rust image writer; no fabricated theme fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ABI_VERSION } from "../../../../host/src/generated/abi";
import { ensureDirRecursive } from "../../../../host/src/vfs/image-helpers";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { registerDeclaredShellLazyArchive, SHELL_LAZY_DATA_ARCHIVE_SPECS } from "../../../../images/vfs/scripts/shell-lazy-archives";

const [archivePath, imageModulePath] = process.argv.slice(2);
assert(archivePath && imageModulePath, "usage: check-lazy-mount.ts <theme.zip> <normal image-module32.wasm>");
const moduleBytes = new Uint8Array(readFileSync(imageModulePath));
const spec = SHELL_LAZY_DATA_ARCHIVE_SPECS.find(value => value.id === "cursor-theme")!;
assert(spec, "shell must declare its normal cursor theme mount");
const fs = KandeloImageFs.create(moduleBytes);
ensureDirRecursive(fs, "/usr/share");
const registered = registerDeclaredShellLazyArchive(fs, spec, (path, dependency) => {
  assert.equal(path, "programs/wasm32/bibata-cursor-theme.zip");
  assert.equal(dependency, "bibata-cursor-theme");
  return archivePath;
});
assert.equal(registered.symlinkTargets.size, 89);
function check(tree: KandeloImageFs) {
  assert(tree.isPathDeferred("/usr/share/icons/default/index.theme"));
  for (const [member, target] of registered.symlinkTargets) {
    const path = `/usr/share/${member}`;
    assert.equal(tree.lstat(path).mode & 0o170000, 0o120000);
    assert.equal(tree.readlink(path), target);
    const targetPath = `${path.slice(0, path.lastIndexOf("/"))}/${target}`;
    assert.equal(tree.stat(path).ino, tree.stat(targetPath).ino, path);
    assert(tree.stat(path).deferred, path);
  }
  const archive = tree.lazyEntries().archives.find(value => value.uri === spec.archiveUrl)!;
  assert(archive);
  assert.equal(archive.bytes, readFileSync(archivePath).byteLength);
  assert.equal(Buffer.from(archive.digest).toString("hex"), registered.integrity.sha256);
}
check(fs);
const image = await fs.saveImage({ metadata: { version: 1, kernelAbi: ABI_VERSION,
  createdBy: "bibata-cursor-theme-lazy-mount-control" }, normalizeTimestampsMs: 0 });
const restored = KandeloImageFs.create(moduleBytes);
restored.loadImage(image);
check(restored);
console.log(JSON.stringify({ aliases: 89, mount: spec.mountPrefix, uri: spec.archiveUrl,
  zipSha256: registered.integrity.sha256, serializedImageBytes: image.byteLength,
  imageModuleSha256: createHash("sha256").update(moduleBytes).digest("hex"),
  result: "ZIP alias planning, real Rust publication, save/load, symlink targets and deferred inode identity PASS" }));
