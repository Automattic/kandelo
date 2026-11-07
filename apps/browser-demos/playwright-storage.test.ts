import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserStorageHome, ownedBrowserStorageRoot, removeBrowserStorageRoot,
  removeNewWritableStreams, writableStreamFiles } from "./playwright-storage";

test("browser homes share one owned root and are removed together", async () => {
  const previous = process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT;
  delete process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT;
  try {
    const firefox = browserStorageHome("firefox");
    const webkit = browserStorageHome("webkit");
    const root = ownedBrowserStorageRoot()!;
    assert.equal(firefox, join(root, "firefox"));
    assert.equal(webkit, join(root, "webkit"));
    assert.equal(browserStorageHome("webkit"), webkit);
    writeFileSync(join(webkit, "storage"), "persistent");
    assert.equal(readFileSync(join(webkit, "storage"), "utf8"), "persistent");
    await removeBrowserStorageRoot(root);
    assert.equal(ownedBrowserStorageRoot(), undefined);
    assert.throws(() => readdirSync(root), { code: "ENOENT" });
  } finally {
    const root = ownedBrowserStorageRoot();
    if (root !== undefined) await removeBrowserStorageRoot(root);
    if (previous === undefined) delete process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT;
    else process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT = previous;
  }
});

test("cleanup refuses unowned paths", async () => {
  await assert.rejects(removeBrowserStorageRoot(tmpdir()), /another runner/);
});

test("only the runner that created a root can remove it", async () => {
  const previous = process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT;
  delete process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT;
  browserStorageHome("webkit");
  const root = ownedBrowserStorageRoot()!;
  try {
    writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: 0 }));
    assert.equal(ownedBrowserStorageRoot(), undefined);
    await assert.rejects(removeBrowserStorageRoot(root), /another runner/);
    assert.equal(readdirSync(root).includes("webkit"), true);
  } finally {
    writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: process.pid }));
    await removeBrowserStorageRoot(root);
    if (previous === undefined) delete process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT;
    else process.env.KANDELO_PLAYWRIGHT_STORAGE_ROOT = previous;
  }
});

test("staging cleanup preserves baseline, unrelated, linked and open files", () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-staging-cleanup-"));
  const old = "FileSystemWritableStreamABC123";
  const fresh = "FileSystemWritableStreamDEF456";
  const held = "FileSystemWritableStreamGHI789";
  const linked = "FileSystemWritableStreamJKL012";
  const symbolic = "FileSystemWritableStreamMNO345";
  try {
    writeFileSync(join(directory, old), "old");
    const baseline = writableStreamFiles(directory);
    writeFileSync(join(directory, fresh), "new");
    writeFileSync(join(directory, held), "open");
    writeFileSync(join(directory, "unrelated"), "preserve");
    linkSync(join(directory, "unrelated"), join(directory, linked));
    symlinkSync(join(directory, "unrelated"), join(directory, symbolic));
    const removed = removeNewWritableStreams(directory, baseline, () => false,
      path => path !== join(directory, held));
    assert.equal(removed.files, 1);
    assert.ok(removed.bytes >= 0);
    assert.deepEqual(readdirSync(directory).sort(), [old, held, linked, symbolic, "unrelated"].sort());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("active browsers prevent staging cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-staging-cleanup-"));
  try {
    writeFileSync(join(directory, "FileSystemWritableStreamABC123"), "held");
    assert.deepEqual(removeNewWritableStreams(directory, new Set(), () => true,
      () => { throw new Error("must not inspect files"); }), { files: 0, bytes: 0 });
    assert.equal(readdirSync(directory).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ownership inspection failure leaves staging files untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-staging-cleanup-"));
  try {
    const path = join(directory, "FileSystemWritableStreamABC123");
    writeFileSync(path, "preserve");
    assert.throws(() => removeNewWritableStreams(directory, new Set(), () => false,
      () => { throw new Error("inspection failed"); }), /inspection failed/);
    assert.equal(readFileSync(path, "utf8"), "preserve");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("another browser starting during inspection prevents deletion", () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-staging-cleanup-"));
  try {
    writeFileSync(join(directory, "FileSystemWritableStreamABC123"), "held");
    let checks = 0;
    const removed = removeNewWritableStreams(directory, new Set(), () => ++checks > 1, () => true);
    assert.equal(removed.files, 0);
    assert.equal(readdirSync(directory).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changed staging file identity prevents deletion", () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-staging-cleanup-"));
  try {
    const path = join(directory, "FileSystemWritableStreamABC123");
    writeFileSync(path, "original");
    const removed = removeNewWritableStreams(directory, new Set(), () => false, () => {
      writeFileSync(path, "changed while inspecting");
      return true;
    });
    assert.equal(removed.files, 0);
    assert.equal(readFileSync(path, "utf8"), "changed while inspecting");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("staging cleanup rejects a redirected directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-staging-cleanup-"));
  try {
    symlinkSync(directory, join(directory, "redirect"));
    assert.throws(() => removeNewWritableStreams(join(directory, "redirect"), new Set(),
      () => false, () => true), /owned directory/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
