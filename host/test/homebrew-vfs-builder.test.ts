import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { gzipSync, zipSync, type Zippable } from "fflate";
import { ABI_VERSION } from "../src/generated/abi";
import {
  buildHomebrewVfs,
  writeHomebrewVfsComposition,
  type HomebrewVfsBuildResult,
  type HomebrewVfsCatalogCheckout,
  type HomebrewVfsCompatibilityPolicy,
  type HomebrewVfsSelectionSource,
} from "../src/homebrew-vfs-builder";
import {
  assertHomebrewBottleMirrorBundle,
  assertHomebrewBottleMirrorPlan,
  assertHomebrewVfsMaterialization,
  buildHomebrewMaterializedVfs,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
} from "../src/homebrew-vfs-composer";
import {
  buildHomebrewLazyLayer,
  buildHomebrewOriginalBottleCollection,
  closeHomebrewLazyLayerDescriptor,
  encodeHomebrewLazyLayerDescriptor,
  type HomebrewDeferredTreeDescriptor,
  type HomebrewDeferredTreeDraftDescriptor,
  type HomebrewLazyLayerClosureEvidence,
  type HomebrewLazyLayerDescriptor,
  type HomebrewLazyLayerDraftDescriptor,
  type HomebrewLazyLayerBasePackageSource,
} from "../src/homebrew-lazy-layer";
import {
  canonicalHomebrewRuntimeLayerBundleIdentityBytes,
  canonicalHomebrewRuntimeLayerDescriptorBytes,
} from "../src/homebrew-lazy-layer-descriptor";
import {
  HOMEBREW_RUNTIME_LAYER_LIMITS,
  parseHomebrewRuntimeLayerDescriptor,
  composeHomebrewRuntimeLayers,
  type HomebrewRuntimeLayerReference,
} from "../src/homebrew-runtime-layer-consumer";
import {
  planFederatedHomebrewVfs,
  planHomebrewVfs,
  type HomebrewLinkManifest,
  type HomebrewTapMetadata,
  type HomebrewVfsPlan,
} from "../src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../src/vfs/package-deferred-tree";
import {
  VFS_DEFERRED_TREE_COLLECTION_LIMITS,
  VFS_DEFERRED_TREE_LIMITS,
} from "../src/vfs/deferred-tree-limits";
import { ensureDirRecursive, writeVfsFile } from "../src/vfs/image-helpers";

const PREFIX = "/home/linuxbrew/.linuxbrew";
const CELLAR = `${PREFIX}/Cellar`;
const KEG = `${CELLAR}/hello/2.12.1`;
const TAP_COMMIT = "1111111111111111111111111111111111111111";
const KANDELO_COMMIT = "2222222222222222222222222222222222222222";
const CACHE_KEY = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const WRONG_SHA = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink";
  data?: string | Uint8Array;
  linkName?: string;
  mode?: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function pythonRuntimeLayerBundleSha(descriptor: HomebrewLazyLayerDescriptor): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-layer-identity-"));
  try {
    const descriptorPath = join(root, "descriptor.json");
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const validator = fileURLToPath(
      new URL("../../scripts/homebrew-vfs-release.py", import.meta.url),
    );
    return execFileSync("python3", [
      "-c",
      "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); " +
        "print(m['runtime_layer_bundle_sha256'](json.load(open(sys.argv[2]))))",
      validator,
      descriptorPath,
    ], { encoding: "utf8" }).trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pythonRuntimeLayerDescriptorBytes(
  descriptor: HomebrewLazyLayerDescriptor,
): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-layer-encoding-"));
  try {
    const descriptorPath = join(root, "descriptor.json");
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const validator = fileURLToPath(
      new URL("../../scripts/homebrew-vfs-release.py", import.meta.url),
    );
    return new Uint8Array(execFileSync("python3", [
      "-c",
      "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); " +
        "sys.stdout.buffer.write(m['runtime_layer_descriptor_bytes'](" +
        "json.load(open(sys.argv[2]))))",
      validator,
      descriptorPath,
    ]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pythonExpectedExternalBottleTransport(
  url: string,
): { kind: "external-https"; url: string } | null {
  const root = mkdtempSync(join(tmpdir(), "kandelo-external-bottle-url-"));
  try {
    const packagePath = join(root, "package.json");
    writeFileSync(packagePath, JSON.stringify({ url }));
    const validator = fileURLToPath(
      new URL("../../scripts/homebrew-vfs-release.py", import.meta.url),
    );
    return JSON.parse(execFileSync("python3", [
      "-c",
      "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); " +
        "print(json.dumps(m['expected_external_bottle_transport'](" +
        "json.load(open(sys.argv[2]))), separators=(',', ':')))",
      validator,
      packagePath,
    ], { encoding: "utf8" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pythonRuntimeLayerCanonicalErrors(
  descriptor: HomebrewLazyLayerDescriptor,
): string[] {
  const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-layer-errors-"));
  try {
    const descriptorPath = join(root, "descriptor.json");
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const validator = fileURLToPath(
      new URL("../../scripts/homebrew-vfs-release.py", import.meta.url),
    );
    return JSON.parse(execFileSync("python3", [
      "-c",
      "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); " +
        "d=json.load(open(sys.argv[2])); errors=[]\n" +
        "for name in ('runtime_layer_descriptor_bytes','runtime_layer_bundle_sha256'):\n" +
        " try: m[name](d); errors.append('')\n" +
        " except Exception as error: errors.append(str(error))\n" +
        "print(json.dumps(errors))",
      validator,
      descriptorPath,
    ], { encoding: "utf8" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bottleTar(entries: TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) chunks.push(tarHeader(entry), tarPayload(entry));
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return gzipSync(tar);
}

function declaredNixGnuTar(): string {
  const executable = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, "tar"))
    .find((candidate) => {
      try {
        return lstatSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  if (!executable ||
      !/^\/nix\/store\/[0-9a-z]{32}-gnutar-[^/]+\/bin\/tar$/.test(executable) ||
      realpathSync(executable) !== executable) {
    throw new Error("Homebrew VFS PAX fixture requires the flake-declared Nix GNU tar");
  }
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
  if (!version.startsWith("tar (GNU tar) ")) {
    throw new Error("Homebrew VFS PAX fixture requires the flake-declared Nix GNU tar");
  }
  return executable;
}

function tarTypeflags(tar: Uint8Array): string[] {
  const flags: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = new TextDecoder()
      .decode(header.subarray(124, 136))
      .replaceAll("\0", "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    flags.push(String.fromCharCode(header[156] || "0".charCodeAt(0)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return flags;
}

function gnuPaxBottle(receipt: Uint8Array): {
  bytes: Uint8Array;
  gnuTar: string;
  typeflags: string[];
} {
  const gnuTar = declaredNixGnuTar();
  const root = mkdtempSync(join(tmpdir(), "kandelo-homebrew-pax-"));
  try {
    const payload = join(root, "hello", "2.12.1");
    mkdirSync(join(payload, "bin"), { recursive: true });
    mkdirSync(join(payload, ".brew"), { recursive: true });
    mkdirSync(join(payload, "share"), { recursive: true });
    writeFileSync(join(payload, "bin", "hello"), "#!/bin/sh\necho hello\n");
    chmodSync(join(payload, "bin", "hello"), 0o755);
    writeFileSync(join(payload, ".brew", "hello.rb"), "class Hello < Formula\nend\n");
    writeFileSync(join(payload, "INSTALL_RECEIPT.json"), receipt);
    // A safe component longer than the ustar name field forces a local PAX
    // header and exercises the same parser path as publisher-created bottles.
    writeFileSync(join(payload, "share", "p".repeat(120)), "PAX path fixture\n");

    const archive = join(root, "hello.tar");
    execFileSync(gnuTar, [
      "--create",
      "--numeric-owner",
      "--mtime=2024-01-22 17:12:37",
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=pax",
      "--pax-option=globexthdr.name=/GlobalHead.%n,exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
      "--file",
      archive,
      "hello/2.12.1",
    ], { cwd: root });
    const tar = new Uint8Array(readFileSync(archive));
    return { bytes: gzipSync(tar), gnuTar, typeflags: tarTypeflags(tar) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function tarHeader(entry: TarSpec): Uint8Array {
  const header = new Uint8Array(512);
  const data = tarEntryData(entry);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.byteLength);
  writeOctal(header, 136, 12, 0);
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = typeflag(entry);
  if (entry.linkName) writeString(header, 157, 100, entry.linkName);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  header[155] = 0x20;
  return header;
}

function tarPayload(entry: TarSpec): Uint8Array {
  const data = tarEntryData(entry);
  const padded = Math.ceil(data.byteLength / 512) * 512;
  const out = new Uint8Array(padded);
  out.set(data);
  return out;
}

function tarEntryData(entry: TarSpec): Uint8Array {
  const carriesPayload =
    (entry.type ?? "file") === "file" ||
    (entry.type === "hardlink" && entry.data !== undefined);
  if (!carriesPayload) {
    return new Uint8Array();
  }
  if (entry.data instanceof Uint8Array) return entry.data;
  return utf8(entry.data ?? "");
}

function typeflag(entry: TarSpec): number {
  switch (entry.type ?? "file") {
    case "file": return "0".charCodeAt(0);
    case "directory": return "5".charCodeAt(0);
    case "symlink": return "2".charCodeAt(0);
    case "hardlink": return "1".charCodeAt(0);
  }
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = utf8(value);
  if (bytes.byteLength > length) throw new Error(`test tar field too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 2, "0");
  writeString(target, offset, length, `${text}\0`);
}

function standardEntries(overrides: TarSpec[] = []): TarSpec[] {
  return [
    { path: "hello/2.12.1/bin/hello", data: "#!/bin/sh\necho hello\n", mode: 0o755 },
    { path: "hello/2.12.1/.brew/hello.rb", data: "class Hello < Formula\nend\n" },
    { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: "{}\n" },
    ...overrides,
  ];
}

function metadataForBottle(
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): HomebrewTapMetadata {
  const bottle = {
    arch: "wasm32",
    bottle_tag: "wasm32_kandelo",
    kandelo_abi: ABI_VERSION,
    cellar: CELLAR,
    prefix: PREFIX,
    url: "file:///tmp/hello.bottle.tar.gz",
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    cache_key_sha: CACHE_KEY,
    link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
    runtime_support: ["node"],
    browser_compatible: false,
    fork_instrumentation: "not-required",
    status: "success",
    built_by: "https://example.invalid/actions/runs/1",
    built_from: {
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: KANDELO_COMMIT,
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_commit: TAP_COMMIT,
      formula_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    ...overrides,
  };
  return {
    schema: 1,
    tap_repository: "kandelo-dev/homebrew-tap-core",
    tap_name: "kandelo-dev/tap-core",
    tap_commit: TAP_COMMIT,
    kandelo_repository: "Automattic/kandelo",
    kandelo_commit: KANDELO_COMMIT,
    kandelo_abi: ABI_VERSION,
    release_tag: `bottles-abi-v${ABI_VERSION}`,
    generated_at: "2026-06-28T00:00:00Z",
    generator: "test",
    packages: [{
      name: "hello",
      full_name: "kandelo-dev/tap-core/hello",
      version: "2.12.1",
      formula_revision: 0,
      bottle_rebuild: 0,
      formula_path: "Formula/hello.rb",
      formula_metadata: "Kandelo/formula/hello.json",
      dependencies: [],
      bottles: [bottle],
    }],
  } as unknown as HomebrewTapMetadata;
}

function linkManifest(
  bytes: Uint8Array,
  overrides: Partial<HomebrewLinkManifest> = {},
): HomebrewLinkManifest {
  return {
    schema: 1,
    package: "hello",
    version: "2.12.1",
    arch: "wasm32",
    kandelo_abi: ABI_VERSION,
    prefix: PREFIX,
    cellar: CELLAR,
    keg: KEG,
    bottle: {
      url: "file:///tmp/hello.bottle.tar.gz",
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      cache_key_sha: CACHE_KEY,
      payload_root: "hello/2.12.1",
    },
    links: [{
      type: "symlink",
      source: "Cellar/hello/2.12.1/bin/hello",
      target: "bin/hello",
    }],
    receipts: [
      "Cellar/hello/2.12.1/.brew/hello.rb",
      "Cellar/hello/2.12.1/INSTALL_RECEIPT.json",
    ],
    env: { PATH_prepend: ["bin"] },
    ...overrides,
  };
}

async function buildFixture(
  bytes: Uint8Array,
  opts: {
    metadataOverrides?: Record<string, unknown>;
    linkOverrides?: Partial<HomebrewLinkManifest>;
    loadBytes?: Uint8Array;
    selectionSource?: HomebrewVfsSelectionSource;
    strict?: boolean;
    catalogCheckout?: HomebrewVfsCatalogCheckout;
    compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
    seedFs?: (fs: MemoryFileSystem) => void;
    migrationLock?: { sha256: string; bytes: number };
    onLoadBottle?: () => void;
    mutatePlan?: (plan: HomebrewVfsPlan) => void;
  } = {},
): Promise<HomebrewVfsBuildResult> {
  const manifest = linkManifest(bytes, opts.linkOverrides);
  const plan = await planHomebrewVfs(metadataForBottle(bytes, opts.metadataOverrides), {
    packages: ["hello"],
    arch: "wasm32",
    runtime: "node",
    ...(opts.strict ? { allowFallback: false } : {}),
    loadLinkManifest: () => manifest,
  });
  opts.mutatePlan?.(plan);
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  opts.seedFs?.(fs);
  return buildHomebrewVfs(plan, {
    fs,
    selectionSource: opts.selectionSource,
    catalogCheckout: opts.catalogCheckout,
    compatibilityPolicy: opts.compatibilityPolicy,
    migrationLock: opts.migrationLock,
    loadBottleBytes: () => {
      opts.onLoadBottle?.();
      return opts.loadBytes ?? bytes;
    },
  });
}

async function buildLinkConflictFixture(
  compatibilityPolicy: HomebrewVfsCompatibilityPolicy | undefined,
  packageNames = ["ed", "posix-utils-lite"],
  onLoadBottle?: () => void,
  missingSourcePackage?: string,
): Promise<HomebrewVfsBuildResult> {
  const bytes = bottleTar(standardEntries());
  const basePlan = await planHomebrewVfs(metadataForBottle(bytes), {
    packages: ["hello"],
    arch: "wasm32",
    runtime: "node",
    loadLinkManifest: () => linkManifest(bytes),
  });
  const packages = packageNames.map((name) => {
    const pkg = basePlan.packages[0];
    const keg = `${CELLAR}/${name}/2.12.1`;
    const sourceName = name === missingSourcePackage ? "missing" : "hello";
    return {
      ...pkg,
      name,
      fullName: `kandelo-dev/tap-core/${name}`,
      keg,
      linkManifestPath: `Kandelo/link/${name}-2.12.1-rebuild0-wasm32.json`,
      linkManifest: {
        ...pkg.linkManifest,
        package: name,
        keg,
        links: [{
          type: "symlink" as const,
          source: `Cellar/${name}/2.12.1/bin/${sourceName}`,
          target: "bin/ex",
        }],
        receipts: [
          `Cellar/${name}/2.12.1/.brew/hello.rb`,
          `Cellar/${name}/2.12.1/INSTALL_RECEIPT.json`,
        ],
      },
    };
  });
  return buildHomebrewVfs({
    ...basePlan,
    requestedPackages: [...packageNames],
    packages,
  }, {
    fs: MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024)),
    compatibilityPolicy,
    loadBottleBytes: () => {
      onLoadBottle?.();
      return bytes;
    },
  });
}

function readVfsFile(fs: MemoryFileSystem, path: string): string {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(st.size);
    fs.read(fd, bytes, null, bytes.length);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(fd);
  }
}

async function lazyLayerFixture(options: {
  mutateBase?: (fs: MemoryFileSystem) => void;
  mutatePlan?: (plan: HomebrewVfsPlan) => void;
  mutateBaseSource?: (source: HomebrewLazyLayerBasePackageSource) => void;
  runtimeLayer?: { id: string; policy: unknown };
  includeLayerDependency?: boolean;
  hardlinkCanonicalAfterAlias?: boolean;
  overlappingDirectoryModes?: readonly [dependency: number, runtime: number];
  compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
  runtimeReceipt?: string;
  runtimeExtraEntries?: TarSpec[];
} = {}) {
  const baseBytes = bottleTar(standardEntries());
  const baseManifest = linkManifest(baseBytes);
  const basePlan = await planHomebrewVfs(metadataForBottle(baseBytes), {
    packages: ["hello"],
    arch: "wasm32",
    runtime: "node",
    loadLinkManifest: () => baseManifest,
  });
  basePlan.packages[0].tapCommit = "8".repeat(40);
  basePlan.packages[0].kandeloCommit = "7".repeat(40);
  basePlan.packages[0].builtFrom = {
    tapRepository: "kandelo-dev/homebrew-tap-core",
    tapCommit: basePlan.packages[0].tapCommit,
    kandeloRepository: "Automattic/kandelo",
    kandeloCommit: basePlan.packages[0].kandeloCommit,
    formulaSha256: "6".repeat(64),
  };
  const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
  await buildHomebrewVfs(basePlan, {
    fs: baseFs,
    loadBottleBytes: () => baseBytes,
  });
  baseFs.setImageMetadata({
    version: 1,
    kernelAbi: ABI_VERSION,
    homebrew: {
      packages: [{ fullName: basePlan.packages[0].fullName }],
    },
  });
  options.mutateBase?.(baseFs);

  const runtimeVersion = "3.0";
  const runtimeKeg = `${CELLAR}/runtime/${runtimeVersion}`;
  const runtimeBytes = bottleTar([
    ...(options.overlappingDirectoryModes === undefined ? [] : [{
      path: "Cellar/shared-runtime-state",
      type: "directory" as const,
      mode: options.overlappingDirectoryModes[1],
    }]),
    {
      path: `runtime/${runtimeVersion}/bin/runtime`,
      data: "#!/bin/sh\necho runtime\n",
      mode: 0o755,
    },
    ...(options.hardlinkCanonicalAfterAlias ? [
      {
        path: `runtime/${runtimeVersion}/lib/z-canonical.a`,
        data: "hardlinked runtime archive\n",
        mode: 0o644,
      },
      {
        path: `runtime/${runtimeVersion}/lib/a-alias.a`,
        type: "hardlink" as const,
        linkName: `runtime/${runtimeVersion}/lib/z-canonical.a`,
        mode: 0o644,
      },
    ] : []),
    {
      path: `runtime/${runtimeVersion}/.brew/runtime.rb`,
      data: "class Runtime < Formula\nend\n",
    },
    ...(options.runtimeExtraEntries ?? []),
    {
      path: `runtime/${runtimeVersion}/INSTALL_RECEIPT.json`,
      data: options.runtimeReceipt ?? "{}\n",
    },
  ]);
  const runtimeCacheKey =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const runtimePackage = {
    ...basePlan.packages[0],
    name: "runtime",
    fullName: "kandelo-dev/tap-core/runtime",
    version: runtimeVersion,
    url: "file:///tmp/runtime.bottle.tar.gz",
    sha256: sha256(runtimeBytes),
    bytes: runtimeBytes.byteLength,
    cacheKeySha: runtimeCacheKey,
    keg: runtimeKeg,
    payloadRoot: `runtime/${runtimeVersion}`,
    linkManifestPath: "Kandelo/link/runtime-3.0-rebuild0-wasm32.json",
    dependencies: [{
      name: "hello",
      full_name: "kandelo-dev/tap-core/hello",
      version: "2.12.1",
    }],
    linkManifest: {
      ...baseManifest,
      package: "runtime",
      version: runtimeVersion,
      keg: runtimeKeg,
      bottle: {
        ...baseManifest.bottle,
        url: "file:///tmp/runtime.bottle.tar.gz",
        sha256: sha256(runtimeBytes),
        bytes: runtimeBytes.byteLength,
        cache_key_sha: runtimeCacheKey,
        payload_root: `runtime/${runtimeVersion}`,
      },
      links: [{
        type: "symlink" as const,
        source: `Cellar/runtime/${runtimeVersion}/bin/runtime`,
        target: "bin/runtime",
      }],
      receipts: [
        `Cellar/runtime/${runtimeVersion}/.brew/runtime.rb`,
        `Cellar/runtime/${runtimeVersion}/INSTALL_RECEIPT.json`,
      ],
    },
  };
  const dependencyVersion = "1.0";
  const dependencyKeg = `${CELLAR}/runtime-dep/${dependencyVersion}`;
  const dependencyBytes = bottleTar([
    ...(options.overlappingDirectoryModes === undefined ? [] : [{
      path: "Cellar/shared-runtime-state",
      type: "directory" as const,
      mode: options.overlappingDirectoryModes[0],
    }]),
    {
      path: `runtime-dep/${dependencyVersion}/bin/runtime-dep`,
      data: "dependency payload\n",
      mode: 0o755,
    },
    {
      path: `runtime-dep/${dependencyVersion}/bin/runtime-dep-alias`,
      type: "hardlink",
      linkName: `runtime-dep/${dependencyVersion}/bin/runtime-dep`,
      mode: 0o755,
    },
    {
      path: `runtime-dep/${dependencyVersion}/bin/runtime-dep-alias-2`,
      type: "hardlink",
      linkName: `runtime-dep/${dependencyVersion}/bin/runtime-dep-alias`,
      mode: 0o755,
    },
    {
      path: `runtime-dep/${dependencyVersion}/.brew/runtime-dep.rb`,
      data: "class RuntimeDep < Formula\nend\n",
    },
    {
      path: `runtime-dep/${dependencyVersion}/INSTALL_RECEIPT.json`,
      data: "{}\n",
    },
  ]);
  const dependencyCacheKey = sha256(utf8("runtime-dep-cache-key"));
  const dependencyPackage = {
    ...runtimePackage,
    name: "runtime-dep",
    fullName: "kandelo-dev/tap-core/runtime-dep",
    version: dependencyVersion,
    url: "file:///tmp/runtime-dep.bottle.tar.gz",
    sha256: sha256(dependencyBytes),
    bytes: dependencyBytes.byteLength,
    cacheKeySha: dependencyCacheKey,
    keg: dependencyKeg,
    payloadRoot: `runtime-dep/${dependencyVersion}`,
    linkManifestPath: "Kandelo/link/runtime-dep-1.0-rebuild0-wasm32.json",
    dependencies: [{
      name: "hello",
      full_name: "kandelo-dev/tap-core/hello",
      version: "2.12.1",
    }],
    linkManifest: {
      ...runtimePackage.linkManifest,
      package: "runtime-dep",
      version: dependencyVersion,
      keg: dependencyKeg,
      bottle: {
        ...runtimePackage.linkManifest.bottle,
        url: "file:///tmp/runtime-dep.bottle.tar.gz",
        sha256: sha256(dependencyBytes),
        bytes: dependencyBytes.byteLength,
        cache_key_sha: dependencyCacheKey,
        payload_root: `runtime-dep/${dependencyVersion}`,
      },
      links: [{
        type: "symlink" as const,
        source: `Cellar/runtime-dep/${dependencyVersion}/bin/runtime-dep`,
        target: "bin/runtime-dep",
      }],
      receipts: [
        `Cellar/runtime-dep/${dependencyVersion}/.brew/runtime-dep.rb`,
        `Cellar/runtime-dep/${dependencyVersion}/INSTALL_RECEIPT.json`,
      ],
    },
  };
  if (options.includeLayerDependency) {
    runtimePackage.dependencies = [{
      name: "runtime-dep",
      full_name: dependencyPackage.fullName,
      version: dependencyVersion,
    }];
  }
  const plan = {
    ...basePlan,
    requestedPackages: ["runtime"],
    packages: [
      basePlan.packages[0],
      ...(options.includeLayerDependency ? [dependencyPackage] : []),
      runtimePackage,
    ],
  };
  options.mutatePlan?.(plan);
  const baseSource: HomebrewLazyLayerBasePackageSource = {
    schema: 1,
    kind: "kandelo-package-output",
    index: {
      url: `https://github.com/Automattic/kandelo/releases/download/binaries-abi-v${ABI_VERSION}/index.toml`,
      sha256: "1111111111111111111111111111111111111111111111111111111111111111",
      bytes: 1234,
      abi: ABI_VERSION,
    },
    package: {
      name: "shell",
      version: "0.1.0",
      revision: 14,
      arch: "wasm32",
      cache_key_sha:
        "2222222222222222222222222222222222222222222222222222222222222222",
    },
    archive: {
      format: "kandelo-package-tar-zstd-v2",
      url: `https://github.com/Automattic/kandelo/releases/download/binaries-abi-v${ABI_VERSION}/shell-0.1.0-rev14-abi${ABI_VERSION}-wasm32-22222222.tar.zst`,
      sha256: "3333333333333333333333333333333333333333333333333333333333333333",
      bytes: 45678,
    },
    output: {
      name: "shell",
      path: "shell.vfs.zst",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bytes: 12345,
    },
  };
  options.mutateBaseSource?.(baseSource);
  const runtimeRootPackage = (plan as HomebrewVfsPlan & {
    requestedFullNames?: string[];
  }).requestedFullNames?.find((name) => name.endsWith("/runtime")) ??
    `${plan.tapName}/runtime`;
  const build = () => buildHomebrewLazyLayer(plan, {
    fs: MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024)),
    baseVfs: {
      fs: baseFs,
      image: {
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bytes: 12345,
      },
      source: baseSource,
    },
    acceptanceVfs: {
      sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      bytes: 23456,
    },
    runtimeLayer: options.runtimeLayer ?? {
      id: "runtime",
      policy: {
        schema: 1,
        kind: "kandelo-homebrew-runtime-layer-policy",
        base_package: "shell",
        layers: [{
          id: "runtime",
          root_package: runtimeRootPackage,
        }],
      },
    },
    compatibilityPolicy: options.compatibilityPolicy,
    loadBottleBytes: (pkg) =>
      pkg.name === "hello"
        ? baseBytes
        : pkg.name === "runtime-dep"
          ? dependencyBytes
          : runtimeBytes,
  });
  return {
    baseFs,
    plan,
    build,
    baseBytes,
    runtimeBytes,
    runtimeKeg,
    dependencyBytes,
    dependencyKeg,
  };
}

async function runtimeLayerConsumerFixture(
  options: {
    includeLayerDependency?: boolean;
    runtimeReceipt?: string;
    runtimeExtraEntries?: TarSpec[];
  } = {},
) {
  const fixture = await lazyLayerFixture({
    includeLayerDependency: options.includeLayerDependency,
    runtimeReceipt: options.runtimeReceipt,
    runtimeExtraEntries: options.runtimeExtraEntries,
    mutateBase(fs) {
      const composition = JSON.parse(readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"));
      composition.packages[0].url =
        "https://example.invalid/bottles/hello.bottle.tar.gz";
      writeVfsFile(
        fs,
        "/etc/kandelo/homebrew-vfs.json",
        `${JSON.stringify(composition)}\n`,
      );
    },
    mutatePlan(plan) {
      for (const pkg of plan.packages) {
        pkg.url = `https://example.invalid/bottles/${pkg.name}.bottle.tar.gz`;
      }
    },
  });
  const result = await fixture.build();
  const baseImageBytes = await fixture.baseFs.saveImage();
  const baseSha = sha256(baseImageBytes);
  result.descriptor.base_vfs.sha256 = baseSha;
  result.descriptor.base_vfs.bytes = baseImageBytes.byteLength;
  result.descriptor.base_vfs.package_source.output.sha256 = baseSha;
  result.descriptor.base_vfs.package_source.output.bytes = baseImageBytes.byteLength;
  const descriptor = closeHomebrewLazyLayerDescriptor(result.descriptor, {
    descriptor: {
      asset: "kandelo-homebrew-vfs.json",
      sha256: "1".repeat(64),
      bytes: 101,
    },
    report: {
      asset: "kandelo-homebrew-vfs-report.json",
      sha256: "2".repeat(64),
      bytes: 102,
    },
    node: {
      asset: "kandelo-homebrew-node-evidence.json",
      sha256: "3".repeat(64),
      bytes: 103,
    },
    browser: {
      asset: "kandelo-homebrew-browser-evidence.json",
      sha256: "4".repeat(64),
      bytes: 104,
    },
  });
  return {
    ...fixture,
    descriptor,
    archive: result.payloads.find((payload) => payload.id === "runtime")!.bytes,
    payloads: result.payloads,
    baseImageBytes,
  };
}

function descriptorTree(
  descriptor: HomebrewLazyLayerDescriptor,
): HomebrewDeferredTreeDescriptor;
function descriptorTree(
  descriptor: HomebrewLazyLayerDraftDescriptor,
): HomebrewDeferredTreeDraftDescriptor;
function descriptorTree(
  descriptor: HomebrewLazyLayerDescriptor | HomebrewLazyLayerDraftDescriptor,
) {
  return descriptor.deferred_trees[0];
}

function descriptorEntries(descriptor: HomebrewLazyLayerDescriptor) {
  return descriptorTree(descriptor).inventory.entries;
}

function bundleReleaseTransport(
  tree: HomebrewDeferredTreeDescriptor,
) {
  const transport = tree.transports.find((item) => item.kind === "bundle-release");
  if (transport === undefined) throw new Error("fixture has no bundle release transport");
  return transport;
}

function draftBundleReleaseTransport(
  tree: HomebrewDeferredTreeDraftDescriptor,
) {
  const transport = tree.transports.find((item) => item.kind === "bundle-release");
  if (transport === undefined) throw new Error("fixture has no bundle release transport");
  return transport;
}

function refreshInventory(descriptor: HomebrewLazyLayerDescriptor): void {
  for (const tree of descriptor.deferred_trees) {
    const inventory = tree.inventory;
    const entries = inventory.entries;
    inventory.entry_count = entries.length;
    inventory.source_entry_count = inventory.source?.entries.length ??
      new Set(entries.map((entry) => entry.source_path)).size;
    inventory.regular_inode_count = new Set(
      entries.flatMap((entry) => entry.inode_group ? [entry.inode_group] : []),
    ).size;
    inventory.layer_entry_count = entries.filter(
      (entry) => entry.ownership === "layer",
    ).length;
    if (descriptor.schema === 5) {
      inventory.mergeable_directory_count = entries.filter(
        (entry) => entry.ownership === "mergeable-directory",
      ).length;
      delete inventory.shared_base_directory_count;
    } else {
      inventory.shared_base_directory_count = entries.filter(
        (entry) => entry.ownership === "shared-base-directory",
      ).length;
      delete inventory.mergeable_directory_count;
    }
    if (inventory.source === undefined) {
      inventory.expanded_bytes = entries.filter((entry) => entry.type !== "hardlink")
        .reduce((total, entry) => total + entry.size, 0);
    }
    inventory.payload_bytes = entries.filter((entry) => entry.type === "file")
      .reduce((total, entry) => total + entry.size, 0);
  }
}

function runtimeLayerReference(
  id: string,
  descriptor: HomebrewLazyLayerDescriptor,
): { reference: HomebrewRuntimeLayerReference; bytes: Uint8Array } {
  const bytes = encodeHomebrewLazyLayerDescriptor(descriptor);
  return {
    bytes,
    reference: {
      id,
      descriptor: {
        url: `https://github.com/${descriptor.release.repository}/releases/download/` +
          `${descriptor.release.tag}/kandelo-homebrew-${id}-layer.json`,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
    },
  };
}

function runtimeLayerVariant(
  source: HomebrewLazyLayerDescriptor,
  id: string,
): HomebrewLazyLayerDescriptor {
  const descriptor = structuredClone(source);
  const pkg = descriptor.packages.layer[0];
  const oldName = pkg.name;
  const oldFullName = pkg.full_name;
  const replaceName = (value: string) => value.replaceAll(oldName, id);

  pkg.name = id;
  pkg.full_name = `${pkg.tap_name}/${id}`;
  pkg.url = `https://example.invalid/bottles/${id}.bottle.tar.gz`;
  pkg.sha256 = sha256(utf8(`${id}-bottle`));
  pkg.cache_key_sha = sha256(utf8(`${id}-cache-key`));
  pkg.link_manifest = replaceName(pkg.link_manifest);
  pkg.keg = replaceName(pkg.keg);
  pkg.opt_link = {
    path: `opt/${id}`,
    target: `../${pkg.keg.slice(`${PREFIX}/`.length)}`,
  };

  descriptor.selection.requested_packages = [id];
  descriptor.selection.package_order = descriptor.selection.package_order.map(
    (name) => name === oldFullName ? pkg.full_name : name,
  );
  descriptor.selection.layer_package_order = [pkg.full_name];
  const tree = descriptorTree(descriptor);
  tree.id = id;
  if (tree.package !== undefined) tree.package = pkg.full_name;
  tree.activation.capabilities = [`homebrew-bottle:${id}`];
  tree.activation.roots = tree.activation.roots.map(replaceName);
  if (tree.inventory.source !== undefined) {
    for (const entry of tree.inventory.source.entries) {
      entry.path = replaceName(entry.path);
      if (entry.target !== undefined) entry.target = replaceName(entry.target);
    }
    tree.inventory.source.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
  }
  for (const entry of tree.inventory.entries) {
    entry.path = replaceName(entry.path);
    entry.source_path = replaceName(entry.source_path);
    if (entry.inode_group !== undefined) {
      entry.inode_group = replaceName(entry.inode_group);
    }
    if (entry.target !== undefined) {
      entry.target = replaceName(entry.target);
      if (entry.type === "symlink") entry.size = utf8(entry.target).byteLength;
    }
  }
  tree.inventory.entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const releaseTransport = bundleReleaseTransport(tree);
  releaseTransport.url = releaseTransport.url.replace(
    /[^/]+$/,
    `kandelo-homebrew-${id}-layer.bin`,
  );
  releaseTransport.asset = `kandelo-homebrew-${id}-layer.bin`;
  tree.content.sha256 = pkg.sha256;
  refreshInventory(descriptor);
  return recloseRuntimeLayerDescriptor(descriptor);
}

function runtimeLayerCollection(
  source: HomebrewLazyLayerDescriptor,
  ids: readonly string[],
): HomebrewLazyLayerDescriptor {
  if (ids.length === 0) throw new Error("runtime layer collection requires a root");
  const variants = ids.map((id) => runtimeLayerVariant(source, id));
  const descriptor = structuredClone(source);
  descriptor.selection.requested_packages = [ids[0]!];
  descriptor.packages.layer = variants.map((variant) =>
    structuredClone(variant.packages.layer[0]!)
  );
  descriptor.selection.layer_package_order = descriptor.packages.layer.map(
    (pkg) => pkg.full_name,
  );
  descriptor.selection.package_order = [
    ...descriptor.selection.base_package_order,
    ...descriptor.selection.layer_package_order,
  ];
  descriptor.deferred_trees = variants.map((variant) => {
    const tree = structuredClone(descriptorTree(variant));
    return tree;
  });
  const seenPaths = new Set<string>();
  for (const tree of descriptor.deferred_trees) {
    tree.inventory.entries = tree.inventory.entries.filter((entry) => {
      if (seenPaths.has(entry.path)) return false;
      seenPaths.add(entry.path);
      return true;
    });
  }
  refreshInventory(descriptor);
  return recloseRuntimeLayerDescriptor(descriptor);
}

function truncateRuntimeLayerCollection(
  source: HomebrewLazyLayerDescriptor,
  packageCount: number,
): HomebrewLazyLayerDescriptor {
  const descriptor = structuredClone(source);
  descriptor.packages.layer = descriptor.packages.layer.slice(0, packageCount);
  descriptor.deferred_trees = descriptor.deferred_trees.slice(0, packageCount);
  descriptor.selection.layer_package_order = descriptor.packages.layer.map(
    (pkg) => pkg.full_name,
  );
  descriptor.selection.package_order = [
    ...descriptor.selection.base_package_order,
    ...descriptor.selection.layer_package_order,
  ];
  refreshInventory(descriptor);
  return recloseRuntimeLayerDescriptor(descriptor);
}

function withMergeableDirectory(
  source: HomebrewLazyLayerDescriptor,
  path: string,
  mode = 0o755,
): HomebrewLazyLayerDescriptor {
  const descriptor = structuredClone(source);
  const tree = descriptorTree(descriptor);
  tree.inventory.entries.push({
    path: path.slice(1),
    source_path: `.kandelo-descriptor/${tree.id}/test-mergeable-${sha256(utf8(path)).slice(0, 16)}`,
    materialization: "descriptor",
    type: "directory",
    ownership: "mergeable-directory",
    mode,
    size: 0,
  });
  tree.inventory.entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  refreshInventory(descriptor);
  return recloseRuntimeLayerDescriptor(descriptor);
}

function withBaseImage(
  source: HomebrewLazyLayerDescriptor,
  baseImageBytes: Uint8Array,
): HomebrewLazyLayerDescriptor {
  const descriptor = structuredClone(source);
  const digest = sha256(baseImageBytes);
  descriptor.base_vfs.sha256 = digest;
  descriptor.base_vfs.bytes = baseImageBytes.byteLength;
  descriptor.base_vfs.package_source.output.sha256 = digest;
  descriptor.base_vfs.package_source.output.bytes = baseImageBytes.byteLength;
  return recloseRuntimeLayerDescriptor(descriptor);
}

function asLegacySharedDirectoryLayer(
  source: HomebrewLazyLayerDescriptor,
  sharedPath: string,
): HomebrewLazyLayerDescriptor {
  const descriptor = structuredClone(source);
  descriptor.schema = 4;
  const tree = descriptorTree(descriptor);
  delete tree.package;
  delete tree.inventory.source;
  for (const entry of tree.inventory.entries) {
    delete entry.materialization;
    if (entry.path === sharedPath.slice(1)) {
      entry.ownership = "shared-base-directory";
    } else if (entry.ownership === "mergeable-directory") {
      entry.ownership = "shared-base-directory";
    }
  }
  tree.content.decoder = "zip-v1";
  tree.content.media_type = "application/zip";
  refreshInventory(descriptor);
  return recloseRuntimeLayerDescriptor(descriptor);
}

function withoutReleaseUrl<T extends { url: string }>(value: T): Omit<T, "url"> {
  const { url: _url, ...identity } = value;
  return identity;
}

function closeRuntimeLayerDraft(
  draft: HomebrewLazyLayerDraftDescriptor,
): HomebrewLazyLayerDescriptor {
  return closeHomebrewLazyLayerDescriptor(draft, {
    descriptor: { asset: "kandelo-homebrew-vfs.json", sha256: "1".repeat(64), bytes: 101 },
    report: { asset: "kandelo-homebrew-vfs-report.json", sha256: "2".repeat(64), bytes: 102 },
    node: { asset: "kandelo-homebrew-node-evidence.json", sha256: "3".repeat(64), bytes: 103 },
    browser: { asset: "kandelo-homebrew-browser-evidence.json", sha256: "4".repeat(64), bytes: 104 },
  });
}

/**
 * Recreate a valid closed fixture after a test changes signed semantics.
 *
 * The production closer owns every derived bundle asset, tag, and release URL.
 * Tests that are not specifically exercising stale identity must use the same
 * path instead of updating one derived field by hand.
 */
function recloseRuntimeLayerDescriptor(
  descriptor: HomebrewLazyLayerDescriptor,
): HomebrewLazyLayerDescriptor {
  const closed = structuredClone(descriptor);
  const {
    bundle: _bundle,
    release: _release,
    acceptance_evidence: acceptanceEvidence,
    acceptance_vfs: acceptanceVfs,
    deferred_trees: deferredTrees,
    ...common
  } = closed;
  const draft: HomebrewLazyLayerDraftDescriptor = {
    ...common,
    kind: "kandelo-homebrew-deferred-layer-draft",
    acceptance_vfs: withoutReleaseUrl(acceptanceVfs),
    deferred_trees: deferredTrees.map((tree) => ({
      ...tree,
      transports: tree.transports.map((transport) =>
        transport.kind === "bundle-release"
          ? { kind: transport.kind, asset: transport.asset }
          : { kind: transport.kind, url: transport.url }
      ),
    })),
  };
  const evidence: HomebrewLazyLayerClosureEvidence = {
    descriptor: withoutReleaseUrl(acceptanceEvidence.descriptor),
    report: withoutReleaseUrl(acceptanceEvidence.report),
    node: withoutReleaseUrl(acceptanceEvidence.node),
    browser: withoutReleaseUrl(acceptanceEvidence.browser),
  };
  const reclosed = closeHomebrewLazyLayerDescriptor(draft, evidence);
  Object.assign(descriptor, reclosed);
  return descriptor;
}

function makeLazyLayerPlanFederated(plan: HomebrewVfsPlan): void {
  const rootRepository = "example/homebrew-runtimes";
  const rootTap = "example/runtimes";
  const rootCommit = "3333333333333333333333333333333333333333";
  const runtime = plan.packages[1];
  runtime.fullName = `${rootTap}/runtime`;
  runtime.tapRepository = rootRepository;
  runtime.tapName = rootTap;
  runtime.tapCommit = rootCommit;
  runtime.builtFrom = {
    tapRepository: rootRepository,
    tapCommit: rootCommit,
    kandeloRepository: runtime.kandeloRepository,
    kandeloCommit: runtime.kandeloCommit,
    formulaSha256: "5".repeat(64),
  };
  plan.tapRepository = rootRepository;
  plan.tapName = rootTap;
  plan.tapCommit = rootCommit;
  Object.assign(plan, {
    requestedFullNames: [`${rootTap}/runtime`],
    taps: [
      {
        tapRepository: "kandelo-dev/homebrew-tap-core",
        tapName: "kandelo-dev/tap-core",
        tapCommit: TAP_COMMIT,
        kandeloRepository: "Automattic/kandelo",
        kandeloCommit: KANDELO_COMMIT,
        kandeloAbi: ABI_VERSION,
        releaseTag: `bottles-abi-v${ABI_VERSION}`,
      },
      {
        tapRepository: rootRepository,
        tapName: rootTap,
        tapCommit: rootCommit,
        kandeloRepository: "Automattic/kandelo",
        kandeloCommit: KANDELO_COMMIT,
        kandeloAbi: ABI_VERSION,
        releaseTag: `bottles-abi-v${ABI_VERSION}`,
      },
    ],
  });
}

describe("Homebrew runtime layer consumer", () => {
  it("rejects a semantic mutation that retains the old closed bundle identity", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    fixture.descriptor.base_vfs.package_source.package.revision += 1;
    const { reference, bytes } = runtimeLayerReference("runtime", fixture.descriptor);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [reference],
      fetch: async () => new Response(bytes),
    })).rejects.toThrow("bundle identity does not match its descriptor");
  });

  it("rejects noncanonical descriptor bytes even when their JSON value is unchanged", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const bytes = utf8(`${JSON.stringify(fixture.descriptor, null, 2)}\n`);
    const reference = runtimeLayerReference("runtime", fixture.descriptor).reference;
    reference.descriptor.sha256 = sha256(bytes);
    reference.descriptor.bytes = bytes.byteLength;

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [reference],
      fetch: async () => new Response(bytes),
    })).rejects.toThrow("descriptor bytes are not canonical-json-v1");
  });

  it("uses one Unicode-scalar canonical order in TypeScript and Python", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const inventory = descriptorTree(fixture.descriptor).inventory as unknown as
      Record<string, unknown>;
    const bmpKey = "\ue000";
    const nonBmpKey = "\u{10000}";
    // UTF-16 comparison puts the non-BMP surrogate pair first. Scalar-value
    // comparison, like Python, puts U+E000 before U+10000.
    inventory[nonBmpKey] = "non-BMP";
    inventory[bmpKey] = "BMP";
    recloseRuntimeLayerDescriptor(fixture.descriptor);

    const descriptorBytes = canonicalHomebrewRuntimeLayerDescriptorBytes(
      fixture.descriptor,
    );
    expect(Array.from(pythonRuntimeLayerDescriptorBytes(fixture.descriptor))).toEqual(
      Array.from(descriptorBytes),
    );
    expect(pythonRuntimeLayerBundleSha(fixture.descriptor)).toBe(
      sha256(canonicalHomebrewRuntimeLayerBundleIdentityBytes(fixture.descriptor)),
    );
    const encoded = new TextDecoder().decode(descriptorBytes);
    expect(encoded.indexOf(`"${bmpKey}"`)).toBeLessThan(
      encoded.indexOf(`"${nonBmpKey}"`),
    );
  });

  it("rejects lone Unicode surrogates in both canonical validators", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    fixture.descriptor.base_vfs.package_source.package.version = "1.0-\ud800";

    expect(() => canonicalHomebrewRuntimeLayerDescriptorBytes(fixture.descriptor))
      .toThrow(/Unicode scalar values/);
    expect(() => canonicalHomebrewRuntimeLayerBundleIdentityBytes(fixture.descriptor))
      .toThrow(/Unicode scalar values/);
    expect(pythonRuntimeLayerCanonicalErrors(fixture.descriptor)).toEqual([
      expect.stringMatching(/Unicode scalar values/),
      expect.stringMatching(/Unicode scalar values/),
    ]);
    expect(() => parseHomebrewRuntimeLayerDescriptor(fixture.descriptor))
      .toThrow(/Unicode scalar values/);
  });

  it("retains direct immutable transports beside the derived release mirror", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const directUrl = "https://ghcr.io/v2/example/runtime/blobs/sha256:immutable";
    descriptorTree(fixture.descriptor).transports.unshift({
      kind: "external-https",
      url: directUrl,
    });
    recloseRuntimeLayerDescriptor(fixture.descriptor);
    expect(pythonRuntimeLayerBundleSha(fixture.descriptor)).toBe(
      fixture.descriptor.bundle.sha256,
    );
    expect(Array.from(pythonRuntimeLayerDescriptorBytes(fixture.descriptor))).toEqual(
      Array.from(canonicalHomebrewRuntimeLayerDescriptorBytes(fixture.descriptor)),
    );
    const { reference, bytes } = runtimeLayerReference("runtime", fixture.descriptor);
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [reference],
      fetch: async () => new Response(bytes),
    });
    expect(composed.layers).toHaveLength(1);
    expect(composed.fs.exportLazyArchiveEntries()[0]?.url).toBe(directUrl);
  });

  it("registers verified stubs without fetching the archive, then verifies it on demand", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const { reference, bytes } = runtimeLayerReference("runtime", fixture.descriptor);
    let descriptorFetches = 0;
    let archiveFetches = 0;
    const { fs, layers: registered } = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [reference],
      fetch: async () => {
        descriptorFetches += 1;
        return new Response(bytes);
      },
      archiveFetch: async () => {
        archiveFetches += 1;
        return new Response(fixture.archive);
      },
    });

    expect(descriptorFetches).toBe(1);
    expect(registered).toHaveLength(1);
    expect(fs.readlink(`${PREFIX}/bin/runtime`)).toBe(
      `${fixture.runtimeKeg}/bin/runtime`,
    );
    expect(fs.exportLazyArchiveEntries()[0]).toMatchObject({
      url: descriptorTree(fixture.descriptor).transports[0].url,
      integrity: {
        sha256: descriptorTree(fixture.descriptor).content.sha256,
        bytes: fixture.archive.byteLength,
      },
    });

    await expect(
      fs.ensureMaterialized(`${fixture.runtimeKeg}/bin/runtime`),
    ).resolves.toBe(true);
    expect(readVfsFile(fs, `${fixture.runtimeKeg}/bin/runtime`))
      .toContain("echo runtime");
    expect(archiveFetches).toBe(1);
  });

  it("keeps the original bottle immutable and applies receipt relocation on first use", async () => {
    const receipt = JSON.stringify({
      changed_files: ["INSTALL_RECEIPT.json", "lib/runtime.conf"],
      source: { path: "@@HOMEBREW_LIBRARY@@/Formula/runtime.rb" },
    }) + "\n";
    const fixture = await runtimeLayerConsumerFixture({
      runtimeReceipt: receipt,
      runtimeExtraEntries: [{
        path: "runtime/3.0/lib/runtime.conf",
        data: "prefix=@@HOMEBREW_PREFIX@@\ncellar=@@HOMEBREW_CELLAR@@\n",
        mode: 0o640,
      }],
    });
    const tree = descriptorTree(fixture.descriptor);
    expect(tree.content.sha256).toBe(sha256(fixture.runtimeBytes));
    expect(tree.content.bytes).toBe(fixture.runtimeBytes.byteLength);
    expect(tree.inventory.entries.filter((entry) =>
      entry.materialization === "archive-homebrew-relocate"
    ).map((entry) => entry.source_path).sort()).toEqual([
      "runtime/3.0/INSTALL_RECEIPT.json",
      "runtime/3.0/lib/runtime.conf",
    ]);

    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference],
      fetch: async () => new Response(runtime.bytes),
      archiveFetch: async () => new Response(fixture.runtimeBytes),
    });
    await expect(
      composed.fs.ensureMaterialized(`${fixture.runtimeKeg}/lib/runtime.conf`),
    ).resolves.toBe(true);
    expect(readVfsFile(composed.fs, `${fixture.runtimeKeg}/lib/runtime.conf`)).toBe(
      `prefix=${PREFIX}\ncellar=${CELLAR}\n`,
    );
    expect(JSON.parse(
      readVfsFile(composed.fs, `${fixture.runtimeKeg}/INSTALL_RECEIPT.json`),
    )).toMatchObject({
      source: { path: `${PREFIX}/Library/Formula/runtime.rb` },
    });
    expect(composed.fs.stat(`${fixture.runtimeKeg}/lib/runtime.conf`).mode & 0o7777)
      .toBe(0o640);
  });

  it("accepts upstream null changed_files as an empty relocation set", async () => {
    const fixture = await runtimeLayerConsumerFixture({
      runtimeReceipt: JSON.stringify({ changed_files: null }) + "\n",
    });
    expect(descriptorTree(fixture.descriptor).inventory.entries.filter((entry) =>
      entry.materialization === "archive-homebrew-relocate"
    )).toEqual([]);

    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference],
      fetch: async () => new Response(runtime.bytes),
      archiveFetch: async () => new Response(fixture.runtimeBytes),
    });
    await expect(
      composed.fs.ensureMaterialized(`${fixture.runtimeKeg}/bin/runtime`),
    ).resolves.toBe(true);
    expect(JSON.parse(
      readVfsFile(composed.fs, `${fixture.runtimeKeg}/INSTALL_RECEIPT.json`),
    )).toEqual({ changed_files: null });
  });

  it("relocates a lazy receipt-declared hardlink once for every inode alias", async () => {
    const fixture = await runtimeLayerConsumerFixture({
      runtimeReceipt: JSON.stringify({
        changed_files: ["lib/runtime.conf", "lib/runtime-alias.conf"],
      }) + "\n",
      runtimeExtraEntries: [{
        path: "runtime/3.0/lib/runtime-alias.conf",
        type: "hardlink",
        linkName: "runtime/3.0/lib/runtime.conf",
      }, {
        path: "runtime/3.0/lib/runtime.conf",
        data: "@@HOMEBREW_PREFIX@@\n",
        mode: 0o640,
      }],
    });
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference],
      fetch: async () => new Response(runtime.bytes),
      archiveFetch: async () => new Response(fixture.runtimeBytes),
    });

    await expect(
      composed.fs.ensureMaterialized(`${fixture.runtimeKeg}/lib/runtime-alias.conf`),
    ).resolves.toBe(true);
    expect(readVfsFile(composed.fs, `${fixture.runtimeKeg}/lib/runtime.conf`))
      .toBe(`${PREFIX}\n`);
    expect(readVfsFile(composed.fs, `${fixture.runtimeKeg}/lib/runtime-alias.conf`))
      .toBe(`${PREFIX}\n`);
    expect(composed.fs.stat(`${fixture.runtimeKeg}/lib/runtime.conf`).ino)
      .toBe(composed.fs.stat(`${fixture.runtimeKeg}/lib/runtime-alias.conf`).ino);
  });

  it("rejects relocation markers not owned by the immutable bottle receipt", async () => {
    const fixture = await runtimeLayerConsumerFixture({
      runtimeReceipt: JSON.stringify({
        changed_files: ["INSTALL_RECEIPT.json"],
      }) + "\n",
    });
    const executable = descriptorEntries(fixture.descriptor).find((entry) =>
      entry.path.endsWith("/bin/runtime") && entry.type === "file"
    )!;
    executable.materialization = "archive-homebrew-relocate";
    recloseRuntimeLayerDescriptor(fixture.descriptor);
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference],
      fetch: async () => new Response(runtime.bytes),
      archiveFetch: async () => new Response(fixture.runtimeBytes),
    });
    await expect(
      composed.fs.ensureMaterialized(`${fixture.runtimeKeg}/bin/runtime`),
    ).rejects.toThrow(/relocation markers differ from INSTALL_RECEIPT.json/);
  });

  it("rejects a descriptor that hides every relocation named by its bottle receipt", async () => {
    const fixture = await runtimeLayerConsumerFixture({
      runtimeReceipt: JSON.stringify({
        changed_files: ["INSTALL_RECEIPT.json", "lib/runtime.conf"],
        source: { path: "@@HOMEBREW_LIBRARY@@/Formula/runtime.rb" },
      }) + "\n",
      runtimeExtraEntries: [{
        path: "runtime/3.0/lib/runtime.conf",
        data: "@@HOMEBREW_PREFIX@@\n",
      }],
    });
    const tree = descriptorTree(fixture.descriptor);
    const sourceByPath = new Map(
      tree.inventory.source!.entries.map((entry) => [entry.path, entry]),
    );
    for (const entry of tree.inventory.entries) {
      if (entry.materialization !== "archive-homebrew-relocate") continue;
      entry.materialization = "archive";
      const source = sourceByPath.get(entry.source_path)!;
      if (source.type === "file") entry.size = source.size;
    }
    refreshInventory(fixture.descriptor);
    recloseRuntimeLayerDescriptor(fixture.descriptor);
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference],
      fetch: async () => new Response(runtime.bytes),
      archiveFetch: async () => new Response(fixture.runtimeBytes),
    });

    await expect(
      composed.fs.ensureMaterialized(`${fixture.runtimeKeg}/lib/runtime.conf`),
    ).rejects.toThrow(/relocation markers differ from INSTALL_RECEIPT.json/);
  });

  it("composes disjoint selected layers while leaving both archives lazy", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const perlDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);
    const { fs, layers } = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    });

    expect(layers).toHaveLength(2);
    expect(fs.exportLazyArchiveEntries()).toHaveLength(2);
    expect(fs.readlink(`${PREFIX}/bin/runtime`)).toBe(
      `${fixture.runtimeKeg}/bin/runtime`,
    );
    expect(fs.readlink(`${PREFIX}/bin/perl`)).toBe(
      `${perlDescriptor.packages.layer[0].keg}/bin/perl`,
    );
  });

  it("creates one absent mergeable directory for identical claims from two layers", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const sharedPath = `${PREFIX}/shared-prefix`;
    const runtimeDescriptor = withMergeableDirectory(fixture.descriptor, sharedPath);
    const perlDescriptor = runtimeLayerVariant(runtimeDescriptor, "perl");
    const runtime = runtimeLayerReference("runtime", runtimeDescriptor);
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);
    const mkdir = vi.spyOn(MemoryFileSystem.prototype, "mkdir");
    try {
      const composed = await composeHomebrewRuntimeLayers({
        baseImageBytes: fixture.baseImageBytes,
        arch: "wasm32",
        kernelAbi: ABI_VERSION,
        layers: [runtime.reference, perl.reference],
        fetch: async (url) => new Response(responses.get(url)!),
      });
      expect(composed.fs.lstat(sharedPath).mode & 0o170000).toBe(0o040000);
      expect(composed.fs.exportLazyArchiveEntries()).toHaveLength(2);
      expect(mkdir.mock.calls.filter(([path]) => path === sharedPath)).toHaveLength(1);
    } finally {
      mkdir.mockRestore();
    }
  });

  it("reuses an existing real base directory for a schema-5 mergeable claim", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const sharedPath = `${PREFIX}/shared-prefix`;
    const base = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    ensureDirRecursive(base, sharedPath);
    base.chmod(sharedPath, 0o755);
    const baseImageBytes = await base.saveImage();
    const descriptor = withBaseImage(
      withMergeableDirectory(fixture.descriptor, sharedPath),
      baseImageBytes,
    );
    const runtime = runtimeLayerReference("runtime", descriptor);
    const mkdir = vi.spyOn(MemoryFileSystem.prototype, "mkdir");
    try {
      const composed = await composeHomebrewRuntimeLayers({
        baseImageBytes,
        arch: "wasm32",
        kernelAbi: ABI_VERSION,
        layers: [runtime.reference],
        fetch: async () => new Response(runtime.bytes),
      });
      expect(composed.fs.lstat(sharedPath).mode & 0o7777).toBe(0o755);
      expect(mkdir.mock.calls.filter(([path]) => path === sharedPath)).toHaveLength(0);
    } finally {
      mkdir.mockRestore();
    }
  });

  it("rejects mergeable non-directories and unequal duplicate directory modes", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const sharedPath = `${PREFIX}/shared-prefix`;
    const base = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    writeVfsFile(base, sharedPath, "base file", 0o644);
    const baseImageBytes = await base.saveImage();
    const collidingDescriptor = withBaseImage(
      withMergeableDirectory(fixture.descriptor, sharedPath),
      baseImageBytes,
    );
    const colliding = runtimeLayerReference("runtime", collidingDescriptor);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [colliding.reference],
      fetch: async () => new Response(colliding.bytes),
    })).rejects.toThrow(/cannot merge directory/);

    const mismatchedBase = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    ensureDirRecursive(mismatchedBase, sharedPath);
    mismatchedBase.chmod(sharedPath, 0o700);
    const mismatchedBaseImage = await mismatchedBase.saveImage();
    const mismatchedDescriptor = withBaseImage(
      withMergeableDirectory(fixture.descriptor, sharedPath, 0o755),
      mismatchedBaseImage,
    );
    const mismatched = runtimeLayerReference("runtime", mismatchedDescriptor);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: mismatchedBaseImage,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [mismatched.reference],
      fetch: async () => new Response(mismatched.bytes),
    })).rejects.toThrow(/base mode differs from the descriptor/);

    const runtimeDescriptor = withMergeableDirectory(fixture.descriptor, sharedPath, 0o755);
    const perlDescriptor = withMergeableDirectory(
      runtimeLayerVariant(fixture.descriptor, "perl"),
      sharedPath,
      0o700,
    );
    const runtime = runtimeLayerReference("runtime", runtimeDescriptor);
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/conflict at .*shared-prefix/);
  });

  it("keeps keg directories exclusive and schema-4 shared directories base-owned", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const baseWithKeg = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    ensureDirRecursive(baseWithKeg, fixture.runtimeKeg);
    const kegBaseImage = await baseWithKeg.saveImage();
    const kegDescriptor = withBaseImage(fixture.descriptor, kegBaseImage);
    const kegLayer = runtimeLayerReference("runtime", kegDescriptor);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: kegBaseImage,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [kegLayer.reference],
      fetch: async () => new Response(kegLayer.bytes),
    })).rejects.toThrow(/collides with the base/);

    const absentShared = `${PREFIX}/legacy-shared`;
    const legacyDescriptor = asLegacySharedDirectoryLayer(
      withMergeableDirectory(fixture.descriptor, absentShared),
      absentShared,
    );
    const legacy = runtimeLayerReference("runtime", legacyDescriptor);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [legacy.reference],
      fetch: async () => new Response(legacy.bytes),
    })).rejects.toThrow(/does not share an existing base directory/);
  });

  it("rejects closed-schema, path-cap, and archive-cap violations", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    expect(() => parseHomebrewRuntimeLayerDescriptor({
      ...structuredClone(fixture.descriptor),
      unexpected: true,
    })).toThrow(/descriptor has unexpected or missing fields/);

    const missing = structuredClone(fixture.descriptor) as Partial<
      HomebrewLazyLayerDescriptor
    >;
    delete missing.deferred_trees;
    expect(() => parseHomebrewRuntimeLayerDescriptor(missing)).toThrow(
      /descriptor has unexpected or missing fields/,
    );

    const longPath = structuredClone(fixture.descriptor);
    descriptorEntries(longPath).find((entry) => entry.type === "file")!.path =
      `${PREFIX.slice(1)}/${"x".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes)}`;
    expect(() => parseHomebrewRuntimeLayerDescriptor(longPath)).toThrow(
      /path exceeds 4096 bytes/,
    );

    const largeArchive = structuredClone(fixture.descriptor);
    descriptorTree(largeArchive).content.bytes =
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes + 1;
    expect(() => parseHomebrewRuntimeLayerDescriptor(largeArchive)).toThrow(
      /deferred tree .* bytes must be an integer/,
    );
  });

  it("parses 32 requested names while runtime composition remains a one-root contract", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtimeRoot = fixture.descriptor.packages.layer[0]!.name;
    const shellRoots = [
      runtimeRoot,
      ...Array.from(
        { length: 31 },
        (_, index) => `shell-root-${index.toString().padStart(2, "0")}`,
      ),
    ];
    const accepted = structuredClone(fixture.descriptor);
    accepted.selection.requested_packages = shellRoots;
    recloseRuntimeLayerDescriptor(accepted);
    expect(() => parseHomebrewRuntimeLayerDescriptor(accepted)).not.toThrow();
    const acceptedReference = runtimeLayerReference(runtimeRoot, accepted);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [acceptedReference.reference],
      fetch: async () => new Response(acceptedReference.bytes),
    })).rejects.toThrow(/descriptor names a different runtime root/);

    const rejected = structuredClone(accepted);
    rejected.selection.requested_packages = Array.from(
      { length: HOMEBREW_RUNTIME_LAYER_LIMITS.maxRequestedPackages + 1 },
      (_, index) => `root-${index.toString().padStart(3, "0")}`,
    );
    expect(() => parseHomebrewRuntimeLayerDescriptor(rejected)).toThrow(
      new RegExp(`1 to ${HOMEBREW_RUNTIME_LAYER_LIMITS.maxRequestedPackages} entries`),
    );
  });

  it("negotiates original-bottle inventories without reinterpreting legacy ZIP trees", async () => {
    const fixture = await runtimeLayerConsumerFixture();

    const directUnderLegacySchema = structuredClone(fixture.descriptor);
    directUnderLegacySchema.schema = 4;
    expect(() => parseHomebrewRuntimeLayerDescriptor(directUnderLegacySchema))
      .toThrow(/deferred tree 0 has unexpected or missing fields/);

    const missingSource = structuredClone(fixture.descriptor);
    delete descriptorTree(missingSource).inventory.source;
    expect(() => recloseRuntimeLayerDescriptor(missingSource)).toThrow(
      /schema 5 tree .* is not a complete original bottle/,
    );

    const missingBinding = structuredClone(fixture.descriptor);
    delete descriptorTree(missingBinding).package;
    expect(() => recloseRuntimeLayerDescriptor(missingBinding)).toThrow(
      /schema 5 tree .* is not a complete original bottle/,
    );

    const legacy = asLegacySharedDirectoryLayer(
      fixture.descriptor,
      `${PREFIX}/unused-shared-path`,
    );
    expect(() => parseHomebrewRuntimeLayerDescriptor(legacy)).not.toThrow();

    const legacyUnderDirectSchema = structuredClone(legacy);
    legacyUnderDirectSchema.schema = 5;
    expect(() => parseHomebrewRuntimeLayerDescriptor(legacyUnderDirectSchema))
      .toThrow(/deferred tree 0 has unexpected or missing fields/);
  });

  it("binds original-bottle modes and makes link-manifest overrides explicit", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const changedArchiveMode = structuredClone(fixture.descriptor);
    descriptorEntries(changedArchiveMode).find((entry) =>
      entry.type === "file" && entry.materialization === "archive" &&
      entry.path.endsWith("/bin/runtime")
    )!.mode = 0o644;
    recloseRuntimeLayerDescriptor(changedArchiveMode);
    expect(() => parseHomebrewRuntimeLayerDescriptor(changedArchiveMode)).toThrow(
      /archive entry .* differs from source/,
    );

    const copied = await lazyLayerFixture({
      mutateBase(fs) {
        const composition = JSON.parse(readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"));
        composition.packages[0].url =
          "https://example.invalid/bottles/hello.bottle.tar.gz";
        writeVfsFile(
          fs,
          "/etc/kandelo/homebrew-vfs.json",
          `${JSON.stringify(composition)}\n`,
        );
      },
      mutatePlan(plan) {
        for (const pkg of plan.packages) {
          pkg.url = `https://example.invalid/bottles/${pkg.name}.bottle.tar.gz`;
        }
        const runtime = plan.packages.find((pkg) => pkg.name === "runtime")!;
        runtime.linkManifest.links = [{
          type: "file",
          source: "Cellar/runtime/3.0/bin/runtime",
          target: "bin/runtime-copy",
          mode: "0644",
        }];
      },
    });
    const result = await copied.build();
    const copiedEntry = descriptorEntries(result.descriptor).find((entry) =>
      entry.path.endsWith("/bin/runtime-copy")
    )!;
    expect(copiedEntry).toMatchObject({
      type: "file",
      mode: 0o644,
      materialization: "archive-copy-mode",
    });

    const closed = closeRuntimeLayerDraft(result.descriptor);
    const disguised = structuredClone(closed);
    descriptorEntries(disguised).find((entry) =>
      entry.path.endsWith("/bin/runtime-copy")
    )!.materialization = "archive-copy";
    recloseRuntimeLayerDescriptor(disguised);
    expect(() => parseHomebrewRuntimeLayerDescriptor(disguised)).toThrow(
      /archive copy .* differs from source/,
    );

    const amplified = structuredClone(fixture.descriptor);
    const sourceFile = descriptorEntries(amplified).find((entry) =>
      entry.type === "file" && entry.path.endsWith("/bin/runtime")
    )!;
    for (let index = 0; index < 600; index += 1) {
      descriptorEntries(amplified).push({
        path: `${PREFIX.slice(1)}/bin/runtime-copy-${String(index).padStart(3, "0")}`,
        source_path: sourceFile.source_path,
        materialization: "archive-copy",
        type: "file",
        ownership: "layer",
        mode: sourceFile.mode,
        size: sourceFile.size,
        inode_group: `runtime:copy:${index}`,
      });
    }
    descriptorEntries(amplified).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    refreshInventory(amplified);
    recloseRuntimeLayerDescriptor(amplified);
    expect(descriptorTree(amplified).inventory.payload_bytes).toBeGreaterThan(
      descriptorTree(amplified).inventory.expanded_bytes,
    );
    expect(() => parseHomebrewRuntimeLayerDescriptor(amplified)).not.toThrow();
  });

  it("confines archive symlinks to their keg and requires their real 0777 mode", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const withArchiveSymlink = () => {
      const descriptor = structuredClone(fixture.descriptor);
      const tree = descriptorTree(descriptor);
      const sourcePath = "runtime/3.0/bin/runtime-link";
      const guestPath = `${fixture.runtimeKeg.slice(1)}/bin/runtime-link`;
      tree.inventory.source!.entries.push({
        path: sourcePath,
        type: "symlink",
        mode: 0o777,
        size: 0,
        target: "runtime",
      });
      tree.inventory.entries.push({
        path: guestPath,
        source_path: sourcePath,
        materialization: "archive",
        type: "symlink",
        ownership: "layer",
        mode: 0o777,
        size: utf8("runtime").byteLength,
        target: "runtime",
      });
      tree.inventory.source!.entries.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
      tree.inventory.entries.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
      refreshInventory(descriptor);
      recloseRuntimeLayerDescriptor(descriptor);
      return { descriptor, sourcePath, guestPath };
    };

    const valid = withArchiveSymlink();
    expect(() => parseHomebrewRuntimeLayerDescriptor(valid.descriptor)).not.toThrow();

    for (const [target, message] of [
      ["/tmp/outside", /target must be relative/],
      ["../../outside", /escapes its keg/],
    ] as const) {
      const escaped = withArchiveSymlink();
      const tree = descriptorTree(escaped.descriptor);
      tree.inventory.source!.entries.find((entry) => entry.path === escaped.sourcePath)!.target =
        target;
      const guest = tree.inventory.entries.find((entry) => entry.path === escaped.guestPath)!;
      guest.target = target;
      guest.size = utf8(target).byteLength;
      recloseRuntimeLayerDescriptor(escaped.descriptor);
      expect(() => parseHomebrewRuntimeLayerDescriptor(escaped.descriptor)).toThrow(message);
    }

    const wrongMode = withArchiveSymlink();
    const wrongModeTree = descriptorTree(wrongMode.descriptor);
    wrongModeTree.inventory.source!.entries.find(
      (entry) => entry.path === wrongMode.sourcePath,
    )!.mode = 0o755;
    wrongModeTree.inventory.entries.find(
      (entry) => entry.path === wrongMode.guestPath,
    )!.mode = 0o755;
    recloseRuntimeLayerDescriptor(wrongMode.descriptor);
    expect(() => parseHomebrewRuntimeLayerDescriptor(wrongMode.descriptor)).toThrow(
      /symlink mode must be 0777/,
    );
  });

  it("binds each direct tree to its own package keg, opt link, and root identity", async () => {
    const fixture = await runtimeLayerConsumerFixture({ includeLayerDependency: true });
    const dependency = fixture.descriptor.deferred_trees.find((tree) =>
      tree.package?.endsWith("/runtime-dep")
    )!;

    const crossedKeg = structuredClone(fixture.descriptor);
    const crossedDependency = crossedKeg.deferred_trees.find((tree) =>
      tree.package?.endsWith("/runtime-dep")
    )!;
    crossedDependency.inventory.entries.find((entry) =>
      entry.type === "file" && entry.materialization === "archive"
    )!.path = `${fixture.runtimeKeg.slice(1)}/bin/foreign-dependency`;
    crossedDependency.inventory.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    recloseRuntimeLayerDescriptor(crossedKeg);
    expect(() => parseHomebrewRuntimeLayerDescriptor(crossedKeg)).toThrow(
      /maps an archive member outside its keg/,
    );

    const swappedActivation = structuredClone(fixture.descriptor);
    swappedActivation.deferred_trees.find((tree) => tree.id === dependency.id)!
      .activation.roots = [fixture.runtimeKeg];
    recloseRuntimeLayerDescriptor(swappedActivation);
    expect(() => parseHomebrewRuntimeLayerDescriptor(swappedActivation)).toThrow(
      /root .* is unowned|activation differs from its keg/,
    );

    const changedPackageOnly = structuredClone(fixture.descriptor);
    changedPackageOnly.deferred_trees.find((tree) => tree.id === dependency.id)!.package =
      "kandelo-dev/tap-core/runtime";
    expect(sha256(canonicalHomebrewRuntimeLayerBundleIdentityBytes(changedPackageOnly)))
      .not.toBe(sha256(canonicalHomebrewRuntimeLayerBundleIdentityBytes(fixture.descriptor)));
    expect(() => parseHomebrewRuntimeLayerDescriptor(changedPackageOnly)).toThrow(
      /bundle identity|bottle tree differs from package/,
    );

    const wrongRoot = structuredClone(fixture.descriptor);
    const rootTree = wrongRoot.deferred_trees.find((tree) => tree.id === "runtime")!;
    const replacementId = `${dependency.id}-replacement`;
    rootTree.id = replacementId;
    rootTree.activation.capabilities = [`homebrew-bottle:${replacementId}`];
    rootTree.transports.find((transport) => transport.kind === "bundle-release")!.asset =
      `kandelo-homebrew-${replacementId}-layer.bin`;
    wrongRoot.bundle.assets.deferred_trees.find((tree) => tree.id === "runtime")!.id =
      replacementId;
    wrongRoot.bundle.assets.deferred_trees.find((tree) => tree.id === replacementId)!.asset =
      `kandelo-homebrew-${replacementId}-layer.bin`;
    wrongRoot.deferred_trees.sort((left, right) => left.id.localeCompare(right.id));
    wrongRoot.bundle.assets.deferred_trees.sort((left, right) => left.id.localeCompare(right.id));
    recloseRuntimeLayerDescriptor(wrongRoot);
    const encoded = runtimeLayerReference("runtime", wrongRoot);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
    })).rejects.toThrow(/root tree differs from its selected package/);
  });

  it("rejects an incomplete aggregate bottle namespace before registration", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const incomplete = structuredClone(fixture.descriptor);
    const tree = descriptorTree(incomplete);
    const omitted = tree.inventory.entries.find((entry) =>
      entry.type === "directory" &&
      entry.path === PREFIX.slice(1)
    )!;
    tree.inventory.entries = tree.inventory.entries.filter((entry) => entry !== omitted);
    refreshInventory(incomplete);
    recloseRuntimeLayerDescriptor(incomplete);

    expect(() => parseHomebrewRuntimeLayerDescriptor(incomplete)).toThrow(
      `original-bottle inventory omits directory /${omitted.path}`,
    );
  });

  it("enforces exact package-keg and mergeable directory ownership", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    for (const mutation of [
      {
        path: PREFIX.slice(1),
        ownership: "layer" as const,
        expected: "mergeable-directory",
      },
      {
        path: `${fixture.runtimeKeg.slice(1)}/bin`,
        ownership: "mergeable-directory" as const,
        expected: "layer",
      },
    ]) {
      const descriptor = structuredClone(fixture.descriptor);
      const entry = descriptorTree(descriptor).inventory.entries.find(
        (candidate) => candidate.path === mutation.path,
      )!;
      entry.ownership = mutation.ownership;
      refreshInventory(descriptor);
      recloseRuntimeLayerDescriptor(descriptor);
      expect(() => parseHomebrewRuntimeLayerDescriptor(descriptor)).toThrow(
        `directory /${mutation.path} must have ${mutation.expected} ownership`,
      );
    }
  });

  it("restores multiple original bottles and fetches each complete bottle independently", async () => {
    const fixture = await runtimeLayerConsumerFixture({ includeLayerDependency: true });
    const dependencyTree = fixture.descriptor.deferred_trees.find((tree) =>
      tree.package?.endsWith("/runtime-dep")
    )!;
    const sourceAlias = dependencyTree.inventory.source!.entries.find((entry) =>
      entry.path.endsWith("/runtime-dep-alias-2")
    )!;
    const guestAlias = dependencyTree.inventory.entries.find((entry) =>
      entry.path.endsWith("/runtime-dep-alias-2")
    )!;
    expect(sourceAlias.target).toBe(
      `runtime-dep/1.0/bin/runtime-dep-alias`,
    );
    expect(guestAlias.target).toBe(
      `${fixture.dependencyKeg.slice(1)}/bin/runtime-dep-alias`,
    );
    const encoded = runtimeLayerReference("runtime", fixture.descriptor);
    const payloadByUrl = new Map<string, Uint8Array>();
    for (const tree of fixture.descriptor.deferred_trees) {
      const release = bundleReleaseTransport(tree);
      payloadByUrl.set(
        release.url,
        fixture.payloads.find((payload) => payload.id === tree.id)!.bytes,
      );
    }
    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
      archiveFetch: async (url) => new Response(payloadByUrl.get(url)!),
    });
    const serialized = await composed.fs.saveImage();
    const restored = MemoryFileSystem.fromImage(serialized);
    const fetched: string[] = [];
    restored.setLazyFetcher(async (url) => {
      fetched.push(url);
      return new Response(payloadByUrl.get(url)!);
    });

    expect(restored.exportLazyArchiveEntries()).toHaveLength(2);
    expect(() => restored.lstat(`${fixture.runtimeKeg}/bin/runtime`)).not.toThrow();
    expect(() => restored.lstat(`${fixture.dependencyKeg}/bin/runtime-dep`)).not.toThrow();
    expect(fetched).toEqual([]);

    await expect(restored.ensureMaterialized(`${fixture.runtimeKeg}/bin/runtime`))
      .resolves.toBe(true);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("kandelo-homebrew-runtime-layer.bin");
    expect(readVfsFile(restored, `${fixture.runtimeKeg}/bin/runtime`))
      .toContain("echo runtime");

    const partitioned = MemoryFileSystem.fromImage(await restored.saveImage());
    const pendingAfterEmbedding = partitioned.exportLazyArchiveEntries();
    expect(pendingAfterEmbedding).toHaveLength(1);
    expect(JSON.stringify(pendingAfterEmbedding)).toContain("runtime-dep");
    expect(JSON.stringify(pendingAfterEmbedding)).not.toContain(
      "kandelo-homebrew-runtime-layer.bin",
    );

    await expect(restored.ensureMaterialized(`${fixture.dependencyKeg}/bin/runtime-dep-alias-2`))
      .resolves.toBe(true);
    expect(fetched).toHaveLength(2);
    expect(fetched[1]).not.toBe(fetched[0]);
    const original = restored.lstat(`${fixture.dependencyKeg}/bin/runtime-dep`);
    const alias = restored.lstat(`${fixture.dependencyKeg}/bin/runtime-dep-alias`);
    const chainedAlias = restored.lstat(`${fixture.dependencyKeg}/bin/runtime-dep-alias-2`);
    expect(alias.ino).toBe(original.ino);
    expect(chainedAlias.ino).toBe(original.ino);
    expect(readVfsFile(restored, `${fixture.dependencyKeg}/bin/runtime-dep-alias-2`))
      .toBe("dependency payload\n");
  });

  it("resolves descriptor hardlink chains and rejects a cyclic tail", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    const file = descriptorEntries(descriptor).find((entry) => entry.type === "file")!;
    let target = file.path;
    let sourceTarget = file.source_path;
    const addedPaths: string[] = [];
    for (const suffix of ["a", "b", "c"]) {
      const path = `${file.path}-hardlink-${suffix}`;
      addedPaths.push(path);
      descriptorEntries(descriptor).push({
        path,
        source_path: `${file.source_path}-hardlink-${suffix}`,
        materialization: "archive",
        type: "hardlink",
        ownership: "layer",
        mode: file.mode,
        size: file.size,
        target,
        inode_group: file.inode_group,
      });
      descriptorTree(descriptor).inventory.source!.entries.push({
        path: `${file.source_path}-hardlink-${suffix}`,
        type: "hardlink",
        mode: file.mode,
        size: 0,
        target: sourceTarget,
      });
      target = path;
      sourceTarget = `${file.source_path}-hardlink-${suffix}`;
    }
    descriptorEntries(descriptor).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    descriptorTree(descriptor).inventory.source!.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    refreshInventory(descriptor);

    expect(() => parseHomebrewRuntimeLayerDescriptor(descriptor)).not.toThrow();

    const cyclic = structuredClone(descriptor);
    const links = addedPaths.map((path) =>
      descriptorEntries(cyclic).find((entry) => entry.path === path)!
    );
    links[0].target = links[links.length - 1].path;
    expect(() => parseHomebrewRuntimeLayerDescriptor(cyclic))
      .toThrow(/cycle reaches/);
  });

  it("binds every layer package to its declared keg, opt link, and tap provenance", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const missingKeg = structuredClone(fixture.descriptor);
    const missingKegPackage = missingKeg.packages.layer[0];
    missingKegPackage.keg = `${PREFIX}/Cellar/runtime/missing`;
    missingKegPackage.opt_link.target = "../Cellar/runtime/missing";
    expect(() => parseHomebrewRuntimeLayerDescriptor(missingKeg)).toThrow(
      /activation differs from its keg|has no layer-owned keg entry/,
    );

    const wrongOpt = structuredClone(fixture.descriptor);
    const optPath = `${PREFIX.slice(1)}/${wrongOpt.packages.layer[0].opt_link.path}`;
    const optEntry = descriptorEntries(wrongOpt).find((entry) => entry.path === optPath)!;
    optEntry.target = "../Cellar/runtime/wrong";
    optEntry.size = utf8(optEntry.target).byteLength;
    refreshInventory(wrongOpt);
    expect(() => parseHomebrewRuntimeLayerDescriptor(wrongOpt)).toThrow(
      /does not own its keg and opt link|has no matching opt link entry/,
    );

    const wrongProvenance = structuredClone(fixture.descriptor);
    wrongProvenance.packages.layer[0].built_from!.kandelo_repository =
      "other/kandelo";
    expect(() => parseHomebrewRuntimeLayerDescriptor(wrongProvenance)).toThrow(
      /build provenance differs from its tap lock/,
    );
  });

  it("enforces layer-count, descriptor-byte, and reference-shape caps before fetch", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const exact = runtimeLayerReference("runtime", fixture.descriptor);
    let fetches = 0;
    const fetch = async () => {
      fetches += 1;
      return new Response(exact.bytes);
    };

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: Array.from(
        { length: HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers + 1 },
        (_, index) => ({
          id: `layer-${index}`,
          descriptor: {
            url: `https://example.invalid/layer-${index}.json`,
            sha256: index.toString(16).padStart(64, "0"),
            bytes: 1,
          },
        }),
      ),
      fetch,
    })).rejects.toThrow(/layer count .* exceeds/);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [{
        ...exact.reference,
        id: "a".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackageNameBytes + 1),
      }],
      fetch,
    })).rejects.toThrow(/reference 0 id is not a bounded Homebrew runtime-layer id/);

    const half = Math.floor(HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes / 2) + 1;
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [
        { ...exact.reference, descriptor: { ...exact.reference.descriptor, bytes: half } },
        {
          id: "perl",
          descriptor: {
            url: "https://example.invalid/layers/perl.json",
            sha256: "2".repeat(64),
            bytes: half,
          },
        },
      ],
      fetch,
    })).rejects.toThrow(/descriptors exceed/);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [{
        ...exact.reference,
        unexpected: true,
      } as HomebrewRuntimeLayerReference],
      fetch,
    })).rejects.toThrow(/reference 0 has unexpected or missing fields/);
    expect(fetches).toBe(0);
  });

  it("accepts exact per-tree and aggregate byte boundaries", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtimeDescriptor = structuredClone(fixture.descriptor);
    const perlDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    for (const descriptor of [runtimeDescriptor, perlDescriptor]) {
      const tree = descriptorTree(descriptor);
      tree.content.bytes = HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes;
      tree.inventory.expanded_bytes =
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes;
      descriptor.packages.layer[0].bytes = tree.content.bytes;
      recloseRuntimeLayerDescriptor(descriptor);
    }
    const runtime = runtimeLayerReference("runtime", runtimeDescriptor);
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);

    const composed = await composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    });
    expect(composed.fs.pendingDeferredTreeUsage()).toMatchObject({
      archiveBytes: HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionArchiveBytes,
      expandedBytes: HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionExpandedBytes,
    });
    const restored = MemoryFileSystem.fromImage(await composed.fs.saveImage());
    expect(restored.pendingDeferredTreeUsage()).toEqual(
      composed.fs.pendingDeferredTreeUsage(),
    );
  });

  it("rejects aggregate uncompressed size before changing the VFS", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptors = [
      structuredClone(fixture.descriptor),
      runtimeLayerVariant(fixture.descriptor, "perl"),
      runtimeLayerVariant(fixture.descriptor, "ruby"),
    ];
    const declaredSize = Math.floor(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionExpandedBytes /
        descriptors.length,
    ) + 1;
    for (const descriptor of descriptors) {
      descriptorTree(descriptor).inventory.expanded_bytes = declaredSize;
      recloseRuntimeLayerDescriptor(descriptor);
    }
    const references = ["runtime", "perl", "ruby"].map((name, index) =>
      runtimeLayerReference(name, descriptors[index]!)
    );
    const responses = new Map(
      references.map((reference) => [
        reference.reference.descriptor.url,
        reference.bytes,
      ]),
    );
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: references.map((reference) => reference.reference),
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/expansion cap/i);
    expect(() => fs.lstat(fixture.runtimeKeg)).toThrow();
    for (const descriptor of descriptors.slice(1)) {
      expect(() => fs.lstat(descriptor.packages.layer[0].keg)).toThrow();
    }
  });

  it("caps packages across layers and counts pending base trees before registration", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const ids = Array.from(
      { length: HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages + 1 },
      (_, index) => `package-${index.toString().padStart(3, "0")}`,
    );
    const first = runtimeLayerCollection(fixture.descriptor, ids.slice(0, 256));
    const secondOver = runtimeLayerCollection(fixture.descriptor, ids.slice(256));
    const firstReference = runtimeLayerReference(ids[0]!, first);
    const secondOverReference = runtimeLayerReference(ids[256]!, secondOver);
    const overResponses = new Map([
      [firstReference.reference.descriptor.url, firstReference.bytes],
      [secondOverReference.reference.descriptor.url, secondOverReference.bytes],
    ]);
    const register = vi.spyOn(MemoryFileSystem.prototype, "registerLazyTree");
    try {
      await expect(composeHomebrewRuntimeLayers({
        baseImageBytes: fixture.baseImageBytes,
        arch: "wasm32",
        kernelAbi: ABI_VERSION,
        layers: [firstReference.reference, secondOverReference.reference],
        fetch: async (url) => new Response(overResponses.get(url)!),
      })).rejects.toThrow(/513 layer-owned packages; maximum is 512/);
      expect(register).not.toHaveBeenCalled();

      const base = MemoryFileSystem.fromImage(fixture.baseImageBytes);
      base.registerLazyTree({
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: "9".repeat(64),
        bytes: 1,
        expandedBytes: 1,
        sourceEntryCount: 1,
        transports: ["https://example.invalid/base-pending.zip"],
      }, [{
        vfsPath: "/base-pending/file",
        sourcePath: "base-pending/file",
        type: "file",
        mode: 0o644,
        size: 1,
        inodeGroup: "base-pending:file",
      }], "/", {
        mode: "first-use",
        capabilities: ["test:base-pending"],
        roots: ["/base-pending"],
      });
      const baseWithPendingTree = await base.saveImage();
      const secondBoundary = truncateRuntimeLayerCollection(secondOver, 256);
      const boundFirst = withBaseImage(first, baseWithPendingTree);
      const boundSecond = withBaseImage(secondBoundary, baseWithPendingTree);
      const boundFirstReference = runtimeLayerReference(ids[0]!, boundFirst);
      const boundSecondReference = runtimeLayerReference(ids[256]!, boundSecond);
      const boundaryResponses = new Map([
        [boundFirstReference.reference.descriptor.url, boundFirstReference.bytes],
        [boundSecondReference.reference.descriptor.url, boundSecondReference.bytes],
      ]);
      register.mockClear();
      await expect(composeHomebrewRuntimeLayers({
        baseImageBytes: baseWithPendingTree,
        arch: "wasm32",
        kernelAbi: ABI_VERSION,
        layers: [boundFirstReference.reference, boundSecondReference.reference],
        fetch: async (url) => new Response(boundaryResponses.get(url)!),
      })).rejects.toThrow(/513 deferred trees .* maximum is 512/);
      expect(register).not.toHaveBeenCalled();
    } finally {
      register.mockRestore();
    }
  }, 120_000);

  it("reports each unpublished staged filesystem exactly once across failure phases", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const exact = runtimeLayerReference("runtime", fixture.descriptor);
    let discarded = 0;
    const onStagedFileSystemDiscarded = (buffer: SharedArrayBuffer) => {
      discarded += 1;
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(buffer.byteLength).toBeGreaterThan(0);
    };

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: Array.from(
        { length: HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers + 1 },
        (_, index) => ({
          id: `layer-${index}`,
          descriptor: {
            url: `https://example.invalid/layer-${index}.json`,
            sha256: index.toString(16).padStart(64, "0"),
            bytes: 1,
          },
        }),
      ),
      onStagedFileSystemDiscarded,
    })).rejects.toThrow(/layer count .* exceeds/);
    expect(discarded).toBe(1);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [exact.reference],
      fetch: async () => {
        throw new Error("descriptor transport offline");
      },
      onStagedFileSystemDiscarded,
    })).rejects.toThrow("descriptor transport offline");
    expect(discarded).toBe(2);

    const prefetchDescriptor = structuredClone(fixture.descriptor);
    descriptorTree(prefetchDescriptor).activation.mode = "boot-prefetch";
    recloseRuntimeLayerDescriptor(prefetchDescriptor);
    const prefetch = runtimeLayerReference("runtime", prefetchDescriptor);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [prefetch.reference],
      fetch: async () => new Response(prefetch.bytes),
      archiveFetch: async () => {
        throw new Error("boot transport offline");
      },
      onStagedFileSystemDiscarded,
    })).rejects.toThrow("boot transport offline");
    expect(discarded).toBe(3);
  });

  it("does not report a published stage or let a discard observer mask the failure", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const exact = runtimeLayerReference("runtime", fixture.descriptor);
    let discarded = 0;
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [exact.reference],
      fetch: async () => new Response(exact.bytes),
      onStagedFileSystemDiscarded: () => {
        discarded += 1;
      },
    })).resolves.toMatchObject({ layers: [{ id: "runtime" }] });
    expect(discarded).toBe(0);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: Array.from(
        { length: HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers + 1 },
        (_, index) => ({
          id: `layer-${index}`,
          descriptor: {
            url: `https://example.invalid/layer-${index}.json`,
            sha256: index.toString(16).padStart(64, "0"),
            bytes: 1,
          },
        }),
      ),
      onStagedFileSystemDiscarded: () => {
        throw new Error("observer failure");
      },
    })).rejects.toThrow(/layer count .* exceeds/);
  });

  it("rejects aggregate compressed size before changing the VFS", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptors = [
      structuredClone(fixture.descriptor),
      runtimeLayerVariant(fixture.descriptor, "perl"),
      runtimeLayerVariant(fixture.descriptor, "ruby"),
    ];
    const declaredSize = Math.floor(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionArchiveBytes /
        descriptors.length,
    ) + 1;
    for (const descriptor of descriptors) {
      descriptorTree(descriptor).content.bytes = declaredSize;
      descriptor.packages.layer[0].bytes = declaredSize;
      recloseRuntimeLayerDescriptor(descriptor);
    }
    const references = ["runtime", "perl", "ruby"].map((name, index) =>
      runtimeLayerReference(name, descriptors[index]!)
    );
    const responses = new Map(
      references.map((reference) => [
        reference.reference.descriptor.url,
        reference.bytes,
      ]),
    );
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: references.map((reference) => reference.reference),
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/archive-byte cap/i);
    expect(() => fs.lstat(fixture.runtimeKeg)).toThrow();
    for (const descriptor of descriptors.slice(1)) {
      expect(() => fs.lstat(descriptor.packages.layer[0].keg)).toThrow();
    }
  });

  it("publishes no filesystem when a late second-layer allocation exhausts space", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const perlDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    const tree = descriptorTree(perlDescriptor);
    const bulkRoot = `${perlDescriptor.packages.layer[0].keg.slice(1)}/bulk`;
    tree.inventory.entries.push({
      path: bulkRoot,
      source_path: `.kandelo-descriptor/perl/bulk`,
      materialization: "descriptor",
      type: "directory",
      ownership: "layer",
      mode: 0o755,
      size: 0,
    });
    for (let index = 0; index < 20_000; index += 1) {
      const path = `${bulkRoot}/entry-${index.toString().padStart(5, "0")}`;
      const sourcePath = `perl/3.0/bulk/entry-${index.toString().padStart(5, "0")}`;
      tree.inventory.entries.push({
        path,
        source_path: sourcePath,
        materialization: "archive",
        type: "file",
        ownership: "layer",
        mode: 0o644,
        size: 0,
        inode_group: `bulk:${index}`,
      });
      tree.inventory.source!.entries.push({
        path: sourcePath,
        type: "file",
        mode: 0o644,
        size: 0,
      });
    }
    tree.inventory.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    tree.inventory.source!.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    refreshInventory(perlDescriptor);
    recloseRuntimeLayerDescriptor(perlDescriptor);
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);
    const untouched = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/no space|ENOSPC/i);
    expect(() => untouched.lstat(fixture.runtimeKeg)).toThrow();
    expect(() => untouched.lstat(perlDescriptor.packages.layer[0].keg)).toThrow();
  }, 30_000);

  it("keeps caller-owned shared state intact when boot-prefetch fails", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    descriptorTree(descriptor).activation.mode = "boot-prefetch";
    recloseRuntimeLayerDescriptor(descriptor);
    const encoded = runtimeLayerReference("runtime", descriptor);
    const owner = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
    let releaseDescriptor!: () => void;
    const descriptorGate = new Promise<void>((resolve) => {
      releaseDescriptor = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const composition = composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => {
        markFetchStarted();
        await descriptorGate;
        return new Response(encoded.bytes);
      },
      archiveFetch: async () => {
        throw new Error("boot transport offline");
      },
    });

    await fetchStarted;
    writeVfsFile(peer, "/peer-owned", "survives\n", 0o644);
    releaseDescriptor();
    await expect(composition).rejects.toThrow("boot transport offline");
    expect(readVfsFile(owner, "/peer-owned")).toBe("survives\n");
    expect(() => owner.lstat(fixture.runtimeKeg)).toThrow();
  });

  it("rejects reused archive identities and cross-layer directory ownership", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const duplicateArchiveDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    descriptorTree(duplicateArchiveDescriptor).content.sha256 =
      descriptorTree(fixture.descriptor).content.sha256;
    duplicateArchiveDescriptor.packages.layer[0].sha256 =
      descriptorTree(fixture.descriptor).content.sha256;
    recloseRuntimeLayerDescriptor(duplicateArchiveDescriptor);
    const duplicateArchive = runtimeLayerReference("perl", duplicateArchiveDescriptor);
    let responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [duplicateArchive.reference.descriptor.url, duplicateArchive.bytes],
    ]);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, duplicateArchive.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/reuses another deferred tree/);

    const nestedDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    descriptorEntries(nestedDescriptor).find((entry) => entry.type === "file")!.path =
      `${fixture.runtimeKeg.slice(1)}/foreign-perl`;
    descriptorEntries(nestedDescriptor).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    recloseRuntimeLayerDescriptor(nestedDescriptor);
    const nested = runtimeLayerReference("perl", nestedDescriptor);
    responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [nested.reference.descriptor.url, nested.bytes],
    ]);
    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, nested.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(
      /original-bottle inventory omits directory|maps an archive member outside its keg|descends through runtime-owned directory/,
    );
  });

  it("rejects a shell composition digest mismatch before changing the VFS", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    descriptor.base_vfs.composition.package_set_sha256 = "9".repeat(64);
    recloseRuntimeLayerDescriptor(descriptor);
    const encoded = runtimeLayerReference("runtime", descriptor);
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
    })).rejects.toThrow(/does not bind the shell composition/);
    expect(() => fs.lstat(fixture.runtimeKeg)).toThrow();
  });

  it("rejects descriptor size and digest mismatches before parsing", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const exact = runtimeLayerReference("runtime", fixture.descriptor);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [{
        ...exact.reference,
        descriptor: { ...exact.reference.descriptor, bytes: exact.bytes.byteLength - 1 },
      }],
      fetch: async () => new Response(exact.bytes),
    })).rejects.toThrow(/descriptor exceeds expected/);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [{
        ...exact.reference,
        descriptor: { ...exact.reference.descriptor, sha256: "0".repeat(64) },
      }],
      fetch: async () => new Response(exact.bytes),
    })).rejects.toThrow(/descriptor SHA-256 .* does not match/);
  });

  it("rejects a descriptor that does not bind the exact loaded shell", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    descriptor.base_vfs.sha256 = "9".repeat(64);
    descriptor.base_vfs.package_source.output.sha256 = "9".repeat(64);
    recloseRuntimeLayerDescriptor(descriptor);
    const encoded = runtimeLayerReference("runtime", descriptor);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
    })).rejects.toThrow(/does not bind the loaded shell image/);
  });

  it("rejects unsafe descriptor paths before changing the VFS", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    descriptorEntries(descriptor)[0].path = "../escape";
    const encoded = runtimeLayerReference("runtime", descriptor);
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
    })).rejects.toThrow(/canonical relative POSIX path/);
    expect(() => fs.lstat("/escape")).toThrow();
  });

  it("rejects a layer path that collides with the exact base filesystem", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    const file = descriptorEntries(descriptor).find((entry) => entry.type === "file")!;
    file.path = `${KEG.slice(1)}/bin/hello`;
    descriptorEntries(descriptor).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    recloseRuntimeLayerDescriptor(descriptor);
    const encoded = runtimeLayerReference("runtime", descriptor);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
    })).rejects.toThrow(
      /original-bottle inventory omits directory|maps an archive member outside its keg|collides with the base/,
    );
  });

  it("rejects pairwise path conflicts between independently named layers", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const perlDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    const runtimeFile = descriptorEntries(fixture.descriptor).find(
      (entry) => entry.type === "file",
    )!;
    const perlFile = descriptorEntries(perlDescriptor).find((entry) => entry.type === "file")!;
    perlFile.path = runtimeFile.path;
    descriptorEntries(perlDescriptor).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    recloseRuntimeLayerDescriptor(perlDescriptor);
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);

    await expect(composeHomebrewRuntimeLayers({
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(
      /original-bottle inventory omits directory|maps an archive member outside its keg|conflict at/,
    );
  });
});

describe("Homebrew VFS planner public bounds", () => {
  const planFixture = (
    metadata: HomebrewTapMetadata,
    manifest: HomebrewLinkManifest,
    packages = [metadata.packages[0]!.name],
  ) => planHomebrewVfs(metadata, {
    packages,
    arch: "wasm32",
    runtime: "node",
    loadLinkManifest: () => manifest,
  });

  it("derives deferred-tree wire limits from the generic reload contract", () => {
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxEntries,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionArchiveBytes).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionExpandedBytes).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxExpandedBytes,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionPayloadBytes).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxPayloadBytes,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionEntries).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxEntries,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxTransportsPerTree).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilities).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationRoots).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxActivationRoots,
    );
    expect(HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilityBytes).toBe(
      VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes,
    );
  });

  it("accepts exact UTF-8 byte limits for every public string-bound class", async () => {
    const bytes = bottleTar(standardEntries());

    const generic = structuredClone(metadataForBottle(bytes));
    generic.generator = "é".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxStringBytes / 2);
    expect(utf8(generic.generator)).toHaveLength(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxStringBytes,
    );
    await expect(planFixture(generic, linkManifest(bytes))).resolves.toBeDefined();

    const pathMetadata = structuredClone(metadataForBottle(bytes));
    const pathManifest = structuredClone(linkManifest(bytes));
    pathManifest.receipts = ["a".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes)];
    await expect(planFixture(pathMetadata, pathManifest)).resolves.toBeDefined();

    const versionMetadata = structuredClone(metadataForBottle(bytes));
    const versionManifest = structuredClone(linkManifest(bytes));
    const version = "é".repeat(128);
    expect(utf8(version)).toHaveLength(256);
    versionMetadata.packages[0]!.version = version;
    versionManifest.version = version;
    await expect(planFixture(versionMetadata, versionManifest)).resolves.toBeDefined();

    const repositoryMetadata = structuredClone(metadataForBottle(bytes));
    const repositoryPrefix = "o/homebrew-";
    const tapSuffix = "r".repeat(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxRepositoryBytes - repositoryPrefix.length,
    );
    repositoryMetadata.tap_repository = `${repositoryPrefix}${tapSuffix}`;
    repositoryMetadata.tap_name = `o/${tapSuffix}`;
    repositoryMetadata.packages[0]!.full_name =
      `${repositoryMetadata.tap_name}/hello`;
    expect(utf8(repositoryMetadata.tap_repository)).toHaveLength(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxRepositoryBytes,
    );
    await expect(planFixture(repositoryMetadata, linkManifest(bytes))).resolves.toBeDefined();

    const fullNameMetadata = structuredClone(metadataForBottle(bytes));
    const longTapSuffix = "t".repeat(254);
    const longPackage = "p".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackageNameBytes);
    fullNameMetadata.tap_repository = `o/homebrew-${longTapSuffix}`;
    fullNameMetadata.tap_name = `o/${longTapSuffix}`;
    fullNameMetadata.packages[0]!.name = longPackage;
    fullNameMetadata.packages[0]!.full_name = `${fullNameMetadata.tap_name}/${longPackage}`;
    const fullNameManifest = structuredClone(linkManifest(bytes));
    fullNameManifest.package = longPackage;
    expect(utf8(fullNameMetadata.packages[0]!.full_name)).toHaveLength(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxRepositoryBytes,
    );
    await expect(planFixture(
      fullNameMetadata,
      fullNameManifest,
      [longPackage],
    )).resolves.toBeDefined();

    const urlMetadata = structuredClone(metadataForBottle(bytes));
    const urlManifest = structuredClone(linkManifest(bytes));
    const urlPrefix = "https://example.invalid/";
    const url = urlPrefix + "u".repeat(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxStringBytes - utf8(urlPrefix).byteLength,
    );
    urlMetadata.packages[0]!.bottles[0]!.url = url;
    urlManifest.bottle.url = url;
    expect(utf8(url)).toHaveLength(HOMEBREW_RUNTIME_LAYER_LIMITS.maxStringBytes);
    await expect(planFixture(urlMetadata, urlManifest)).resolves.toBeDefined();
  });

  it("rejects over-limit and NUL values across metadata and link-manifest fields", async () => {
    const bytes = bottleTar(standardEntries());
    type BoundaryCase = {
      label: string;
      limit: number;
      mutate: (
        metadata: HomebrewTapMetadata,
        manifest: HomebrewLinkManifest,
        value: string,
      ) => void;
    };
    const stringLimit = HOMEBREW_RUNTIME_LAYER_LIMITS.maxStringBytes;
    const repositoryLimit = HOMEBREW_RUNTIME_LAYER_LIMITS.maxRepositoryBytes;
    const packageLimit = HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackageNameBytes;
    const pathLimit = HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes;
    const cases: BoundaryCase[] = [
      { label: "tap repository", limit: repositoryLimit, mutate: (m, _l, v) => {
        m.tap_repository = v;
      } },
      { label: "tap name", limit: repositoryLimit, mutate: (m, _l, v) => {
        m.tap_name = v;
      } },
      { label: "Kandelo repository", limit: repositoryLimit, mutate: (m, _l, v) => {
        m.kandelo_repository = v;
      } },
      { label: "package name", limit: packageLimit, mutate: (m, _l, v) => {
        m.packages[0]!.name = v;
      } },
      { label: "package full name", limit: repositoryLimit, mutate: (m, _l, v) => {
        m.packages[0]!.full_name = v;
      } },
      { label: "package version", limit: 256, mutate: (m, _l, v) => {
        m.packages[0]!.version = v;
      } },
      { label: "formula path", limit: pathLimit, mutate: (m, _l, v) => {
        m.packages[0]!.formula_path = v;
      } },
      { label: "formula metadata path", limit: pathLimit, mutate: (m, _l, v) => {
        m.packages[0]!.formula_metadata = v;
      } },
      { label: "dependency name", limit: packageLimit, mutate: (m, _l, v) => {
        m.packages[0]!.dependencies = [{ name: v }];
      } },
      { label: "dependency full name", limit: repositoryLimit, mutate: (m, _l, v) => {
        m.packages[0]!.dependencies = [{ name: "dep", full_name: v }];
      } },
      { label: "dependency version", limit: 256, mutate: (m, _l, v) => {
        m.packages[0]!.dependencies = [{ name: "dep", version: v }];
      } },
      { label: "bottle status", limit: stringLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.status = v as "success";
      } },
      { label: "bottle URL", limit: stringLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.url = v;
      } },
      { label: "bottle cellar", limit: pathLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.cellar = v;
      } },
      { label: "bottle prefix", limit: pathLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.prefix = v;
      } },
      { label: "bottle link manifest", limit: pathLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.link_manifest = v;
      } },
      { label: "fallback URL", limit: stringLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.fallback_url = v;
      } },
      { label: "fallback link manifest", limit: pathLimit, mutate: (m, _l, v) => {
        m.packages[0]!.bottles[0]!.fallback_link_manifest = v;
      } },
      { label: "manifest package", limit: packageLimit, mutate: (_m, l, v) => {
        l.package = v;
      } },
      { label: "manifest version", limit: 256, mutate: (_m, l, v) => {
        l.version = v;
      } },
      { label: "manifest prefix", limit: pathLimit, mutate: (_m, l, v) => {
        l.prefix = v;
      } },
      { label: "manifest cellar", limit: pathLimit, mutate: (_m, l, v) => {
        l.cellar = v;
      } },
      { label: "manifest keg", limit: pathLimit, mutate: (_m, l, v) => {
        l.keg = v;
      } },
      { label: "manifest bottle URL", limit: stringLimit, mutate: (_m, l, v) => {
        l.bottle.url = v;
      } },
      { label: "manifest payload root", limit: pathLimit, mutate: (_m, l, v) => {
        l.bottle.payload_root = v;
      } },
      { label: "manifest link source", limit: pathLimit, mutate: (_m, l, v) => {
        l.links[0]!.source = v;
      } },
      { label: "manifest link target", limit: pathLimit, mutate: (_m, l, v) => {
        l.links[0]!.target = v;
      } },
      { label: "manifest receipt", limit: pathLimit, mutate: (_m, l, v) => {
        l.receipts[0] = v;
      } },
      { label: "manifest PATH entry", limit: pathLimit, mutate: (_m, l, v) => {
        l.env.PATH_prepend = [v];
      } },
    ];

    for (const boundary of cases) {
      for (const value of ["x".repeat(boundary.limit + 1), "valid\0suffix"]) {
        const metadata = structuredClone(metadataForBottle(bytes));
        const manifest = structuredClone(linkManifest(bytes));
        boundary.mutate(metadata, manifest, value);
        await expect(planFixture(metadata, manifest), boundary.label).rejects.toThrow(
          /NUL-free string|must not contain NUL/,
        );
      }
    }
  });

  it("bounds federated root and dependency tap inputs before resolution", async () => {
    const bytes = bottleTar(standardEntries());
    const metadata = metadataForBottle(bytes);
    const overlong = "x".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxRepositoryBytes + 1);
    await expect(planFederatedHomebrewVfs([metadata], {
      rootTapName: overlong,
      packages: ["hello"],
      arch: "wasm32",
      runtime: "node",
      loadLinkManifest: () => linkManifest(bytes),
    })).rejects.toThrow(/at most 512 bytes/);

    const dependency = structuredClone(metadata);
    dependency.tap_repository = overlong;
    await expect(planFederatedHomebrewVfs([metadata, dependency], {
      rootTapName: metadata.tap_name,
      packages: ["hello"],
      arch: "wasm32",
      runtime: "node",
      loadLinkManifest: () => linkManifest(bytes),
    })).rejects.toThrow(/at most 512 bytes/);
  });
});

describe("Homebrew VFS builder", () => {
  it("builds a deterministic deferred tree containing only base-exclusive package output", async () => {
    const fixture = await lazyLayerFixture();
    const first = await fixture.build();
    const second = await fixture.build();
    expect(first.payloads.map((payload) => ({
      id: payload.id,
      asset: payload.asset,
      bytes: Array.from(payload.bytes),
    }))).toEqual(second.payloads.map((payload) => ({
      id: payload.id,
      asset: payload.asset,
      bytes: Array.from(payload.bytes),
    })));
    expect(first.descriptor).toEqual(second.descriptor);
    expect(first.descriptor.selection).toEqual({
      requested_packages: ["runtime"],
      package_order: [
        "kandelo-dev/tap-core/hello",
        "kandelo-dev/tap-core/runtime",
      ],
      base_package_order: ["kandelo-dev/tap-core/hello"],
      layer_package_order: ["kandelo-dev/tap-core/runtime"],
    });
    expect(first.descriptor.schema).toBe(5);
    expect(first.descriptor.kind).toBe("kandelo-homebrew-deferred-layer-draft");
    expect(first.descriptor.base_vfs).toMatchObject({
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bytes: 12345,
      kernel_abi: ABI_VERSION,
      package_source: {
        kind: "kandelo-package-output",
        package: {
          name: "shell",
          arch: "wasm32",
        },
        output: {
          path: "shell.vfs.zst",
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      composition: {
        package_count: 1,
        package_order: ["kandelo-dev/tap-core/hello"],
      },
    });
    expect(first.descriptor.acceptance_vfs).toEqual({
      asset: "kandelo-homebrew.vfs.zst",
      sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      bytes: 23456,
    });
    expect(first.descriptor.packages.base).toEqual([expect.objectContaining({
      full_name: "kandelo-dev/tap-core/hello",
      sha256: sha256(fixture.baseBytes),
      link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
    })]);
    expect(first.descriptor.packages.layer).toEqual([expect.objectContaining({
      full_name: "kandelo-dev/tap-core/runtime",
      sha256: sha256(fixture.runtimeBytes),
    })]);

    const tree = descriptorTree(first.descriptor);
    const inventoryEntries = tree.inventory.entries;
    expect(tree).toMatchObject({
      package: "kandelo-dev/tap-core/runtime",
      activation: { mode: "first-use" },
      content: {
        decoder: "homebrew-bottle-tar-gzip-v1",
        media_type: "application/vnd.oci.image.layer.v1.tar+gzip",
        sha256: sha256(fixture.runtimeBytes),
        bytes: fixture.runtimeBytes.byteLength,
      },
      transports: [{
        kind: "bundle-release",
        asset: "kandelo-homebrew-runtime-layer.bin",
      }],
    });
    expect(first.payloads).toHaveLength(1);
    expect(Array.from(first.payloads[0].bytes)).toEqual(Array.from(fixture.runtimeBytes));
    expect(tree.inventory.source).toMatchObject({
      schema: 1,
      kind: "homebrew-bottle-tar-gzip-v1",
      entries: expect.arrayContaining([
        expect.objectContaining({
          path: "runtime/3.0/bin/runtime",
          type: "file",
          mode: 0o755,
        }),
      ]),
    });
    expect(inventoryEntries).toContainEqual(expect.objectContaining({
      path: "home/linuxbrew/.linuxbrew/Cellar/runtime/3.0/bin/runtime",
      source_path: "runtime/3.0/bin/runtime",
      type: "file",
      materialization: "archive",
    }));
    expect(inventoryEntries).toContainEqual(expect.objectContaining({
      path: "home/linuxbrew/.linuxbrew/bin/runtime",
      type: "symlink",
      target: `${fixture.runtimeKeg}/bin/runtime`,
      materialization: "descriptor",
    }));
    expect(inventoryEntries).toContainEqual(expect.objectContaining({
      path: "home/linuxbrew/.linuxbrew/bin",
      type: "directory",
      ownership: "mergeable-directory",
    }));
  });

  it("emits deterministic byte-identical bottle groups for a dependency closure", async () => {
    const fixture = await lazyLayerFixture({ includeLayerDependency: true });
    const first = await fixture.build();
    const second = await fixture.build();
    expect(first.descriptor).toEqual(second.descriptor);
    expect(first.payloads.map((payload) => payload.id)).toEqual(
      [...first.payloads.map((payload) => payload.id)].sort(),
    );
    expect(first.descriptor.deferred_trees.map((tree) => tree.id)).toEqual(
      first.payloads.map((payload) => payload.id),
    );
    expect(new Set(first.descriptor.deferred_trees.map((tree) => tree.package))).toEqual(
      new Set(first.descriptor.selection.layer_package_order),
    );
    for (const payload of first.payloads) {
      const tree = first.descriptor.deferred_trees.find((candidate) => candidate.id === payload.id)!;
      const expected = tree.package?.endsWith("/runtime-dep")
        ? fixture.dependencyBytes
        : fixture.runtimeBytes;
      expect(Array.from(payload.bytes)).toEqual(Array.from(expected));
      expect(tree.content.sha256).toBe(sha256(expected));
      expect(tree.content.bytes).toBe(expected.byteLength);
      expect(draftBundleReleaseTransport(tree).asset).toBe(payload.asset);
    }
    const dependency = first.descriptor.deferred_trees.find(
      (tree) => tree.package?.endsWith("/runtime-dep"),
    )!;
    const file = dependency.inventory.entries.find(
      (entry) => entry.path.endsWith("/bin/runtime-dep"),
    )!;
    const alias = dependency.inventory.entries.find(
      (entry) => entry.path.endsWith("/bin/runtime-dep-alias"),
    )!;
    expect(alias).toMatchObject({
      type: "hardlink",
      materialization: "archive",
      target: file.path,
      inode_group: file.inode_group,
    });
    const allPaths = first.descriptor.deferred_trees.flatMap(
      (tree) => tree.inventory.entries.map((entry) => entry.path),
    );
    expect(new Set(allPaths).size).toBe(allPaths.length);
  });

  it("keeps signed TAR hardlink roles when lexical VFS order encounters the alias first", async () => {
    const fixture = await lazyLayerFixture({ hardlinkCanonicalAfterAlias: true });
    const result = await fixture.build();
    const tree = descriptorTree(result.descriptor);
    const sourceCanonical = tree.inventory.source!.entries.find(
      (entry) => entry.path.endsWith("/lib/z-canonical.a"),
    );
    const sourceAlias = tree.inventory.source!.entries.find(
      (entry) => entry.path.endsWith("/lib/a-alias.a"),
    );
    expect(sourceCanonical).toMatchObject({ type: "file", mode: 0o644 });
    expect(sourceAlias).toMatchObject({
      type: "hardlink",
      target: sourceCanonical!.path,
    });

    const canonical = tree.inventory.entries.find(
      (entry) => entry.path.endsWith("/lib/z-canonical.a"),
    );
    const alias = tree.inventory.entries.find(
      (entry) => entry.path.endsWith("/lib/a-alias.a"),
    );
    expect(canonical).toMatchObject({
      type: "file",
      materialization: "archive",
      mode: 0o644,
    });
    expect(alias).toMatchObject({
      type: "hardlink",
      materialization: "archive",
      target: canonical!.path,
      inode_group: canonical!.inode_group,
      mode: 0o644,
    });
  });

  it("merges equal explicit directory modes and rejects cross-bottle mode drift", async () => {
    const equal = await lazyLayerFixture({
      includeLayerDependency: true,
      overlappingDirectoryModes: [0o700, 0o700],
    });
    const result = await equal.build();
    const shared = result.descriptor.deferred_trees.flatMap(
      (tree) => tree.inventory.entries,
    ).filter((entry) => entry.path.endsWith("/Cellar/shared-runtime-state"));
    expect(shared).toEqual([expect.objectContaining({
      type: "directory",
      ownership: "mergeable-directory",
      mode: 0o700,
    })]);

    const mismatched = await lazyLayerFixture({
      includeLayerDependency: true,
      overlappingDirectoryModes: [0o755, 0o700],
    });
    await expect(mismatched.build()).rejects.toThrow(
      /assign different modes to directory .*shared-runtime-state/,
    );
  });

  it("preserves an explicit mode 0000 instead of substituting a default", async () => {
    const entries = standardEntries();
    entries[0].mode = 0;
    const bytes = bottleTar(entries);
    const result = await buildFixture(bytes);
    expect(result.fs.lstat(`${KEG}/bin/hello`).mode & 0o7777).toBe(0);
  });

  it("builds a package collection without a runtime root or release envelope", async () => {
    const fixture = await lazyLayerFixture({ includeLayerDependency: true });
    const selectedPlan: HomebrewVfsPlan = {
      ...fixture.plan,
      packages: fixture.plan.packages.filter((pkg) => pkg.name !== "hello"),
    };
    const collection = await buildHomebrewOriginalBottleCollection(selectedPlan, {
      fs: MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024)),
      baseFs: fixture.baseFs,
      loadBottleBytes: (pkg) =>
        pkg.name === "runtime-dep" ? fixture.dependencyBytes : fixture.runtimeBytes,
    });
    expect(Object.keys(collection).sort()).toEqual([
      "deferredTrees",
      "packages",
      "payloads",
      "report",
    ]);
    expect(collection.packages.map((pkg) => pkg.full_name)).toEqual(
      selectedPlan.packages.map((pkg) => pkg.fullName),
    );
    expect(collection.deferredTrees.map((tree) => tree.package).sort()).toEqual(
      selectedPlan.packages.map((pkg) => pkg.fullName).sort(),
    );
    expect(collection.deferredTrees.some((tree) => tree.id === "runtime")).toBe(false);
    expect(collection.payloads.map((payload) => payload.id)).toEqual(
      collection.deferredTrees.map((tree) => tree.id),
    );
  });

  it("composes global ownership before embedding a checked closure and deferring the rest", async () => {
    const fixture = await lazyLayerFixture({ includeLayerDependency: true });
    const deferredVersion = "4.0";
    const deferredKeg = `${CELLAR}/deferred/${deferredVersion}`;
    const deferredBytes = bottleTar([
      {
        path: `deferred/${deferredVersion}/bin/deferred`,
        data: "deferred payload\n",
        mode: 0o755,
      },
      {
        path: `deferred/${deferredVersion}/share/deferred.txt`,
        data: "deferred sibling\n",
        mode: 0o644,
      },
      {
        path: `deferred/${deferredVersion}/.brew/deferred.rb`,
        data: "class Deferred < Formula\nend\n",
      },
      {
        path: `deferred/${deferredVersion}/INSTALL_RECEIPT.json`,
        data: "{}\n",
      },
    ]);
    const runtime = fixture.plan.packages.find((pkg) => pkg.name === "runtime")!;
    const deferred = {
      ...structuredClone(runtime),
      name: "deferred",
      fullName: "kandelo-dev/tap-core/deferred",
      version: deferredVersion,
      url: "file:///tmp/deferred.bottle.tar.gz",
      sha256: sha256(deferredBytes),
      bytes: deferredBytes.byteLength,
      cacheKeySha: sha256(utf8("deferred-cache-key")),
      keg: deferredKeg,
      payloadRoot: `deferred/${deferredVersion}`,
      linkManifestPath: "Kandelo/link/deferred-4.0-rebuild0-wasm32.json",
      dependencies: [{
        name: "hello",
        full_name: "kandelo-dev/tap-core/hello",
        version: "2.12.1",
      }],
      linkManifest: {
        ...structuredClone(runtime.linkManifest),
        package: "deferred",
        version: deferredVersion,
        keg: deferredKeg,
        bottle: {
          ...structuredClone(runtime.linkManifest.bottle),
          url: "file:///tmp/deferred.bottle.tar.gz",
          sha256: sha256(deferredBytes),
          bytes: deferredBytes.byteLength,
          cache_key_sha: sha256(utf8("deferred-cache-key")),
          payload_root: `deferred/${deferredVersion}`,
        },
        // Compete with the embedded root to prove the winner comes from the
        // full four-package projection, not a later three-package re-pour.
        links: [{
          type: "symlink" as const,
          source: `Cellar/deferred/${deferredVersion}/bin/deferred`,
          target: "bin/runtime",
        }],
        receipts: [
          `Cellar/deferred/${deferredVersion}/.brew/deferred.rb`,
          `Cellar/deferred/${deferredVersion}/INSTALL_RECEIPT.json`,
        ],
      },
    };
    const plan: HomebrewVfsPlan = {
      ...fixture.plan,
      requestedPackages: ["runtime", "deferred"],
      packages: [...fixture.plan.packages, deferred],
    };
    const policy = {
      schema: 1,
      kind: "kandelo-homebrew-vfs-materialization-policy",
      embedded_roots: ["kandelo-dev/tap-core/runtime"],
      embedded_package_order: [
        "kandelo-dev/tap-core/hello",
        "kandelo-dev/tap-core/runtime-dep",
        "kandelo-dev/tap-core/runtime",
      ],
    };
    const compatibilityPolicy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: ["/usr/bin"] },
      link_conflict_owners: [{
        target: "bin/runtime",
        package: "kandelo-dev/tap-core/runtime",
        reason: "the embedded runtime owns the shared command",
      }],
      aliases: [{
        package: "kandelo-dev/tap-core/deferred",
        source_kind: "keg",
        source: "bin/deferred",
        targets: ["/bin/deferred"],
      }],
      runtime_state: [{
        requires_package: "kandelo-dev/tap-core/deferred",
        path: "/var/lib/deferred",
        kind: "directory",
        mode: 0o755,
        uid: 1000,
        gid: 1000,
        reason: "deferred runtime state remains consumer-owned",
      }],
    };
    const bytesByPackage = new Map([
      ["hello", fixture.baseBytes],
      ["runtime-dep", fixture.dependencyBytes],
      ["runtime", fixture.runtimeBytes],
      ["deferred", deferredBytes],
    ]);
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
    ensureDirRecursive(fs, "/home");
    ensureDirRecursive(fs, "/var/lib");
    const result = await buildHomebrewMaterializedVfs(plan, {
      fs,
      collectionFs: MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024)),
      policy,
      mirrorRepository: "kandelo-dev/homebrew-tap-core",
      compatibilityPolicy,
      writeProfile: true,
      loadBottleBytes(pkg) {
        return bytesByPackage.get(pkg.name)!;
      },
    });

    const packageTreeArchive = zipSync({
      "bin/": [new Uint8Array(), {
        os: 3,
        attrs: ((0o040755 << 16) >>> 0),
      }],
      "bin/tool": [utf8("package tree\n"), {
        os: 3,
        attrs: ((0o100755 << 16) >>> 0),
      }],
    } satisfies Zippable);
    const packageTreeSpec = {
      schema: 1,
      kind: "kandelo-package-deferred-zip-tree",
      id: "shell/package-bootstrap",
      content_role: "source-tree",
      package: { name: "shell", output: "package-bootstrap.zip" },
      archive: {
        url: "package-bootstrap.zip",
        mode_policy: "portable-posix-v1",
      },
      mount_prefix: "/opt/package-bootstrap",
      owner: { uid: 0, gid: 0 },
      activation: {
        mode: "first-use",
        capabilities: ["package:bootstrap"],
        roots: ["/opt/package-bootstrap/bin/tool"],
      },
    } as const satisfies PackageDeferredZipTreeSpec;
    const withPackageTree = MemoryFileSystem.fromImage(await fs.saveImage());
    registerPackageDeferredZipTree(
      withPackageTree,
      derivePackageDeferredZipTree(packageTreeSpec, packageTreeArchive),
    );
    expect(() => assertHomebrewVfsMaterialization(
      withPackageTree,
      result.evidence,
    )).not.toThrow();

    const withUnexpectedBottle = MemoryFileSystem.fromImage(await fs.saveImage());
    registerPackageDeferredZipTree(
      withUnexpectedBottle,
      derivePackageDeferredZipTree({
        ...packageTreeSpec,
        activation: {
          ...packageTreeSpec.activation,
          capabilities: ["homebrew-bottle:unexpected"],
        },
      }, packageTreeArchive),
    );
    expect(() => assertHomebrewVfsMaterialization(
      withUnexpectedBottle,
      result.evidence,
    )).toThrow(/pending deferred trees differ/);

    expect(result.selection.embeddedPackages.map((pkg) => pkg.fullName)).toEqual(
      policy.embedded_package_order,
    );
    expect(result.selection.deferredPackages.map((pkg) => pkg.fullName)).toEqual([
      "kandelo-dev/tap-core/deferred",
    ]);
    expect(result.report.materialization).toMatchObject({
      embedded_tree_count: 3,
      deferred_tree_count: 1,
      bottle_mirror: {
        asset_count: 1,
        manifest_path: HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
        manifest_sha256: result.mirrorPlanAsset.sha256,
        manifest_bytes: result.mirrorPlanAsset.bytes.byteLength,
      },
    });
    expect(result.evidence.mirrorPlan).toEqual({
      path: HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
      sha256: result.mirrorPlanAsset.sha256,
      bytes: result.mirrorPlanAsset.bytes.byteLength,
    });
    expect(readVfsFile(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH)).toBe(
      new TextDecoder().decode(result.mirrorPlanAsset.bytes),
    );
    expect(() => assertHomebrewVfsMaterialization(fs, {
      ...result.evidence,
      // Two packages may legitimately have byte-identical bottles. Deferred
      // identity is the exact mirror URL + integrity, never SHA/size alone.
      embedded: [
        ...result.evidence.embedded,
        {
          package: "kandelo-dev/tap-core/byte-identical-embedded",
          treeId: "byte-identical-embedded",
          sha256: result.evidence.deferred[0]!.sha256,
          bytes: result.evidence.deferred[0]!.bytes,
        },
      ],
    })).not.toThrow();
    expect(() => assertHomebrewVfsMaterialization(fs, {
      ...result.evidence,
      deferred: [{
        ...result.evidence.deferred[0]!,
        url: `${result.evidence.deferred[0]!.url}-wrong`,
      }],
    })).toThrow(/pending deferred trees differ/);
    expect(result.mirrorPlan.tag).toBe(
      `homebrew-shell-bottles-sha256-${result.mirrorPlan.collection_sha256}`,
    );
    expect(result.mirrorPlan.assets).toEqual([
      expect.objectContaining({
        package: "kandelo-dev/tap-core/deferred",
        sha256: sha256(deferredBytes),
        bytes: deferredBytes.byteLength,
      }),
    ]);
    expect(() => assertHomebrewBottleMirrorBundle(
      result.mirrorPlan,
      result.mirrorPayloads,
      result.mirrorPlanAsset,
    )).not.toThrow();
    const tamperedPayloadBytes = new Uint8Array(result.mirrorPayloads[0]!.bytes);
    tamperedPayloadBytes[0] ^= 0xff;
    expect(() => assertHomebrewBottleMirrorBundle(
      result.mirrorPlan,
      [{ ...result.mirrorPayloads[0]!, bytes: tamperedPayloadBytes }],
      result.mirrorPlanAsset,
    )).toThrow(/payload differs/);
    const tamperedManifestBytes = new Uint8Array(
      result.mirrorPlanAsset.bytes.byteLength + 1,
    );
    tamperedManifestBytes.set(result.mirrorPlanAsset.bytes);
    expect(() => assertHomebrewBottleMirrorBundle(
      result.mirrorPlan,
      result.mirrorPayloads,
      { ...result.mirrorPlanAsset, bytes: tamperedManifestBytes },
    )).toThrow(/manifest bytes are not canonical/);
    expect(() => assertHomebrewBottleMirrorBundle(
      { ...result.mirrorPlan, repository: "kandelo-dev/.." },
      result.mirrorPayloads,
      result.mirrorPlanAsset,
    )).toThrow(/invalid top-level fields/);
    expect(() => assertHomebrewBottleMirrorBundle(
      {
        ...result.mirrorPlan,
        assets: [result.mirrorPlan.assets[0]!, result.mirrorPlan.assets[0]!],
      },
      result.mirrorPayloads,
      result.mirrorPlanAsset,
    )).toThrow(/asset ownership is not canonical/);
    expect(() => assertHomebrewBottleMirrorPlan({
      ...result.mirrorPlan,
      assets: [],
    })).toThrow(/invalid top-level fields/);
    expect(() => assertHomebrewBottleMirrorPlan({
      ...result.mirrorPlan,
      assets: Array.from({ length: 129 }, (_, index) => ({
        ...result.mirrorPlan.assets[0]!,
        id: `bottle-${String(index).padStart(3, "0")}`,
        package: `kandelo-dev/tap-core/pkg${index}`,
        asset: `asset-${index}.bin`,
        url: `${result.mirrorPlan.release_root}/asset-${index}.bin`,
      })),
    })).toThrow(/invalid top-level fields/);
    expect(() => assertHomebrewBottleMirrorPlan({
      ...result.mirrorPlan,
      assets: [{
        ...result.mirrorPlan.assets[0]!,
        bytes: 512 * 1024 * 1024 + 1,
      }],
    })).toThrow(/asset ownership is not canonical/);
    expect(fs.exportLazyArchiveEntries()).toHaveLength(1);
    expect(fs.readlink(`${PREFIX}/bin/runtime`)).toBe(`${runtime.keg}/bin/runtime`);
    expect(fs.readlink("/bin/deferred")).toBe(`${deferredKeg}/bin/deferred`);
    expect(fs.lstat("/var/lib/deferred").mode & 0o7777).toBe(0o755);
    expect(readVfsFile(fs, "/etc/profile.d/kandelo-homebrew.sh")).toContain(PREFIX);
    expect(() => writeHomebrewVfsComposition(fs, plan, result.report)).toThrow(
      /refusing to replace existing Homebrew VFS composition/,
    );

    const savedImage = await fs.saveImage();
    const restored = MemoryFileSystem.fromImage(savedImage);
    assertHomebrewVfsMaterialization(restored, result.evidence);
    expect(restored.exportLazyArchiveEntries()).toHaveLength(1);
    const offlineFetch = vi.fn(async () => {
      throw new Error("network disabled during embedded command proof");
    });
    restored.setLazyFetcher(offlineFetch);
    await expect(restored.preparePath(`${runtime.keg}/bin/runtime`)).resolves.toBe(false);
    expect(readVfsFile(restored, `${runtime.keg}/bin/runtime`)).toContain("runtime");
    expect(offlineFetch).not.toHaveBeenCalled();

    const deferredFetch = vi.fn(async (url: string) => {
      expect(url).toBe(result.mirrorPlan.assets[0]!.url);
      return new Response(deferredBytes);
    });
    restored.setLazyFetcher(deferredFetch);
    await expect(restored.preparePath(`${deferredKeg}/bin/deferred`)).resolves.toBe(true);
    expect(deferredFetch).toHaveBeenCalledTimes(1);
    expect(readVfsFile(restored, `${deferredKeg}/bin/deferred`)).toContain(
      "deferred payload",
    );
    expect(readVfsFile(restored, `${deferredKeg}/share/deferred.txt`)).toContain(
      "deferred sibling",
    );
    expect(restored.exportLazyArchiveEntries()).toEqual([]);

    const tamperedPlanFs = MemoryFileSystem.fromImage(savedImage);
    writeVfsFile(
      tamperedPlanFs,
      HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
      "not the exact mirror plan\n",
      0o644,
    );
    expect(() => assertHomebrewVfsMaterialization(
      tamperedPlanFs,
      result.evidence,
    )).toThrow(/embedded bottle mirror plan changed identity/);

    const unrelatedFs = MemoryFileSystem.create(
      new SharedArrayBuffer(32 * 1024 * 1024),
    );
    ensureDirRecursive(unrelatedFs, "/home");
    ensureDirRecursive(unrelatedFs, "/var/lib");
    writeVfsFile(unrelatedFs, "/unrelated-vfs-state", "not mirror identity\n");
    const unrelatedResult = await buildHomebrewMaterializedVfs(plan, {
      fs: unrelatedFs,
      collectionFs: MemoryFileSystem.create(
        new SharedArrayBuffer(32 * 1024 * 1024),
      ),
      policy,
      mirrorRepository: "kandelo-dev/homebrew-tap-core",
      compatibilityPolicy,
      writeProfile: true,
      loadBottleBytes(pkg) {
        return bytesByPackage.get(pkg.name)!;
      },
    });
    expect(unrelatedResult.mirrorPlan.tag).toBe(result.mirrorPlan.tag);

    const reservedPlanFs = MemoryFileSystem.create(
      new SharedArrayBuffer(32 * 1024 * 1024),
    );
    ensureDirRecursive(reservedPlanFs, "/etc/kandelo");
    ensureDirRecursive(reservedPlanFs, "/home");
    ensureDirRecursive(reservedPlanFs, "/var/lib");
    writeVfsFile(
      reservedPlanFs,
      HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
      "preexisting owner\n",
    );
    await expect(buildHomebrewMaterializedVfs(plan, {
      fs: reservedPlanFs,
      collectionFs: MemoryFileSystem.create(
        new SharedArrayBuffer(32 * 1024 * 1024),
      ),
      policy,
      mirrorRepository: "kandelo-dev/homebrew-tap-core",
      compatibilityPolicy,
      writeProfile: true,
      loadBottleBytes(pkg) {
        return bytesByPackage.get(pkg.name)!;
      },
    })).rejects.toThrow(/refusing to replace existing Homebrew bottle mirror plan/);
  });

  it("preserves exact eligible external bottle URLs and rejects fragments", async () => {
    const exactUrl =
      "https://github.com:443/kandelo-dev/homebrew-tap-core/releases/download/" +
      "bottles-abi-v42/runtime.bottle.tar.gz";
    const exact = await lazyLayerFixture({
      mutatePlan(plan) {
        const pkg = plan.packages.find((candidate) => candidate.name === "runtime")!;
        pkg.url = exactUrl;
        pkg.linkManifest.bottle.url = exactUrl;
      },
    });
    const exactResult = await exact.build();
    expect(descriptorTree(exactResult.descriptor).transports).toContainEqual({
      kind: "external-https",
      url: exactUrl,
    });
    expect(pythonExpectedExternalBottleTransport(exactUrl)).toEqual({
      kind: "external-https",
      url: exactUrl,
    });

    const ineligibleUrls = [
      `${exactUrl}#not-immutable-identity`,
      exactUrl.replace("github.com", "%67ithub.com"),
      exactUrl.replace("/releases/download/", "/releases\\download/"),
      exactUrl.replace("/releases/download/", "/releases/x/../download/"),
      exactUrl.replace("/kandelo-dev/", "/../"),
    ];
    for (const ineligibleUrl of ineligibleUrls) {
      const ineligible = await lazyLayerFixture({
        mutatePlan(plan) {
          const pkg = plan.packages.find((candidate) => candidate.name === "runtime")!;
          pkg.url = ineligibleUrl;
          pkg.linkManifest.bottle.url = ineligibleUrl;
        },
      });
      const result = await ineligible.build();
      expect(descriptorTree(result.descriptor).transports).toEqual([
        expect.objectContaining({ kind: "bundle-release" }),
      ]);
      expect(pythonExpectedExternalBottleTransport(ineligibleUrl)).toBeNull();
    }
  });

  it("uses eager conflict ownership for direct bottle links", async () => {
    const mutatePlan = (plan: HomebrewVfsPlan) => {
      plan.packages.find((pkg) => pkg.name === "runtime-dep")!
        .linkManifest.links[0].target = "bin/runtime";
    };
    const unreviewed = await lazyLayerFixture({
      includeLayerDependency: true,
      mutatePlan,
    });
    await expect(unreviewed.build()).rejects.toThrow(/migration lock must select an owner/);

    const reviewed = await lazyLayerFixture({
      includeLayerDependency: true,
      mutatePlan,
      compatibilityPolicy: {
        mirror_link_manifest_bin: { targets: [] },
        aliases: [],
        link_conflict_owners: [{
          target: "bin/runtime",
          package: "kandelo-dev/tap-core/runtime",
          reason: "test fixture selects the runtime root",
        }],
      },
    });
    const result = await reviewed.build();
    const owners = result.descriptor.deferred_trees.filter((tree) =>
      tree.inventory.entries.some((entry) =>
        entry.path === "home/linuxbrew/.linuxbrew/bin/runtime"
      )
    );
    expect(owners.map((tree) => tree.package)).toEqual([
      "kandelo-dev/tap-core/runtime",
    ]);
  });

  it("projects a reviewed runtime policy to exactly one descriptor root", async () => {
    const fixture = await lazyLayerFixture({
      mutatePlan(plan) {
        const unrelated = structuredClone(plan.packages[1]);
        unrelated.name = "unrelated";
        unrelated.fullName = "kandelo-dev/tap-core/unrelated";
        plan.requestedPackages = ["runtime", "unrelated"];
        plan.packages.push(unrelated);
      },
      runtimeLayer: {
        id: "runtime",
        policy: {
          schema: 1,
          kind: "kandelo-homebrew-runtime-layer-policy",
          base_package: "shell",
          layers: [{
            id: "runtime",
            root_package: "kandelo-dev/tap-core/runtime",
          }],
        },
      },
    });

    const result = await fixture.build();
    expect(result.descriptor.selection).toEqual({
      requested_packages: ["runtime"],
      package_order: [
        "kandelo-dev/tap-core/hello",
        "kandelo-dev/tap-core/runtime",
      ],
      base_package_order: ["kandelo-dev/tap-core/hello"],
      layer_package_order: ["kandelo-dev/tap-core/runtime"],
    });
    expect(draftBundleReleaseTransport(descriptorTree(result.descriptor)).asset).toBe(
      "kandelo-homebrew-runtime-layer.bin",
    );
    expect(descriptorEntries(result.descriptor).some((entry) =>
      entry.path.includes("unrelated")
    )).toBe(false);
  });

  it("rejects a base dependency with a different selected bottle identity", async () => {
    const fixture = await lazyLayerFixture({
      mutatePlan(plan) {
        plan.packages[0].sha256 = WRONG_SHA;
      },
    });
    await expect(fixture.build()).rejects.toThrow(
      "base owns kandelo-dev/tap-core/hello with a different bottle identity",
    );
  });

  it("rejects a package commit that differs from its bottle build provenance", async () => {
    const fixture = await lazyLayerFixture({
      mutatePlan(plan) {
        plan.packages[0].tapCommit = "9".repeat(40);
      },
    });
    await expect(fixture.build()).rejects.toThrow(
      "kandelo-dev/tap-core/hello has inconsistent bottle build provenance",
    );
  });

  it("rejects a base image whose bytes do not match its package-output receipt", async () => {
    const fixture = await lazyLayerFixture({
      mutateBaseSource(source) {
        source.output.sha256 = WRONG_SHA;
      },
    });
    await expect(fixture.build()).rejects.toThrow(
      "base bytes do not match their canonical package output",
    );
  });

  it("rejects a layer file that would replace a base-owned path", async () => {
    const fixture = await lazyLayerFixture({
      mutateBase(fs) {
        writeVfsFile(fs, `${PREFIX}/bin/runtime`, "base-owned\n", 0o755);
      },
    });
    await expect(fixture.build()).rejects.toThrow(
      `path collides with base-owned path: ${PREFIX}/bin/runtime`,
    );
  });

  it("rejects a mergeable directory whose embedded base mode would be retained", async () => {
    const fixture = await lazyLayerFixture({
      mutateBase(fs) {
        fs.chmod(`${PREFIX}/bin`, 0o700);
      },
    });
    await expect(fixture.build()).rejects.toThrow(
      `mergeable directory mode differs from base: ${PREFIX}/bin`,
    );
  });

  it("reuses an exact base dependency across a locked third-party tap plan", async () => {
    const fixture = await lazyLayerFixture({ mutatePlan: makeLazyLayerPlanFederated });
    const result = await fixture.build();
    expect(result.descriptor.tap).toEqual({
      repository: "example/homebrew-runtimes",
      name: "example/runtimes",
      commit: "3333333333333333333333333333333333333333",
    });
    expect(result.descriptor.tap_lock.map((tap) => ({
      repository: tap.repository,
      name: tap.name,
      commit: tap.commit,
    }))).toEqual([
      {
        repository: "example/homebrew-runtimes",
        name: "example/runtimes",
        commit: "3333333333333333333333333333333333333333",
      },
      {
        repository: "kandelo-dev/homebrew-tap-core",
        name: "kandelo-dev/tap-core",
        commit: TAP_COMMIT,
      },
    ]);
    expect(result.descriptor.selection.base_package_order).toEqual([
      "kandelo-dev/tap-core/hello",
    ]);
    expect(result.descriptor.selection.layer_package_order).toEqual([
      "example/runtimes/runtime",
    ]);
  });

  it("rejects a package whose dependency tap differs from the federated lock", async () => {
    const fixture = await lazyLayerFixture({
      mutatePlan(plan) {
        makeLazyLayerPlanFederated(plan);
        const taps = (plan as HomebrewVfsPlan & {
          taps: Array<{ tapName: string; tapRepository: string }>;
        }).taps;
        const core = taps.find((tap) => tap.tapName === "kandelo-dev/tap-core")!;
        core.tapRepository = "other/homebrew-tap-core";
      },
    });
    await expect(fixture.build()).rejects.toThrow(
      "kandelo-dev/tap-core/hello is not owned by its exact locked tap",
    );
  });

  it("pours a verified bottle, creates its canonical opt link, and writes metadata", async () => {
    const bytes = bottleTar(standardEntries());
    const result = await buildFixture(bytes);

    expect(readVfsFile(result.fs, `${KEG}/bin/hello`)).toContain("echo hello");
    expect(result.fs.readlink(`${PREFIX}/bin/hello`)).toBe(`${KEG}/bin/hello`);
    expect(result.fs.readlink(`${PREFIX}/opt/hello`)).toBe("../Cellar/hello/2.12.1");
    expect(readVfsFile(result.fs, `${PREFIX}/opt/hello/bin/hello`)).toContain("echo hello");
    const composition = JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    );
    expect(composition.packages[0].opt_link).toEqual({
      path: "opt/hello",
      target: "../Cellar/hello/2.12.1",
    });
    expect(result.report.packages[0]).toMatchObject({
      name: "hello",
      source_status: "success",
      staged_files: 3,
      links: ["bin/hello"],
      opt_link: {
        path: "opt/hello",
        target: "../Cellar/hello/2.12.1",
      },
    });
    expect(result.report.selection).toMatchObject({
      kind: "packages",
      requested_packages: ["hello"],
    });
  });

  it("composes a real GNU PAX bottle while preserving its sanitized receipt bytes", async () => {
    const receipt = utf8(JSON.stringify({
      source: {
        path: "Formula/hello.rb",
        tap: "kandelo-dev/tap-core",
        versions: { stable: "2.12.1" },
      },
      built_as_bottle: true,
      poured_from_bottle: false,
    }) + "\n");
    const bottle = gnuPaxBottle(receipt);
    expect(bottle.gnuTar).toMatch(/^\/nix\/store\/[0-9a-z]{32}-gnutar-[^/]+\/bin\/tar$/);
    expect(bottle.typeflags.some((flag) => flag === "x" || flag === "g")).toBe(true);

    const result = await buildFixture(bottle.bytes);
    const installedReceiptBytes = readVfsFile(result.fs, `${KEG}/INSTALL_RECEIPT.json`);
    expect(installedReceiptBytes).toBe(new TextDecoder().decode(receipt));
    const installedReceipt = JSON.parse(installedReceiptBytes);
    expect(installedReceipt.source.tap).toBe("kandelo-dev/tap-core");
    expect(installedReceipt.source).not.toHaveProperty("tap_git_head");
    const composition = JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    );
    expect(composition.metadata).toMatchObject({
      tap_name: "kandelo-dev/tap-core",
      tap_commit: TAP_COMMIT,
    });
  });

  it("relocates every supported Homebrew text placeholder declared by the bottle receipt", async () => {
    const receipt = JSON.stringify({
      changed_files: ["INSTALL_RECEIPT.json", "lib/runtime.conf"],
      source: {
        path: "@@HOMEBREW_LIBRARY@@/Taps/kandelo-dev/homebrew-tap-core/Formula/hello.rb",
      },
    }) + "\n";
    const runtime = [
      "prefix=@@HOMEBREW_PREFIX@@",
      "cellar=@@HOMEBREW_CELLAR@@",
      "repository=@@HOMEBREW_REPOSITORY@@",
      "library=@@HOMEBREW_LIBRARY@@",
      "perl=@@HOMEBREW_PERL@@",
      "again=@@HOMEBREW_PREFIX@@",
    ].join("\n") + "\n";
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: receipt },
      { path: "hello/2.12.1/lib/runtime.conf", data: runtime, mode: 0o640 },
    ]);

    const result = await buildFixture(bytes);
    expect(JSON.parse(readVfsFile(result.fs, `${KEG}/INSTALL_RECEIPT.json`)))
      .toMatchObject({
        source: {
          path: `${PREFIX}/Library/Taps/kandelo-dev/homebrew-tap-core/Formula/hello.rb`,
        },
      });
    expect(readVfsFile(result.fs, `${KEG}/lib/runtime.conf`)).toBe([
      `prefix=${PREFIX}`,
      `cellar=${CELLAR}`,
      `repository=${PREFIX}`,
      `library=${PREFIX}/Library`,
      `perl=${PREFIX}/opt/perl/bin/perl`,
      `again=${PREFIX}`,
    ].join("\n") + "\n");
    expect(result.fs.stat(`${KEG}/lib/runtime.conf`).mode & 0o7777).toBe(0o640);
  });

  it("relocates Homebrew's Java placeholder from the exact OpenJDK runtime dependency", async () => {
    const receipt = JSON.stringify({
      changed_files: ["lib/java.conf"],
      runtime_dependencies: [{
        full_name: "kandelo-dev/tap-core/openjdk@21",
        version: "21.0.2",
      }],
    }) + "\n";
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: receipt },
      { path: "hello/2.12.1/lib/java.conf", data: "java=@@HOMEBREW_JAVA@@\n" },
    ]);

    const result = await buildFixture(bytes);
    expect(readVfsFile(result.fs, `${KEG}/lib/java.conf`)).toBe(
      `java=${PREFIX}/opt/openjdk@21/libexec\n`,
    );
  });

  it("uses the legacy runtime dependency name when full_name is not a string", async () => {
    const receipt = JSON.stringify({
      changed_files: ["lib/java.conf"],
      runtime_dependencies: [{ full_name: null, name: "openjdk@21" }],
    }) + "\n";
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: receipt },
      { path: "hello/2.12.1/lib/java.conf", data: "java=@@HOMEBREW_JAVA@@\n" },
    ]);

    const result = await buildFixture(bytes);
    expect(readVfsFile(result.fs, `${KEG}/lib/java.conf`)).toBe(
      `java=${PREFIX}/opt/openjdk@21/libexec\n`,
    );
  });

  it("relocates receipt-declared hardlinks through their shared inode", async () => {
    const receipt = JSON.stringify({
      changed_files: ["lib/runtime.conf", "lib/runtime-alias.conf"],
    }) + "\n";
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: receipt },
      {
        path: "hello/2.12.1/lib/runtime-alias.conf",
        type: "hardlink",
        linkName: "hello/2.12.1/lib/runtime.conf",
      },
      { path: "hello/2.12.1/lib/runtime.conf", data: "@@HOMEBREW_PREFIX@@\n" },
    ]);

    const result = await buildFixture(bytes);
    expect(readVfsFile(result.fs, `${KEG}/lib/runtime.conf`)).toBe(`${PREFIX}\n`);
    expect(readVfsFile(result.fs, `${KEG}/lib/runtime-alias.conf`)).toBe(`${PREFIX}\n`);
    expect(result.fs.stat(`${KEG}/lib/runtime.conf`).ino)
      .toBe(result.fs.stat(`${KEG}/lib/runtime-alias.conf`).ino);
  });

  it("leaves undeclared placeholder text untouched because changed_files is authoritative", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/lib/runtime.conf", data: "@@HOMEBREW_PREFIX@@\n" },
    ]);

    const result = await buildFixture(bytes);
    expect(readVfsFile(result.fs, `${KEG}/lib/runtime.conf`))
      .toBe("@@HOMEBREW_PREFIX@@\n");
  });

  it.each([
    [
      "a non-array",
      { changed_files: "lib/runtime.conf" },
      "changed_files must be an array or null",
    ],
    ["a non-string entry", { changed_files: [17] }, "changed_files[0] is not a string"],
    ["an unsafe path", { changed_files: ["../runtime.conf"] }, "unsafe path segment"],
    [
      "a duplicate path",
      { changed_files: ["lib/runtime.conf", "lib/runtime.conf"] },
      "repeats changed file lib/runtime.conf",
    ],
    ["a missing path", { changed_files: ["lib/missing.conf"] }, "missing or not regular"],
    [
      "an oversized path",
      { changed_files: [`lib/${"x".repeat(4096)}`] },
      "unsafe path segment",
    ],
  ])("rejects receipt changed_files containing %s", async (_label, receipt, expected) => {
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      {
        path: "hello/2.12.1/INSTALL_RECEIPT.json",
        data: JSON.stringify(receipt) + "\n",
      },
      { path: "hello/2.12.1/lib/runtime.conf", data: "plain text\n" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow(expected);
  });

  it("rejects Java relocation without one exact OpenJDK runtime dependency", async () => {
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      {
        path: "hello/2.12.1/INSTALL_RECEIPT.json",
        data: JSON.stringify({ changed_files: ["lib/java.conf"] }) + "\n",
      },
      { path: "hello/2.12.1/lib/java.conf", data: "@@HOMEBREW_JAVA@@\n" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow(
      "without exactly one OpenJDK runtime dependency",
    );
  });

  it("rejects a newline-suffixed OpenJDK dependency name", async () => {
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      {
        path: "hello/2.12.1/INSTALL_RECEIPT.json",
        data: JSON.stringify({
          changed_files: ["lib/java.conf"],
          runtime_dependencies: [{ full_name: "openjdk@21\n" }],
        }) + "\n",
      },
      { path: "hello/2.12.1/lib/java.conf", data: "@@HOMEBREW_JAVA@@\n" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow(
      "without exactly one OpenJDK runtime dependency",
    );
  });

  it("rejects an invalid INSTALL_RECEIPT.json before applying relocation", async () => {
    const bytes = bottleTar([
      ...standardEntries().filter((entry) =>
        entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"
      ),
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: "not json\n" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("not valid UTF-8 JSON");
  });

  it("records bounded Brewfile and requested-root provenance", async () => {
    const bytes = bottleTar(standardEntries());
    const brewfile = utf8(
      'tap "kandelo-dev/tap-core"\nbrew "hello"\n',
    );
    const result = await buildFixture(bytes, {
      selectionSource: {
        kind: "brewfile",
        parser: "kandelo-static-brewfile-v1",
        sha256: sha256(brewfile),
        bytes: brewfile.byteLength,
        requestedPackages: ["hello"],
      },
    });
    const expectedRootsSha = sha256(utf8(JSON.stringify(["hello"])));

    expect(result.report.selection).toEqual({
      kind: "brewfile",
      requested_packages: ["hello"],
      requested_packages_sha256: expectedRootsSha,
      brewfile: {
        parser: "kandelo-static-brewfile-v1",
        sha256: sha256(brewfile),
        bytes: brewfile.byteLength,
      },
    });
    expect(JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    ).selection).toEqual(result.report.selection);
  });

  it("records the consumer catalog separately from strict bottle build provenance", async () => {
    const bytes = bottleTar(standardEntries());
    const bottleUrl =
      `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:${sha256(bytes)}`;
    const builtTapCommit = "3333333333333333333333333333333333333333";
    const builtKandeloCommit = "4444444444444444444444444444444444444444";
    const formulaSha256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const catalogCommit = "5555555555555555555555555555555555555555";
    const result = await buildFixture(bytes, {
      strict: true,
      metadataOverrides: {
        url: bottleUrl,
        built_from: {
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: builtKandeloCommit,
          tap_repository: "kandelo-dev/homebrew-tap-core",
          tap_commit: builtTapCommit,
          formula_sha256: formulaSha256,
        },
      },
      linkOverrides: {
        bottle: {
          url: bottleUrl,
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
      catalogCheckout: {
        tapRepository: "kandelo-dev/homebrew-tap-core",
        tapName: "kandelo-dev/tap-core",
        checkoutCommit: catalogCommit,
      },
    });
    const composition = JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    );

    expect(result.report.catalog).toEqual({
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      checkout_commit: catalogCommit,
    });
    expect(result.report.metadata).toMatchObject({
      tap_commit: TAP_COMMIT,
      kandelo_commit: KANDELO_COMMIT,
    });
    expect(result.report.packages[0].built_from).toEqual({
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_commit: builtTapCommit,
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: builtKandeloCommit,
      formula_sha256: formulaSha256,
    });
    expect(composition.catalog).toEqual(result.report.catalog);
    expect(composition.packages[0].built_from)
      .toEqual(result.report.packages[0].built_from);
  });

  it("binds the reviewed migration lock into the report and composition", async () => {
    const bytes = bottleTar(standardEntries());
    const binding = {
      sha256: "abababababababababababababababababababababababababababababababab",
      bytes: 4096,
    };
    const result = await buildFixture(bytes, { migrationLock: binding });
    const composition = JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    );

    expect(result.report.migration_lock).toEqual(binding);
    expect(composition.migration_lock).toEqual(binding);

    await expect(buildFixture(bytes, {
      migrationLock: { sha256: "not-a-sha", bytes: 4096 },
    })).rejects.toThrow("migration lock provenance is invalid");
  });

  it("applies and reports exact package-conditioned runtime state", async () => {
    const bytes = bottleTar(standardEntries());
    const contents = "export DEMO=1\n";
    const compatibilityPolicy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [],
      aliases: [],
      // Deliberately put the child before its declared directory. The builder
      // validates the graph first and applies directory parents before files.
      runtime_state: [
        {
          requires_package: "kandelo-dev/tap-core/hello",
          path: "/etc/profile.d/demo.sh",
          kind: "text_file",
          mode: 0o640,
          uid: 0,
          gid: 12,
          reason: "Exercise a package-conditioned profile fragment.",
          contents,
        },
        {
          requires_package: "kandelo-dev/tap-core/hello",
          path: "/home/.demo/record",
          kind: "empty_file",
          mode: 0o660,
          uid: 1000,
          gid: 1000,
          reason: "Exercise a package-conditioned writable file.",
        },
        {
          requires_package: "kandelo-dev/tap-core/hello",
          path: "/home/.demo",
          kind: "directory",
          mode: 0o770,
          uid: 1000,
          gid: 1000,
          reason: "Own the parent runtime directory.",
        },
      ],
    };
    const result = await buildFixture(bytes, {
      compatibilityPolicy,
      seedFs(fs) {
        ensureDirRecursive(fs, "/etc/profile.d");
        ensureDirRecursive(fs, "/home");
      },
    });

    expect(readVfsFile(result.fs, "/etc/profile.d/demo.sh")).toBe(contents);
    expect(readVfsFile(result.fs, "/home/.demo/record")).toBe("");
    expect(result.fs.lstat("/etc/profile.d/demo.sh")).toMatchObject({
      uid: 0,
      gid: 12,
    });
    expect(result.fs.lstat("/etc/profile.d/demo.sh").mode & 0o7777).toBe(0o640);
    expect(result.fs.lstat("/home/.demo")).toMatchObject({ uid: 1000, gid: 1000 });
    expect(result.fs.lstat("/home/.demo").mode & 0o7777).toBe(0o770);
    expect(result.fs.lstat("/home/.demo/record")).toMatchObject({
      uid: 1000,
      gid: 1000,
      size: 0,
    });
    expect(result.fs.lstat("/home/.demo/record").mode & 0o7777).toBe(0o660);
    expect(result.report.runtime_state).toEqual([
      expect.objectContaining({
        requires_package: "kandelo-dev/tap-core/hello",
        path: "/etc/profile.d/demo.sh",
        kind: "text_file",
        mode: 0o640,
        uid: 0,
        gid: 12,
        content_sha256: sha256(utf8(contents)),
        content_bytes: utf8(contents).byteLength,
      }),
      expect.objectContaining({
        path: "/home/.demo/record",
        kind: "empty_file",
        content_sha256: sha256(new Uint8Array()),
        content_bytes: 0,
      }),
      expect.objectContaining({
        path: "/home/.demo",
        kind: "directory",
      }),
    ]);
    expect(JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    ).runtime_state).toEqual(result.report.runtime_state);
  });

  it("rejects invalid runtime-state declarations before pouring bottles", async () => {
    const bytes = bottleTar(standardEntries());
    const valid = {
      requires_package: "kandelo-dev/tap-core/hello",
      path: "/etc/runtime-state",
      kind: "empty_file" as const,
      mode: 0o600,
      uid: 0,
      gid: 0,
      reason: "Test state.",
    };
    const policy = (runtime_state: unknown[]): HomebrewVfsCompatibilityPolicy => ({
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [],
      aliases: [],
      runtime_state: runtime_state as HomebrewVfsCompatibilityPolicy["runtime_state"],
    });
    let bottleLoads = 0;

    for (const [declaration, expected] of [
      [{ ...valid, requires_package: "kandelo-dev/tap-core/missing" }, "requires_package"],
      [{ ...valid, path: 42 }, "path is invalid"],
      [{ ...valid, path: "/etc/../runtime-state" }, "normalized absolute path"],
      [{ ...valid, path: "/etc/kandelo/owned" }, "reserved for image metadata"],
      [{ ...valid, path: `${PREFIX}/unowned` }, "outside bottle prefixes"],
      [{ ...valid, kind: "socket" }, "kind is invalid"],
      [{ ...valid, mode: 0o10000 }, "mode is invalid"],
      [{ ...valid, uid: -1 }, "uid is invalid"],
      [{ ...valid, gid: 0x8000_0000 }, "gid is invalid"],
      [{ ...valid, reason: "" }, "reason is invalid"],
      [{ ...valid, contents: "not allowed" }, "unsupported shape"],
      [{ ...valid, extra: true }, "unsupported shape"],
      [{
        ...valid,
        kind: "text_file",
        contents: "x".repeat(65_537),
      }, "contents are invalid"],
    ] as const) {
      await expect(buildFixture(bytes, {
        compatibilityPolicy: policy([declaration]),
        onLoadBottle: () => { bottleLoads += 1; },
      })).rejects.toThrow(expected);
    }
    expect(bottleLoads).toBe(0);

    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy([valid, valid]),
    })).rejects.toThrow("declared more than once");
    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy([
        { ...valid, path: "/home/state", kind: "text_file", contents: "parent" },
        { ...valid, path: "/home/state/child" },
      ]),
    })).rejects.toThrow("cannot contain");
  });

  it("rejects runtime-state overwrites and missing or non-directory parents", async () => {
    const bytes = bottleTar(standardEntries());
    const policy = (path: string): HomebrewVfsCompatibilityPolicy => ({
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [],
      aliases: [],
      runtime_state: [{
        requires_package: "kandelo-dev/tap-core/hello",
        path,
        kind: "empty_file",
        mode: 0o600,
        uid: 0,
        gid: 0,
        reason: "Test state.",
      }],
    });

    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("/etc/existing"),
      seedFs(fs) {
        ensureDirRecursive(fs, "/etc");
        writeVfsFile(fs, "/etc/existing", "base-owned", 0o644);
      },
    })).rejects.toThrow("already exists in the platform base or a bottle");
    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("/missing/child"),
    })).rejects.toThrow("parent /missing is not an existing directory");
    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("/etc-file/child"),
      seedFs(fs) {
        writeVfsFile(fs, "/etc-file", "not a directory", 0o644);
      },
    })).rejects.toThrow("parent /etc-file is not an existing directory");
  });

  it("mirrors only bottle-owned bin links into POSIX command paths", async () => {
    const bytes = bottleTar(standardEntries());
    const compatibilityPolicy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: ["/usr/bin", "/bin"] },
      link_conflict_owners: [],
      aliases: [{
        package: "kandelo-dev/tap-core/hello",
        source_kind: "link",
        source: "bin/hello",
        targets: ["/usr/bin/sh", "/bin/sh"],
      }],
    };
    const result = await buildFixture(bytes, { compatibilityPolicy });

    for (const path of ["/usr/bin/hello", "/bin/hello", "/usr/bin/sh", "/bin/sh"]) {
      expect(result.fs.readlink(path)).toBe(`${PREFIX}/bin/hello`);
      expect(readVfsFile(result.fs, path)).toContain("echo hello");
    }
    expect(result.report.compatibility_links).toEqual([
      expect.objectContaining({
        path: "/usr/bin/hello",
        package: "kandelo-dev/tap-core/hello",
        source: "bin/hello",
        ownership: "bottle-link-manifest",
      }),
      expect.objectContaining({ path: "/bin/hello" }),
      expect.objectContaining({ path: "/usr/bin/sh" }),
      expect.objectContaining({ path: "/bin/sh" }),
    ]);
    expect(JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    ).compatibility_links).toEqual(result.report.compatibility_links);
  });

  it("creates explicitly reviewed aliases from executable bottle-keg files", async () => {
    const bytes = bottleTar(standardEntries([{
      path: "hello/2.12.1/libexec/git-core/git-remote-http",
      data: "#!/bin/sh\necho remote\n",
      mode: 0o755,
    }]));
    const compatibilityPolicy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [],
      aliases: [{
        package: "kandelo-dev/tap-core/hello",
        source_kind: "keg",
        source: "libexec/git-core/git-remote-http",
        targets: ["/usr/bin/git-remote-http", "/usr/bin/git-remote-https"],
      }],
    };
    const result = await buildFixture(bytes, { compatibilityPolicy });

    for (const path of ["/usr/bin/git-remote-http", "/usr/bin/git-remote-https"]) {
      expect(result.fs.readlink(path)).toBe(
        `${CELLAR}/hello/2.12.1/libexec/git-core/git-remote-http`,
      );
      expect(readVfsFile(result.fs, path)).toContain("echo remote");
    }
    expect(result.report.compatibility_links).toEqual([
      expect.objectContaining({
        path: "/usr/bin/git-remote-http",
        source: "libexec/git-core/git-remote-http",
        ownership: "bottle-keg",
      }),
      expect.objectContaining({
        path: "/usr/bin/git-remote-https",
        ownership: "bottle-keg",
      }),
    ]);
  });

  it("rejects misdeclared, missing, and non-executable bottle-keg alias sources", async () => {
    const bytes = bottleTar(standardEntries([{
      path: "hello/2.12.1/libexec/not-executable",
      data: "not executable\n",
      mode: 0o644,
    }]));
    const policy = (source: string): HomebrewVfsCompatibilityPolicy => ({
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [],
      aliases: [{
        package: "kandelo-dev/tap-core/hello",
        source_kind: "keg",
        source,
        targets: ["/usr/bin/reviewed-alias"],
      }],
    });

    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("bin/hello"),
    })).rejects.toThrow('declare source_kind "link"');
    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("libexec/missing"),
    })).rejects.toThrow("is not an executable regular bottle file");
    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("libexec/not-executable"),
    })).rejects.toThrow("is not an executable regular bottle file");
    await expect(buildFixture(bytes, {
      compatibilityPolicy: policy("../bin/hello"),
    })).rejects.toThrow("contains an unsafe path segment");
  });

  it("selects duplicate prefix and POSIX links only through migration-lock ownership", async () => {
    const policy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: ["/usr/bin", "/bin"] },
      link_conflict_owners: [{
        target: "bin/ex",
        package: "kandelo-dev/tap-core/posix-utils-lite",
        reason: "Preserve the current main-shell ex implementation.",
      }],
      aliases: [],
    };
    const result = await buildLinkConflictFixture(policy);
    const selectedKeg = `${CELLAR}/posix-utils-lite/2.12.1`;
    const composition = JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    );

    expect(result.fs.readlink(`${PREFIX}/bin/ex`)).toBe(`${selectedKeg}/bin/hello`);
    expect(result.fs.readlink("/usr/bin/ex")).toBe(`${PREFIX}/bin/ex`);
    expect(result.fs.readlink("/bin/ex")).toBe(`${PREFIX}/bin/ex`);
    expect(result.report.packages.find(({ name }) => name === "ed")?.links).toEqual([]);
    expect(result.report.packages.find(({ name }) => name === "posix-utils-lite")?.links)
      .toEqual(["bin/ex"]);
    expect(result.report.link_conflicts).toEqual([{
      path: `${PREFIX}/bin/ex`,
      target: "bin/ex",
      owners: ["kandelo-dev/tap-core/ed", "kandelo-dev/tap-core/posix-utils-lite"],
      selected_package: "kandelo-dev/tap-core/posix-utils-lite",
      skipped_packages: ["kandelo-dev/tap-core/ed"],
      reason: "Preserve the current main-shell ex implementation.",
      resolution: "migration-lock",
    }]);
    expect(composition.link_conflicts).toEqual(result.report.link_conflicts);
    expect(result.report.compatibility_links?.filter(({ source }) => source === "bin/ex"))
      .toHaveLength(2);

    const reversed = await buildLinkConflictFixture(
      policy,
      ["posix-utils-lite", "ed"],
    );
    expect(reversed.fs.readlink(`${PREFIX}/bin/ex`)).toBe(`${selectedKeg}/bin/hello`);
    expect(reversed.report.link_conflicts?.[0].selected_package)
      .toBe("kandelo-dev/tap-core/posix-utils-lite");
  });

  it("validates a reviewed losing link source before skipping its target", async () => {
    const policy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [{
        target: "bin/ex",
        package: "kandelo-dev/tap-core/posix-utils-lite",
        reason: "Preserve the current main-shell ex implementation.",
      }],
      aliases: [],
    };
    await expect(buildLinkConflictFixture(
      policy,
      undefined,
      undefined,
      "ed",
    )).rejects.toThrow("link source Cellar/ed/2.12.1/bin/missing is missing");
  });

  it("rejects missing, stale, and duplicate link-conflict owner declarations before pouring", async () => {
    let bottleLoads = 0;
    await expect(buildLinkConflictFixture(undefined, undefined, () => {
      bottleLoads += 1;
    })).rejects.toThrow("migration lock must select an owner");
    expect(bottleLoads).toBe(0);

    const declaration = {
      target: "bin/ex",
      package: "kandelo-dev/tap-core/posix-utils-lite",
      reason: "Preserve the current main-shell ex implementation.",
    };
    const policy: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [declaration],
      aliases: [],
    };
    await expect(buildLinkConflictFixture(
      policy,
      ["posix-utils-lite"],
    )).rejects.toThrow("is stale or unnecessary");

    await expect(buildLinkConflictFixture({
      mirror_link_manifest_bin: { targets: [] },
      link_conflict_owners: [declaration, declaration],
      aliases: [],
    })).rejects.toThrow("is declared more than once");
  });

  it("rejects legacy path collisions and aliases not owned by a bottle manifest", async () => {
    const bytes = bottleTar(standardEntries());
    const mirror: HomebrewVfsCompatibilityPolicy = {
      mirror_link_manifest_bin: { targets: ["/usr/bin"] },
      link_conflict_owners: [],
      aliases: [],
    };
    await expect(buildFixture(bytes, {
      compatibilityPolicy: mirror,
      seedFs(fs) {
        ensureDirRecursive(fs, "/usr/bin");
        writeVfsFile(fs, "/usr/bin/hello", "legacy registry bytes", 0o755);
      },
    })).rejects.toThrow("already exists in the platform base or another package");

    await expect(buildFixture(bytes, {
      compatibilityPolicy: {
        mirror_link_manifest_bin: { targets: [] },
        link_conflict_owners: [],
        aliases: [{
          package: "kandelo-dev/tap-core/hello",
          source_kind: "link",
          source: "bin/not-reviewed",
          targets: ["/bin/sh"],
        }],
      },
    })).rejects.toThrow("is not owned by that bottle's link manifest");
  });

  it("rejects invalid Brewfile provenance before loading bottle bytes", async () => {
    const bytes = bottleTar(standardEntries());
    let loaded = false;
    const manifest = linkManifest(bytes);
    const plan = await planHomebrewVfs(metadataForBottle(bytes), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: () => manifest,
    });
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    await expect(buildHomebrewVfs(plan, {
      fs,
      selectionSource: {
        kind: "brewfile",
        parser: "kandelo-static-brewfile-v1",
        sha256: "not-a-sha",
        bytes: 10,
        requestedPackages: ["hello"],
      } as HomebrewVfsSelectionSource,
      loadBottleBytes() {
        loaded = true;
        return bytes;
      },
    })).rejects.toThrow("selection provenance is invalid");
    expect(loaded).toBe(false);
  });

  it("rejects Brewfile roots that differ from the plan before loading bottle bytes", async () => {
    const bytes = bottleTar(standardEntries());
    let loaded = false;
    const plan = await planHomebrewVfs(metadataForBottle(bytes), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: () => linkManifest(bytes),
    });
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    await expect(buildHomebrewVfs(plan, {
      fs,
      selectionSource: {
        kind: "brewfile",
        parser: "kandelo-static-brewfile-v1",
        sha256: sha256(utf8('brew "other"\n')),
        bytes: 13,
        requestedPackages: ["other"],
      },
      loadBottleBytes() {
        loaded = true;
        return bytes;
      },
    })).rejects.toThrow("requested packages do not match the plan roots");
    expect(loaded).toBe(false);
  });

  it("supports keg-relative link sources and receipts", async () => {
    const bytes = bottleTar(standardEntries());
    const result = await buildFixture(bytes, {
      linkOverrides: {
        links: [{ type: "symlink", source: "bin/hello", target: "bin/hello" }],
        receipts: [".brew/hello.rb", "INSTALL_RECEIPT.json"],
      },
    });

    expect(result.fs.readlink(`${PREFIX}/bin/hello`)).toBe(`${KEG}/bin/hello`);
  });

  it("rejects a link-manifest collision with the canonical opt link", async () => {
    const bytes = bottleTar(standardEntries());

    await expect(buildFixture(bytes, {
      linkOverrides: {
        links: [
          { type: "symlink", source: "bin/hello", target: "bin/hello" },
          { type: "symlink", source: "bin/hello", target: "opt/hello" },
        ],
      },
    })).rejects.toThrow(
      `canonical opt link opt/hello already exists at ${PREFIX}/opt/hello`,
    );
  });

  it("rejects a non-directory canonical opt root", async () => {
    const bytes = bottleTar(standardEntries());

    await expect(buildFixture(bytes, {
      linkOverrides: {
        links: [
          { type: "symlink", source: "bin/hello", target: "bin/hello" },
          { type: "symlink", source: "bin/hello", target: "opt" },
        ],
      },
    })).rejects.toThrow(
      `canonical opt directory is not a real directory at ${PREFIX}/opt`,
    );
  });

  it("pours and links a POSIX bracket utility path", async () => {
    const bytes = bottleTar(standardEntries([
      {
        path: "hello/2.12.1/bin/[",
        data: "#!/bin/sh\necho bracket\n",
        mode: 0o755,
      },
    ]));
    const result = await buildFixture(bytes, {
      linkOverrides: {
        links: [{
          type: "symlink",
          source: "Cellar/hello/2.12.1/bin/[",
          target: "bin/[",
        }],
      },
    });

    expect(result.fs.readlink(`${PREFIX}/bin/[`)).toBe(`${KEG}/bin/[`);
    expect(readVfsFile(result.fs, `${KEG}/bin/[`)).toContain("echo bracket");
    expect(result.report.packages[0].links).toEqual(["bin/["]);
  });

  it("records last-green fallback source status in the report", async () => {
    const bytes = bottleTar(standardEntries());
    const metadataOverrides = {
      status: "failed",
      error: "latest rebuild failed",
      last_attempt: "2026-06-28T00:00:00Z",
      last_attempt_by: "https://example.invalid/actions/runs/2",
      url: undefined,
      sha256: undefined,
      bytes: undefined,
      cache_key_sha: undefined,
      link_manifest: undefined,
      fallback_url: "file:///tmp/hello.last-green.tar.gz",
      fallback_sha256: sha256(bytes),
      fallback_bytes: bytes.byteLength,
      fallback_cache_key_sha: CACHE_KEY,
      fallback_link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
      fallback_built_at: "2026-06-27T00:00:00Z",
    };
    const result = await buildFixture(bytes, {
      metadataOverrides,
      linkOverrides: {
        bottle: {
          url: "file:///tmp/hello.last-green.tar.gz",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
    });

    expect(result.report.packages[0].source_status).toBe("fallback");
    expect(result.report.packages[0].metadata_status).toBe("failed");
  });

  it("rejects byte count mismatches before extraction", async () => {
    const bytes = bottleTar(standardEntries());
    await expect(buildFixture(bytes, {
      metadataOverrides: { bytes: bytes.byteLength + 1 },
      linkOverrides: {
        bottle: {
          url: "file:///tmp/hello.bottle.tar.gz",
          sha256: sha256(bytes),
          bytes: bytes.byteLength + 1,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
    })).rejects.toThrow("byte count");
  });

  it("rejects sha256 mismatches before extraction", async () => {
    const bytes = bottleTar(standardEntries());
    await expect(buildFixture(bytes, {
      metadataOverrides: { sha256: WRONG_SHA },
      linkOverrides: {
        bottle: {
          url: "file:///tmp/hello.bottle.tar.gz",
          sha256: WRONG_SHA,
          bytes: bytes.byteLength,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
    })).rejects.toThrow("bottle sha256");
  });

  it("rejects missing receipts after staging", async () => {
    const bytes = bottleTar(standardEntries([
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", type: "hardlink" },
    ]).filter((entry) => entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"));

    await expect(buildFixture(bytes)).rejects.toThrow("receipt");
  });

  it("rejects unsafe tar paths", async () => {
    const bytes = bottleTar([
      { path: "../evil", data: "bad" },
      ...standardEntries(),
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("unsafe path segment");
  });

  it("stages safe hardlinks as shared regular-file inodes", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "hello/2.12.1/bin/hello" },
    ]);

    const result = await buildFixture(bytes);
    const original = result.fs.stat(`${KEG}/bin/hello`);
    const linked = result.fs.stat(`${KEG}/bin/hello2`);

    expect(readVfsFile(result.fs, `${KEG}/bin/hello2`)).toContain("echo hello");
    expect(linked.ino).toBe(original.ino);
    expect(linked.nlink).toBe(2);
    expect(original.nlink).toBe(2);
    expect(result.report.packages[0].staged_files).toBe(4);
  });

  it("resolves forward hardlinks after their regular-file targets", async () => {
    const bytes = bottleTar([
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "hello/2.12.1/bin/hello" },
      ...standardEntries(),
    ]);

    const result = await buildFixture(bytes);
    expect(result.fs.stat(`${KEG}/bin/hello2`).ino)
      .toBe(result.fs.stat(`${KEG}/bin/hello`).ino);
  });

  it("rejects hardlinks whose targets escape the bottle", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "../hello" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("unsafe path segment");
  });

  it("rejects hardlinks into another Cellar keg", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      {
        path: "hello/2.12.1/bin/hello2",
        type: "hardlink",
        linkName: "Cellar/other/1.0/bin/other",
      },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow(`not contained in keg ${KEG}`);
  });

  it("rejects hardlink entries installed into another Cellar keg", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      {
        path: "Cellar/other/1.0/bin/other",
        type: "hardlink",
        linkName: "hello/2.12.1/bin/hello",
      },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow(`not contained in keg ${KEG}`);
  });

  it("rejects hardlinks with payload bytes", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      {
        path: "hello/2.12.1/bin/hello2",
        type: "hardlink",
        linkName: "hello/2.12.1/bin/hello",
        data: "ignored payload",
      },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("nonzero payload size");
  });

  it("rejects hardlink targets not staged by the same bottle", async () => {
    const missing = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "hello/2.12.1/bin/missing" },
    ]);
    await expect(buildFixture(missing)).rejects.toThrow("is not staged by this bottle");
  });

  it("rejects cyclic hardlink targets", async () => {
    const cyclic = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "hello/2.12.1/bin/hello3" },
      { path: "hello/2.12.1/bin/hello3", type: "hardlink", linkName: "hello/2.12.1/bin/hello2" },
    ]);
    await expect(buildFixture(cyclic)).rejects.toThrow("target is missing or cyclic");
  });

  it("rejects hardlinks to non-regular bottle entries", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/bin/hello-link", type: "symlink", linkName: "hello" },
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "hello/2.12.1/bin/hello-link" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("is not a regular file");
  });
});
