import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { unzipSync } from "fflate";
import {
  collectProductInputObjects,
  type ProductInputObjectSource,
  verifyExactProductSourceIdentity,
} from "./abi-staging-collect-product-inputs";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

test("collects every manifest-owned private input without a parallel selector list", () => {
  const fixture = createFixture();
  const first = collectProductInputObjects({
    ...fixture.options,
    outRoot: join(fixture.root, "first"),
    sources: fixture.sources,
  });
  const second = collectProductInputObjects({
    ...fixture.options,
    outRoot: join(fixture.root, "second"),
    sources: fixture.sources,
  });

  assert.deepEqual(first, second);
  assert.equal(first.target_abi.version, fixture.previousAbi + 1);
  assert.deepEqual(
    first.objects.map((object) => object.id),
    [
      "archive-mini-source",
      "package-libmini-output-libmini",
      "package-mini-output-cli",
      "package-mini-output-runtime",
      "package-mini-source-role-standard-library",
      "repository-fixtures",
      "toolchain-sdk-sysroot",
    ],
  );
  assert.deepEqual(
    first.objects.map((object) => object.adapter),
    [
      "source-archive-v1",
      "package-output-directory-zip-v1",
      "package-output-file-v1",
      "package-output-file-v1",
      "package-source-role-zip-v1",
      "repository-path-bundle-v1",
      "toolchain-directory-zip-v1",
    ],
  );

  const sourceRole = first.objects.find(
    (object) => object.id === "package-mini-source-role-standard-library",
  );
  assert(sourceRole);
  const sourceRoleZip = unzipSync(
    new Uint8Array(readFileSync(join(fixture.root, "first", sourceRole.path))),
  );
  assert.deepEqual(Object.keys(sourceRoleZip).sort(), [
    "standard-library/",
    "standard-library/lib/",
    "standard-library/lib/Module.pm",
  ]);

  const repository = first.objects.find(
    (object) => object.id === "repository-fixtures",
  );
  assert(repository);
  const repositoryBundle = JSON.parse(
    readFileSync(join(fixture.root, "first", repository.path), "utf8"),
  );
  assert.deepEqual(repositoryBundle.paths, ["fixtures/config.json"]);
  assert(!JSON.stringify(repositoryBundle).includes("undeclared.txt"));

  const artifactBytes = readFileSync(join(fixture.root, "first", "inputs/artifacts.json"));
  assert.equal(sha256(artifactBytes), first.inventory_sha256);
});

test("rejects missing, extra, substituted, and linked input sources before collection", () => {
  const fixture = createFixture();
  const missing = fixture.sources.slice(1);
  const extra: ProductInputObjectSource[] = [
    ...fixture.sources,
    {
      kind: "package-output",
      package: "undeclared",
      selectorKind: "output",
      selector: "surprise",
      content: { kind: "file", path: fixture.program },
    },
  ];
  const substituted = fixture.sources.map((source) =>
    source.kind === "package-output" && source.package === "mini"
      && source.selectorKind === "output" && source.selector === "runtime"
      ? { ...source, selector: "other-runtime" }
      : source
  );
  const linkedPath = join(fixture.root, "linked-program");
  symlinkSync(fixture.program, linkedPath);
  const linked = fixture.sources.map((source) =>
    source.kind === "package-output" && source.package === "mini"
      && source.selectorKind === "output" && source.selector === "cli"
      ? { ...source, content: { kind: "file" as const, path: linkedPath } }
      : source
  );

  for (const [name, sources] of [
    ["missing", missing],
    ["extra", extra],
    ["substituted", substituted],
    ["linked", linked],
  ] as const) {
    assert.throws(
      () => collectProductInputObjects({
        ...fixture.options,
        outRoot: join(fixture.root, `invalid-${name}`),
        sources,
      }),
      /input|source|symlink|inventory/i,
      name,
    );
  }
});

test("production collection derives exact Git and dev-shell identity itself", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-product-source-identity-"));
  roots.add(root);
  writeFileSync(join(root, "flake.lock"), "exact lock\n");
  writeFileSync(join(root, "selected.txt"), "selected\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", "flake.lock", "selected.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const lockSha256 = sha256(readFileSync(join(root, "flake.lock")));

  assert.doesNotThrow(() => verifyExactProductSourceIdentity({
    root,
    commit,
    tree,
    devShellLockSha256: lockSha256,
  }));
  assert.throws(
    () => verifyExactProductSourceIdentity({
      root,
      commit: "0".repeat(40),
      tree,
      devShellLockSha256: lockSha256,
    }),
    /commit|head|identity/i,
  );
  assert.throws(
    () => verifyExactProductSourceIdentity({
      root,
      commit,
      tree,
      devShellLockSha256: "0".repeat(64),
    }),
    /lock/i,
  );
  writeFileSync(join(root, "selected.txt"), "mutated\n");
  assert.throws(
    () => verifyExactProductSourceIdentity({
      root,
      commit,
      tree,
      devShellLockSha256: lockSha256,
    }),
    /clean|changed/i,
  );
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "kandelo-product-input-collector-"));
  roots.add(root);
  const sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, "fixtures"), { recursive: true });
  writeFileSync(join(sourceRoot, "fixtures/config.json"), "{\"ok\":true}\n");
  writeFileSync(join(sourceRoot, "undeclared.txt"), "not selected\n");

  const program = join(root, "mini.wasm");
  const runtime = join(root, "mini-runtime.zip");
  const library = join(root, "libmini");
  const standardLibrary = join(root, "standard-library-source");
  const archive = join(root, "mini-source.tar.gz");
  const toolchain = join(root, "sdk-sysroot");
  writeFileSync(program, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(runtime, "runtime bytes\n");
  mkdirSync(join(library, "lib"), { recursive: true });
  writeFileSync(join(library, "lib/libmini.a"), "archive\n");
  mkdirSync(join(standardLibrary, "lib"), { recursive: true });
  writeFileSync(join(standardLibrary, "lib/Module.pm"), "package Module;\n");
  chmodSync(join(standardLibrary, "lib/Module.pm"), 0o644);
  writeFileSync(archive, "pinned upstream archive\n");
  mkdirSync(join(toolchain, "include"), { recursive: true });
  writeFileSync(join(toolchain, "include/stdio.h"), "/* exact */\n");

  const manifest = {
    architecture: "wasm32",
    boot: { argv: ["/bin/mini"], cwd: "/", env: {}, gid: 0, uid: 0 },
    builder: "images/vfs/scripts/build-mini-product.sh",
    composition: {
      product: [{ id: "public-base", materialization: "embedded" }],
      repository: [{
        id: "fixtures",
        paths: ["fixtures/config.json"],
        role: "build",
      }],
    },
    evidence: { node: { test: "mini-node" } },
    id: "mini-product",
    mounts: [{ path: "/", readonly: false, source: "built-image" }],
    output: "mini-product.vfs",
    schema: 1,
    software: {
      archive: [{
        id: "mini-source",
        materialization: "embedded",
        role: "runtime",
        sha256: sha256(readFileSync(archive)),
        url: "https://sources.example.test/mini-source.tar.gz",
      }],
      homebrew: [{
        formulae: ["bash"],
        materialization: "lazy",
        tap: "kandelo-dev/homebrew-tap-core",
      }],
      package: [
        {
          materialization: "embedded",
          name: "mini",
          outputs: ["cli", "runtime"],
          role: "runtime",
          source_roles: ["standard-library"],
        },
        {
          name: "libmini",
          outputs: ["libmini"],
          role: "build",
          source_roles: [],
        },
      ],
      toolchain: [{
        component: "sdk-sysroot",
        id: "sdk-sysroot",
        materialization: "embedded",
        provider: "repository-dev-shell",
        role: "runtime",
      }],
    },
  };
  const manifestSha256 = sha256(canonicalJsonBytes(manifest));
  const catalogPath = join(root, "catalog.json");
  writeFileSync(catalogPath, canonicalJsonBytes({
    kind: "kandelo-vfs-product-catalog",
    products: [{
      manifest,
      path: "images/vfs/products/mini-product.toml",
      sha256: manifestSha256,
    }],
    schema: 1,
  }));
  const previousAbi = 17;
  const sources: ProductInputObjectSource[] = [
    {
      kind: "package-output",
      package: "mini",
      selectorKind: "output",
      selector: "cli",
      content: { kind: "file", path: program },
    },
    {
      kind: "package-output",
      package: "mini",
      selectorKind: "output",
      selector: "runtime",
      content: { kind: "file", path: runtime },
    },
    {
      kind: "package-output",
      package: "mini",
      selectorKind: "source-role",
      selector: "standard-library",
      content: { kind: "directory", path: standardLibrary },
    },
    {
      kind: "package-output",
      package: "libmini",
      selectorKind: "output",
      selector: "libmini",
      content: { kind: "directory", path: library },
    },
    {
      kind: "source-archive",
      id: "mini-source",
      content: { kind: "file", path: archive },
    },
    {
      kind: "toolchain-output",
      id: "sdk-sysroot",
      content: { kind: "directory", path: toolchain },
    },
  ];
  return {
    root,
    program,
    previousAbi,
    sources,
    options: {
      catalogPath,
      productId: "mini-product",
      sourceRoot,
      source: {
        repository: "kandelo-dev/kandelo",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
      },
      targetAbi: {
        version: previousAbi + 1,
        snapshotSha256: "c".repeat(64),
      },
      buildEnvironment: {
        policySha256: "d".repeat(64),
        devShellLockSha256: "e".repeat(64),
      },
    },
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sortJson(value))}\n`);
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
