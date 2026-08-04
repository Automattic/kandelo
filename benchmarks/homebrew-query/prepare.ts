#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import {
  MemoryFileSystem,
  type SerializedLazyTree,
  type VfsImageMetadata,
} from "../../host/src/vfs/memory-fs";
import { restoreVerifiedVfsImage } from "../../host/src/vfs/load-image";
import { ensureDirRecursive } from "../../host/src/vfs/image-helpers";
import { ENOENT } from "../../host/src/vfs/sharedfs-vendor";
import type {
  HomebrewQueryArtifact,
  HomebrewQueryFixtureManifest,
  HomebrewQueryLazyArtifact,
  HomebrewQueryTap,
} from "./contracts";

interface Options {
  imagePath: string;
  kernelPath: string;
  bootstrapPath: string;
  outputDirectory: string;
  sourceCommit: string;
  lazyUrlBase: string;
  taps: Array<{ name: string; path: string }>;
  coreFormula: string;
  canaryFormula?: string;
  trustedFormulae: string[];
  eager: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256_RE = /^[0-9a-f]{64}$/;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  mkdirSync(options.outputDirectory, { recursive: true });
  const lazyDirectory = join(options.outputDirectory, "lazy");
  mkdirSync(lazyDirectory, { recursive: true });

  const sourceImage = bytes(options.imagePath);
  const fs = await restoreVerifiedVfsImage(sourceImage);
  const metadata = fs.getImageMetadata() as (VfsImageMetadata & {
    homebrewBootstrap?: { ownership?: { prefix?: unknown } };
    homebrew?: { defaultShell?: { path?: unknown; argv?: unknown } };
  }) | null;
  const prefix = metadata?.homebrewBootstrap?.ownership?.prefix;
  const shellPath = metadata?.homebrew?.defaultShell?.path;
  const shellArgv = metadata?.homebrew?.defaultShell?.argv;
  if (
    typeof prefix !== "string" || !prefix.startsWith("/") ||
    typeof shellPath !== "string" || !shellPath.startsWith("/") ||
    !Array.isArray(shellArgv) || typeof shellArgv[0] !== "string"
  ) {
    throw new Error("Homebrew image does not declare its prefix and shell");
  }

  const taps: HomebrewQueryTap[] = [];
  const tapRepositories = new Set<string>();
  for (const tap of options.taps) {
    const repository = tapRepository(tap.name);
    if (tapRepositories.has(repository)) {
      throw new Error(`Duplicate tap repository: ${repository}`);
    }
    tapRepositories.add(repository);
    const dirty = git(tap.path, ["status", "--porcelain=v1"]);
    if (dirty !== "") {
      throw new Error(`Tap checkout is not clean: ${tap.path}`);
    }
    const commit = git(tap.path, ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`Tap ${tap.name} did not resolve to a commit`);
    }
    const target = `${prefix}/Library/Taps/${repository}`;
    removeVfsTree(fs, target);
    copyHostTree(fs, tap.path, target, 1000, 1000);
    taps.push({ name: tap.name, repository, commit });
  }

  // Homebrew treats Caskroom as part of an initialized prefix even when no
  // casks are installed. Published shells mount an empty writable directory
  // here; put the same state in the cross-host fixture so `brew list` measures
  // discovery rather than an incomplete harness mount.
  const caskroom = `${prefix}/Caskroom`;
  ensureDirRecursive(fs, caskroom, 0o755);
  fs.chown(caskroom, 1000, 1000);
  fs.chmod(caskroom, 0o755);

  const environment = [
    "HOME=/home/user",
    "USER=user",
    "LOGNAME=user",
    `SHELL=${shellPath}`,
    `PATH=${prefix}/bin:${prefix}/sbin:/usr/local/bin:/usr/bin:/bin`,
    ...readVfsText(fs, "/etc/homebrew/brew.env")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  ];
  for (const required of [
    "HOMEBREW_NO_AUTO_UPDATE=1",
    "HOMEBREW_NO_INSTALL_FROM_API=1",
    "HOMEBREW_NO_ANALYTICS=1",
  ]) {
    if (!environment.includes(required)) environment.push(required);
  }
  const trustedFormulae = [...new Set(options.trustedFormulae)].sort();
  if (trustedFormulae.length > 0) {
    // WHY: Kandelo mounts /home/user and /var as fresh per-boot scratch on
    // both hosts, so user state embedded there is intentionally hidden at
    // runtime. Keep this immutable benchmark input in the rootfs-backed /etc
    // tree and select it through the standard XDG configuration variable.
    const configRoot = "/etc/kandelo/homebrew-query-config";
    const configHome = `${configRoot}/homebrew`;
    for (let index = environment.length - 1; index >= 0; index -= 1) {
      if (
        environment[index]!.startsWith("XDG_CONFIG_HOME=") ||
        environment[index]!.startsWith("HOMEBREW_USER_CONFIG_HOME=")
      ) {
        environment.splice(index, 1);
      }
    }
    environment.push(`XDG_CONFIG_HOME=${configRoot}`);
    ensureDirRecursive(fs, configHome, 0o700);
    fs.chown(configRoot, 1000, 1000);
    fs.chmod(configRoot, 0o700);
    fs.chown(configHome, 1000, 1000);
    fs.chmod(configHome, 0o700);
    fs.createFileWithOwner(
      `${configHome}/trust.json`,
      0o600,
      1000,
      1000,
      new TextEncoder().encode(
        `${JSON.stringify({ trustedformulae: trustedFormulae }, null, 2)}\n`,
      ),
    );
  }

  const inheritedMetadata: VfsImageMetadata = metadata ?? { version: 1 };
  fs.setImageMetadata({
    ...inheritedMetadata,
    homebrewQueryBenchmark: {
      schema: 1,
      taps,
      sourceImageSha256: sha256(sourceImage),
    },
  });
  const rootfsPath = join(options.outputDirectory, "rootfs.vfs.zst");
  await saveCompressedImage(fs, rootfsPath);

  const bootstrap = bytes(options.bootstrapPath);
  const lazyAssets = await materializeLazyArtifacts({
    groups: fs.exportLazyArchiveEntries(),
    bootstrap,
    lazyUrlBase: options.lazyUrlBase,
    outputDirectory: options.outputDirectory,
  });

  let eagerRootfs: HomebrewQueryArtifact | undefined;
  if (options.eager) {
    const eagerFs = await restoreVerifiedVfsImage(bytes(rootfsPath));
    const assetsByUrl = new Map(
      lazyAssets.map((asset) => [
        asset.url,
        bytes(join(options.outputDirectory, asset.file)),
      ]),
    );
    eagerFs.setLazyFetcher(async (input) => {
      const url = new URL(input, options.lazyUrlBase).href;
      const asset = assetsByUrl.get(url);
      if (!asset) throw new Error(`Unbound eager lazy URL: ${url}`);
      return new Response(wholeArrayBuffer(asset));
    });
    const eagerPath = join(options.outputDirectory, "rootfs-eager.vfs.zst");
    await saveCompressedImage(eagerFs, eagerPath, true);
    eagerRootfs = fingerprint(eagerPath, options.outputDirectory);
  }

  const kernelOutput = join(options.outputDirectory, "kernel.wasm");
  copyFileSync(options.kernelPath, kernelOutput);
  const commands = [
    { id: "version", argv: [`${prefix}/bin/brew`, "--version"] },
    { id: "config", argv: [`${prefix}/bin/brew`, "config"] },
    {
      id: "info",
      argv: [`${prefix}/bin/brew`, "info", options.coreFormula],
    },
    {
      id: "info_json_v2",
      argv: [
        `${prefix}/bin/brew`,
        "info",
        "--json=v2",
        "--formula",
        options.coreFormula,
      ],
    },
    {
      id: "list_versions",
      argv: [`${prefix}/bin/brew`, "list", "--versions"],
    },
    ...(options.canaryFormula === undefined
      ? []
      : [{
          id: "canary_info",
          argv: [`${prefix}/bin/brew`, "info", options.canaryFormula],
        }]),
  ];
  const manifest: HomebrewQueryFixtureManifest = {
    schema: 1,
    kind: "kandelo-homebrew-query-benchmark",
    createdAt: new Date().toISOString(),
    sourceCommit: options.sourceCommit,
    rootfs: fingerprint(rootfsPath, options.outputDirectory),
    ...(eagerRootfs === undefined ? {} : { eagerRootfs }),
    kernel: fingerprint(kernelOutput, options.outputDirectory),
    lazyUrlBase: options.lazyUrlBase,
    lazyAssets,
    shell: { path: shellPath, argv0: shellArgv[0] },
    homebrew: { prefix, environment, trustedFormulae },
    taps,
    commands,
    focusCommandId: "info",
  };
  const manifestPath = join(options.outputDirectory, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `Prepared ${manifestPath} with ${lazyAssets.length} closed lazy bindings\n`,
  );
}

async function materializeLazyArtifacts(options: {
  groups: SerializedLazyTree[];
  bootstrap: Uint8Array;
  lazyUrlBase: string;
  outputDirectory: string;
}): Promise<HomebrewQueryLazyArtifact[]> {
  const bootstrapSha256 = sha256(options.bootstrap);
  const contentFiles = new Map<string, string>();
  const output: HomebrewQueryLazyArtifact[] = [];
  const seenUrls = new Set<string>();
  for (const group of options.groups) {
    const content = group.content;
    const integrity = group.integrity;
    const expectedSha256 = content?.sha256 ?? integrity?.sha256;
    const expectedBytes = content?.bytes ?? integrity?.bytes;
    const transports = content?.transports ?? [group.url];
    if (
      typeof expectedSha256 !== "string" || !SHA256_RE.test(expectedSha256) ||
      typeof expectedBytes !== "number" ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 ||
      transports.length === 0
    ) {
      throw new Error(`Deferred tree ${group.mountPrefix} lacks content identity`);
    }
    let relativeFile = contentFiles.get(expectedSha256);
    if (relativeFile === undefined) {
      relativeFile = `lazy/${expectedSha256}.bin`;
      const outputPath = join(options.outputDirectory, relativeFile);
      if (expectedSha256 === bootstrapSha256) {
        writeFileSync(outputPath, options.bootstrap);
      } else if (!existsSync(outputPath)) {
        const sourceUrl = new URL(transports[0]!, options.lazyUrlBase).href;
        process.stdout.write(`Fetching ${sourceUrl}\n`);
        const response = await fetch(sourceUrl, {
          credentials: "omit",
          redirect: "follow",
        });
        if (!response.ok) {
          throw new Error(`Lazy asset returned HTTP ${response.status}: ${sourceUrl}`);
        }
        writeFileSync(outputPath, new Uint8Array(await response.arrayBuffer()));
      }
      const artifact = fingerprint(outputPath, options.outputDirectory);
      if (
        artifact.sha256 !== expectedSha256 || artifact.bytes !== expectedBytes
      ) {
        throw new Error(`Lazy asset changed identity: ${outputPath}`);
      }
      contentFiles.set(expectedSha256, relativeFile);
    }
    for (const transport of transports) {
      const url = new URL(transport, options.lazyUrlBase).href;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      output.push({
        url,
        file: relativeFile,
        bytes: expectedBytes,
        sha256: expectedSha256,
      });
    }
  }
  return output.sort((left, right) => left.url.localeCompare(right.url));
}

async function saveCompressedImage(
  fs: MemoryFileSystem,
  outputPath: string,
  materializeAll = false,
): Promise<void> {
  const image = await fs.saveImage({
    materializeAll,
    normalizeTimestampsMs: 0,
  });
  const compressed = zstdCompressSync(image, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });
  writeFileSync(outputPath, compressed);
}

function copyHostTree(
  fs: MemoryFileSystem,
  source: string,
  target: string,
  uid: number,
  gid: number,
): void {
  const stat = lstatSync(source);
  const mode = stat.mode & 0o7777;
  if (stat.isDirectory()) {
    ensureDirRecursive(fs, target, mode || 0o755);
    fs.chown(target, uid, gid);
    fs.chmod(target, mode || 0o755);
    for (const name of readdirSync(source).sort()) {
      copyHostTree(fs, join(source, name), `${target}/${name}`, uid, gid);
    }
  } else if (stat.isFile()) {
    ensureDirRecursive(fs, target.slice(0, target.lastIndexOf("/")));
    fs.createFileWithOwner(target, mode || 0o644, uid, gid, bytes(source));
  } else if (stat.isSymbolicLink()) {
    ensureDirRecursive(fs, target.slice(0, target.lastIndexOf("/")));
    fs.symlinkWithOwner(readlinkSync(source), target, uid, gid);
  } else {
    throw new Error(`Tap contains unsupported host entry: ${source}`);
  }
}

function removeVfsTree(fs: MemoryFileSystem, path: string): void {
  let mode: number;
  try {
    mode = fs.lstat(path).mode & S_IFMT;
  } catch (error) {
    if (vfsErrorCode(error) === ENOENT) return;
    throw error;
  }
  if (mode === S_IFDIR) {
    const handle = fs.opendir(path);
    const children: string[] = [];
    try {
      for (;;) {
        const entry = fs.readdir(handle);
        if (!entry) break;
        if (entry.name !== "." && entry.name !== "..") {
          children.push(entry.name);
        }
      }
    } finally {
      fs.closedir(handle);
    }
    for (const child of children) removeVfsTree(fs, `${path}/${child}`);
    fs.rmdir(path);
  } else if (mode === S_IFREG || mode === S_IFLNK) {
    fs.unlink(path);
  } else {
    throw new Error(`VFS tap path has unsupported type: ${path}`);
  }
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const output = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < output.byteLength) {
      const count = fs.read(
        fd,
        output.subarray(offset),
        null,
        output.byteLength - offset,
      );
      if (count <= 0) throw new Error(`Short VFS read: ${path}`);
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return decoder.decode(output);
}

function fingerprint(
  path: string,
  root: string,
): HomebrewQueryArtifact {
  const value = bytes(path);
  return {
    file: relative(root, path).split("\\").join("/"),
    bytes: value.byteLength,
    sha256: sha256(value),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(path: string): Uint8Array {
  const value = readFileSync(path);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function wholeArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function tapRepository(name: string): string {
  const match = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/.exec(name);
  if (!match) throw new Error(`Invalid tap name: ${name}`);
  return `${match[1]}/homebrew-${match[2]}`;
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function vfsErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: number }).code
    : undefined;
}

function parseOptions(argv: string[]): Options {
  const allowed = new Set([
    "image",
    "kernel",
    "bootstrap",
    "output",
    "source-commit",
    "lazy-url-base",
    "tap",
    "core-formula",
    "canary-formula",
    "trust-formula",
  ]);
  const values = new Map<string, string[]>();
  let eager = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--eager") {
      eager = true;
      continue;
    }
    if (!argument.startsWith("--")) usage(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument.slice(2) : argument.slice(2, equals);
    if (!allowed.has(name)) usage(`Unknown option: --${name}`);
    const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) {
      usage(`Missing value for --${name}`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.at(-1);
    if (!value) usage(`--${name} is required`);
    return resolve(value!);
  };
  const sourceCommit = values.get("source-commit")?.at(-1);
  if (!sourceCommit || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    usage("--source-commit must be a full Git commit");
  }
  const taps = (values.get("tap") ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0) usage("--tap must be TAP_NAME=CHECKOUT_PATH");
    return {
      name: value.slice(0, separator),
      path: resolve(value.slice(separator + 1)),
    };
  });
  if (taps.length === 0) usage("At least one --tap is required");
  const lazyUrlBase = values.get("lazy-url-base")?.at(-1) ??
    "https://homebrew-query-benchmark.invalid/";
  if (!lazyUrlBase.endsWith("/")) {
    usage("--lazy-url-base must end with /");
  }
  new URL(lazyUrlBase);
  return {
    imagePath: required("image"),
    kernelPath: required("kernel"),
    bootstrapPath: required("bootstrap"),
    outputDirectory: required("output"),
    sourceCommit,
    lazyUrlBase,
    taps,
    coreFormula: values.get("core-formula")?.at(-1) ??
      "kandelo-dev/tap-core/dash",
    canaryFormula: values.get("canary-formula")?.at(-1),
    trustedFormulae: values.get("trust-formula") ?? [],
    eager,
  };
}

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: npx tsx benchmarks/homebrew-query/prepare.ts " +
      "--image PATH --kernel PATH --bootstrap PATH --output DIR " +
      "--source-commit COMMIT --tap TAP=PATH [--tap TAP=PATH] " +
      "[--core-formula NAME] [--canary-formula NAME] " +
      "[--trust-formula NAME] [--eager]\n",
  );
  process.exit(2);
}

void main().catch((error) => {
  process.stderr.write(
    `homebrew-query prepare failed: ${error instanceof Error ? error.stack : error}\n`,
  );
  process.exitCode = 1;
});
