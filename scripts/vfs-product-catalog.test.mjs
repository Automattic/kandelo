import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(
  repoRoot,
  "images/vfs/products/generated/catalog.json",
);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return `${JSON.stringify(normalize(value))}\n`;
}

function manifestDigest(manifest) {
  return createHash("sha256").update(canonicalBytes(manifest)).digest("hex");
}

function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-vfs-catalog-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeCanonical(path, value) {
  writeFileSync(path, canonicalBytes(value));
  return path;
}

function readCatalog() {
  return JSON.parse(readFileSync(catalogPath, "utf8"));
}

test("loads the checked catalog and exposes package-backed image roots", () => {
  const catalog = loadVfsProductCatalog(catalogPath);

  const rootfs = catalog.productById("platform-rootfs");
  const shell = catalog.productById("browser-main-shell");
  assert.equal(shell.output, "shell.vfs.zst");
  assert.deepEqual(
    rootfs.software.package,
    [
      {
        name: "rootfs",
        outputs: ["rootfs"],
        source_roles: [],
        role: "runtime",
        materialization: "embedded",
      },
    ],
  );
  assert.deepEqual(
    shell.software.package,
    [
      {
        name: "shell",
        outputs: ["shell"],
        source_roles: [],
        role: "runtime",
        materialization: "embedded",
      },
    ],
  );
  assert.throws(() => catalog.productById("missing-product"), /missing-product/);
});

test("rejects unknown fields, duplicate IDs, and a tampered manifest digest", () => {
  withTempDir((directory) => {
    const unknown = readCatalog();
    unknown.unreviewed = true;
    assert.throws(
      () => loadVfsProductCatalog(writeCanonical(join(directory, "unknown.json"), unknown)),
      /unknown field.*unreviewed/i,
    );

    const duplicate = readCatalog();
    duplicate.products.push(structuredClone(duplicate.products[0]));
    assert.throws(
      () => loadVfsProductCatalog(writeCanonical(join(directory, "duplicate.json"), duplicate)),
      /duplicate product ID/i,
    );

    const tampered = readCatalog();
    tampered.products[0].sha256 = "0".repeat(64);
    assert.throws(
      () => loadVfsProductCatalog(writeCanonical(join(directory, "tampered.json"), tampered)),
      /manifest digest/i,
    );

    const productOwnedPages = readCatalog();
    productOwnedPages.products[0].manifest.pages = { load: "eager" };
    productOwnedPages.products[0].sha256 = manifestDigest(
      productOwnedPages.products[0].manifest,
    );
    assert.throws(
      () => loadVfsProductCatalog(
        writeCanonical(join(directory, "product-pages.json"), productOwnedPages),
      ),
      /unknown field.*pages/i,
    );
  });
});

test("accepts bounded prepared-runtime toolchain components", () => {
  withTempDir((directory) => {
    const catalog = readCatalog();
    const product = catalog.products[0];
    product.manifest.software.toolchain.push({
      component: "kernel-wasm",
      id: "kernel-wasm",
      provider: "prepared-runtime",
      role: "build",
    });
    product.sha256 = manifestDigest(product.manifest);
    assert.doesNotThrow(() => loadVfsProductCatalog(
      writeCanonical(join(directory, "prepared-runtime.json"), catalog),
    ));

    product.manifest.software.toolchain.at(-1).provider = "ambient-path";
    product.sha256 = manifestDigest(product.manifest);
    assert.throws(
      () => loadVfsProductCatalog(
        writeCanonical(join(directory, "ambient-path.json"), catalog),
      ),
      /provider is invalid/i,
    );
  });
});
