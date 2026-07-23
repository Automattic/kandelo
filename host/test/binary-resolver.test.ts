import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  tryResolveBinary,
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

beforeEach(() => {
  savedXdgCacheHome = process.env.XDG_CACHE_HOME;
  const cacheHome = mkdtempSync(join(tmpdir(), "kandelo-resolver-xdg-cache-"));
  cleanupDirs.add(cacheHome);
  process.env.XDG_CACHE_HOME = cacheHome;
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
  resetBinaryResolverManifestCacheForTests();
  if (savedXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = savedXdgCacheHome;
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
  const directory = join(findRepoRoot(), "packages", "registry", name);
  cleanupDirs.add(directory);
  return directory;
}

function writeFixturePackageManifest(name: string, manifest: string): string {
  const directory = fixturePackageDirectory(name);
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, "package.toml");
  writeFileSync(manifestPath, manifest);
  return manifestPath;
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
  for (const root of [
    localBinariesDir(),
    binariesDir(),
    join(findRepoRoot(), "host", "wasm"),
  ]) {
    cleanupDirs.add(join(root, "programs", "wasm32", name));
  }
  return { name, members };
}

function fixtureCanonicalRoot(
  packageName: string,
  arch = "wasm32",
): string {
  const digest = randomUUID().replaceAll("-", "").repeat(2);
  const root = join(
    binaryProgramCacheRoot(),
    `${packageName}-1.0.0-rev1-${arch}-${digest}`,
  );
  mkdirSync(root, { recursive: true });
  cleanupDirs.add(root);
  return root;
}

function fixtureLocalCanonicalRoot(
  packageName: string,
  arch = "wasm32",
): string {
  const packageGenerations = join(
    localBinariesDir(),
    ".kandelo-local-generations",
    arch,
    packageName,
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

  it("fails closed when a registry package directory has no manifest", () => {
    const name = fixturePackageName();
    mkdirSync(fixturePackageDirectory(name), { recursive: true });

    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${name}/image.zip`,
    )).toThrow(/registry package directory exists but package\.toml is missing/);
    expect(() => resolveBinary(
      `programs/wasm32/${name}/image.zip`,
    )).toThrow(/registry package directory exists but package\.toml is missing/);
    expect(() => tryResolveBinary(
      `programs/wasm32/${name}/image.zip`,
    )).toThrow(/registry package directory exists but package\.toml is missing/);
    expect(() => tryResolveBinarySet([
      `programs/wasm32/${name}/image.zip`,
    ])).toThrow(/registry package directory exists but package\.toml is missing/);
  });

  it("fails closed when an existing package manifest cannot be read", () => {
    const name = fixturePackageName();
    const directory = fixturePackageDirectory(name);
    mkdirSync(join(directory, "package.toml"), { recursive: true });

    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${name}/image.zip`,
    )).toThrow(/cannot read it/);
  });

  it("fails closed when the resolver projection is malformed or incomplete", () => {
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
    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${malformedName}/one.zip`,
    )).toThrow(/malformed resolver-owned table header/);

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
    )).toThrow(/\[\[outputs\]\] entry 2 requires name and wasm/);
  });

  it("discovers every output and runtime file in a multi-member package", () => {
    const fixture = createMultiOutputFixture();
    const expected = fixture.members.map((member) => member.relPath);

    for (const member of fixture.members) {
      expect(programOutputClosureRelPaths(member.relPath)).toEqual(expected);
    }
    expect(() => programOutputClosureRelPaths(
      `programs/wasm32/${fixture.name}/not-declared.zip`,
    )).toThrow(/is not a declared member of multi-member package/);
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
    const scalarName = fixturePackageName();
    writeFixturePackageManifest(scalarName, `kind = "program"
name = "${scalarName}"
arches = ["wasm32"]
[[outputs]]
name = "${sharedOutput}"
wasm = "${sharedOutput}.wasm"
`);
    resetBinaryResolverManifestCacheForTests();

    expect(programOutputClosureRelPaths(
      `programs/wasm32/${sharedOutput}.wasm`,
    )).toBeNull();
    expect(() => programOutputClosureRelPaths(
      `programs/wasm64/${sharedOutput}.wasm`,
    )).toThrow(/Legacy flat resolver path/);
  });

  it("fails closed for Rust-valid literal-string package metadata", () => {
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
    resetBinaryResolverManifestCacheForTests();

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
    const oldCanonicalRoot = fixtureCanonicalRoot(fixture.name);
    const oldMirrors = fixture.members.map((member) =>
      linkClosureMember(binariesDir(), member, oldCanonicalRoot, "old-generation")
    );
    const pinned = tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    );
    expect(pinned).toEqual(oldMirrors.map((mirror) => realpathSync(mirror)));

    const newCanonicalRoot = fixtureCanonicalRoot(fixture.name);
    const liveDirectory = join(
      binariesDir(),
      "programs",
      "wasm32",
      fixture.name,
    );
    const stagedDirectory = `${liveDirectory}.test-stage-${randomUUID()}`;
    cleanupDirs.add(stagedDirectory);
    for (const member of fixture.members) {
      const target = writeCanonicalMember(
        newCanonicalRoot,
        member.sourceArtifact,
        "new-generation",
      );
      const packageRelative = member.relPath.split("/").slice(3).join("/");
      const mirror = join(stagedDirectory, packageRelative);
      mkdirSync(dirname(mirror), { recursive: true });
      symlinkSync(target, mirror);
    }
    const backupDirectory = `${liveDirectory}.test-backup-${randomUUID()}`;
    cleanupDirs.add(backupDirectory);
    renameSync(liveDirectory, backupDirectory);
    renameSync(stagedDirectory, liveDirectory);

    expect(pinned!.map((path) => readFileSync(path, "utf8"))).toEqual(
      fixture.members.map(() => "old-generation"),
    );
    expect(tryResolveBinarySet(
      fixture.members.map((member) => member.relPath),
    )!.map((path) => readFileSync(path, "utf8"))).toEqual(
      fixture.members.map(() => "new-generation"),
    );
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

  it("rejects preexisting same-tier symlinks into different canonical cache entries", () => {
    const fixture = createMultiOutputFixture();
    const firstCanonicalRoot = fixtureCanonicalRoot(fixture.name);
    const secondCanonicalRoot = fixtureCanonicalRoot(fixture.name);
    linkClosureMember(
      binariesDir(),
      fixture.members[0]!,
      firstCanonicalRoot,
    );
    for (const member of fixture.members.slice(1)) {
      linkClosureMember(binariesDir(), member, secondCanonicalRoot);
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

  it("accepts complete regular files from one installed package identity", () => {
    const fixture = createMultiOutputFixture();
    const installedRoot = join(findRepoRoot(), "host", "wasm");
    const installed = fixture.members.map((member) =>
      writeCandidate(
        installedRoot,
        member.relPath,
        new TextEncoder().encode("installed-package-member"),
      )
    );

    expect(resolveBinary(fixture.members[1]!.relPath)).toBe(installed[1]);
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
