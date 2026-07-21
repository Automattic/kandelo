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
import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import { ABI_VERSION } from "../src/generated/abi";
import {
  buildHomebrewVfs,
  type HomebrewVfsBuildResult,
  type HomebrewVfsCatalogCheckout,
  type HomebrewVfsCompatibilityPolicy,
  type HomebrewVfsSelectionSource,
} from "../src/homebrew-vfs-builder";
import {
  buildHomebrewLazyLayer,
  encodeHomebrewLazyLayerDescriptor,
  type HomebrewLazyLayerDescriptor,
  type HomebrewLazyLayerBasePackageSource,
} from "../src/homebrew-lazy-layer";
import {
  HOMEBREW_RUNTIME_LAYER_LIMITS,
  parseHomebrewRuntimeLayerDescriptor,
  registerHomebrewRuntimeLayers,
  type HomebrewRuntimeLayerReference,
} from "../src/homebrew-runtime-layer-consumer";
import {
  planHomebrewVfs,
  type HomebrewLinkManifest,
  type HomebrewTapMetadata,
  type HomebrewVfsPlan,
} from "../src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsFile } from "../src/vfs/image-helpers";
import {
  extractZipEntry,
  parseZipCentralDirectory,
} from "../src/vfs/zip";

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
    {
      path: `runtime/${runtimeVersion}/bin/runtime`,
      data: "#!/bin/sh\necho runtime\n",
      mode: 0o755,
    },
    {
      path: `runtime/${runtimeVersion}/.brew/runtime.rb`,
      data: "class Runtime < Formula\nend\n",
    },
    {
      path: `runtime/${runtimeVersion}/INSTALL_RECEIPT.json`,
      data: "{}\n",
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
  const plan = {
    ...basePlan,
    requestedPackages: ["runtime"],
    packages: [basePlan.packages[0], runtimePackage],
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
    loadBottleBytes: (pkg) => pkg.name === "hello" ? baseBytes : runtimeBytes,
  });
  return { baseFs, plan, build, baseBytes, runtimeBytes, runtimeKeg };
}

async function runtimeLayerConsumerFixture() {
  const fixture = await lazyLayerFixture({
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
      plan.packages[0].url =
        "https://example.invalid/bottles/hello.bottle.tar.gz";
      plan.packages[1].url =
        "https://example.invalid/bottles/runtime.bottle.tar.gz";
    },
  });
  const result = await fixture.build();
  const baseImageBytes = await fixture.baseFs.saveImage();
  const baseSha = sha256(baseImageBytes);
  result.descriptor.base_vfs.sha256 = baseSha;
  result.descriptor.base_vfs.bytes = baseImageBytes.byteLength;
  result.descriptor.base_vfs.package_source.output.sha256 = baseSha;
  result.descriptor.base_vfs.package_source.output.bytes = baseImageBytes.byteLength;
  return {
    ...fixture,
    descriptor: result.descriptor,
    archive: result.archive,
    baseImageBytes,
  };
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
        url: `https://example.invalid/layers/${id}.json`,
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
  for (const entry of descriptor.entries) {
    entry.path = replaceName(entry.path);
    if (entry.target !== undefined) {
      entry.target = replaceName(entry.target);
      entry.size = utf8(entry.target).byteLength;
    }
  }
  descriptor.entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  descriptor.archive.asset = `kandelo-homebrew-${id}-layer.zip`;
  descriptor.archive.url = descriptor.archive.url.replace(
    /[^/]+$/,
    descriptor.archive.asset,
  );
  descriptor.archive.sha256 = sha256(utf8(`${id}-archive`));
  descriptor.archive.uncompressed_bytes = descriptor.entries.reduce(
    (total, entry) => total + entry.size,
    0,
  );
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
  it("registers verified stubs without fetching the archive, then verifies it on demand", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const { reference, bytes } = runtimeLayerReference("runtime", fixture.descriptor);
    let descriptorFetches = 0;
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    const registered = await registerHomebrewRuntimeLayers({
      fs,
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [reference],
      fetch: async () => {
        descriptorFetches += 1;
        return new Response(bytes);
      },
    });

    expect(descriptorFetches).toBe(1);
    expect(registered).toHaveLength(1);
    expect(fs.readlink(`${PREFIX}/bin/runtime`)).toBe(
      `${fixture.runtimeKeg}/bin/runtime`,
    );
    expect(fs.exportLazyArchiveEntries()[0]).toMatchObject({
      url: fixture.descriptor.archive.url,
      integrity: {
        sha256: fixture.descriptor.archive.sha256,
        bytes: fixture.archive.byteLength,
      },
    });

    const originalFetch = globalThis.fetch;
    let archiveFetches = 0;
    globalThis.fetch = async () => {
      archiveFetches += 1;
      return new Response(fixture.archive);
    };
    try {
      await expect(
        fs.ensureMaterialized(`${fixture.runtimeKeg}/bin/runtime`),
      ).resolves.toBe(true);
      expect(readVfsFile(fs, `${fixture.runtimeKeg}/bin/runtime`))
        .toContain("echo runtime");
      expect(archiveFetches).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(registerHomebrewRuntimeLayers({
      fs,
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).resolves.toHaveLength(2);

    expect(fs.exportLazyArchiveEntries()).toHaveLength(2);
    expect(fs.readlink(`${PREFIX}/bin/runtime`)).toBe(
      `${fixture.runtimeKeg}/bin/runtime`,
    );
    expect(fs.readlink(`${PREFIX}/bin/perl`)).toBe(
      `${perlDescriptor.packages.layer[0].keg}/bin/perl`,
    );
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
    delete missing.archive;
    expect(() => parseHomebrewRuntimeLayerDescriptor(missing)).toThrow(
      /descriptor has unexpected or missing fields/,
    );

    const longPath = structuredClone(fixture.descriptor);
    longPath.entries.find((entry) => entry.type === "file")!.path =
      `${PREFIX.slice(1)}/${"x".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes)}`;
    expect(() => parseHomebrewRuntimeLayerDescriptor(longPath)).toThrow(
      /path exceeds 4096 bytes/,
    );

    const largeArchive = structuredClone(fixture.descriptor);
    largeArchive.archive.bytes = HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes + 1;
    expect(() => parseHomebrewRuntimeLayerDescriptor(largeArchive)).toThrow(
      /archive bytes must be an integer/,
    );
  });

  it("binds every layer package to its declared keg, opt link, and tap provenance", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const missingKeg = structuredClone(fixture.descriptor);
    const missingKegPackage = missingKeg.packages.layer[0];
    missingKegPackage.keg = `${PREFIX}/Cellar/runtime/missing`;
    missingKegPackage.opt_link.target = "../Cellar/runtime/missing";
    expect(() => parseHomebrewRuntimeLayerDescriptor(missingKeg)).toThrow(
      /has no layer-owned keg entry/,
    );

    const wrongOpt = structuredClone(fixture.descriptor);
    const optPath = `${PREFIX.slice(1)}/${wrongOpt.packages.layer[0].opt_link.path}`;
    const optEntry = wrongOpt.entries.find((entry) => entry.path === optPath)!;
    optEntry.target = "../Cellar/runtime/wrong";
    optEntry.size = utf8(optEntry.target).byteLength;
    wrongOpt.archive.uncompressed_bytes = wrongOpt.entries.reduce(
      (total, entry) => total + entry.size,
      0,
    );
    expect(() => parseHomebrewRuntimeLayerDescriptor(wrongOpt)).toThrow(
      /has no matching opt link entry/,
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
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);
    let fetches = 0;
    const fetch = async () => {
      fetches += 1;
      return new Response(exact.bytes);
    };

    await expect(registerHomebrewRuntimeLayers({
      fs,
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

    await expect(registerHomebrewRuntimeLayers({
      fs,
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [{
        ...exact.reference,
        id: "a".repeat(HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackageNameBytes + 1),
      }],
      fetch,
    })).rejects.toThrow(/reference 0 id is invalid/);

    const half = Math.floor(HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes / 2) + 1;
    await expect(registerHomebrewRuntimeLayers({
      fs,
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

    await expect(registerHomebrewRuntimeLayers({
      fs,
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

  it("rejects aggregate uncompressed size before changing the VFS", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtimeDescriptor = structuredClone(fixture.descriptor);
    const perlDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    const declaredSize = Math.floor(
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes / 2,
    ) + 1;
    for (const descriptor of [runtimeDescriptor, perlDescriptor]) {
      const file = descriptor.entries.find((entry) => entry.type === "file")!;
      file.size = declaredSize;
      descriptor.archive.uncompressed_bytes = descriptor.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
    }
    const runtime = runtimeLayerReference("runtime", runtimeDescriptor);
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(registerHomebrewRuntimeLayers({
      fs,
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/selected Homebrew runtime layers exceed the uncompressed size cap/i);
    expect(() => fs.lstat(fixture.runtimeKeg)).toThrow();
    expect(() => fs.lstat(perlDescriptor.packages.layer[0].keg)).toThrow();
  });

  it("rejects reused archive identities and cross-layer directory ownership", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const duplicateArchiveDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    duplicateArchiveDescriptor.archive.asset = fixture.descriptor.archive.asset;
    duplicateArchiveDescriptor.archive.url = fixture.descriptor.archive.url;
    duplicateArchiveDescriptor.archive.sha256 = fixture.descriptor.archive.sha256;
    const duplicateArchive = runtimeLayerReference("perl", duplicateArchiveDescriptor);
    let responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [duplicateArchive.reference.descriptor.url, duplicateArchive.bytes],
    ]);

    await expect(registerHomebrewRuntimeLayers({
      fs: MemoryFileSystem.fromImage(fixture.baseImageBytes),
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, duplicateArchive.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/reuses another layer archive/);

    const nestedDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    nestedDescriptor.entries.find((entry) => entry.type === "file")!.path =
      `${fixture.runtimeKeg.slice(1)}/foreign-perl`;
    nestedDescriptor.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    const nested = runtimeLayerReference("perl", nestedDescriptor);
    responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [nested.reference.descriptor.url, nested.bytes],
    ]);
    await expect(registerHomebrewRuntimeLayers({
      fs: MemoryFileSystem.fromImage(fixture.baseImageBytes),
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, nested.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/descends through runtime-owned directory/);
  });

  it("rejects a shell composition digest mismatch before changing the VFS", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const descriptor = structuredClone(fixture.descriptor);
    descriptor.base_vfs.composition.package_set_sha256 = "9".repeat(64);
    const encoded = runtimeLayerReference("runtime", descriptor);
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(registerHomebrewRuntimeLayers({
      fs,
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
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(registerHomebrewRuntimeLayers({
      fs,
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [{
        ...exact.reference,
        descriptor: { ...exact.reference.descriptor, bytes: exact.bytes.byteLength - 1 },
      }],
      fetch: async () => new Response(exact.bytes),
    })).rejects.toThrow(/descriptor exceeds expected/);

    await expect(registerHomebrewRuntimeLayers({
      fs,
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
    const encoded = runtimeLayerReference("runtime", descriptor);

    await expect(registerHomebrewRuntimeLayers({
      fs: MemoryFileSystem.fromImage(fixture.baseImageBytes),
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
    descriptor.entries[0].path = "../escape";
    const encoded = runtimeLayerReference("runtime", descriptor);
    const fs = MemoryFileSystem.fromImage(fixture.baseImageBytes);

    await expect(registerHomebrewRuntimeLayers({
      fs,
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
    const file = descriptor.entries.find((entry) => entry.type === "file")!;
    file.path = `${KEG.slice(1)}/bin/hello`;
    descriptor.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    const encoded = runtimeLayerReference("runtime", descriptor);

    await expect(registerHomebrewRuntimeLayers({
      fs: MemoryFileSystem.fromImage(fixture.baseImageBytes),
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [encoded.reference],
      fetch: async () => new Response(encoded.bytes),
    })).rejects.toThrow(/collides with the base/);
  });

  it("rejects pairwise path conflicts between independently named layers", async () => {
    const fixture = await runtimeLayerConsumerFixture();
    const runtime = runtimeLayerReference("runtime", fixture.descriptor);
    const perlDescriptor = runtimeLayerVariant(fixture.descriptor, "perl");
    const runtimeFile = fixture.descriptor.entries.find(
      (entry) => entry.type === "file",
    )!;
    const perlFile = perlDescriptor.entries.find((entry) => entry.type === "file")!;
    perlFile.path = runtimeFile.path;
    perlDescriptor.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    const perl = runtimeLayerReference("perl", perlDescriptor);
    const responses = new Map([
      [runtime.reference.descriptor.url, runtime.bytes],
      [perl.reference.descriptor.url, perl.bytes],
    ]);

    await expect(registerHomebrewRuntimeLayers({
      fs: MemoryFileSystem.fromImage(fixture.baseImageBytes),
      baseImageBytes: fixture.baseImageBytes,
      arch: "wasm32",
      kernelAbi: ABI_VERSION,
      layers: [runtime.reference, perl.reference],
      fetch: async (url) => new Response(responses.get(url)!),
    })).rejects.toThrow(/conflict at/);
  });
});

describe("Homebrew VFS builder", () => {
  it("builds a deterministic lazy ZIP containing only base-exclusive package output", async () => {
    const fixture = await lazyLayerFixture();
    const first = await fixture.build();
    const second = await fixture.build();
    expect(Array.from(first.archive)).toEqual(Array.from(second.archive));
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
    expect(first.descriptor.schema).toBe(2);
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
    expect(first.descriptor.release.tag).toBe(
      "homebrew-vfs-sha256-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );
    expect(first.descriptor.packages.base).toEqual([expect.objectContaining({
      full_name: "kandelo-dev/tap-core/hello",
      sha256: sha256(fixture.baseBytes),
      link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
    })]);
    expect(first.descriptor.packages.layer).toEqual([expect.objectContaining({
      full_name: "kandelo-dev/tap-core/runtime",
      sha256: sha256(fixture.runtimeBytes),
    })]);

    const entries = parseZipCentralDirectory(first.archive);
    expect(entries.map((entry) => entry.fileName)).toEqual(
      first.descriptor.entries.map((entry) =>
        entry.type === "directory" ? `${entry.path}/` : entry.path
      ),
    );
    const executable = entries.find(
      (entry) => entry.fileName === "home/linuxbrew/.linuxbrew/Cellar/runtime/3.0/bin/runtime",
    );
    expect(executable?.mode & 0o7777).toBe(0o755);
    expect(new TextDecoder().decode(extractZipEntry(first.archive, executable!)))
      .toContain("echo runtime");
    const linked = entries.find(
      (entry) => entry.fileName === "home/linuxbrew/.linuxbrew/bin/runtime",
    );
    expect(linked?.isSymlink).toBe(true);
    expect(new TextDecoder().decode(extractZipEntry(first.archive, linked!)))
      .toBe(`${fixture.runtimeKeg}/bin/runtime`);
    expect(entries.some((entry) => entry.fileName.startsWith("etc/"))).toBe(false);
    expect(entries.some((entry) => entry.fileName.includes("/hello/"))).toBe(false);
    expect(first.descriptor.entries).toContainEqual(expect.objectContaining({
      path: "home/linuxbrew/.linuxbrew/bin",
      type: "directory",
      ownership: "shared-base-directory",
    }));
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
