import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  deriveProductInputObjectSources,
} from "./abi-staging-product-input-sources";
import {
  collectProductInputObjectsFromResolvedSources,
} from "./abi-staging-collect-product-inputs";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

test("derives physical inputs only from one selected product manifest", () => {
  const fixture = createFixture();
  const sources = deriveProductInputObjectSources({
    archiveFiles: { "mini-source": fixture.archive },
    catalogPath: fixture.catalog,
    packageRoots: {
      libmini: fixture.libraryRoot,
      mini: fixture.packageRoot,
    },
    productId: "mini-product",
    programIndexPath: fixture.programIndex,
    runtimeRoot: fixture.runtimeRoot,
  });

  assert.deepEqual(
    sources.map((source) => source.kind === "package-output"
      ? `${source.package}:${source.selectorKind}:${source.selector}`
      : `${source.kind}:${source.id}`),
    [
      "mini:output:cli",
      "mini:output:runtime-data",
      "mini:source-role:test-suite",
      "libmini:output:libmini",
      "source-archive:mini-source",
      "toolchain-output:sdk-sysroot",
    ],
  );
  assert.equal(
    sources[0]?.content.path,
    realpathSync(join(fixture.packageRoot, "mini.wasm")),
  );
  assert.equal(
    sources[1]?.content.path,
    realpathSync(join(
      fixture.packageRoot,
      ".kandelo-vfs-product-outputs/runtime-data",
    )),
  );
  assert.equal(
    sources[2]?.content.path,
    realpathSync(join(
      fixture.packageRoot,
      ".kandelo-vfs-source-roles/test-suite",
    )),
  );
  assert.equal(sources[3]?.content.path, realpathSync(fixture.libraryRoot));
  assert(!JSON.stringify(sources).includes("undeclared"));
});

test("fails closed when a manifest-selected physical input is unavailable", () => {
  const fixture = createFixture();
  rmSync(
    join(fixture.packageRoot, ".kandelo-vfs-source-roles/test-suite"),
    { force: true, recursive: true },
  );
  assert.throws(
    () => deriveProductInputObjectSources({
      archiveFiles: { "mini-source": fixture.archive },
      catalogPath: fixture.catalog,
      packageRoots: {
        libmini: fixture.libraryRoot,
        mini: fixture.packageRoot,
      },
      productId: "mini-product",
      programIndexPath: fixture.programIndex,
      runtimeRoot: fixture.runtimeRoot,
    }),
    /mini.*source role.*test-suite.*unavailable/i,
  );
});

test("production collection derives and captures the selected manifest closure", () => {
  const fixture = createFixture();
  const inventory = collectProductInputObjectsFromResolvedSources({
    archiveFiles: { "mini-source": fixture.archive },
    buildEnvironment: {
      devShellLockSha256: "e".repeat(64),
      policySha256: "d".repeat(64),
    },
    catalogPath: fixture.catalog,
    outRoot: join(fixture.root, "collected"),
    packageRoots: {
      libmini: fixture.libraryRoot,
      mini: fixture.packageRoot,
    },
    productId: "mini-product",
    programIndexPath: fixture.programIndex,
    runtimeRoot: fixture.runtimeRoot,
    source: {
      commit: "a".repeat(40),
      repository: "kandelo-dev/kandelo",
      tree: "b".repeat(40),
    },
    sourceRoot: fixture.sourceRoot,
    targetAbi: {
      snapshotSha256: "c".repeat(64),
      version: 18,
    },
  });

  assert.deepEqual(
    inventory.objects.map((object) => object.id),
    [
      "archive-mini-source",
      "package-libmini-output-libmini",
      "package-mini-output-cli",
      "package-mini-output-runtime-data",
      "package-mini-source-role-test-suite",
      "toolchain-sdk-sysroot",
    ],
  );
  assert.equal(
    readFileSync(join(fixture.root, "collected/inputs/artifacts.json"), "utf8"),
    `${JSON.stringify(sortJson({
      ...inventory,
      inventory_sha256: undefined,
    }), (_key, value) => value === undefined ? undefined : value)}\n`,
  );
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "kandelo-product-source-adapter-"));
  roots.add(root);
  const packageRoot = join(root, "mini-package");
  const libraryRoot = join(root, "libmini-package");
  const runtimeRoot = join(root, "runtime");
  const sourceRoot = join(root, "source");
  mkdirSync(join(packageRoot, ".kandelo-vfs-product-outputs"), {
    recursive: true,
  });
  mkdirSync(join(packageRoot, ".kandelo-vfs-source-roles/test-suite/tests"), {
    recursive: true,
  });
  mkdirSync(join(libraryRoot, "lib"), { recursive: true });
  mkdirSync(join(runtimeRoot, "toolchain/wasm32-sysroot/include"), {
    recursive: true,
  });
  mkdirSync(sourceRoot);
  writeFileSync(join(packageRoot, "mini.wasm"), "mini\n");
  writeFileSync(
    join(packageRoot, ".kandelo-vfs-product-outputs/runtime-data"),
    "runtime\n",
  );
  writeFileSync(
    join(packageRoot, ".kandelo-vfs-source-roles/test-suite/tests/a.test"),
    "test\n",
  );
  writeFileSync(join(packageRoot, "undeclared.wasm"), "undeclared\n");
  writeFileSync(join(libraryRoot, "lib/libmini.a"), "library\n");
  writeFileSync(
    join(runtimeRoot, "toolchain/wasm32-sysroot/include/stdio.h"),
    "header\n",
  );
  const archive = join(root, "mini-source.tar.gz");
  writeFileSync(archive, "archive\n");

  const manifest = {
    architecture: "wasm32",
    boot: { argv: ["/bin/mini"], cwd: "/", env: {}, gid: 0, uid: 0 },
    builder: "images/vfs/scripts/build-mini.sh",
    composition: { product: [], repository: [] },
    evidence: { node: { test: "mini-node" } },
    id: "mini-product",
    mounts: [{ path: "/", readonly: false, source: "built-image" }],
    output: "mini.vfs",
    schema: 1,
    software: {
      archive: [{
        id: "mini-source",
        materialization: "embedded",
        role: "runtime",
        sha256: createHash("sha256").update("archive\n").digest("hex"),
        url: "https://example.test/mini.tar.gz",
      }],
      homebrew: [],
      package: [
        {
          materialization: "embedded",
          name: "mini",
          outputs: ["cli", "runtime-data"],
          role: "runtime",
          source_roles: ["test-suite"],
        },
        {
          name: "libmini",
          outputs: ["libmini"],
          role: "build",
          source_roles: [],
        },
      ],
      toolchain: [{
        component: "wasm32-sysroot",
        id: "sdk-sysroot",
        materialization: "embedded",
        provider: "repository-dev-shell",
        role: "runtime",
      }],
    },
  };
  const catalog = join(root, "catalog.json");
  writeFileSync(catalog, canonicalJson({
    kind: "kandelo-vfs-product-catalog",
    products: [{
      manifest,
      path: "images/vfs/products/mini-product.toml",
      sha256: createHash("sha256")
        .update(canonicalJson(manifest))
        .digest("hex"),
    }],
    schema: 1,
  }));
  const programIndex = join(root, "program-packages.json");
  writeFileSync(programIndex, canonicalJson({
    format: 2,
    identities: {},
    packages: {
      mini: {
        arches: ["wasm32"],
        cacheKeys: { wasm32: "c".repeat(64) },
        dependencyClosures: { wasm32: [] },
        manifestSha256: "d".repeat(64),
        members: [{
          forkInstrumentation: "disabled",
          kind: "output",
          mirrorPath: "mini/mini.wasm",
          outputName: "cli",
          sourceArtifact: "mini.wasm",
        }],
      },
      undeclared: {
        arches: ["wasm32"],
        cacheKeys: { wasm32: "e".repeat(64) },
        dependencyClosures: { wasm32: [] },
        manifestSha256: "f".repeat(64),
        members: [],
      },
    },
  }));
  return {
    archive,
    catalog,
    libraryRoot,
    packageRoot,
    programIndex,
    root,
    runtimeRoot,
    sourceRoot,
  };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
