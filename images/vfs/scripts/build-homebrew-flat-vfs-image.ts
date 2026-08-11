import { createHash } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { HomebrewBottleDescriptor } from "../../../host/src/homebrew-bottle-descriptor";
import {
  buildHomebrewVfsSelection,
  type HomebrewFlatVfsBuildReport,
} from "../../../host/src/homebrew-vfs-builder";
import { fetchHomebrewBottleBytes } from "../../../host/src/homebrew-vfs-fetch";
import { planHomebrewVfsSelection } from "../../../host/src/homebrew-vfs-planner";
import { resolveHomebrewVfsResourcePolicy } from "../../../host/src/homebrew-vfs-resource-policy";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import {
  KANDELO_SHELL_CONFIG_PATH,
  MAX_KANDELO_SHELL_CONFIG_BYTES,
} from "../../../web-libs/kandelo-session/src/shell-config";
import {
  assertShellExecutable,
  parseShellConfigBytes,
  restoreVerifiedHomebrewBaseImage,
  serializeVerifiedHomebrewVfsImage,
} from "./build-homebrew-vfs-image";
import { sourceDateEpochMilliseconds } from "./vfs-image-helpers";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SELECTION_BYTES = 16 * 1024 * 1024;
const MAX_BASE_IMAGE_BYTES = 1024 * 1024 * 1024;
const EXTRACTION_COMMANDS = Object.freeze([
  {
    formula: "kandelo-dev/tap-core/tar",
    stablePath: "/usr/bin/tar",
    selectedPath: "/opt/kandelo/homebrew/bin/tar",
  },
  {
    formula: "kandelo-dev/tap-core/gzip",
    stablePath: "/usr/bin/gzip",
    selectedPath: "/opt/kandelo/homebrew/bin/gzip",
  },
]);

export interface FlatHomebrewVfsCliOptions {
  selection: string;
  baseImage: string;
  bottleCache: string;
  shellConfig: string;
  out: string;
  report: string;
}

const CLI_FLAGS = new Map<string, keyof FlatHomebrewVfsCliOptions>([
  ["--selection", "selection"],
  ["--base-image", "baseImage"],
  ["--bottle-cache", "bottleCache"],
  ["--shell-config", "shellConfig"],
  ["--out", "out"],
  ["--report", "report"],
]);

export function parseFlatHomebrewVfsArgs(
  args: readonly string[],
): FlatHomebrewVfsCliOptions {
  const parsed: Partial<FlatHomebrewVfsCliOptions> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !CLI_FLAGS.has(flag)) {
      throw new Error(`unknown flat Homebrew VFS option: ${flag ?? "<missing>"}`);
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`flat Homebrew VFS option ${flag} requires one value`);
    }
    const key = CLI_FLAGS.get(flag)!;
    if (parsed[key] !== undefined) {
      throw new Error(`flat Homebrew VFS option ${flag} was provided more than once`);
    }
    parsed[key] = value;
  }
  for (const [flag, key] of CLI_FLAGS) {
    if (parsed[key] === undefined) {
      throw new Error(`required flat Homebrew VFS option is missing: ${flag}`);
    }
  }
  const options = parsed as FlatHomebrewVfsCliOptions;
  if (resolve(options.out) === resolve(options.report)) {
    throw new Error("flat Homebrew VFS image and report paths must be different");
  }
  return options;
}

export interface FlatHomebrewBottleCacheIdentity {
  fullName: string;
  sha256: string;
  bytes: number;
}

/** Read one exact digest-addressed bottle. This path has no URL fallback. */
export function readFlatHomebrewBottleCacheEntry(
  cacheRoot: string,
  bottle: FlatHomebrewBottleCacheIdentity,
): Uint8Array {
  if (!SHA256_RE.test(bottle.sha256)) {
    throw new Error(`invalid flat Homebrew bottle digest for ${bottle.fullName}`);
  }
  if (!Number.isSafeInteger(bottle.bytes) || bottle.bytes <= 0) {
    throw new Error(`invalid flat Homebrew bottle byte count for ${bottle.fullName}`);
  }
  const path = join(cacheRoot, `${bottle.sha256}.tar.gz`);
  const label = `flat bottle cache entry for ${bottle.fullName} at ${path}`;
  const bytes = readBoundedRegularFileNoFollow(
    path,
    label,
    bottle.bytes,
    bottle.bytes,
    0o600,
  );
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== bottle.sha256) {
    throw new Error(
      `${label} expected ${bottle.sha256}, got ${actualSha256}`,
    );
  }
  return bytes;
}

export function readBoundedRegularFileNoFollow(
  path: string,
  label: string,
  maxBytes: number,
  expectedBytes?: number,
  expectedMode?: number,
): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`${label} has an invalid byte limit`);
  }
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
  ) {
    throw new Error(`${label} has an invalid expected byte count`);
  }
  if (
    expectedMode !== undefined &&
    (!Number.isSafeInteger(expectedMode) ||
      expectedMode < 0 ||
      expectedMode > 0o7777)
  ) {
    throw new Error(`${label} has an invalid expected mode`);
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(
      `${label} must be an accessible regular non-symlink file: ${errorMessage(error)}`,
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
    }
    if (expectedBytes !== undefined && stat.size !== expectedBytes) {
      throw new Error(
        `${label} expected ${expectedBytes} bytes, found ${stat.size}`,
      );
    }
    assertExpectedFileMode(stat.mode, expectedMode, label);
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (count === 0) {
        throw new Error(`${label} changed while it was being read`);
      }
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new Error(`${label} changed while it was being read`);
    }
    const verified = fstatSync(descriptor);
    if (
      !verified.isFile() ||
      verified.size !== stat.size ||
      verified.mode !== stat.mode
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    assertExpectedFileMode(verified.mode, expectedMode, label);
    return Uint8Array.from(buffer);
  } finally {
    closeSync(descriptor);
  }
}

function assertExpectedFileMode(
  mode: number,
  expectedMode: number | undefined,
  label: string,
): void {
  if (expectedMode === undefined || (mode & 0o7777) === expectedMode) return;
  throw new Error(
    `${label} must have mode ${expectedMode.toString(8).padStart(4, "0")}, ` +
      `found ${(mode & 0o7777).toString(8).padStart(4, "0")}`,
  );
}

export type FlatHomebrewBottleFetcher = (
  url: string,
  options: { expectedBytes: number },
) => Promise<Uint8Array>;

export interface FlatHomebrewVfsBuilderDependencies {
  fetchBottleBytes?: FlatHomebrewBottleFetcher;
  publishBottleCacheEntry?: typeof publishFlatHomebrewBottleCacheEntry;
  publishOutputs?: typeof publishFlatHomebrewVfsOutputs;
}

export interface FlatHomebrewVfsArtifactReport {
  schema: 1;
  selection: {
    sha256: string;
    bytes: number;
    name: string;
  };
  base_image: {
    sha256: string;
    bytes: number;
    kernel_abi: number;
  };
  shell_config: {
    path: string;
    argv: string[];
    sha256: string;
    bytes: number;
  };
  bottle_cache: {
    entries: Array<{
      full_name: string;
      sha256: string;
      bytes: number;
    }>;
  };
  image: {
    filename: string;
    sha256: string;
    bytes: number;
    capacity: {
      byte_length: number;
      max_byte_length: number;
    };
  };
  build_report: HomebrewFlatVfsBuildReport;
}

export interface FlatHomebrewVfsBuilderResult {
  report: FlatHomebrewVfsArtifactReport;
  cleanupWarnings: readonly string[];
}

/** Build, restore-check, and no-clobber publish one self-contained flat VFS. */
export async function runFlatHomebrewVfsImageBuilder(
  args: readonly string[],
  dependencies: FlatHomebrewVfsBuilderDependencies = {},
): Promise<FlatHomebrewVfsBuilderResult> {
  const options = parseFlatHomebrewVfsArgs(args);
  const selectionBytes = readBoundedRegularFileNoFollow(
    options.selection,
    `flat Homebrew selection at ${options.selection}`,
    MAX_SELECTION_BYTES,
  );
  const plan = planHomebrewVfsSelection(selectionBytes);
  if (basename(resolve(options.out)) !== plan.requestedVfsFilename) {
    throw new Error(
      `flat Homebrew output filename must match selection request ` +
        `${plan.requestedVfsFilename}`,
    );
  }

  const baseBytes = readBoundedRegularFileNoFollow(
    options.baseImage,
    `flat Homebrew base image at ${options.baseImage}`,
    MAX_BASE_IMAGE_BYTES,
  );
  const base = await restoreVerifiedHomebrewBaseImage(
    baseBytes,
    `flat Homebrew base image at ${options.baseImage}`,
    plan.kandeloAbi,
  );
  // This is deliberately before cache reads and public fetches. A lazy base
  // is the wrong product input, not an invitation for this builder to perform
  // hidden network I/O or guess how to make the platform rootfs eager.
  assertNoPendingLazyBacking(base.fs, "flat Homebrew base image");

  const shell = parseShellConfigBytes(
    readBoundedRegularFileNoFollow(
      options.shellConfig,
      `flat Homebrew shell config at ${options.shellConfig}`,
      MAX_KANDELO_SHELL_CONFIG_BYTES,
    ),
    options.shellConfig,
  );
  const cacheRoot = resolveFlatHomebrewBottleCacheRoot(options.bottleCache);
  const cleanupWarnings: string[] = [];
  const fetchBottle = dependencies.fetchBottleBytes ??
    ((url, fetchOptions) => fetchHomebrewBottleBytes(url, fetchOptions));
  const publishBottle = dependencies.publishBottleCacheEntry ??
    publishFlatHomebrewBottleCacheEntry;

  const build = await buildHomebrewVfsSelection(plan, {
    baseFs: base.fs,
    async loadBottleBytes(descriptor) {
      const loaded = await loadFlatHomebrewBottle(
        cacheRoot,
        descriptor,
        fetchBottle,
        publishBottle,
      );
      cleanupWarnings.push(...loaded.cleanupWarnings);
      return Uint8Array.from(loaded.bytes);
    },
  });

  installFlatHomebrewShellConfig(build.fs, shell);
  assertNoPendingLazyBacking(build.fs, "composed flat Homebrew VFS");
  // Defense in depth: even if a future materializer introduces lazy state
  // after the explicit registry check, all-materialized serialization may not
  // reach the network. It must fail instead.
  build.fs.setLazyFetcher(async (url) => {
    throw new Error(
      `flat Homebrew VFS serialization refused lazy fetch: ${String(url)}`,
    );
  });

  const policy = resolveHomebrewVfsResourcePolicy(plan.resourcePolicy);
  const serialized = await serializeVerifiedHomebrewVfsImage(
    build.fs,
    plan.requestedVfsFilename,
    {
      materializeAll: true,
      normalizeTimestampsMs: sourceDateEpochMilliseconds(
        process.env.SOURCE_DATE_EPOCH,
      ),
      metadata: {
        version: 1,
        kernelAbi: plan.kandeloAbi,
        createdBy: "images/vfs/scripts/build-homebrew-flat-vfs-image.ts",
        capacity: { maxByteLength: policy.vfs.maxByteLength },
        baseImage: {
          sha256: base.sha256,
          bytes: base.bytes,
          kernelAbi: base.metadata.kernelAbi,
        },
        shellConfig: {
          path: shell.config.path,
          argv: [...shell.config.argv],
          sha256: shell.sha256,
          bytes: shell.bytes,
        },
        homebrewFlat: {
          selectionSha256: plan.selectionSha256,
          requestedVfsFilename: plan.requestedVfsFilename,
          resourcePolicy: plan.resourcePolicy,
        },
      },
    },
    policy.vfs.maxByteLength,
  );
  assertNoPendingLazyBacking(build.fs, "serialized flat Homebrew VFS source");

  const restored = MemoryFileSystem.fromImagePreservingCapacity(serialized.bytes);
  await restored.verifyImportedLazyAtomicGroupSeals();
  assertNoPendingLazyBacking(restored, "restored flat Homebrew VFS");
  assertRestoredFlatHomebrewVfs(
    restored,
    build.report,
    shell,
    policy.vfs.maxByteLength,
    serialized.bytes,
  );

  const capacity = MemoryFileSystem.readImageCapacity(serialized.bytes);
  const imageSha256 = sha256(serialized.bytes);
  const report: FlatHomebrewVfsArtifactReport = {
    schema: 1,
    selection: {
      sha256: plan.selectionSha256,
      bytes: selectionBytes.byteLength,
      name: plan.name,
    },
    base_image: {
      sha256: base.sha256,
      bytes: base.bytes,
      kernel_abi: base.metadata.kernelAbi,
    },
    shell_config: {
      path: shell.config.path,
      argv: [...shell.config.argv],
      sha256: shell.sha256,
      bytes: shell.bytes,
    },
    bottle_cache: {
      entries: plan.packages.map((descriptor) => ({
        full_name: descriptor.fullName,
        sha256: descriptor.sha256,
        bytes: descriptor.bytes,
      })),
    },
    image: {
      filename: plan.requestedVfsFilename,
      sha256: imageSha256,
      bytes: serialized.bytes.byteLength,
      capacity: {
        byte_length: capacity.byteLength,
        max_byte_length: capacity.maxByteLength,
      },
    },
    build_report: build.report,
  };
  const reportBytes = new TextEncoder().encode(
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const publishOutputs = dependencies.publishOutputs ??
    publishFlatHomebrewVfsOutputs;
  const publication = publishOutputs([
    {
      finalPath: options.out,
      bytes: serialized.bytes,
      expectedSha256: imageSha256,
      expectedBytes: serialized.bytes.byteLength,
    },
    {
      finalPath: options.report,
      bytes: reportBytes,
      expectedSha256: sha256(reportBytes),
      expectedBytes: reportBytes.byteLength,
    },
  ]);
  cleanupWarnings.push(...publication.cleanupWarnings);
  return { report, cleanupWarnings };
}

interface LoadedFlatHomebrewBottle {
  bytes: Uint8Array;
  cleanupWarnings: readonly string[];
}

async function loadFlatHomebrewBottle(
  cacheRoot: string,
  descriptor: HomebrewBottleDescriptor,
  fetchBottle: FlatHomebrewBottleFetcher,
  publishBottle: typeof publishFlatHomebrewBottleCacheEntry,
): Promise<LoadedFlatHomebrewBottle> {
  const identity = {
    fullName: descriptor.fullName,
    sha256: descriptor.sha256,
    bytes: descriptor.bytes,
  };
  const path = flatHomebrewBottleCachePath(cacheRoot, identity.sha256);
  if (lstatOrNull(path) !== null) {
    return {
      bytes: readFlatHomebrewBottleCacheEntry(cacheRoot, identity),
      cleanupWarnings: [],
    };
  }

  const fetched = await fetchBottle(descriptor.url, {
    expectedBytes: descriptor.bytes,
  });
  assertExactFlatHomebrewBottleBytes(fetched, identity, "fetched bottle");
  const publication = publishBottle(cacheRoot, identity, fetched);
  // Re-read the digest path as the sole cache authority. This also covers a
  // same-digest publisher race without trusting the fetched buffer directly.
  return {
    bytes: readFlatHomebrewBottleCacheEntry(cacheRoot, identity),
    cleanupWarnings: publication.cleanupWarnings,
  };
}

function installFlatHomebrewShellConfig(
  fs: MemoryFileSystem,
  shell: ReturnType<typeof parseShellConfigBytes>,
): void {
  assertShellExecutable(fs, shell.config.path);
  if (fs.isPathDeferred(shell.config.path)) {
    throw new Error(
      `flat Homebrew default shell must be eager: ${shell.config.path}`,
    );
  }
  if (vfsPathExists(fs, KANDELO_SHELL_CONFIG_PATH)) {
    throw new Error(
      `refusing to overwrite existing default shell config: ` +
        KANDELO_SHELL_CONFIG_PATH,
    );
  }
  ensureDirRecursive(fs, dirname(KANDELO_SHELL_CONFIG_PATH));
  writeVfsBinary(fs, KANDELO_SHELL_CONFIG_PATH, shell.source, 0o644);
  assertShellExecutable(fs, shell.config.path);
}

function assertRestoredFlatHomebrewVfs(
  fs: MemoryFileSystem,
  buildReport: HomebrewFlatVfsBuildReport,
  shell: ReturnType<typeof parseShellConfigBytes>,
  expectedMaxByteLength: number,
  imageBytes: Uint8Array,
): void {
  const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
  if (capacity.maxByteLength !== expectedMaxByteLength) {
    throw new Error(
      `restored flat Homebrew VFS capacity ${capacity.maxByteLength} ` +
        `does not match ${expectedMaxByteLength}`,
    );
  }
  if (fs.getImageMetadata()?.kernelAbi !== buildReport.kandelo_abi) {
    throw new Error(
      `restored flat Homebrew VFS does not declare ABI ` +
        buildReport.kandelo_abi,
    );
  }
  assertShellExecutable(fs, shell.config.path);
  if (fs.isPathDeferred(shell.config.path)) {
    throw new Error(
      `restored flat Homebrew shell is deferred: ${shell.config.path}`,
    );
  }
  const brewTarget = "/opt/kandelo/homebrew/bin/brew";
  let target: string;
  try {
    target = fs.readlink("/usr/bin/brew");
  } catch {
    throw new Error("restored flat Homebrew VFS is missing /usr/bin/brew");
  }
  if (target !== brewTarget) {
    throw new Error(
      `restored flat Homebrew /usr/bin/brew targets ${target}, ` +
        `expected ${brewTarget}`,
    );
  }
  assertVfsExecutable(fs, brewTarget, "Homebrew entrypoint");
  assertRestoredExtractionCommands(fs, buildReport);
  for (const pkg of buildReport.packages) {
    for (const relativePath of pkg.links) {
      const path = `${pkg.prefix}/${relativePath}`;
      if (!vfsPathExists(fs, path)) {
        throw new Error(
          `restored flat Homebrew VFS is missing selected link ${path}`,
        );
      }
    }
  }
  const expectedGuestReport = `${JSON.stringify(buildReport, null, 2)}\n`;
  if (readVfsText(fs, "/etc/kandelo/homebrew-vfs.json") !== expectedGuestReport) {
    throw new Error("restored flat Homebrew guest build report changed");
  }
  if (
    readVfsText(fs, KANDELO_SHELL_CONFIG_PATH) !==
      new TextDecoder("utf-8", { fatal: true }).decode(shell.source)
  ) {
    throw new Error("restored flat Homebrew shell config changed");
  }
}

function assertRestoredExtractionCommands(
  fs: MemoryFileSystem,
  buildReport: HomebrewFlatVfsBuildReport,
): void {
  const selected = EXTRACTION_COMMANDS.filter((command) =>
    buildReport.packages.some((pkg) => pkg.full_name === command.formula)
  );
  if (selected.length === 0) return;
  if (selected.length !== EXTRACTION_COMMANDS.length) {
    throw new Error("restored flat Homebrew VFS has an incomplete tar/gzip pair");
  }
  for (const command of selected) {
    let link;
    try {
      link = fs.lstat(command.stablePath);
    } catch {
      throw new Error(
        `restored flat Homebrew VFS is missing ${command.stablePath}`,
      );
    }
    if (
      (link.mode & 0xf000) !== 0xa000 ||
      link.uid !== 0 ||
      link.gid !== 0 ||
      fs.readlink(command.stablePath) !== command.selectedPath ||
      fs.isPathDeferred(command.stablePath)
    ) {
      throw new Error(
        `restored flat Homebrew ${command.stablePath} is not the ` +
          `root-owned selected link to ${command.selectedPath}`,
      );
    }
    assertVfsExecutable(
      fs,
      command.selectedPath,
      `selected Homebrew ${command.formula}`,
    );
  }
}

function assertVfsExecutable(
  fs: MemoryFileSystem,
  path: string,
  label: string,
): void {
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`${label} is missing from the restored VFS: ${path}`);
  }
  if ((stat.mode & 0xf000) !== 0x8000 || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not an executable regular file: ${path}`);
  }
}

function assertNoPendingLazyBacking(fs: MemoryFileSystem, label: string): void {
  const lazyFiles = fs.exportLazyEntries();
  const lazyTrees = fs.exportLazyArchiveEntries();
  if (lazyFiles.length !== 0 || lazyTrees.length !== 0) {
    throw new Error(
      `${label} must be self-contained; pending lazy backing remains ` +
        `(${lazyFiles.length} files, ${lazyTrees.length} trees)`,
    );
  }
}

function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const descriptor = fs.open(path, constants.O_RDONLY, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        descriptor,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`incomplete VFS read for ${path}`);
      }
      offset += count;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    fs.close(descriptor);
  }
}

function resolveFlatHomebrewBottleCacheRoot(cacheRoot: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(cacheRoot);
  } catch (error) {
    throw new Error(
      `flat Homebrew bottle cache must be an accessible directory: ` +
        errorMessage(error),
    );
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("flat Homebrew bottle cache must be a directory");
  }
  return resolved;
}

function flatHomebrewBottleCachePath(cacheRoot: string, digest: string): string {
  return join(cacheRoot, `${digest}.tar.gz`);
}

function assertExactFlatHomebrewBottleBytes(
  bytes: unknown,
  bottle: FlatHomebrewBottleCacheIdentity,
  label: string,
): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label} for ${bottle.fullName} is not bytes`);
  }
  if (bytes.byteLength !== bottle.bytes) {
    throw new Error(
      `${label} for ${bottle.fullName} expected ${bottle.bytes} bytes, ` +
        `found ${bytes.byteLength}`,
    );
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== bottle.sha256) {
    throw new Error(
      `${label} for ${bottle.fullName} expected ${bottle.sha256}, ` +
        `got ${actualSha256}`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FlatHomebrewVfsOutput {
  finalPath: string;
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
}

/** Publish one digest-addressed cache inode without replacing any path. */
export function publishFlatHomebrewBottleCacheEntry(
  cacheRoot: string,
  bottle: FlatHomebrewBottleCacheIdentity,
  bytes: Uint8Array,
): FlatHomebrewVfsPublicationResult {
  assertExactFlatHomebrewBottleBytes(bytes, bottle, "flat bottle cache input");
  const resolvedRoot = resolveFlatHomebrewBottleCacheRoot(cacheRoot);
  const finalPath = flatHomebrewBottleCachePath(resolvedRoot, bottle.sha256);
  if (lstatOrNull(finalPath) !== null) {
    readFlatHomebrewBottleCacheEntry(resolvedRoot, bottle);
    return { cleanupWarnings: [] };
  }

  let stagingDirectory: string | null = null;
  let published: { path: string; identity: FileIdentity } | null = null;
  let publicationError: unknown = null;
  try {
    stagingDirectory = mkdtempSync(
      join(resolvedRoot, ".kandelo-homebrew-bottle-"),
    );
    chmodSync(stagingDirectory, 0o700);
    const stagedPath = join(stagingDirectory, "bottle.tar.gz");
    const stagedStat = writeAndVerifyFlatHomebrewVfsStagedOutput(stagedPath, {
      finalPath,
      bytes,
      expectedSha256: bottle.sha256,
      expectedBytes: bottle.bytes,
    });
    const stagedIdentity = identityOf(stagedStat);
    try {
      linkSync(stagedPath, finalPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        readFlatHomebrewBottleCacheEntry(resolvedRoot, bottle);
        return cleanupCachePublication(stagingDirectory);
      }
      throw error;
    }
    published = { path: finalPath, identity: stagedIdentity };
    const linked = lstatSync(finalPath, { bigint: true });
    if (
      !linked.isFile() ||
      linked.size !== BigInt(bottle.bytes) ||
      (linked.mode & 0o777n) !== 0o600n ||
      !sameIdentity(identityOf(linked), stagedIdentity)
    ) {
      throw new Error(
        `flat bottle cache output did not link its staged inode: ${finalPath}`,
      );
    }
  } catch (error) {
    publicationError = error;
    if (published !== null) {
      try {
        rollbackFlatHomebrewVfsOutputs([published]);
      } catch (rollbackError) {
        publicationError = new Error(
          `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`,
        );
      }
    }
  }

  const cleanup = cleanupCachePublication(stagingDirectory);
  if (publicationError !== null) {
    const cleanupDetail = cleanup.cleanupWarnings.length === 0
      ? ""
      : `; ${cleanup.cleanupWarnings.join("; ")}`;
    throw new Error(
      `flat Homebrew bottle cache publication failed: ` +
        `${errorMessage(publicationError)}${cleanupDetail}`,
    );
  }
  return cleanup;
}

function cleanupCachePublication(
  stagingDirectory: string | null,
): FlatHomebrewVfsPublicationResult {
  const cleanupWarnings: string[] = [];
  if (stagingDirectory !== null) {
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupWarnings.push(
        `flat Homebrew bottle cache cleanup failed for ${stagingDirectory}: ` +
          errorMessage(error),
      );
    }
  }
  return { cleanupWarnings };
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface PreparedFlatHomebrewVfsOutput {
  finalPath: string;
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
}

export interface FlatHomebrewVfsPublicationResult {
  cleanupWarnings: readonly string[];
}

/**
 * Publish the generated image and report through private same-parent staging.
 * The helper owns and removes only its fresh staging directory. Final paths
 * are never replaced, and a later failure rolls back only links made here.
 * Cleanup failure after both links is a returned warning because publication
 * has already succeeded and the final paths must not be reported as absent.
 */
export function publishFlatHomebrewVfsOutputs(
  outputs: readonly FlatHomebrewVfsOutput[],
): FlatHomebrewVfsPublicationResult {
  if (outputs.length !== 2) {
    throw new Error(
      "flat Homebrew VFS publication requires exactly an image and report",
    );
  }

  const prepared = prepareFlatHomebrewVfsOutputs(outputs);
  const published: Array<{ path: string; identity: FileIdentity }> = [];
  let stagingDirectory: string | null = null;
  let publicationError: unknown = null;
  try {
    stagingDirectory = mkdtempSync(
      join(prepared.parentPath, ".kandelo-homebrew-vfs-"),
    );
    chmodSync(stagingDirectory, 0o700);
    const staged = prepared.outputs.map((output, index) => {
      const path = join(stagingDirectory, `output-${index}`);
      const stat = writeAndVerifyFlatHomebrewVfsStagedOutput(path, output);
      return { path, stat, output };
    });
    if (sameIdentity(identityOf(staged[0]!.stat), identityOf(staged[1]!.stat))) {
      throw new Error("flat Homebrew image and report share one staged inode");
    }

    for (const candidate of staged) {
      if (lstatOrNull(candidate.output.finalPath) !== null) {
        throw new Error(
          `flat Homebrew final output already exists: ` +
            candidate.output.finalPath,
        );
      }
      linkSync(candidate.path, candidate.output.finalPath);
      const stagedIdentity = identityOf(candidate.stat);
      published.push({
        path: candidate.output.finalPath,
        identity: stagedIdentity,
      });
      const linked = lstatSync(candidate.output.finalPath, { bigint: true });
      const linkedIdentity = identityOf(linked);
      if (
        !linked.isFile() ||
        linked.size !== BigInt(candidate.output.expectedBytes) ||
        (linked.mode & 0o777n) !== 0o600n ||
        !sameIdentity(linkedIdentity, stagedIdentity)
      ) {
        throw new Error(
          `flat Homebrew final output did not link its staged inode: ` +
            candidate.output.finalPath,
        );
      }
    }
  } catch (error) {
    try {
      rollbackFlatHomebrewVfsOutputs(published);
      publicationError = error;
    } catch (rollbackError) {
      publicationError = new Error(
        `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`,
      );
    }
  }

  const cleanupWarnings: string[] = [];
  if (stagingDirectory !== null) {
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupWarnings.push(
        `flat Homebrew staging cleanup failed for ${stagingDirectory}: ` +
          errorMessage(error),
      );
    }
  }
  if (publicationError !== null) {
    const cleanupDetail = cleanupWarnings.length === 0
      ? ""
      : `; ${cleanupWarnings.join("; ")}`;
    throw new Error(
      `flat Homebrew VFS output publication failed: ` +
        `${errorMessage(publicationError)}${cleanupDetail}`,
    );
  }
  return { cleanupWarnings };
}

function writeAndVerifyFlatHomebrewVfsStagedOutput(
  path: string,
  output: PreparedFlatHomebrewVfsOutput,
): BigIntStats {
  const descriptor = openSync(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // The create mode is umask-filtered. Set and verify the owned inode's
    // exact private mode before any hard link can expose it.
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, output.bytes);
    const stat = fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.size !== BigInt(output.expectedBytes) ||
      (stat.mode & 0o777n) !== 0o600n
    ) {
      throw new Error(`flat Homebrew staged output is incomplete: ${path}`);
    }

    const actualSha256 = hashExactFileDescriptor(
      descriptor,
      output.expectedBytes,
      path,
    );
    if (actualSha256 !== output.expectedSha256) {
      throw new Error(
        `flat Homebrew staged output ${path} expected SHA-256 ` +
          `${output.expectedSha256}, got ${actualSha256}`,
      );
    }
    const verified = fstatSync(descriptor, { bigint: true });
    if (
      !verified.isFile() ||
      verified.size !== stat.size ||
      (verified.mode & 0o777n) !== 0o600n ||
      !sameIdentity(identityOf(verified), identityOf(stat))
    ) {
      throw new Error(`flat Homebrew staged output changed: ${path}`);
    }
    return verified;
  } finally {
    closeSync(descriptor);
  }
}

function hashExactFileDescriptor(
  descriptor: number,
  expectedBytes: number,
  path: string,
): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.max(1, Math.min(expectedBytes, 64 * 1024)),
  );
  let offset = 0;
  while (offset < expectedBytes) {
    const requested = Math.min(buffer.byteLength, expectedBytes - offset);
    const count = readSync(descriptor, buffer, 0, requested, offset);
    if (count === 0) {
      throw new Error(`flat Homebrew staged output changed: ${path}`);
    }
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(descriptor, extra, 0, 1, expectedBytes) !== 0) {
    throw new Error(`flat Homebrew staged output changed: ${path}`);
  }
  return hash.digest("hex");
}

function prepareFlatHomebrewVfsOutputs(
  outputs: readonly FlatHomebrewVfsOutput[],
): { parentPath: string; outputs: PreparedFlatHomebrewVfsOutput[] } {
  const parentPaths = outputs.map((output) =>
    realpathSync(dirname(resolve(output.finalPath)))
  );
  if (parentPaths[0] !== parentPaths[1]) {
    throw new Error(
      "flat Homebrew image and report must share one final directory",
    );
  }
  const finalPaths = outputs.map((output) =>
    join(parentPaths[0]!, basename(resolve(output.finalPath)))
  );
  if (finalPaths[0] === finalPaths[1]) {
    throw new Error("flat Homebrew image and report paths must be different");
  }

  return {
    parentPath: parentPaths[0]!,
    outputs: outputs.map((output, index) => {
      const bytes = output.bytes;
      const expectedSha256 = output.expectedSha256;
      const expectedBytes = output.expectedBytes;
      if (!SHA256_RE.test(expectedSha256)) {
        throw new Error("flat Homebrew output has an invalid SHA-256");
      }
      if (
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes < 0
      ) {
        throw new Error("flat Homebrew output has an invalid byte count");
      }
      if (bytes.byteLength !== expectedBytes) {
        throw new Error(
          `flat Homebrew output expected ${expectedBytes} bytes, ` +
            `found ${bytes.byteLength}`,
        );
      }
      const actualSha256 = createHash("sha256")
        .update(bytes)
        .digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `flat Homebrew output expected ${expectedSha256}, ` +
            `got ${actualSha256}`,
        );
      }
      return {
        finalPath: finalPaths[index]!,
        bytes,
        expectedSha256,
        expectedBytes,
      };
    }),
  };
}

function rollbackFlatHomebrewVfsOutputs(
  outputs: readonly { path: string; identity: FileIdentity }[],
): void {
  for (const output of [...outputs].reverse()) {
    const current = lstatOrNull(output.path);
    if (
      current !== null &&
      sameIdentity(identityOf(current), output.identity)
    ) {
      unlinkSync(output.path);
    }
  }
}

function identityOf(stat: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))
) {
  void runFlatHomebrewVfsImageBuilder(process.argv.slice(2)).then(
    ({ report, cleanupWarnings }) => {
      console.log(
        `Built ${report.image.filename} (${report.image.sha256}, ` +
          `${report.image.bytes} bytes)`,
      );
      for (const warning of cleanupWarnings) console.warn(warning);
    },
    (error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    },
  );
}
