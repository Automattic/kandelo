import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const distRoot = new URL("./dist/", import.meta.url);
const publishingPage = new URL(
  "reference/homebrew-publishing.html",
  distRoot,
);

async function readPage(url) {
  return readFile(url, "utf8");
}

async function readPageModule(page) {
  const hashes = JSON.parse(await readFile(new URL("hashmap.json", distRoot)));
  const hash = hashes[page];

  assert.match(hash, /^[A-Za-z0-9_-]+$/);
  return readFile(
    new URL(`assets/${page}.${hash}.lean.js`, distRoot),
    "utf8",
  );
}

test("published Homebrew references expose their section metadata", async () => {
  const [publishing, packaging] = await Promise.all([
    readPageModule("reference_homebrew-publishing.md"),
    readPageModule("reference_homebrew-packaging-system.md"),
  ]);

  assert.ok(!publishing.includes('"headers":[]'));
  assert.ok(!packaging.includes('"headers":[]'));
  assert.ok(publishing.includes('"slug":"durable-kandelo-package-input"'));
  assert.ok(packaging.includes('"slug":"the-short-version"'));
});

test("published workflow expressions remain literal", async () => {
  const publishing = await readPage(publishingPage);

  assert.ok(publishing.includes("${{ github.sha }}"));
  assert.ok(publishing.includes("${{ runner.environment }}"));
});
