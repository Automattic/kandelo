import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import {
  binariesDir,
  binaryProgramCacheRoot,
  findRepoRoot,
  localBinariesDir,
  programOutputClosureRelPaths,
  resetBinaryResolverManifestCacheForTests,
  resolveBinary,
  setProgramIndexContextCheckerForTests,
  tryResolveBinary,
  tryResolveBinaries,
  tryResolveBinarySet,
} from "../src/binary-resolver";
import { ABI_VERSION } from "../src/generated/abi";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../src/vfs/memory-fs";

const cleanupDirs = new Set<string>();
const cleanupEmptyDirs = new Set<string>();
let savedXdgCacheHome: string | undefined;
let savedBinaryCacheRoot: string | undefined;
let hadSavedBinaryCacheRoot = false;
let savedRegistry: string | undefined;
let hadSavedRegistry = false;
let savedResolverRepoRoot: string | undefined;
let hadSavedResolverRepoRoot = false;
let fixtureRegistryRoot = "";
let fixtureRegistryIdentities: Record<string, unknown> = {};
let fixtureRegistryPackages: Record<string, unknown> = {};

beforeEach(() => {
  hadSavedBinaryCacheRoot = Object.prototype.hasOwnProperty.call(
    process.env,
    "WASM_POSIX_BINARY_CACHE_ROOT",
  );
  savedBinaryCacheRoot = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  savedXdgCacheHome = process.env.XDG_CACHE_HOME;
  const cacheHome = mkdtempSync(join(tmpdir(), "kandelo-resolver-xdg-cache-"));
  cleanupDirs.add(cacheHome);
  process.env.XDG_CACHE_HOME = cacheHome;
  hadSavedRegistry = Object.prototype.hasOwnProperty.call(
    process.env,
    "WASM_POSIX_DEPS_REGISTRY",
  );
  savedRegistry = process.env.WASM_POSIX_DEPS_REGISTRY;
  hadSavedResolverRepoRoot = Object.prototype.hasOwnProperty.call(
    process.env,
    "WASM_POSIX_BINARY_RESOLVER_REPO_ROOT",
  );
  savedResolverRepoRoot = process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT;
  delete process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT;
  fixtureRegistryRoot = mkdtempSync(
    join(tmpdir(), "kandelo-resolver-registry-"),
  );
  cleanupDirs.add(fixtureRegistryRoot);
  fixtureRegistryIdentities = {};
  fixtureRegistryPackages = {};
  writeFixtureRegistryIndex();
  process.env.WASM_POSIX_DEPS_REGISTRY = fixtureRegistryRoot;
  setProgramIndexContextCheckerForTests(() => {});
  resetBinaryResolverManifestCacheForTests();
});

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of cleanupEmptyDirs) {
    try {
      rmdirSync(dir);
    } catch {
      // Keep any non-empty resolver cache directories owned by the user.
    }
  }
  cleanupDirs.clear();
  cleanupEmptyDirs.clear();
  setProgramIndexContextCheckerForTests(null);
  resetBinaryResolverManifestCacheForTests();
  if (savedXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = savedXdgCacheHome;
  }
  if (hadSavedBinaryCacheRoot) {
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = savedBinaryCacheRoot ?? "";
  } else {
    delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  }
  if (hadSavedRegistry) {
    process.env.WASM_POSIX_DEPS_REGISTRY = savedRegistry ?? "";
  } else {
    delete process.env.WASM_POSIX_DEPS_REGISTRY;
  }
  if (hadSavedResolverRepoRoot) {
    process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT =
      savedResolverRepoRoot ?? "";
  } else {
    delete process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT;
  }
});

function uleb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function sleb128I32(n: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    let byte = n & 0x7f;
    n >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(name: string): number[] {
  const encoded = new TextEncoder().encode(name);
  return [...uleb128(encoded.length), ...encoded];
}

function functionBody(instructions: number[]): number[] {
  const body = [0x00, ...instructions, 0x0b];
  return [...uleb128(body.length), ...body];
}

function executableWasmWithAbi(abi: number): Uint8Array {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ];

  bytes.push(...section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]));
  bytes.push(...section(3, [0x02, 0x00, 0x00]));
  bytes.push(...section(7, [
    0x02,
    ...nameBytes("__abi_version"), 0x00, 0x00,
    ...nameBytes("_start"), 0x00, 0x01,
  ]));
  bytes.push(...section(10, [
    0x02,
    ...functionBody([0x41, ...sleb128I32(abi)]),
    ...functionBody([0x41, 0x00]),
  ]));

  return new Uint8Array(bytes);
}

async function vfsImage(
  metadata: VfsImageMetadata | null | undefined,
  compressed: boolean,
): Promise<Uint8Array> {
  const mfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  const image = await mfs.saveImage(
    metadata === undefined ? undefined : { metadata },
  );
  return compressed ? new Uint8Array(zstdCompressSync(image)) : image;
}

function fixtureClosureRelPaths(names: readonly string[]): string[] {
  const testRoot = "programs/wasm32/__binary_resolver_test__";
  const dir = `${testRoot}/${randomUUID()}`;
  cleanupDirs.add(join(localBinariesDir(), dir));
  cleanupDirs.add(join(binariesDir(), dir));
  for (const root of [localBinariesDir(), binariesDir()]) {
    cleanupEmptyDirs.add(join(root, testRoot));
    cleanupEmptyDirs.add(join(root, "programs/wasm32"));
    cleanupEmptyDirs.add(join(root, "programs"));
    cleanupEmptyDirs.add(root);
  }
  return names.map((name) => `${dir}/${name}`);
}

function fixtureRelPath(extension: ".wasm" | ".vfs" | ".vfs.zst" | ".dat"): string {
  return fixtureClosureRelPaths([`artifact${extension}`])[0];
}

function candidatePath(root: string, relPath: string): string {
  return join(root, relPath);
}

function writeCandidate(root: string, relPath: string, bytes: Uint8Array): string {
  const path = candidatePath(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

interface MultiOutputFixture {
  name: string;
  members: Array<{
    relPath: string;
    sourceArtifact: string;
  }>;
}

function fixturePackageName(): string {
  return `binary-resolver-test-${randomUUID()}`;
}

function fixturePackageDirectory(name: string): string {
  const directory = join(fixtureRegistryRoot, name);
  cleanupDirs.add(directory);
  return directory;
}

function writeFixturePackageManifest(name: string, manifest: string): string {
  const directory = fixturePackageDirectory(name);
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, "package.toml");
  writeFileSync(manifestPath, manifest);
  resetBinaryResolverManifestCacheForTests();
  return manifestPath;
}

interface FixtureProjectionMember {
  kind: "output" | "runtime-file";
  sourceArtifact: string;
  mirrorPath: string;
  outputName?: string;
  forkInstrumentation?: "auto" | "disabled";
  guestPath?: string;
  mode?: number;
}

interface FixtureDependencyIdentity {
  packageName: string;
  manifestSha256: string;
  cacheKey: string;
}

function fixtureCacheKey(packageName: string, arch = "wasm32"): string {
  return createHash("sha256")
    .update(`binary-resolver fixture:${packageName}:${arch}`)
    .digest("hex");
}

function writeFixtureRegistryIndex(): void {
  writeFileSync(
    join(fixtureRegistryRoot, "program-packages.json"),
    `${JSON.stringify({
      format: "kandelo-program-packages-v2",
      identities: fixtureRegistryIdentities,
      packages: fixtureRegistryPackages,
    }, null, 2)}\n`,
  );
  resetBinaryResolverManifestCacheForTests();
}

function writeFixturePackageProjection(
  name: string,
  members: FixtureProjectionMember[],
  arches = ["wasm32"],
  cacheKeys = Object.fromEntries(
    arches.map((arch) => [arch, fixtureCacheKey(name, arch)]),
  ),
  dependencyClosures: Record<string, FixtureDependencyIdentity[]> =
    Object.fromEntries(arches.map((arch) => [arch, []])),
): void {
  const manifestPath = join(fixturePackageDirectory(name), "package.toml");
  const manifestSha256 = createHash("sha256")
    .update(readFileSync(manifestPath))
    .digest("hex");
  fixtureRegistryIdentities[name] = {
    manifestSha256,
    cacheKeys: {
      wasm32: cacheKeys.wasm32 ?? fixtureCacheKey(name, "wasm32"),
      wasm64: cacheKeys.wasm64 ?? fixtureCacheKey(name, "wasm64"),
    },
  };
  fixtureRegistryPackages[name] = {
    manifestSha256,
    arches,
    cacheKeys,
    dependencyClosures,
    members,
  };
  writeFixtureRegistryIndex();
}

function writeFixturePackageIdentity(
  name: string,
  cacheKeys: Record<string, string> = {
    wasm32: fixtureCacheKey(name, "wasm32"),
    wasm64: fixtureCacheKey(name, "wasm64"),
  },
): FixtureDependencyIdentity {
  const manifestPath = join(fixturePackageDirectory(name), "package.toml");
  const manifestSha256 = createHash("sha256")
    .update(readFileSync(manifestPath))
    .digest("hex");
  fixtureRegistryIdentities[name] = { manifestSha256, cacheKeys };
  writeFixtureRegistryIndex();
  return {
    packageName: name,
    manifestSha256,
    cacheKey: cacheKeys.wasm32!,
  };
}

describe("program package source freshness boundary", () => {
  it("checks every public program-resolution boundary without duplicate nested checks", () => {
    const relPath = fixtureRelPath(".dat");
    const path = writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("program data"),
    );
    const calls: Array<{ sourceRepoRoot: string; registryRoots: string[] }> = [];
    setProgramIndexContextCheckerForTests((sourceRepoRoot, registryRoots) => {
      calls.push({ sourceRepoRoot, registryRoots: [...registryRoots] });
    });

    expect(programOutputClosureRelPaths(relPath)).toBeNull();
    expect(resolveBinary(relPath)).toBe(path);
    expect(tryResolveBinary(relPath)).toBe(path);
    expect(tryResolveBinaries([relPath])).toEqual([path]);
    expect(tryResolveBinarySet([relPath])).toEqual([path]);

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.sourceRepoRoot).toBe(findRepoRoot());
      expect(call.registryRoots).toEqual([fixtureRegistryRoot]);
    }
  });

  it("checks one projection once for a batch of independent optional artifacts", () => {
    const [presentRelPath, absentRelPath] = fixtureClosureRelPaths([
      "present.dat",
      "absent.dat",
    ]);
    const presentPath = writeCandidate(
      localBinariesDir(),
      presentRelPath!,
      new TextEncoder().encode("program data"),
    );
    const calls: string[][] = [];
    setProgramIndexContextCheckerForTests((_sourceRepoRoot, registryRoots) => {
      calls.push([...registryRoots]);
    });

    expect(tryResolveBinaries([presentRelPath!, absentRelPath!])).toEqual([
      presentPath,
      null,
    ]);
    expect(calls).toEqual([[fixtureRegistryRoot]]);
  });

  it("passes the exact configured registry order to the Rust checker", () => {
    const upperRoot = mkdtempSync(
      join(tmpdir(), "kandelo-resolver-upper-registry-"),
    );
    cleanupDirs.add(upperRoot);
    writeFileSync(
      join(upperRoot, "program-packages.json"),
      '{"format":"kandelo-program-packages-v2","identities":{},"packages":{}}\n',
    );
    process.env.WASM_POSIX_DEPS_REGISTRY =
      `${upperRoot}:${fixtureRegistryRoot}`;
    const calls: string[][] = [];
    setProgramIndexContextCheckerForTests((_sourceRepoRoot, registryRoots) => {
      calls.push([...registryRoots]);
    });

    expect(
      programOutputClosureRelPaths(
        "programs/wasm32/not-selected/not-selected.wasm",
      ),
    ).toBeNull();

    expect(calls).toEqual([[upperRoot, fixtureRegistryRoot]]);
  });

  it("does not consume source projection policy after the exact checker fails", () => {
    setProgramIndexContextCheckerForTests(() => {
      throw new Error("injected stale program projection");
    });

    expect(() =>
      programOutputClosureRelPaths(
        "programs/wasm32/stale-package/stale.wasm",
      )
    ).toThrow("injected stale program projection");
  });

  it("executes the production checker command and fails closed on its error", () => {
    const checkerRoot = mkdtempSync(
      join(tmpdir(), "kandelo-resolver-checker-command-"),
    );
    cleanupDirs.add(checkerRoot);
    const checkerPath = join(checkerRoot, "xtask");
    writeFileSync(
      checkerPath,
      `#!/bin/sh
printf 'checker args: %s %s\\nregistry: %s\\n' "$1" "$2" "$WASM_POSIX_DEPS_REGISTRY" >&2
exit 23
`,
    );
    chmodSync(checkerPath, 0o755);
    const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
    const hadSavedXtask = Object.prototype.hasOwnProperty.call(
      process.env,
      "WASM_POSIX_XTASK_BIN",
    );
    process.env.WASM_POSIX_XTASK_BIN = checkerPath;
    setProgramIndexContextCheckerForTests(null);
    try {
      expect(() =>
        programOutputClosureRelPaths(
          "programs/wasm32/production-check/production-check.wasm",
        )
      ).toThrow(
        /program-index-context-check failed with status 23[\s\S]*checker args: build-deps program-index-context-check/,
      );
    } finally {
      if (hadSavedXtask) {
        process.env.WASM_POSIX_XTASK_BIN = savedXtask ?? "";
      } else {
        delete process.env.WASM_POSIX_XTASK_BIN;
      }
      setProgramIndexContextCheckerForTests(() => {});
    }
  });
});

interface StandaloneRegistryEntry {
  manifest: string;
  cacheKeys: Record<"wasm32" | "wasm64", string>;
  projection?: {
    arches: Array<"wasm32" | "wasm64">;
    dependencyClosures: Record<string, FixtureDependencyIdentity[]>;
    members: FixtureProjectionMember[];
  };
}

function writeStandaloneRegistry(
  root: string,
  entries: Record<string, StandaloneRegistryEntry>,
  contextualEntries: Record<string, StandaloneRegistryEntry> = {},
): void {
  const identities: Record<string, unknown> = {};
  const packages: Record<string, unknown> = {};
  const addProjection = (
    packageName: string,
    entry: StandaloneRegistryEntry,
  ) => {
    const manifestSha256 = createHash("sha256")
      .update(entry.manifest)
      .digest("hex");
    identities[packageName] = {
      manifestSha256,
      cacheKeys: entry.cacheKeys,
    };
    if (entry.projection) {
      packages[packageName] = {
        manifestSha256,
        arches: entry.projection.arches,
        cacheKeys: Object.fromEntries(
          entry.projection.arches.map(
            (arch) => [arch, entry.cacheKeys[arch]],
          ),
        ),
        dependencyClosures: entry.projection.dependencyClosures,
        members: entry.projection.members,
      };
    }
  };
  for (const [packageName, entry] of Object.entries(contextualEntries)) {
    addProjection(packageName, entry);
  }
  for (const [packageName, entry] of Object.entries(entries)) {
    const packageRoot = join(root, packageName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.toml"), entry.manifest);
    addProjection(packageName, entry);
  }
  writeFileSync(
    join(root, "program-packages.json"),
    `${JSON.stringify({
      format: "kandelo-program-packages-v2",
      identities,
      packages,
    }, null, 2)}\n`,
  );
}

function standaloneDependencyIdentity(
  packageName: string,
  manifest: string,
  cacheKey: string,
): FixtureDependencyIdentity {
  return {
    packageName,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    cacheKey,
  };
}

function createMultiOutputFixture(): MultiOutputFixture {
  const name = fixturePackageName();
  writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
version = "1.0.0"
kernel_abi = ${ABI_VERSION}
depends_on = []

[source]
url = "https://example.invalid/source.tar.gz"
sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[license]
spdx = "MIT"

[[outputs]]
name = "image"
wasm = "artifacts/image.zip"

[[outputs]]
name = "bootstrap"
wasm = "support/bootstrap.zip"

[[runtime_files]]
artifact = "share/runtime.dat"
guest_path = "/usr/share/runtime.dat"
`);
  const members = [
    {
      relPath: `programs/wasm32/${name}/image.zip`,
      sourceArtifact: "artifacts/image.zip",
    },
    {
      relPath: `programs/wasm32/${name}/bootstrap.zip`,
      sourceArtifact: "support/bootstrap.zip",
    },
    {
      relPath: `programs/wasm32/${name}/share/runtime.dat`,
      sourceArtifact: "share/runtime.dat",
    },
  ];
  writeFixturePackageProjection(name, [
    {
      kind: "output",
      sourceArtifact: "artifacts/image.zip",
      mirrorPath: `${name}/image.zip`,
      outputName: "image",
      forkInstrumentation: "auto",
    },
    {
      kind: "output",
      sourceArtifact: "support/bootstrap.zip",
      mirrorPath: `${name}/bootstrap.zip`,
      outputName: "bootstrap",
      forkInstrumentation: "auto",
    },
    {
      kind: "runtime-file",
      sourceArtifact: "share/runtime.dat",
      mirrorPath: `${name}/share/runtime.dat`,
      guestPath: "/usr/share/runtime.dat",
      mode: 0o644,
    },
  ]);
  for (const root of [
    localBinariesDir(),
    binariesDir(),
    join(findRepoRoot(), "host", "wasm"),
  ]) {
    cleanupDirs.add(join(root, "programs", "wasm32", name));
  }
  return { name, members };
}

function createScalarOutputFixture(): {
  name: string;
  relPath: string;
  sourceArtifact: string;
} {
  const name = fixturePackageName();
  const outputName = `command-${randomUUID()}`;
  const sourceArtifact = `bin/${outputName}.wasm`;
  const relPath = `programs/wasm32/${outputName}.wasm`;
  writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
version = "1.0.0"
kernel_abi = ${ABI_VERSION}
depends_on = []

[source]
url = "https://example.invalid/${name}.tar.gz"
sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[license]
spdx = "MIT"

[[outputs]]
name = "${outputName}"
wasm = "${sourceArtifact}"
`);
  writeFixturePackageProjection(name, [{
    kind: "output",
    sourceArtifact,
    mirrorPath: `${outputName}.wasm`,
    outputName,
    forkInstrumentation: "auto",
  }]);
  for (const root of [localBinariesDir(), binariesDir()]) {
    cleanupDirs.add(join(root, relPath));
  }
  return { name, relPath, sourceArtifact };
}

function fixtureCanonicalRoot(
  packageName: string,
  arch = "wasm32",
  cacheKey = fixtureCacheKey(packageName, arch),
): string {
  const root = join(
    binaryProgramCacheRoot(),
    `${packageName}-1.0.0-rev1-${arch}-${cacheKey}`,
  );
  mkdirSync(root, { recursive: true });
  cleanupDirs.add(root);
  return root;
}

function fixtureLocalCanonicalRoot(
  packageName: string,
  arch = "wasm32",
  cacheKey = fixtureCacheKey(packageName, arch),
): string {
  const packageGenerations = join(
    localBinariesDir(),
    ".kandelo-local-generations",
    arch,
    packageName,
    cacheKey,
  );
  const root = join(packageGenerations, randomUUID());
  mkdirSync(root, { recursive: true });
  cleanupDirs.add(packageGenerations);
  cleanupEmptyDirs.add(dirname(packageGenerations));
  cleanupEmptyDirs.add(dirname(dirname(packageGenerations)));
  cleanupEmptyDirs.add(dirname(dirname(dirname(packageGenerations))));
  return root;
}

function fixtureArbitraryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-binary-resolver-arbitrary-"));
  cleanupDirs.add(root);
  return root;
}

function writeCanonicalMember(
  canonicalRoot: string,
  sourceArtifact: string,
  contents: string | Uint8Array,
): string {
  const target = join(canonicalRoot, ...sourceArtifact.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function linkClosureMember(
  mirrorRoot: string,
  member: MultiOutputFixture["members"][number],
  canonicalRoot: string,
  contents: string | Uint8Array = member.relPath,
): string {
  const target = writeCanonicalMember(
    canonicalRoot,
    member.sourceArtifact,
    contents,
  );
  const mirror = join(mirrorRoot, member.relPath);
  mkdirSync(dirname(mirror), { recursive: true });
  symlinkSync(target, mirror);
  return mirror;
}

describe("binary resolver artifact policy", () => {
  it("does not mistake an installed package consumer workspace for Kandelo", () => {
    const consumer = mkdtempSync(join(tmpdir(), "kandelo-consumer-root-"));
    cleanupDirs.add(consumer);
    const installedModule = join(
      consumer,
      "node_modules",
      "@automattic",
      "wasm-posix-host",
      "dist",
    );
    mkdirSync(installedModule, { recursive: true });
    writeFileSync(join(consumer, "Cargo.toml"), "[workspace]\nmembers = []\n");
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"unrelated-consumer","private":true}\n',
    );

    expect(() => findRepoRoot(installedModule)).toThrow(
      /Could not find repo root/,
    );
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"kandelo","private":true}\n',
    );
    expect(findRepoRoot(installedModule)).toBe(consumer);
  });

  it("skips a stale local .vfs.zst when a fetched ABI-matching candidate exists", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const staleLocal = await vfsImage(
      { version: 1, kernelAbi: ABI_VERSION - 1 },
      true,
    );
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    writeCandidate(localBinariesDir(), relPath, staleLocal);
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("skips a stale local .vfs when a fetched ABI-matching candidate exists", async () => {
    const relPath = fixtureRelPath(".vfs");
    const staleLocal = await vfsImage(
      { version: 1, kernelAbi: ABI_VERSION - 1 },
      false,
    );
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, false);

    writeCandidate(localBinariesDir(), relPath, staleLocal);
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("selects a matching local .vfs.zst before the fetched candidate", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const local = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    const localPath = writeCandidate(localBinariesDir(), relPath, local);
    writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("accepts a VFS image with metadata but no kernelAbi declaration", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const local = await vfsImage({ version: 1 }, true);
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    const localPath = writeCandidate(localBinariesDir(), relPath, local);
    writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("skips an uninspectable local VFS image for a valid fetched candidate", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("not a VFS image"),
    );
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("keeps skipping a stale local .wasm when a fetched ABI-matching candidate exists", () => {
    const relPath = fixtureRelPath(".wasm");
    const staleLocal = executableWasmWithAbi(ABI_VERSION - 1);
    const fetched = executableWasmWithAbi(ABI_VERSION);

    writeCandidate(localBinariesDir(), relPath, staleLocal);
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("skips an uninspectable local .wasm for a valid fetched candidate", () => {
    const relPath = fixtureRelPath(".wasm");
    const fetched = executableWasmWithAbi(ABI_VERSION);

    writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("not a Wasm module"),
    );
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("prefers a local declared runtime data file over the fetched candidate", () => {
    const relPath = fixtureRelPath(".dat");
    const localPath = writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("local-runtime"),
    );
    writeCandidate(
      binariesDir(),
      relPath,
      new TextEncoder().encode("fetched-runtime"),
    );

    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("returns null only for a genuinely absent scalar artifact", () => {
    const missing = fixtureRelPath(".dat");
    expect(tryResolveBinary(missing)).toBeNull();

    const rejected = fixtureRelPath(".wasm");
    writeCandidate(
      localBinariesDir(),
      rejected,
      new TextEncoder().encode("not a Wasm module"),
    );
    expect(() => tryResolveBinary(rejected)).toThrow(
      /exists but was rejected by artifact policy/,
    );

    const dangling = fixtureRelPath(".dat");
    const danglingPath = candidatePath(localBinariesDir(), dangling);
    mkdirSync(dirname(danglingPath), { recursive: true });
    symlinkSync(`${danglingPath}.missing-target`, danglingPath);
    expect(() => tryResolveBinary(dangling)).toThrow(
      /exists but was rejected by artifact policy/,
    );
  });
});

describe("binary resolver package closures", () => {
  it("rejects noncanonical path spellings at every public resolver entry", () => {
    const fixture = createMultiOutputFixture();
    const canonical = fixture.members[0]!.relPath;
    const packagePrefix = `programs/wasm32/${fixture.name}`;
    const aliases = [
      `${packagePrefix}/./image.zip`,
      `${packagePrefix}//image.zip`,
      `${packagePrefix}/../${fixture.name}/image.zip`,
      canonical.replaceAll("/", "\\"),
      `/absolute/${canonical}`,
      `C:/${canonical}`,
    ];

    for (const alias of aliases) {
      expect(() => programOutputClosureRelPaths(alias)).toThrow(
        /normalized portable relative path/,
      );
      expect(() => resolveBinary(alias)).toThrow(
        /normalized portable relative path/,
      );
      expect(() => tryResolveBinary(alias)).toThrow(
        /normalized portable relative path/,
      );
      expect(() => tryResolveBinarySet([alias])).toThrow(
        /normalized portable relative path/,
      );
    }
  });

  it("leaves a nested path with no registry package directory on the single-artifact path", () => {
    const name = fixturePackageName();
    const relPath = `programs/wasm32/${name}/standalone.dat`;
    cleanupDirs.add(join(localBinariesDir(), "programs", "wasm32", name));
    const localPath = writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("standalone"),
    );

    expect(programOutputClosureRelPaths(relPath)).toBeNull();
    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("matches Rust first-hit semantics by ignoring a directory without package.toml", () => {
    const name = fixturePackageName();
    mkdirSync(fixturePackageDirectory(name), { recursive: true });
    const relPath = `programs/wasm32/${name}/image.zip`;
    const localPath = writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("not-a-package"),
    );

    expect(programOutputClosureRelPaths(relPath)).toBeNull();
    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("matches Rust first-hit semantics when package.toml is not a file", () => {
    const name = fixturePackageName();
    const directory = fixturePackageDirectory(name);
    mkdirSync(join(directory, "package.toml"), { recursive: true });
    const relPath = `programs/wasm32/${name}/image.zip`;
    const localPath = writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("not-a-package"),
    );

    expect(programOutputClosureRelPaths(relPath)).toBeNull();
    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("does not parse an unrelated malformed manifest at runtime", () => {
    const malformedName = fixturePackageName();
    writeFixturePackageManifest(malformedName, `kind = "program"
name = "${malformedName}"
[[outputs]
name = "one"
wasm = "one.zip"
[[outputs]]
name = "two"
wasm = "two.zip"
`);
    const fixture = createMultiOutputFixture();
    expect(programOutputClosureRelPaths(fixture.members[0]!.relPath)).toEqual(
      fixture.members.map((member) => member.relPath),
    );
    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${malformedName}/one.zip`,
    )).toThrow(/absent from program-packages\.json/);

    const incompleteName = fixturePackageName();
    writeFixturePackageManifest(incompleteName, `kind = "program"
name = "${incompleteName}"
[[outputs]]
name = "one"
wasm = "one.zip"
[[outputs]]
name = "two"
`);
    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${incompleteName}/one.zip`,
    )).toThrow(/absent from program-packages\.json/);
  });

  it("discovers every output and runtime file in a multi-member package", () => {
    const fixture = createMultiOutputFixture();
    const expected = fixture.members.map((member) => member.relPath);

    for (const member of fixture.members) {
      expect(programOutputClosureRelPaths(member.relPath)).toEqual(expected);
    }
    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${fixture.name}/not-declared.zip`,
    )).toThrow(/is not a declared member of package/);
  });

  it("discovers Rust-valid package and output path components", () => {
    const name = `.binary resolver ${randomUUID()}`;
    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "image one"
wasm = "artifacts/image.zip"
[[outputs]]
name = ".bootstrap"
wasm = "support/bootstrap.zip"
`);
    writeFixturePackageProjection(name, [
      {
        kind: "output",
        sourceArtifact: "artifacts/image.zip",
        mirrorPath: `${name}/image one.zip`,
        outputName: "image one",
        forkInstrumentation: "auto",
      },
      {
        kind: "output",
        sourceArtifact: "support/bootstrap.zip",
        mirrorPath: `${name}/.bootstrap.zip`,
        outputName: ".bootstrap",
        forkInstrumentation: "auto",
      },
    ]);
    const members = [
      {
        relPath: `programs/wasm32/${name}/image one.zip`,
        sourceArtifact: "artifacts/image.zip",
      },
      {
        relPath: `programs/wasm32/${name}/.bootstrap.zip`,
        sourceArtifact: "support/bootstrap.zip",
      },
    ];
    for (const root of [localBinariesDir(), binariesDir()]) {
      cleanupDirs.add(join(root, "programs", "wasm32", name));
    }
    const canonicalRoot = fixtureCanonicalRoot(name);
    const targets = members.map((member) => realpathSync(
      linkClosureMember(binariesDir(), member, canonicalRoot),
    ));

    expect(programOutputClosureRelPaths(members[0]!.relPath)).toEqual(
      members.map((member) => member.relPath),
    );
    expect(resolveBinary(members[0]!.relPath)).toBe(targets[0]);
  });

  it("treats one output plus a runtime file as one package generation", () => {
    const name = fixturePackageName();
    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "${name}"
wasm = "${name}.wasm"
[[runtime_files]]
artifact = "share/runtime.dat"
guest_path = "/usr/share/runtime.dat"
`);
    writeFixturePackageProjection(name, [
      {
        kind: "output",
        sourceArtifact: `${name}.wasm`,
        mirrorPath: `${name}/${name}.wasm`,
        outputName: name,
        forkInstrumentation: "auto",
      },
      {
        kind: "runtime-file",
        sourceArtifact: "share/runtime.dat",
        mirrorPath: `${name}/share/runtime.dat`,
        guestPath: "/usr/share/runtime.dat",
        mode: 0o644,
      },
    ]);
    const members = [
      {
        relPath: `programs/wasm32/${name}/${name}.wasm`,
        sourceArtifact: `${name}.wasm`,
      },
      {
        relPath: `programs/wasm32/${name}/share/runtime.dat`,
        sourceArtifact: "share/runtime.dat",
      },
    ];
    for (const root of [localBinariesDir(), binariesDir()]) {
      cleanupDirs.add(join(root, "programs", "wasm32", name));
    }
    const canonicalRoot = fixtureCanonicalRoot(name);
    const targets = members.map((member, index) => {
      const mirror = linkClosureMember(
        binariesDir(),
        member,
        canonicalRoot,
        index === 0 ? executableWasmWithAbi(ABI_VERSION) : "runtime",
      );
      return realpathSync(mirror);
    });

    for (const member of members) {
      expect(programOutputClosureRelPaths(member.relPath)).toEqual(
        members.map((entry) => entry.relPath),
      );
    }
    expect(resolveBinary(members[0]!.relPath)).toBe(targets[0]);
    expect(tryResolveBinarySet(members.map((member) => member.relPath))).toEqual(
      targets,
    );

    const legacyFlatPath = `programs/wasm32/${name}.wasm`;
    expect(() => programOutputClosureRelPaths(legacyFlatPath)).toThrow(
      new RegExp(`Legacy flat resolver path.*${name}/${name}\\.wasm`),
    );
    expect(() => resolveBinary(legacyFlatPath)).toThrow(
      /Legacy flat resolver path/,
    );
    expect(() => tryResolveBinary(legacyFlatPath)).toThrow(
      /Legacy flat resolver path/,
    );
    expect(() => tryResolveBinarySet([legacyFlatPath])).toThrow(
      /Legacy flat resolver path/,
    );
    expect(() => programOutputClosureRelPaths(
      `programs/wasm64/${name}/${name}.wasm`,
    )).toThrow(/does not declare resolver artifacts for wasm64/);
  });

  it("rejects a stale nested directory after a package becomes scalar", () => {
    const name = fixturePackageName();
    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "${name}"
wasm = "${name}.wasm"
`);
    writeFixturePackageProjection(name, [
      {
        kind: "output",
        sourceArtifact: `${name}.wasm`,
        mirrorPath: `${name}.wasm`,
        outputName: name,
        forkInstrumentation: "auto",
      },
    ]);
    const staleNested = `programs/wasm32/${name}/${name}.wasm`;
    writeCandidate(
      localBinariesDir(),
      staleNested,
      executableWasmWithAbi(ABI_VERSION),
    );

    expect(() => programOutputClosureRelPaths(staleNested)).toThrow(
      /is not a declared member of package/,
    );
    expect(() => resolveBinary(staleNested)).toThrow(
      /is not a declared member of package/,
    );
  });

  it("fails a selected package when its generated projection is stale", () => {
    const fixture = createMultiOutputFixture();
    const manifestPath = join(
      fixtureRegistryRoot,
      fixture.name,
      "package.toml",
    );
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, "utf8")}\n# changed after projection\n`,
    );

    expect(() => programOutputClosureRelPaths(
      fixture.members[0]!.relPath,
    )).toThrow(/projection is stale/);
  });

  it("uses the requested arch when a scalar owner shares a legacy flat name", () => {
    const sharedOutput = `shared-${randomUUID()}`;
    const packageOwnedName = fixturePackageName();
    writeFixturePackageManifest(packageOwnedName, `kind = "program"
name = "${packageOwnedName}"
arches = ["wasm32", "wasm64"]
[[outputs]]
name = "${sharedOutput}"
wasm = "${sharedOutput}.wasm"
[[runtime_files]]
artifact = "share/runtime.dat"
guest_path = "/usr/share/runtime.dat"
`);
    writeFixturePackageProjection(
      packageOwnedName,
      [
        {
          kind: "output",
          sourceArtifact: `${sharedOutput}.wasm`,
          mirrorPath: `${packageOwnedName}/${sharedOutput}.wasm`,
          outputName: sharedOutput,
          forkInstrumentation: "auto",
        },
        {
          kind: "runtime-file",
          sourceArtifact: "share/runtime.dat",
          mirrorPath: `${packageOwnedName}/share/runtime.dat`,
          guestPath: "/usr/share/runtime.dat",
          mode: 0o644,
        },
      ],
      ["wasm32", "wasm64"],
    );
    const scalarName = fixturePackageName();
    writeFixturePackageManifest(scalarName, `kind = "program"
name = "${scalarName}"
arches = ["wasm32"]
[[outputs]]
name = "${sharedOutput}"
wasm = "${sharedOutput}.wasm"
`);
    writeFixturePackageProjection(scalarName, [
      {
        kind: "output",
        sourceArtifact: `${sharedOutput}.wasm`,
        mirrorPath: `${sharedOutput}.wasm`,
        outputName: sharedOutput,
        forkInstrumentation: "auto",
      },
    ]);

    expect(programOutputClosureRelPaths(
      `programs/wasm32/${sharedOutput}.wasm`,
    )).toEqual([`programs/wasm32/${sharedOutput}.wasm`]);
    expect(() => programOutputClosureRelPaths(
      `programs/wasm64/${sharedOutput}.wasm`,
    )).toThrow(/Legacy flat resolver path/);
  });

  it("does not merge a lower external registry over a first-hit package", () => {
    const name = fixturePackageName();
    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]
name = "broken"
wasm = "broken.wasm"
`);

    const lowerRoot = mkdtempSync(join(tmpdir(), "kandelo-lower-registry-"));
    cleanupDirs.add(lowerRoot);
    const lowerDirectory = join(lowerRoot, name);
    mkdirSync(lowerDirectory, { recursive: true });
    const lowerManifest = `kind = "program"
name = "${name}"
[[outputs]]
name = "lower"
wasm = "lower.wasm"
[[runtime_files]]
artifact = "share/lower.dat"
guest_path = "/share/lower.dat"
`;
    writeFileSync(join(lowerDirectory, "package.toml"), lowerManifest);
    writeFileSync(
      join(lowerRoot, "program-packages.json"),
      `${JSON.stringify({
        format: "kandelo-program-packages-v2",
        identities: {
          [name]: {
            manifestSha256: createHash("sha256")
              .update(lowerManifest)
              .digest("hex"),
            cacheKeys: {
              wasm32: fixtureCacheKey(name),
              wasm64: fixtureCacheKey(name, "wasm64"),
            },
          },
        },
        packages: {
          [name]: {
            manifestSha256: createHash("sha256")
              .update(lowerManifest)
              .digest("hex"),
            arches: ["wasm32"],
            cacheKeys: {
              wasm32: fixtureCacheKey(name),
            },
            dependencyClosures: { wasm32: [] },
            members: [
              {
                kind: "output",
                sourceArtifact: "lower.wasm",
                mirrorPath: `${name}/lower.wasm`,
                outputName: "lower",
                forkInstrumentation: "auto",
              },
              {
                kind: "runtime-file",
                sourceArtifact: "share/lower.dat",
                mirrorPath: `${name}/share/lower.dat`,
                guestPath: "/share/lower.dat",
                mode: 0o644,
              },
            ],
          },
        },
      }, null, 2)}\n`,
    );
    process.env.WASM_POSIX_DEPS_REGISTRY =
      `${fixtureRegistryRoot}:${lowerRoot}`;
    resetBinaryResolverManifestCacheForTests();

    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${name}/lower.wasm`,
    )).toThrow(/absent from program-packages\.json/);
  });

  it("keeps a shadowed lower scalar program path fail-closed", () => {
    const upperRoot = mkdtempSync(join(tmpdir(), "kandelo-upper-library-shadow-"));
    const lowerRoot = mkdtempSync(join(tmpdir(), "kandelo-lower-program-shadow-"));
    cleanupDirs.add(upperRoot);
    cleanupDirs.add(lowerRoot);
    const name = fixturePackageName();
    const outputName = `shadowed-${randomUUID()}`;
    const upperManifest = `kind = "library"
name = "${name}"
version = "1.0.0"
`;
    const lowerManifest = `kind = "program"
name = "${name}"
version = "1.0.0"
`;
    writeStandaloneRegistry(upperRoot, {
      [name]: {
        manifest: upperManifest,
        cacheKeys: {
          wasm32: "1".repeat(64),
          wasm64: "2".repeat(64),
        },
      },
    });
    writeStandaloneRegistry(lowerRoot, {
      [name]: {
        manifest: lowerManifest,
        cacheKeys: {
          wasm32: "3".repeat(64),
          wasm64: "4".repeat(64),
        },
        projection: {
          arches: ["wasm32"],
          dependencyClosures: { wasm32: [] },
          members: [{
            kind: "output",
            sourceArtifact: `${outputName}.wasm`,
            mirrorPath: `${outputName}.wasm`,
            outputName,
            forkInstrumentation: "auto",
          }],
        },
      },
    });
    process.env.WASM_POSIX_DEPS_REGISTRY = `${upperRoot}:${lowerRoot}`;
    const relPath = `programs/wasm32/${outputName}.wasm`;
    writeCandidate(
      binariesDir(),
      relPath,
      executableWasmWithAbi(ABI_VERSION),
    );

    expect(() => programOutputClosureRelPaths(relPath)).toThrow(
      /selected at .* but is absent from program-packages\.json/,
    );
    expect(() => resolveBinary(relPath)).toThrow(
      /selected at .* but is absent from program-packages\.json/,
    );
  });

  it("accepts identical first-hit shadows and an external program generated against external:main", () => {
    const upperRoot = mkdtempSync(join(tmpdir(), "kandelo-upper-context-"));
    const lowerRoot = mkdtempSync(join(tmpdir(), "kandelo-lower-context-"));
    cleanupDirs.add(upperRoot);
    cleanupDirs.add(lowerRoot);
    const contextId = randomUUID();
    const dependencyName = `z-context-dependency-${contextId}`;
    const auxiliaryName = `a-context-dependency-${contextId}`;
    const externalName = fixturePackageName();
    const lowerProgramName = fixturePackageName();
    const dependencyManifest = `kind = "library"
name = "${dependencyName}"
version = "1.0.0"
depends_on = []
`;
    const auxiliaryManifest = `kind = "source"
name = "${auxiliaryName}"
version = "1.0.0"
depends_on = []
`;
    const externalManifest = `kind = "program"
name = "${externalName}"
version = "1.0.0"
depends_on = ["${dependencyName}@1.0.0"]
`;
    const lowerProgramManifest = `kind = "program"
name = "${lowerProgramName}"
version = "1.0.0"
depends_on = ["${dependencyName}@1.0.0"]
`;
    const dependencyKeys = {
      wasm32: "1".repeat(64),
      wasm64: "2".repeat(64),
    };
    const expectedDependency = standaloneDependencyIdentity(
      dependencyName,
      dependencyManifest,
      dependencyKeys.wasm32,
    );
    const auxiliaryKeys = {
      wasm32: "7".repeat(64),
      wasm64: "8".repeat(64),
    };
    const expectedAuxiliary = standaloneDependencyIdentity(
      auxiliaryName,
      auxiliaryManifest,
      auxiliaryKeys.wasm32,
    );
    const scalarProjection = (
      packageName: string,
      dependencyClosures: Record<string, FixtureDependencyIdentity[]>,
    ) => ({
      arches: ["wasm32"] as Array<"wasm32">,
      dependencyClosures,
      members: [{
        kind: "output" as const,
        sourceArtifact: `${packageName}.wasm`,
        mirrorPath: `${packageName}.wasm`,
        outputName: packageName,
        forkInstrumentation: "auto" as const,
      }],
    });

    writeStandaloneRegistry(
      upperRoot,
      {
        [dependencyName]: {
          manifest: dependencyManifest,
          cacheKeys: dependencyKeys,
        },
        [auxiliaryName]: {
          manifest: auxiliaryManifest,
          cacheKeys: auxiliaryKeys,
        },
        [externalName]: {
          manifest: externalManifest,
          cacheKeys: {
            wasm32: "3".repeat(64),
            wasm64: "4".repeat(64),
          },
          projection: scalarProjection(externalName, {
            // Deliberately z-before-a: dependency order is non-semantic.
            wasm32: [expectedDependency, expectedAuxiliary],
          }),
        },
      },
      {
        [lowerProgramName]: {
          manifest: lowerProgramManifest,
          cacheKeys: {
            wasm32: "5".repeat(64),
            wasm64: "6".repeat(64),
          },
          projection: scalarProjection(lowerProgramName, {
            wasm32: [expectedDependency],
          }),
        },
      },
    );
    writeStandaloneRegistry(lowerRoot, {
      [dependencyName]: {
        manifest: dependencyManifest,
        cacheKeys: dependencyKeys,
      },
      [lowerProgramName]: {
        manifest: lowerProgramManifest,
        cacheKeys: {
          wasm32: "5".repeat(64),
          wasm64: "6".repeat(64),
        },
        projection: scalarProjection(lowerProgramName, {
          wasm32: [expectedDependency],
        }),
      },
    });
    process.env.WASM_POSIX_DEPS_REGISTRY = `${upperRoot}:${lowerRoot}`;

    expect(programOutputClosureRelPaths(
      `programs/wasm32/${externalName}.wasm`,
    )).toEqual([`programs/wasm32/${externalName}.wasm`]);
    expect(programOutputClosureRelPaths(
      `programs/wasm32/${lowerProgramName}.wasm`,
    )).toEqual([`programs/wasm32/${lowerProgramName}.wasm`]);
  });

  it("accepts an external program generated against a changed transitive external:main context", () => {
    const upperRoot = mkdtempSync(join(tmpdir(), "kandelo-upper-external-context-"));
    const lowerRoot = mkdtempSync(join(tmpdir(), "kandelo-lower-external-context-"));
    cleanupDirs.add(upperRoot);
    cleanupDirs.add(lowerRoot);
    const leafName = fixturePackageName();
    const middleName = fixturePackageName();
    const externalName = fixturePackageName();
    const lowerLeafManifest = `kind = "source"
name = "${leafName}"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/${leafName}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
`;
    const upperLeafManifest = lowerLeafManifest.replace(
      "0".repeat(64),
      "1".repeat(64),
    );
    const middleManifest = `kind = "library"
name = "${middleName}"
version = "1.0.0"
depends_on = ["${leafName}@1.0.0"]
`;
    const externalManifest = `kind = "program"
name = "${externalName}"
version = "1.0.0"
depends_on = ["${middleName}@1.0.0"]
`;
    const upperLeafKeys = {
      wasm32: "1".repeat(64),
      wasm64: "2".repeat(64),
    };
    const combinedMiddleKeys = {
      wasm32: "3".repeat(64),
      wasm64: "4".repeat(64),
    };
    const externalKeys = {
      wasm32: "5".repeat(64),
      wasm64: "6".repeat(64),
    };
    const expectedLeaf = standaloneDependencyIdentity(
      leafName,
      upperLeafManifest,
      upperLeafKeys.wasm32,
    );
    const expectedMiddle = standaloneDependencyIdentity(
      middleName,
      middleManifest,
      combinedMiddleKeys.wasm32,
    );
    writeStandaloneRegistry(
      upperRoot,
      {
        [leafName]: {
          manifest: upperLeafManifest,
          cacheKeys: upperLeafKeys,
        },
        [externalName]: {
          manifest: externalManifest,
          cacheKeys: externalKeys,
          projection: {
            arches: ["wasm32"],
            dependencyClosures: {
              wasm32: [expectedLeaf, expectedMiddle],
            },
            members: [{
              kind: "output",
              sourceArtifact: `${externalName}.wasm`,
              mirrorPath: `${externalName}.wasm`,
              outputName: externalName,
              forkInstrumentation: "auto",
            }],
          },
        },
      },
      {
        [middleName]: {
          manifest: middleManifest,
          cacheKeys: combinedMiddleKeys,
        },
      },
    );
    writeStandaloneRegistry(lowerRoot, {
      [leafName]: {
        manifest: lowerLeafManifest,
        cacheKeys: {
          wasm32: "7".repeat(64),
          wasm64: "8".repeat(64),
        },
      },
      [middleName]: {
        manifest: middleManifest,
        cacheKeys: {
          wasm32: "9".repeat(64),
          wasm64: "a".repeat(64),
        },
      },
    });
    process.env.WASM_POSIX_DEPS_REGISTRY = `${upperRoot}:${lowerRoot}`;

    expect(programOutputClosureRelPaths(
      `programs/wasm32/${externalName}.wasm`,
    )).toEqual([`programs/wasm32/${externalName}.wasm`]);

    writeFileSync(
      join(lowerRoot, middleName, "package.toml"),
      `${middleManifest}build_input = "changed-after-projection"\n`,
    );
    expect(() =>
      programOutputClosureRelPaths(`programs/wasm32/${externalName}.wasm`)
    ).toThrow(new RegExp(`identity is stale.*${middleName}`));
  });

  it("uses the complete top projection for a lower program whose direct dependency is overridden", () => {
    const upperRoot = mkdtempSync(join(tmpdir(), "kandelo-upper-direct-shadow-"));
    const lowerRoot = mkdtempSync(join(tmpdir(), "kandelo-lower-direct-shadow-"));
    cleanupDirs.add(upperRoot);
    cleanupDirs.add(lowerRoot);
    const dependencyName = fixturePackageName();
    const programName = fixturePackageName();
    const lowerDependencyManifest = `kind = "library"
name = "${dependencyName}"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/${dependencyName}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
`;
    const upperDependencyManifest = lowerDependencyManifest.replace(
      "0".repeat(64),
      "1".repeat(64),
    );
    const programManifest = `kind = "program"
name = "${programName}"
version = "1.0.0"
depends_on = ["${dependencyName}@1.0.0"]
`;
    const upperDependencyIdentity = standaloneDependencyIdentity(
      dependencyName,
      upperDependencyManifest,
      "7".repeat(64),
    );
    const programProjection = (
      dependency: FixtureDependencyIdentity,
    ): StandaloneRegistryEntry["projection"] => ({
      arches: ["wasm32"],
      dependencyClosures: { wasm32: [dependency] },
      members: [{
        kind: "output",
        sourceArtifact: `${programName}.wasm`,
        mirrorPath: `${programName}.wasm`,
        outputName: programName,
        forkInstrumentation: "auto",
      }],
    });
    writeStandaloneRegistry(
      upperRoot,
      {
        [dependencyName]: {
          manifest: upperDependencyManifest,
          cacheKeys: {
            wasm32: "7".repeat(64),
            wasm64: "8".repeat(64),
          },
        },
      },
      {
        [programName]: {
          manifest: programManifest,
          cacheKeys: {
            wasm32: "d".repeat(64),
            wasm64: "e".repeat(64),
          },
          projection: programProjection(upperDependencyIdentity),
        },
      },
    );
    writeStandaloneRegistry(lowerRoot, {
      [dependencyName]: {
        manifest: lowerDependencyManifest,
        cacheKeys: {
          wasm32: "9".repeat(64),
          wasm64: "a".repeat(64),
        },
      },
      [programName]: {
        manifest: programManifest,
        cacheKeys: {
          wasm32: "b".repeat(64),
          wasm64: "c".repeat(64),
        },
        projection: programProjection(standaloneDependencyIdentity(
          dependencyName,
          lowerDependencyManifest,
          "9".repeat(64),
        )),
      },
    });
    process.env.WASM_POSIX_DEPS_REGISTRY = `${upperRoot}:${lowerRoot}`;

    expect(programOutputClosureRelPaths(
      `programs/wasm32/${programName}.wasm`,
    )).toEqual([`programs/wasm32/${programName}.wasm`]);

    process.env.WASM_POSIX_DEPS_REGISTRY = lowerRoot;
    expect(programOutputClosureRelPaths(
      `programs/wasm32/${programName}.wasm`,
    )).toEqual([`programs/wasm32/${programName}.wasm`]);
  });

  it("uses the complete top projection when a lower program's transitive dependency is overridden", () => {
    const upperRoot = mkdtempSync(join(tmpdir(), "kandelo-upper-transitive-shadow-"));
    const lowerRoot = mkdtempSync(join(tmpdir(), "kandelo-lower-transitive-shadow-"));
    cleanupDirs.add(upperRoot);
    cleanupDirs.add(lowerRoot);
    const leafName = fixturePackageName();
    const intermediateName = fixturePackageName();
    const programName = fixturePackageName();
    const lowerLeafManifest = `kind = "source"
name = "${leafName}"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/${leafName}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
`;
    const upperLeafManifest = lowerLeafManifest.replace(
      "0".repeat(64),
      "1".repeat(64),
    );
    const intermediateManifest = `kind = "library"
name = "${intermediateName}"
version = "1.0.0"
depends_on = ["${leafName}@1.0.0"]
`;
    const programManifest = `kind = "program"
name = "${programName}"
version = "1.0.0"
depends_on = ["${intermediateName}@1.0.0"]
`;
    const lowerLeafIdentity = standaloneDependencyIdentity(
      leafName,
      lowerLeafManifest,
      "d".repeat(64),
    );
    const intermediateIdentity = standaloneDependencyIdentity(
      intermediateName,
      intermediateManifest,
      "e".repeat(64),
    );
    const combinedLeafIdentity = standaloneDependencyIdentity(
      leafName,
      upperLeafManifest,
      "f".repeat(64),
    );
    const combinedIntermediateIdentity = standaloneDependencyIdentity(
      intermediateName,
      intermediateManifest,
      "4".repeat(64),
    );
    const programMembers: FixtureProjectionMember[] = [{
      kind: "output",
      sourceArtifact: `${programName}.wasm`,
      mirrorPath: `${programName}.wasm`,
      outputName: programName,
      forkInstrumentation: "auto",
    }];
    writeStandaloneRegistry(
      upperRoot,
      {
        [leafName]: {
          manifest: upperLeafManifest,
          cacheKeys: {
            wasm32: "f".repeat(64),
            wasm64: "f".repeat(64),
          },
        },
      },
      {
        [intermediateName]: {
          manifest: intermediateManifest,
          cacheKeys: {
            wasm32: "4".repeat(64),
            wasm64: "5".repeat(64),
          },
        },
        [programName]: {
          manifest: programManifest,
          cacheKeys: {
            wasm32: "6".repeat(64),
            wasm64: "7".repeat(64),
          },
          projection: {
            arches: ["wasm32"],
            dependencyClosures: {
              wasm32: [
                combinedIntermediateIdentity,
                combinedLeafIdentity,
              ].sort(
                (left, right) =>
                  left.packageName.localeCompare(right.packageName),
              ),
            },
            members: programMembers,
          },
        },
      },
    );
    writeStandaloneRegistry(lowerRoot, {
      [leafName]: {
        manifest: lowerLeafManifest,
        cacheKeys: {
          wasm32: lowerLeafIdentity.cacheKey,
          wasm64: lowerLeafIdentity.cacheKey,
        },
      },
      [intermediateName]: {
        manifest: intermediateManifest,
        cacheKeys: {
          wasm32: intermediateIdentity.cacheKey,
          wasm64: "1".repeat(64),
        },
      },
      [programName]: {
        manifest: programManifest,
        cacheKeys: {
          wasm32: "2".repeat(64),
          wasm64: "3".repeat(64),
        },
        projection: {
          arches: ["wasm32"],
          dependencyClosures: {
            wasm32: [intermediateIdentity, lowerLeafIdentity].sort(
              (left, right) => left.packageName.localeCompare(right.packageName),
            ),
          },
          members: programMembers,
        },
      },
    });
    process.env.WASM_POSIX_DEPS_REGISTRY = `${upperRoot}:${lowerRoot}`;

    expect(programOutputClosureRelPaths(
      `programs/wasm32/${programName}.wasm`,
    )).toEqual([`programs/wasm32/${programName}.wasm`]);
  });

  it("rejects unknown projection fields instead of widening the policy schema", () => {
    const name = fixturePackageName();
    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "${name}"
wasm = "${name}.wasm"
`);
    writeFixturePackageProjection(name, [{
      kind: "output",
      sourceArtifact: `${name}.wasm`,
      mirrorPath: `${name}.wasm`,
      outputName: name,
      forkInstrumentation: "auto",
    }]);
    const projected = fixtureRegistryPackages[name] as Record<string, unknown>;
    projected.unreviewedPolicy = true;
    writeFixtureRegistryIndex();

    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${name}.wasm`,
    )).toThrow(/malformed package/);
  });

  it("rejects a projection that invents a noncanonical scalar mirror layout", () => {
    const name = fixturePackageName();
    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "${name}"
wasm = "${name}.wasm"
`);
    writeFixturePackageProjection(name, [{
      kind: "output",
      sourceArtifact: `${name}.wasm`,
      mirrorPath: `${name}/${name}.wasm`,
      outputName: name,
      forkInstrumentation: "auto",
    }]);

    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${name}/${name}.wasm`,
    )).toThrow(/violate scalar\/package-directory layout/);
  });

  it("observes package additions and shape changes without a process restart", () => {
    const name = fixturePackageName();
    const nested = `programs/wasm32/${name}/first.wasm`;
    expect(programOutputClosureRelPaths(nested)).toBeNull();

    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "first"
wasm = "first.wasm"
[[outputs]]
name = "second"
wasm = "second.wasm"
`);
    writeFixturePackageProjection(name, [
      {
        kind: "output",
        sourceArtifact: "first.wasm",
        mirrorPath: `${name}/first.wasm`,
        outputName: "first",
        forkInstrumentation: "auto",
      },
      {
        kind: "output",
        sourceArtifact: "second.wasm",
        mirrorPath: `${name}/second.wasm`,
        outputName: "second",
        forkInstrumentation: "auto",
      },
    ]);
    expect(programOutputClosureRelPaths(nested)).toEqual([
      nested,
      `programs/wasm32/${name}/second.wasm`,
    ]);

    writeFixturePackageManifest(name, `kind = "program"
name = "${name}"
[[outputs]]
name = "first"
wasm = "first.wasm"
`);
    writeFixturePackageProjection(name, [{
      kind: "output",
      sourceArtifact: "first.wasm",
      mirrorPath: "first.wasm",
      outputName: "first",
      forkInstrumentation: "auto",
    }]);
    expect(() => programOutputClosureRelPaths(nested)).toThrow(
      /not a declared member/,
    );
    expect(programOutputClosureRelPaths(
      "programs/wasm32/first.wasm",
    )).toEqual(["programs/wasm32/first.wasm"]);
  });

  it("rejects cross-package file and package-directory mirror collisions", () => {
    const scalarName = fixturePackageName();
    const directoryName = fixturePackageName();
    writeFixturePackageManifest(scalarName, `kind = "program"
name = "${scalarName}"
[[outputs]]
name = "${directoryName}"
wasm = "artifact"
`);
    writeFixturePackageProjection(scalarName, [{
      kind: "output",
      sourceArtifact: "artifact",
      mirrorPath: directoryName,
      outputName: directoryName,
      forkInstrumentation: "auto",
    }]);
    writeFixturePackageManifest(directoryName, `kind = "program"
name = "${directoryName}"
[[outputs]]
name = "first"
wasm = "first.wasm"
[[outputs]]
name = "second"
wasm = "second.wasm"
`);
    writeFixturePackageProjection(directoryName, [
      {
        kind: "output",
        sourceArtifact: "first.wasm",
        mirrorPath: `${directoryName}/first.wasm`,
        outputName: "first",
        forkInstrumentation: "auto",
      },
      {
        kind: "output",
        sourceArtifact: "second.wasm",
        mirrorPath: `${directoryName}/second.wasm`,
        outputName: "second",
        forkInstrumentation: "auto",
      },
    ]);

    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${directoryName}/first.wasm`,
    )).toThrow(/conflict between selected packages/);
  });

  it("accepts Rust-valid literal-string metadata through the generated projection", () => {
    const name = fixturePackageName();
    writeFixturePackageManifest(name, `kind = 'program'
name = '${name}'
[[outputs]]
name = '${name}'
wasm = '${name}.wasm'
[[runtime_files]]
artifact = 'share/runtime.dat'
guest_path = '/usr/share/runtime.dat'
`);
    writeFixturePackageProjection(name, [
      {
        kind: "output",
        sourceArtifact: `${name}.wasm`,
        mirrorPath: `${name}/${name}.wasm`,
        outputName: name,
        forkInstrumentation: "auto",
      },
      {
        kind: "runtime-file",
        sourceArtifact: "share/runtime.dat",
        mirrorPath: `${name}/share/runtime.dat`,
        guestPath: "/usr/share/runtime.dat",
        mode: 0o644,
      },
    ]);

    const nested = `programs/wasm32/${name}/${name}.wasm`;
    expect(programOutputClosureRelPaths(nested)).toEqual([
      nested,
      `programs/wasm32/${name}/share/runtime.dat`,
    ]);
    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${name}.wasm`,
    )).toThrow(/Legacy flat resolver path/);
  });

  it("accepts mirror symlinks that all target one canonical generation", () => {
    const fixture = createMultiOutputFixture();
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const mirrors = fixture.members.map((member) =>
      linkClosureMember(binariesDir(), member, canonicalRoot)
    );

    const targets = mirrors.map((mirror) => realpathSync(mirror));
    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(targets[0]);
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(targets);

    const localCanonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    const localMirrors = fixture.members.map((member) => {
      const target = writeCanonicalMember(
        localCanonicalRoot,
        member.sourceArtifact,
        `local:${member.relPath}`,
      );
      const mirror = join(localBinariesDir(), member.relPath);
      mkdirSync(dirname(mirror), { recursive: true });
      symlinkSync(relative(dirname(mirror), target), mirror);
      return mirror;
    });
    const localTargets = localMirrors.map((mirror) => realpathSync(mirror));
    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(localTargets[0]);
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(localTargets);
  });

  it("shares an explicit package cache root with archive-stage consumers", () => {
    const explicitCacheRoot = mkdtempSync(
      join(tmpdir(), "kandelo-explicit-package-cache-"),
    );
    cleanupDirs.add(explicitCacheRoot);
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = explicitCacheRoot;
    const fixture = createMultiOutputFixture();
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const mirrors = fixture.members.map((member) =>
      linkClosureMember(binariesDir(), member, canonicalRoot)
    );
    const targets = mirrors.map((mirror) => realpathSync(mirror));

    expect(binaryProgramCacheRoot()).toBe(join(explicitCacheRoot, "programs"));
    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(targets[0]);
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(targets);
  });

  it("accepts a relocated prepared workspace with relative links into one package generation", () => {
    const relocatedRepo = mkdtempSync(
      join(tmpdir(), "kandelo-relocated-test-workspace-"),
    );
    cleanupDirs.add(relocatedRepo);
    writeFileSync(
      join(relocatedRepo, "Cargo.toml"),
      "[workspace]\nmembers = []\n",
    );
    writeFileSync(
      join(relocatedRepo, "package.json"),
      '{"name":"kandelo","private":true}\n',
    );
    process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT = relocatedRepo;
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = ".ci-test-binary-cache";

    const fixture = createMultiOutputFixture();
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const mirrors = fixture.members.map((member) => {
      const target = writeCanonicalMember(
        canonicalRoot,
        member.sourceArtifact,
        member.relPath,
      );
      const mirror = join(binariesDir(), member.relPath);
      mkdirSync(dirname(mirror), { recursive: true });
      symlinkSync(relative(dirname(mirror), target), mirror);
      return mirror;
    });
    const targets = mirrors.map((mirror) => realpathSync(mirror));

    expect(binaryProgramCacheRoot()).toBe(
      join(relocatedRepo, ".ci-test-binary-cache", "programs"),
    );
    expect(
      mirrors.map((mirror) => readlinkSync(mirror).startsWith("/")),
    ).toEqual(mirrors.map(() => false));
    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(targets[0]);
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(targets);
  });

  it("resolves one complete package after its prepared workspace archive is relocated", () => {
    const sourceRepo = mkdtempSync(
      join(tmpdir(), "kandelo-test-workspace-source-"),
    );
    const relocatedRepo = mkdtempSync(
      join(tmpdir(), "kandelo-test-workspace-relocated-"),
    );
    const sourceCache = mkdtempSync(
      join(tmpdir(), "kandelo-test-workspace-cache-"),
    );
    cleanupDirs.add(sourceRepo);
    cleanupDirs.add(relocatedRepo);
    cleanupDirs.add(sourceCache);

    const actualRepo = findRepoRoot();
    const packer = join(sourceRepo, "scripts", "pack-ci-test-workspace.sh");
    mkdirSync(dirname(packer), { recursive: true });
    copyFileSync(
      join(actualRepo, "scripts", "pack-ci-test-workspace.sh"),
      packer,
    );
    chmodSync(packer, 0o755);

    const fakeBin = join(sourceRepo, "fixture-bin");
    mkdirSync(fakeBin, { recursive: true });
    const rustc = join(fakeBin, "rustc");
    writeFileSync(
      rustc,
      "#!/bin/sh\n[ \"${1:-}\" = -vV ] && printf 'host: fixture-host\\n'\n",
    );
    chmodSync(rustc, 0o755);
    const xtask = join(
      sourceRepo,
      "target",
      "fixture-host",
      "release",
      "xtask",
    );
    mkdirSync(dirname(xtask), { recursive: true });
    writeFileSync(
      xtask,
      `#!/bin/sh
if [ "\${1:-}" = build-deps ] && [ "\${2:-}" = cache-root ] && [ "$#" -eq 2 ]; then
  printf '%s\\n' "$WASM_POSIX_BINARY_CACHE_ROOT"
  exit 0
fi
exit 2
`,
    );
    chmodSync(xtask, 0o755);

    for (const relPath of [
      "local-binaries/kernel.wasm",
      "host/wasm/rootfs.vfs",
      "examples/gencat.wasm",
      "examples/pthread_channel_reuse_test.wasm",
      "examples/wait_lifecycle_test.wasm",
      "examples/wait_lifecycle_test.wasm64.wasm",
      "examples/terminal_attributes_api_test.wasm64.wasm",
      "benchmarks/wasm/pipe-throughput.wasm",
      "benchmarks/wasm/file-throughput.wasm",
      "benchmarks/wasm/syscall-latency.wasm",
      "benchmarks/wasm/fork-bench.wasm",
      "benchmarks/wasm/clone-bench.wasm",
      "benchmarks/wasm/spawn-bench.wasm",
      "benchmarks/wasm/hello.wasm",
    ]) {
      const path = join(sourceRepo, relPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, relPath);
    }

    const fixture = createMultiOutputFixture();
    const cacheKey = fixtureCacheKey(fixture.name);
    const generation = join(
      sourceCache,
      "programs",
      `${fixture.name}-1.0.0-rev1-wasm32-${cacheKey}`,
    );
    const originalTargets: string[] = [];
    for (const member of fixture.members) {
      const target = writeCanonicalMember(
        generation,
        member.sourceArtifact,
        member.relPath,
      );
      const mirror = join(sourceRepo, "binaries", member.relPath);
      mkdirSync(dirname(mirror), { recursive: true });
      symlinkSync(target, mirror);
      originalTargets.push(target);
    }

    const archive = join(sourceRepo, "prepared-workspace.tar.zst");
    execFileSync("bash", [packer, archive], {
      cwd: sourceRepo,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        WASM_POSIX_BINARY_CACHE_ROOT: sourceCache,
      },
      stdio: "pipe",
    });
    writeFileSync(
      join(relocatedRepo, "Cargo.toml"),
      "[workspace]\nmembers = []\n",
    );
    writeFileSync(
      join(relocatedRepo, "package.json"),
      '{"name":"kandelo","private":true}\n',
    );
    execFileSync(
      "tar",
      ["--zstd", "-xf", archive, "-C", relocatedRepo],
      { stdio: "pipe" },
    );

    process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT = relocatedRepo;
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = ".ci-test-binary-cache";
    const relocatedMirrors = fixture.members.map((member) =>
      join(relocatedRepo, "binaries", member.relPath)
    );
    expect(
      relocatedMirrors.map((mirror) => readlinkSync(mirror).startsWith("/")),
    ).toEqual(relocatedMirrors.map(() => false));

    const relocatedTargets = relocatedMirrors.map((mirror) =>
      realpathSync(mirror)
    );
    const portablePrograms = realpathSync(join(
      relocatedRepo,
      ".ci-test-binary-cache",
      "programs",
    ));
    expect(relocatedTargets.every((target) =>
      target.startsWith(`${portablePrograms}/`)
    )).toBe(true);
    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(
      relocatedTargets[0],
    );
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(relocatedTargets);
    expect(originalTargets).not.toEqual(relocatedTargets);
  });

  it("anchors a relative explicit package cache at the Kandelo repository", () => {
    const relativeRoot = `.test-package-cache-${randomUUID()}`;
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = relativeRoot;
    expect(binaryProgramCacheRoot()).toBe(
      join(findRepoRoot(), relativeRoot, "programs"),
    );
  });

  it("anchors a relative registry root at Kandelo even from an app cwd", () => {
    const repo = findRepoRoot();
    const relativeRoot = `.test-program-registry-${randomUUID()}`;
    const registryRoot = join(repo, relativeRoot);
    cleanupDirs.add(registryRoot);
    const savedFixtureRoot = fixtureRegistryRoot;
    const savedFixturePackages = fixtureRegistryPackages;
    const savedCwd = process.cwd();
    try {
      fixtureRegistryRoot = registryRoot;
      fixtureRegistryPackages = {};
      mkdirSync(registryRoot, { recursive: true });
      writeFixtureRegistryIndex();
      const fixture = createScalarOutputFixture();
      process.env.WASM_POSIX_DEPS_REGISTRY = relativeRoot;
      process.chdir(join(repo, "apps", "browser-demos"));
      const canonicalRoot = fixtureCanonicalRoot(fixture.name);
      const mirror = linkClosureMember(
        binariesDir(),
        fixture,
        canonicalRoot,
        executableWasmWithAbi(ABI_VERSION),
      );

      expect(relative(repo, mirror)).toContain("binaries/programs/wasm32/");
      expect(resolveBinary(fixture.relPath)).toBe(realpathSync(mirror));
    } finally {
      process.chdir(savedCwd);
      fixtureRegistryRoot = savedFixtureRoot;
      fixtureRegistryPackages = savedFixturePackages;
    }
  });

  it("binds a fetched scalar output to its projected package and cache identity", () => {
    const fixture = createScalarOutputFixture();
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const mirror = linkClosureMember(
      binariesDir(),
      fixture,
      canonicalRoot,
      executableWasmWithAbi(ABI_VERSION),
    );

    expect(programOutputClosureRelPaths(fixture.relPath)).toEqual([
      fixture.relPath,
    ]);
    expect(resolveBinary(fixture.relPath)).toBe(realpathSync(mirror));
  });

  it("binds a local scalar output to its projected package and cache identity", () => {
    const fixture = createScalarOutputFixture();
    const canonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    const mirror = linkClosureMember(
      localBinariesDir(),
      fixture,
      canonicalRoot,
      executableWasmWithAbi(ABI_VERSION),
    );

    expect(resolveBinary(fixture.relPath)).toBe(realpathSync(mirror));
  });

  it("rejects stale fetched and local scalar generations after a recipe switch", () => {
    const fixture = createScalarOutputFixture();
    const oldCacheKey = fixtureCacheKey(fixture.name);
    const fetchedRoot = fixtureCanonicalRoot(
      fixture.name,
      "wasm32",
      oldCacheKey,
    );
    const localRoot = fixtureLocalCanonicalRoot(
      fixture.name,
      "wasm32",
      oldCacheKey,
    );
    linkClosureMember(
      binariesDir(),
      fixture,
      fetchedRoot,
      executableWasmWithAbi(ABI_VERSION),
    );
    linkClosureMember(
      localBinariesDir(),
      fixture,
      localRoot,
      executableWasmWithAbi(ABI_VERSION),
    );

    const outputName = fixture.relPath.split("/").at(-1)!.replace(/\.wasm$/, "");
    writeFixturePackageManifest(fixture.name, `kind = "program"
name = "${fixture.name}"
version = "2.0.0"
kernel_abi = ${ABI_VERSION}
depends_on = []
[source]
url = "https://example.invalid/${fixture.name}-v2.tar.gz"
sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
[license]
spdx = "MIT"
[[outputs]]
name = "${outputName}"
wasm = "${fixture.sourceArtifact}"
`);
    const newCacheKey = "b".repeat(64);
    writeFixturePackageProjection(
      fixture.name,
      [{
        kind: "output",
        sourceArtifact: fixture.sourceArtifact,
        mirrorPath: `${outputName}.wasm`,
        outputName,
        forkInstrumentation: "auto",
      }],
      ["wasm32"],
      { wasm32: newCacheKey },
    );

    expect(() => resolveBinary(fixture.relPath)).toThrow(
      /shared package identity rejected/,
    );
    expect(() => tryResolveBinarySet([fixture.relPath])).toThrow(
      /shared package identity rejected/,
    );
  });

  it("rejects resolver-owned scalar links after their output is renamed", () => {
    const fixture = createScalarOutputFixture();
    const fetchedRoot = fixtureCanonicalRoot(fixture.name);
    const localRoot = fixtureLocalCanonicalRoot(fixture.name);
    const localMirror = linkClosureMember(
      localBinariesDir(),
      fixture,
      localRoot,
      executableWasmWithAbi(ABI_VERSION),
    );
    linkClosureMember(
      binariesDir(),
      fixture,
      fetchedRoot,
      executableWasmWithAbi(ABI_VERSION),
    );

    const renamedOutput = `renamed-${randomUUID()}`;
    writeFixturePackageManifest(fixture.name, `kind = "program"
name = "${fixture.name}"
version = "2.0.0"
depends_on = []
[source]
url = "https://example.invalid/${fixture.name}-v2.tar.gz"
sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
[license]
spdx = "MIT"
[[outputs]]
name = "${renamedOutput}"
wasm = "bin/${renamedOutput}.zip"
`);
    writeFixturePackageProjection(fixture.name, [{
      kind: "output",
      sourceArtifact: `bin/${renamedOutput}.zip`,
      mirrorPath: `${renamedOutput}.zip`,
      outputName: renamedOutput,
      forkInstrumentation: "auto",
    }]);

    expect(() => resolveBinary(fixture.relPath)).toThrow(
      /resolver-owned program generation has no matching selected package projection/,
    );
    rmSync(localMirror);
    expect(() => resolveBinary(fixture.relPath)).toThrow(
      /resolver-owned program generation has no matching selected package projection/,
    );
  });

  it("accepts local mirrors only from one direct immutable local generation", () => {
    const fixture = createMultiOutputFixture();
    const canonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    const mirrors = fixture.members.map((member) =>
      linkClosureMember(localBinariesDir(), member, canonicalRoot)
    );
    const targets = mirrors.map((mirror) => realpathSync(mirror));

    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(targets[0]);
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(targets);
  });

  it("rejects stale fetched and local multi-member cache identities", () => {
    const fixture = createMultiOutputFixture();
    const wrongCacheKey = "c".repeat(64);
    const fetchedRoot = fixtureCanonicalRoot(
      fixture.name,
      "wasm32",
      wrongCacheKey,
    );
    const localRoot = fixtureLocalCanonicalRoot(
      fixture.name,
      "wasm32",
      wrongCacheKey,
    );
    for (const member of fixture.members) {
      linkClosureMember(binariesDir(), member, fetchedRoot);
      linkClosureMember(localBinariesDir(), member, localRoot);
    }

    expect(() => resolveBinary(fixture.members[0]!.relPath)).toThrow(
      /shared package identity rejected/,
    );
  });

  it("rejects fetched mirrors whose target is outside the canonical program cache", () => {
    const fixture = createMultiOutputFixture();
    const arbitraryRoot = fixtureArbitraryRoot();
    for (const member of fixture.members) {
      linkClosureMember(binariesDir(), member, arbitraryRoot);
    }

    expect(() => resolveBinary(fixture.members[0]!.relPath)).toThrow(
      /fetched mirror targets are not one canonical program-cache generation/,
    );
  });

  it("pins canonical member paths across a concurrent live-directory swap", () => {
    const fixture = createMultiOutputFixture();
    const oldCanonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    const oldMirrors = fixture.members.map((member) =>
      linkClosureMember(
        localBinariesDir(),
        member,
        oldCanonicalRoot,
        "generation",
      )
    );
    const pinned = tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    );
    expect(pinned).toEqual(oldMirrors.map((mirror) => realpathSync(mirror)));

    const newCanonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    const liveDirectory = join(
      localBinariesDir(),
      "programs",
      "wasm32",
      fixture.name,
    );
    const stagedDirectory = `${liveDirectory}.test-stage-${randomUUID()}`;
    cleanupDirs.add(stagedDirectory);
    const newTargets: string[] = [];
    for (const member of fixture.members) {
      const target = writeCanonicalMember(
        newCanonicalRoot,
        member.sourceArtifact,
        "generation",
      );
      newTargets.push(target);
      const packageRelative = member.relPath.split("/").slice(3).join("/");
      const mirror = join(stagedDirectory, packageRelative);
      mkdirSync(dirname(mirror), { recursive: true });
      symlinkSync(target, mirror);
    }
    const backupDirectory = `${liveDirectory}.test-backup-${randomUUID()}`;
    cleanupDirs.add(backupDirectory);
    renameSync(liveDirectory, backupDirectory);
    renameSync(stagedDirectory, liveDirectory);

    expect(pinned).toEqual(
      fixture.members.map((member) =>
        join(oldCanonicalRoot, ...member.sourceArtifact.split("/"))
      ),
    );
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toEqual(newTargets);
  });

  it("uses the whole fetched closure when a local runtime member is absent", () => {
    const fixture = createMultiOutputFixture();
    writeCandidate(
      localBinariesDir(),
      fixture.members[0]!.relPath,
      new TextEncoder().encode("partial-local-output"),
    );
    writeCandidate(
      localBinariesDir(),
      fixture.members[1]!.relPath,
      new TextEncoder().encode("partial-local-output"),
    );
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const fetched = fixture.members.map((member) =>
      linkClosureMember(binariesDir(), member, canonicalRoot)
    );

    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(
      realpathSync(fetched[0]!),
    );
  });

  it("rejects preexisting same-tier symlinks into different canonical generations", () => {
    const fixture = createMultiOutputFixture();
    const firstCanonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    const secondCanonicalRoot = fixtureLocalCanonicalRoot(fixture.name);
    linkClosureMember(
      localBinariesDir(),
      fixture.members[0]!,
      firstCanonicalRoot,
    );
    for (const member of fixture.members.slice(1)) {
      linkClosureMember(localBinariesDir(), member, secondCanonicalRoot);
    }

    expect(() => resolveBinary(fixture.members[0]!.relPath)).toThrow(
      /shared package identity rejected: member symlinks target different canonical package generations/,
    );
  });

  it("requires each cache symlink to end in its declared source artifact path", () => {
    const fixture = createMultiOutputFixture();
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const firstMirror = linkClosureMember(
      binariesDir(),
      fixture.members[0]!,
      canonicalRoot,
    );
    rmSync(firstMirror);
    symlinkSync(
      writeCanonicalMember(
        canonicalRoot,
        "wrong/image.zip",
        "wrong-source-path",
      ),
      firstMirror,
    );
    for (const member of fixture.members.slice(1)) {
      linkClosureMember(binariesDir(), member, canonicalRoot);
    }

    expect(() => resolveBinary(fixture.members[0]!.relPath)).toThrow(
      /does not target its declared source artifact artifacts\/image\.zip/,
    );
  });

  it("skips mutable real-file closures because they have no shared cache identity", () => {
    const fixture = createMultiOutputFixture();
    for (const member of fixture.members) {
      writeCandidate(
        localBinariesDir(),
        member.relPath,
        new TextEncoder().encode("unidentified-local-copy"),
      );
    }
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    const fetched = fixture.members.map((member) =>
      linkClosureMember(binariesDir(), member, canonicalRoot)
    );

    expect(resolveBinary(fixture.members[0]!.relPath)).toBe(
      realpathSync(fetched[0]!),
    );
  });

  it("does not treat mutable source-checkout wasm files as an installed package identity", () => {
    const fixture = createMultiOutputFixture();
    const installedRoot = join(findRepoRoot(), "host", "wasm");
    fixture.members.map((member) =>
      writeCandidate(
        installedRoot,
        member.relPath,
        new TextEncoder().encode("installed-package-member"),
      )
    );

    expect(() => resolveBinary(fixture.members[1]!.relPath)).toThrow(
      /mutable source-checkout wasm tree/,
    );
  });

  it("rejects mixed files and symlinks in the installed package identity", () => {
    const fixture = createMultiOutputFixture();
    const installedRoot = join(findRepoRoot(), "host", "wasm");
    writeCandidate(
      installedRoot,
      fixture.members[0]!.relPath,
      new TextEncoder().encode("installed-package-member"),
    );
    const canonicalRoot = fixtureCanonicalRoot(fixture.name);
    for (const member of fixture.members.slice(1)) {
      linkClosureMember(installedRoot, member, canonicalRoot);
    }

    expect(() => resolveBinary(fixture.members[0]!.relPath)).toThrow(
      /regular files and symlinks cannot share one package identity/,
    );
  });

  it("requires explicit set callers to request the complete package closure", () => {
    const fixture = createMultiOutputFixture();
    expect(() => tryResolveBinarySet([
      fixture.members[0]!.relPath,
      fixture.members[1]!.relPath,
    ])).toThrow(/must resolve its complete declared closure/);
  });

  it("does not let an independent batch weaken package closure identity", () => {
    const fixture = createMultiOutputFixture();
    writeCandidate(
      localBinariesDir(),
      fixture.members[0]!.relPath,
      new TextEncoder().encode("partial-local-output"),
    );

    expect(() => tryResolveBinaries([fixture.members[0]!.relPath])).toThrow(
      /Package artifact closure is incomplete/,
    );
  });

  it("keeps an absent package-owned member on the package lookup path", () => {
    const fixture = createMultiOutputFixture();
    expect(tryResolveBinary(fixture.members[0]!.relPath)).toBeNull();
    expect(() => resolveBinary(fixture.members[0]!.relPath)).toThrow(
      new RegExp(`Package artifacts not found for ${fixture.name}`),
    );
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toBeNull();
  });

  it("does not report an empty or dangling package mirror as absent", () => {
    const fixture = createMultiOutputFixture();
    const liveDirectory = join(
      localBinariesDir(),
      "programs",
      "wasm32",
      fixture.name,
    );
    mkdirSync(liveDirectory, { recursive: true });

    expect(() => tryResolveBinary(fixture.members[0]!.relPath)).toThrow(
      /Package artifact closure is incomplete/,
    );
    expect(() => tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )).toThrow(/Package artifact closure is incomplete/);

    rmSync(liveDirectory, { recursive: true });
    for (const member of fixture.members) {
      const mirror = candidatePath(localBinariesDir(), member.relPath);
      mkdirSync(dirname(mirror), { recursive: true });
      symlinkSync(`${mirror}.missing-target`, mirror);
    }
    expect(() => tryResolveBinary(fixture.members[0]!.relPath)).toThrow(
      /Package artifact closure is incomplete/,
    );
  });

  it("returns a complete local closure from one provenance root", () => {
    const [wasmRel, dataRel] = fixtureClosureRelPaths([
      "program.wasm",
      "runtime.dat",
    ]);
    const wasmPath = writeCandidate(
      localBinariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION),
    );
    const dataPath = writeCandidate(
      localBinariesDir(),
      dataRel,
      new TextEncoder().encode("local-runtime"),
    );
    writeCandidate(
      binariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION),
    );
    writeCandidate(
      binariesDir(),
      dataRel,
      new TextEncoder().encode("fetched-runtime"),
    );

    expect(tryResolveBinarySet([wasmRel, dataRel])).toEqual([wasmPath, dataPath]);
  });

  it("falls back wholesale from a partial local closure to complete fetched bytes", () => {
    const [wasmRel, dataRel] = fixtureClosureRelPaths([
      "program.wasm",
      "runtime.dat",
    ]);
    writeCandidate(
      localBinariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION),
    );
    const fetchedWasm = writeCandidate(
      binariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION),
    );
    const fetchedData = writeCandidate(
      binariesDir(),
      dataRel,
      new TextEncoder().encode("fetched-runtime"),
    );

    expect(tryResolveBinarySet([wasmRel, dataRel])).toEqual([
      fetchedWasm,
      fetchedData,
    ]);
  });

  it("rejects complementary partial tiers instead of mixing a closure", () => {
    const [wasmRel, dataRel] = fixtureClosureRelPaths([
      "program.wasm",
      "runtime.dat",
    ]);
    writeCandidate(
      localBinariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION),
    );
    writeCandidate(
      binariesDir(),
      dataRel,
      new TextEncoder().encode("fetched-runtime"),
    );

    expect(() => tryResolveBinarySet([wasmRel, dataRel])).toThrow(
      /no single provenance tier.*tiers will not be mixed/s,
    );
  });

  it("falls back wholesale when a local closure member fails artifact policy", () => {
    const [wasmRel, dataRel] = fixtureClosureRelPaths([
      "program.wasm",
      "runtime.dat",
    ]);
    writeCandidate(
      localBinariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION - 1),
    );
    writeCandidate(
      localBinariesDir(),
      dataRel,
      new TextEncoder().encode("local-runtime"),
    );
    const fetchedWasm = writeCandidate(
      binariesDir(),
      wasmRel,
      executableWasmWithAbi(ABI_VERSION),
    );
    const fetchedData = writeCandidate(
      binariesDir(),
      dataRel,
      new TextEncoder().encode("fetched-runtime"),
    );

    expect(tryResolveBinarySet([wasmRel, dataRel])).toEqual([
      fetchedWasm,
      fetchedData,
    ]);
  });

  it("returns null only when no closure member exists in any tier", () => {
    const relPaths = fixtureClosureRelPaths(["program.wasm", "runtime.dat"]);
    expect(tryResolveBinarySet(relPaths)).toBeNull();
  });
});
