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

import {
  checkMainShellProjection,
  loadVfsProductCatalog,
} from "./vfs-product-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(
  repoRoot,
  "images/vfs/products/generated/catalog.json",
);
const projectionPaths = {
  catalogPath,
  brewfilePath: join(repoRoot, "homebrew/main-shell.Brewfile"),
  runtimeSupportPath: join(
    repoRoot,
    "homebrew/main-shell-homebrew-runtime-support.json",
  ),
  materializationPath: join(
    repoRoot,
    "homebrew/main-shell-materialization-policy.json",
  ),
  compatibilityPath: join(
    repoRoot,
    "homebrew/main-shell-compatibility.json",
  ),
};

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

function checkMainShellToolchainSelection({
  catalogPath: selectedCatalogPath,
  compatibilityPath,
}) {
  const catalog = loadVfsProductCatalog(selectedCatalogPath);
  const selected = catalog.homebrewRoots("browser-main-shell")
    .filter(({ formula }) =>
      ["libcxx", "clang", "kandelo-sdk"].includes(formula));
  assert.deepEqual(selected, [{
    tap: "kandelo-dev/homebrew-tap-core",
    formula: "kandelo-sdk",
    materialization: "lazy",
  }]);
  assert.doesNotMatch(
    JSON.stringify(catalog.productById("browser-main-shell").software.homebrew),
    /https?:|sha256:/,
  );

  const compatibility = JSON.parse(readFileSync(compatibilityPath, "utf8"));
  const toolchainAliases = compatibility.aliases.filter(({ targets }) =>
    targets.some((target) =>
      target === "/usr/lib/llvm" || target === "/usr/wasm32posix"));
  assert.deepEqual(toolchainAliases, [
    {
      package: "kandelo-dev/tap-core/clang",
      source_kind: "keg",
      source: "libexec/llvm",
      targets: ["/usr/lib/llvm"],
    },
    {
      package: "kandelo-dev/tap-core/kandelo-sdk",
      source_kind: "keg",
      source: "libexec/wasm32posix",
      targets: ["/usr/wasm32posix"],
    },
  ]);
}

test("loads the checked catalog and exposes exact Homebrew roots", () => {
  const catalog = loadVfsProductCatalog(catalogPath);

  assert.equal(catalog.productById("browser-main-shell").output, "shell.vfs.zst");
  assert.deepEqual(
    catalog.homebrewRoots("browser-main-shell").filter(({ formula }) =>
      ["bash", "ruby"].includes(formula)
    ),
    [
      {
        tap: "kandelo-dev/homebrew-tap-core",
        formula: "bash",
        materialization: "embedded",
      },
      {
        tap: "kandelo-dev/homebrew-tap-core",
        formula: "ruby",
        materialization: "lazy",
      },
    ],
  );
  assert.throws(() => catalog.productById("missing-product"), /missing-product/);
});

test("main shell selects only the lazy SDK root for the toolchain", () => {
  checkMainShellToolchainSelection(projectionPaths);

  withTempDir((directory) => {
    for (const mutation of ["direct-clang", "duplicate-sdk", "candidate-url"]) {
      const changed = readCatalog();
      const shell = changed.products.find(
        ({ manifest }) => manifest.id === "browser-main-shell",
      );
      const lazy = shell.manifest.software.homebrew.find(
        ({ materialization }) => materialization === "lazy",
      );
      if (mutation === "direct-clang") lazy.formulae.push("clang");
      if (mutation === "duplicate-sdk") lazy.formulae.push("kandelo-sdk");
      if (mutation === "candidate-url") lazy.url = "https://candidate.invalid/sdk";
      shell.sha256 = manifestDigest(shell.manifest);
      const changedPath = writeCanonical(
        join(directory, `${mutation}.json`),
        changed,
      );
      assert.throws(() => checkMainShellToolchainSelection({
        ...projectionPaths,
        catalogPath: changedPath,
      }));
    }

    for (const [name, packageName] of [
      ["clang", "kandelo-dev/tap-core/not-clang"],
      ["sdk", "kandelo-dev/tap-core/not-sdk"],
    ]) {
      const compatibility = JSON.parse(
        readFileSync(projectionPaths.compatibilityPath, "utf8"),
      );
      const target = name === "clang" ? "/usr/lib/llvm" : "/usr/wasm32posix";
      compatibility.aliases.find(({ targets }) => targets.includes(target)).package =
        packageName;
      const changedPath = writeCanonical(
        join(directory, `${name}-alias.json`),
        compatibility,
      );
      assert.throws(() => checkMainShellToolchainSelection({
        ...projectionPaths,
        compatibilityPath: changedPath,
      }));
    }
  });
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

test("main-shell legacy roots and materialization project from the product", () => {
  checkMainShellProjection(projectionPaths);

  withTempDir((directory) => {
    const brewfile = join(directory, "main-shell.Brewfile");
    writeFileSync(
      brewfile,
      `${readFileSync(projectionPaths.brewfilePath, "utf8")}brew "kandelo-dev/tap-core/rogue"\n`,
    );
    assert.throws(
      () => checkMainShellProjection({ ...projectionPaths, brewfilePath: brewfile }),
      /browser-main-shell.*rogue/is,
    );

    const runtime = JSON.parse(readFileSync(projectionPaths.runtimeSupportPath, "utf8"));
    runtime.formula_roots.push({
      package: "kandelo-dev/tap-core/rogue",
      reason: "Test-only root.",
    });
    const runtimePath = join(directory, "runtime.json");
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    assert.throws(
      () => checkMainShellProjection({
        ...projectionPaths,
        runtimeSupportPath: runtimePath,
      }),
      /browser-main-shell.*rogue/is,
    );

    const policy = JSON.parse(readFileSync(projectionPaths.materializationPath, "utf8"));
    policy.embedded_roots = [];
    const policyPath = join(directory, "policy.json");
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    assert.throws(
      () => checkMainShellProjection({
        ...projectionPaths,
        materializationPath: policyPath,
      }),
      /browser-main-shell.*bash/is,
    );

    const changedCatalog = readCatalog();
    const shell = changedCatalog.products.find(
      ({ manifest }) => manifest.id === "browser-main-shell",
    );
    shell.manifest.software.homebrew[0].materialization = "lazy";
    shell.sha256 = manifestDigest(shell.manifest);
    const changedCatalogPath = writeCanonical(
      join(directory, "changed-catalog.json"),
      changedCatalog,
    );
    assert.throws(
      () => checkMainShellProjection({
        ...projectionPaths,
        catalogPath: changedCatalogPath,
      }),
      /browser-main-shell.*bash/is,
    );
  });
});

test("the legacy main-shell checker contains no executable Formula root array", () => {
  const source = readFileSync(
    join(repoRoot, "scripts/check-homebrew-main-shell-brewfile.mjs"),
    "utf8",
  );

  assert.doesNotMatch(source, /runtimeSupportRootOrder\s*=/);
});
