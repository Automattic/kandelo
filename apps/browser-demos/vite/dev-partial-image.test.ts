import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isPartialImageRequest,
  loadPartialImageModule,
  parsePartialImageManifest,
} from "./dev-partial-image";

const manifest = {
  schema: 1,
  image: "shell",
  productId: "browser-main-shell",
  file: "shell-partial.vfs.zst",
  sha256: "a".repeat(64),
  bytes: 702816,
  packages: ["fbdoom", "tmux"],
  selection: ["bash", "fbdoom", "rootfs", "tmux"],
  activities: ["shell", "doom"],
  excludedActivities: [{ profile: "scummvm", missing: ["scummvm", "curl", "unzip"] }],
  builtAt: "2026-11-07T00:00:00Z",
};

test("parses the manifest xtask partial-image writes", () => {
  assert.deepEqual(parsePartialImageManifest(JSON.stringify(manifest)), manifest);
});

test("refuses a manifest that would serve the wrong file", () => {
  assert.throws(() => parsePartialImageManifest(JSON.stringify({ ...manifest, file: "../shell.vfs.zst" })), /file must name/);
  assert.throws(() => parsePartialImageManifest(JSON.stringify({ ...manifest, file: "shell.vfs.zst" })), /file must name/);
  assert.throws(() => parsePartialImageManifest(JSON.stringify({ ...manifest, sha256: "XYZ" })), /sha256/);
  assert.throws(() => parsePartialImageManifest(JSON.stringify({ ...manifest, schema: 2 })), /schema 1/);
});

test("no partial image means no module", () => {
  assert.equal(loadPartialImageModule(mkdtempSync(join(tmpdir(), "partial-")), "/"), null);
});

test("a built partial image is served at one stable, base-scoped URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "partial-"));
  writeFileSync(join(dir, "partial.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "demo.json"), JSON.stringify({ version: 1, profiles: { shell: {} } }));
  const module = loadPartialImageModule(dir, "/scope/");
  assert.equal(module?.imageUrl, "/scope/@kandelo-partial/image.vfs.zst");
  assert.equal(module?.manifest.sha256, manifest.sha256);
  assert.deepEqual(module?.demoConfig, { version: 1, profiles: { shell: {} } });
  assert.equal(isPartialImageRequest("/scope/@kandelo-partial/image.vfs.zst", "/scope/"), true);
  assert.equal(isPartialImageRequest("/@kandelo-partial/image.vfs.zst", "/scope/"), false);
});

test("a manifest without its demo config fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "partial-"));
  writeFileSync(join(dir, "partial.json"), JSON.stringify(manifest));
  assert.throws(() => loadPartialImageModule(dir, "/"), /demo\.json is missing/);
});
