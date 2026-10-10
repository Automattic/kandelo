import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializePublicAsset } from "./run-browser.js";

test("browser benchmarks refresh stale public images from checked package bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-benchmark-assets-"));
  try {
    const source = join(root, "verified-image");
    const target = join(root, "app.vfs.zst");
    writeFileSync(source, "current ABI image");
    writeFileSync(target, "old ABI image");
    const requests: string[] = [];
    const selected = materializePublicAsset("programs/app.vfs.zst", "app.vfs.zst", root, (request) => {
      requests.push(request);
      return source;
    });
    assert.deepEqual(requests, ["programs/app.vfs.zst"]);
    assert.equal(selected.resolverSelectedPath, source);
    assert.equal(selected.selectedPath, target);
    assert.equal(readFileSync(target, "utf8"), "current ABI image");
    writeFileSync(source, "rebuilt ABI image");
    materializePublicAsset("programs/app.vfs.zst", "app.vfs.zst", root, () => source);
    assert.equal(readFileSync(target, "utf8"), "rebuilt ABI image");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public copies cannot satisfy missing or rejected package authority", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-benchmark-assets-"));
  try {
    writeFileSync(join(root, "app.vfs.zst"), "unverified image");
    const selected = materializePublicAsset("programs/app.vfs.zst", "app.vfs.zst", root, () => null);
    assert.equal(selected.selectedPath, null);
    assert.throws(() => materializePublicAsset("programs/app.vfs.zst", "app.vfs.zst", root, () => {
      throw new Error("package provenance rejected");
    }), /package provenance rejected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
