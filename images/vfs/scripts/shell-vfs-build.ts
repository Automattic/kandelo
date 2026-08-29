/**
 * Shared VFS-image populator for the Shell environment.
 *
 * Encapsulates everything build-shell-vfs-image.ts used to do inline and
 * exposes a loader for service demos that layer nginx/php-fpm (+ MariaDB)
 * and application files on top of the already-built shell.vfs.zst image.
 *
 * Builtin service images reuse the filesystem helpers below while preserving
 * the source composition of the already-resolved shell base.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../../../host/src/vfs/memory-fs";
import {
  resolveBinary,
  tryResolveBinary,
  findRepoRoot,
  programWasmArtifactPolicy,
  resolveDirectProgramPackageArtifact,
  type ResolvedDirectProgramPackageArtifact,
} from "../../../host/src/binary-resolver";
import {
  COREUTILS_NAMES,
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../lib/init/shell-binaries";
import {
  displacePosixUtilsLiteManApplet,
  materializeMandocDatabase,
  populateTerminfoDatabase,
  registerDeclaredShellLazyArchive,
  registerManShellProfile,
  registerPythonShellProfile,
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";
import {
  saveImage,
  sourceDateEpochMilliseconds,
  writeVfsBinary,
  symlink,
} from "./vfs-image-helpers";
import type { SaveImageOptions } from "./vfs-image-helpers";
import {
  SHELL_DERIVED_VFS_MIN_FREE_BYTES,
  SHELL_DERIVED_VFS_MIN_FREE_INODES,
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import { populateShellRuntimeLayout } from "./shell-runtime-layout";

const SHELL_DERIVED_CREATED_BY =
  "images/vfs/scripts/saveShellDerivedVfsImage";

export const SOURCE_ROOTFS_SHELL_COMPOSITION = {
  schema: 1,
  kind: "source-rootfs",
} as const;

function depEnvKey(name: string): string {
  return name.replaceAll("-", "_").toUpperCase();
}

function artifactDepName(relPath: string, depName?: string): string {
  if (depName) return depName === "git-remote-http" ? "git" : depName;
  if (relPath.startsWith("programs/git/")) return "git";
  if (relPath.startsWith("programs/file/")) return "file";
  return basename(relPath).replace(/\.(wasm|zip|zst)$/, "");
}

function policyBoundDirectDepArtifact(
  relPath: string,
  depName?: string,
): ResolvedDirectProgramPackageArtifact | null {
  const packageName = artifactDepName(relPath, depName);
  const depDir = process.env[`WASM_POSIX_DEP_${depEnvKey(packageName)}_DIR`];
  if (!depDir) return null;
  // WHY: xtask's direct-dependency variable is only a lookup hint. Resolve it
  // through package policy so a same-basename file in an arbitrary directory
  // cannot impersonate the selected package/cache generation.
  return resolveDirectProgramPackageArtifact(
    relPath,
    packageName,
    depDir,
  );
}

function depArtifactPath(relPath: string, depName?: string): string | null {
  const packageName = artifactDepName(relPath, depName);
  const depDir = process.env[`WASM_POSIX_DEP_${depEnvKey(packageName)}_DIR`];
  if (!depDir) return null;
  const path = join(depDir, basename(relPath));
  if (existsSync(path)) return path;
  throw new Error(
    `direct dependency ${packageName} is available at ${depDir}, ` +
    `but ${basename(relPath)} was not found`,
  );
}

export function tryResolveVfsArtifact(relPath: string, depName?: string): string | null {
  const depPath = depArtifactPath(relPath, depName);
  if (depPath) return depPath;
  return tryResolveBinary(relPath);
}

export function resolveVfsArtifact(relPath: string, depName?: string): string {
  const resolved = tryResolveVfsArtifact(relPath, depName);
  if (resolved) return resolved;
  return resolveBinary(relPath);
}

/**
 * Resolve an executable Wasm dependency only when the builder's declared fork
 * policy agrees with the selected generated package projection.
 *
 * WHY: a VFS path-scoped exception must not become an independent source of
 * package truth. The image builder states its intent explicitly, while the
 * resolver proves that the exact package owning those bytes states the same
 * policy. This helper is deliberately narrower than generic VFS artifact
 * lookup: a policy exception requires an immutable xtask cache generation;
 * relocated inputs and local source overrides need their own content-bound
 * receipt before they can safely carry the same authority.
 */
export function resolvePolicyBoundVfsWasmArtifact(
  relPath: string,
  depName: string,
  forkInstrumentation: "auto" | "disabled",
): string {
  const expectedPackageName = artifactDepName(relPath, depName);
  const direct = policyBoundDirectDepArtifact(relPath, depName);
  const packagePolicy = direct ?? programWasmArtifactPolicy(relPath);
  if (packagePolicy === null) {
    throw new Error(
      `VFS Wasm artifact ${relPath} has no selected generated package policy`,
    );
  }
  if (packagePolicy.packageName !== expectedPackageName) {
    throw new Error(
      `VFS Wasm artifact ${relPath} is owned by package ` +
        `${packagePolicy.packageName}, expected ${expectedPackageName}`,
    );
  }
  if (packagePolicy.forkInstrumentation !== forkInstrumentation) {
    throw new Error(
      `VFS Wasm artifact ${relPath} declares fork instrumentation ` +
        `${packagePolicy.forkInstrumentation}, but its image builder requires ` +
        `${forkInstrumentation}`,
    );
  }
  return direct?.path ?? resolveVfsArtifact(relPath, depName);
}

export async function loadShellBaseFileSystem(
  maxByteLength: number,
): Promise<MemoryFileSystem> {
  const shellImagePath = resolveVfsArtifact("programs/shell.vfs.zst", "shell");
  const shellImage = new Uint8Array(readFileSync(shellImagePath));
  return await loadShellBaseFileSystemFromImage(shellImage, maxByteLength);
}

/**
 * Serialize a transient guest used only by derived-image build steps.
 *
 * The source shell composition carries no boot trigger to suppress, so the
 * build guest snapshot is the image's own serialization.
 */
export function saveShellDerivedBuildGuestSnapshot(
  fs: MemoryFileSystem,
): Promise<Uint8Array> {
  return fs.saveImage();
}

/**
 * Save a product layered on the canonical shell only when it retains enough
 * independent block and inode capacity for normal runtime writes.
 */
export function saveShellDerivedVfsImage(
  fs: MemoryFileSystem,
  outFile: string,
  options: Omit<
    SaveImageOptions,
    "headroom" | "expectedMaxByteLength" | "metadata"
  > & {
    /** Explicit escape hatch for a reviewed product profile above 768 MiB. */
    expectedMaxByteLength?: number;
  } = {},
): Promise<Uint8Array> {
  const {
    expectedMaxByteLength = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    kernelAbi: requestedKernelAbi,
    normalizeTimestampsMs =
      sourceDateEpochMilliseconds(process.env.SOURCE_DATE_EPOCH),
    ...saveOptions
  } = options;
  if (
    expectedMaxByteLength !== SHELL_DERIVED_VFS_PROFILE_MAX_BYTES &&
    (
      !Number.isSafeInteger(expectedMaxByteLength) ||
      expectedMaxByteLength <= SHELL_DERIVED_VFS_PROFILE_MAX_BYTES
    )
  ) {
    throw new Error(
      `${outFile} expectedMaxByteLength must use the standard ` +
        `${SHELL_DERIVED_VFS_PROFILE_MAX_BYTES}-byte product profile or ` +
        "an explicitly reviewed, strictly larger profile",
    );
  }
  const inheritedMetadata = fs.getImageMetadata();
  if (inheritedMetadata === null) {
    throw new Error(
      `${outFile} shell-derived VFS omits inherited shell image metadata`,
    );
  }
  const inheritedKernelAbi = inheritedMetadata.kernelAbi;
  if (
    typeof inheritedKernelAbi !== "number" ||
    !Number.isSafeInteger(inheritedKernelAbi) ||
    inheritedKernelAbi < 0
  ) {
    throw new Error(
      `${outFile} shell-derived VFS omits its inherited kernel ABI`,
    );
  }
  if (
    requestedKernelAbi !== undefined &&
    requestedKernelAbi !== inheritedKernelAbi
  ) {
    throw new Error(
      `${outFile} cannot replace inherited kernel ABI ${inheritedKernelAbi} ` +
        `with ABI ${requestedKernelAbi}`,
    );
  }
  const metadata = shellDerivedImageMetadata(
    fs,
    inheritedMetadata,
    inheritedKernelAbi,
    expectedMaxByteLength,
  );
  // WHY: capacity rebases and product writes use the wall clock. Normalizing
  // only the detached snapshot keeps live timestamps truthful while ensuring
  // identical package inputs produce one cacheable VFS artifact.
  return saveImage(fs, outFile, {
    ...saveOptions,
    kernelAbi: inheritedKernelAbi,
    metadata,
    normalizeTimestampsMs,
    expectedMaxByteLength,
    headroom: {
      minimumFreeBytes: SHELL_DERIVED_VFS_MIN_FREE_BYTES,
      minimumFreeInodes: SHELL_DERIVED_VFS_MIN_FREE_INODES,
    },
  });
}

function shellDerivedImageMetadata(
  fs: MemoryFileSystem,
  inherited: VfsImageMetadata,
  kernelAbi: number,
  maxByteLength: number,
): VfsImageMetadata {
  const abiSnapshotSha256 = inherited.abiSnapshotSha256;
  if (
    abiSnapshotSha256 !== undefined &&
    (
      typeof abiSnapshotSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(abiSnapshotSha256)
    )
  ) {
    throw new Error("shell-derived VFS has an invalid ABI snapshot binding");
  }
  const inheritedAbiSnapshot = abiSnapshotSha256 === undefined
    ? {}
    : { abiSnapshotSha256 };
  const baseImage = requiredRecord(
    inherited.baseImage,
    "direct shell base binding",
  );
  const baseSha256 = baseImage.sha256;
  const baseBytes = baseImage.bytes;
  if (
    typeof baseSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(baseSha256) ||
    typeof baseBytes !== "number" ||
    !Number.isSafeInteger(baseBytes) ||
    baseBytes <= 0 ||
    baseImage.kernelAbi !== kernelAbi
  ) {
    throw new Error("shell-derived VFS has an invalid direct shell base binding");
  }

  const sourceComposition = inherited.shellComposition;
  if (sourceComposition === undefined) {
    throw new Error(
      "shell-derived VFS omits a supported shell composition binding",
    );
  }
  if (!isExactSourceRootfsShellComposition(sourceComposition)) {
    throw new Error(
      "shell-derived VFS has an invalid source shell composition binding",
    );
  }
  // WHY: the internal source shell carries ordinary lazy URLs. Preserve its
  // explicit source identity. Its demo file remains in the VFS, but the demo
  // config is a composition claim and therefore is not copied into the
  // derived image's metadata.
  return {
    version: 1,
    kernelAbi,
    ...inheritedAbiSnapshot,
    createdBy: SHELL_DERIVED_CREATED_BY,
    capacity: { maxByteLength },
    baseImage: {
      sha256: baseSha256,
      bytes: baseBytes,
      kernelAbi,
    },
    shellComposition: SOURCE_ROOTFS_SHELL_COMPOSITION,
  };
}

function isExactSourceRootfsShellComposition(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === SOURCE_ROOTFS_SHELL_COMPOSITION.schema &&
    record.kind === SOURCE_ROOTFS_SHELL_COMPOSITION.kind &&
    Object.keys(record).sort().join("\0") === "kind\0schema"
  );
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`shell-derived VFS omits valid ${label}`);
  }
  return value as Record<string, unknown>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Restore the canonical shell contents for composition into another product
 * image. The source image's capacity is a runtime contract, so it must first
 * be restored with its own ceiling. A downstream image that declares a
 * different ceiling gets a fresh filesystem containing the same logical
 * files and lazy metadata.
 *
 * In particular, a 512 MiB shell image cannot be restored directly into a
 * 256 MiB growable SharedArrayBuffer: the serialized source buffer is already
 * larger than that target. Restoring first and then rebasing makes the
 * build-time transformation explicit without weakening runtime profile
 * validation for the canonical image itself.
 */
export async function loadShellBaseFileSystemFromImage(
  shellImage: Uint8Array,
  maxByteLength: number,
): Promise<MemoryFileSystem> {
  const fs = MemoryFileSystem.fromImagePreservingCapacity(shellImage);
  // WHY: rebasing copies lazy metadata into a new authority boundary, so
  // authenticate imported atomic seals before deciding whether to copy it.
  await fs.verifyImportedLazyAtomicGroupSeals();
  const metadata = fs.getImageMetadata();
  if (
    metadata === null ||
    typeof metadata.kernelAbi !== "number" ||
    !Number.isSafeInteger(metadata.kernelAbi) ||
    metadata.kernelAbi < 0
  ) {
    throw new Error("shell base image omits its required kernel ABI");
  }
  // WHY: `baseImage` names the direct input to this product, not an ancestor
  // used by the shell composer. Rebind it before a rebase copies metadata so
  // Node and service outputs identify the exact shell artifact they consumed.
  fs.setImageMetadata({
    ...metadata,
    baseImage: {
      sha256: sha256Hex(shellImage),
      bytes: shellImage.byteLength,
      kernelAbi: metadata.kernelAbi,
    },
  });
  const stats = fs.statfs("/");
  const effectiveMaxByteLength = stats.blocks * stats.bsize;
  if (effectiveMaxByteLength === maxByteLength) return fs;

  console.log(
    `Rebasing shell base VFS capacity from ${Math.round(effectiveMaxByteLength / 1024 / 1024)} MiB ` +
      `to ${Math.round(maxByteLength / 1024 / 1024)} MiB...`,
  );
  return fs.rebaseToNewFileSystem(maxByteLength);
}

export interface ShellVfsOptions {
  /**
   * When true, every tool binary (bash, coreutils, grep, sed, bc, file,
   * less, m4, make, tar, curl, wget, git, gzip/bzip2/xz/zstd, zip/unzip,
   * nano, lsof) is read from disk and baked into the VFS image. Required
   * for demos that run in `kernelOwnedFs: true` mode — there is no
   * main-thread filesystem to lazy-register against post-boot.
   *
   * When false, utility binaries are stored as lazy VFS metadata. If a base
   * rootfs image was provided, only missing shell-demo tools are added here.
   */
  eagerBinaries: boolean;
  /**
   * When true, `fs` is already initialized from the canonical base rootfs.
   * Base utilities and static system files are left in place; this helper only
   * overlays shell/demo-specific directories, config, and non-base tools.
   */
  baseProvided?: boolean;
  /**
   * Resolve every package-owned artifact used by this composition.
   *
   * Package recipes should provide a strict resolver backed only by their
   * declared dependency directories. Interactive builders may omit it and use
   * the repository binary resolver for backwards compatibility.
   */
  resolveArtifact?: ShellLazyArchiveResolver;
}

/**
 * Populate `fs` with the canonical Shell environment. Called by the shell VFS
 * builder itself; service-image builders should prefer
 * `loadShellBaseFileSystem()` so they inherit the exact shell.vfs.zst artifact.
 *
 * Order is load-bearing: lazy archive metadata must be written before
 * extended symlinks point at their (lazy-stub) targets — the symlink
 * targets are stored as path strings, but it's clearest to keep
 * "archive registers stub" → "symlink aliases stub" sequencing.
 */
export async function populateShellEnvironment(
  fs: MemoryFileSystem,
  opts: ShellVfsOptions,
): Promise<void> {
  const resolveArtifact = opts.resolveArtifact ?? resolveVfsArtifact;
  const strictArtifactResolution = opts.resolveArtifact !== undefined;
  if (opts.baseProvided) {
    populateShellOverlay(fs);
  } else {
    populateSystem(fs);
    populateDash(fs, resolveArtifact);
    if (opts.eagerBinaries) populateBash(fs, resolveArtifact);
    if (!opts.eagerBinaries) populateLazyBinaries(fs, resolveArtifact);
    populateCoreutilsSymlinks(fs);
    if (opts.eagerBinaries) populateCoreutils(fs, resolveArtifact);
    populateGrepSedSymlinks(fs);
    if (opts.eagerBinaries) {
      populateGrep(fs, resolveArtifact);
      populateSed(fs, resolveArtifact);
    }
    populateBaseExtendedSymlinks(fs);
    if (opts.eagerBinaries) populateBaseExtendedBinaries(fs, resolveArtifact);
    populateMagic(fs, resolveArtifact, strictArtifactResolution);
  }
  // WHY: every ncurses/termcap-linked guest program resolves $TERM against
  // /usr/share/terminfo on every run, so the shared database must be present
  // regardless of whether the base rootfs already carries it.
  populateTerminfoDatabase(fs, resolveArtifact);
  // WHY: man/apropos/whatis/man -k consult /usr/share/man/mandoc.db on every
  // run, so the index must be present regardless of the base rootfs. Generated
  // from exactly the -docs bundles this environment registers below
  // (coreutils-docs, lsof-docs) so it never claims pages the image lacks.
  const indexedDocsSpecs = SHELL_LAZY_ARCHIVE_SPECS.filter(
    (spec) => spec.id === "coreutils-docs" || spec.id === "lsof-docs",
  );
  await materializeMandocDatabase(fs, resolveArtifact, indexedDocsSpecs);
  if (opts.baseProvided && !opts.eagerBinaries) {
    populateLazyBinaries(fs, resolveArtifact, { skipExisting: true });
  }
  populateVimArchive(fs, resolveArtifact);
  populateNetHackArchive(fs, resolveArtifact);
  populateRubyArchive(fs, resolveArtifact);
  populatePythonArchive(fs, resolveArtifact);
  registerPythonShellProfile(fs);
  populateNodeArchive(fs, resolveArtifact);
  populatePerlArchive(fs, resolveArtifact);
  populateManArchive(fs, resolveArtifact);
  registerManShellProfile(fs);
  populateCoreutilsDocsArchive(fs, resolveArtifact);
  populateLsofDocsArchive(fs, resolveArtifact);
  populateDemoExtendedSymlinks(fs);
  if (opts.eagerBinaries) populateDemoExtendedBinaries(fs, resolveArtifact);
}

// ── System layout ───────────────────────────────────────────────

function populateSystem(fs: MemoryFileSystem): void {
  populateShellRuntimeLayout(fs);
}

function populateShellOverlay(fs: MemoryFileSystem): void {
  populateShellRuntimeLayout(fs);

  // A rootfs artifact may provide the lazy binary inodes without the
  // user-facing aliases the shell demo expects. Recreate the aliases
  // here so shell.vfs stays self-contained even as rootfs stays minimal.
  populateCoreutilsSymlinks(fs);
  populateGrepSedSymlinks(fs);
  populateBaseExtendedSymlinks(fs);
  populateDemoExtendedSymlinks(fs);
}

// ── Shell binaries ──────────────────────────────────────────────

function populateDash(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const dashBytes = readFileSync(resolveArtifact("programs/dash.wasm", "dash"));
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

function populateBash(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const bashBytes = readFileSync(resolveArtifact("programs/bash.wasm", "bash"));
  writeVfsBinary(fs, "/usr/bin/bash", new Uint8Array(bashBytes));
  symlink(fs, "/usr/bin/bash", "/bin/bash");
}

function populateCoreutilsSymlinks(fs: MemoryFileSystem): void {
  for (const name of [...COREUTILS_NAMES, "["]) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }
}

function populateCoreutils(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const bytes = readFileSync(resolveArtifact("programs/coreutils.wasm", "coreutils"));
  writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(bytes));
}

function populateGrepSedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/grep", "/bin/grep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/fgrep");
  symlink(fs, "/usr/bin/grep", "/bin/fgrep");

  symlink(fs, "/usr/bin/sed", "/bin/sed");
}

function populateGrep(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const bytes = readFileSync(resolveArtifact("programs/grep.wasm", "grep"));
  writeVfsBinary(fs, "/usr/bin/grep", new Uint8Array(bytes));
}

function populateSed(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const bytes = readFileSync(resolveArtifact("programs/sed.wasm", "sed"));
  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(bytes));
}

function populateLazyBinaries(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
  opts: { skipExisting?: boolean } = {},
): void {
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (opts.skipExisting && fs.getLazyEntry(spec.vfsPath)) continue;
    const resolved = resolveArtifact(spec.resolverPath, spec.id);
    const size = statSync(resolved).size;
    fs.registerLazyFile(
      spec.vfsPath,
      shellLazyPlaceholderUrl(spec),
      size,
      0o755,
    );
  }
}

// ── Extended toolset ────────────────────────────────────────────

function populateBaseExtendedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/bc", "/bin/bc");
  symlink(fs, "/usr/bin/file", "/bin/file");
  symlink(fs, "/usr/bin/m4", "/bin/m4");
  symlink(fs, "/usr/bin/make", "/bin/make");
}

function populateDemoExtendedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/less", "/bin/less");
  symlink(fs, "/usr/bin/tar", "/bin/tar");
  symlink(fs, "/usr/bin/curl", "/bin/curl");
  symlink(fs, "/usr/bin/nc", "/bin/nc");
  symlink(fs, "/usr/bin/nc", "/usr/bin/netcat");
  symlink(fs, "/usr/bin/nc", "/bin/netcat");
  symlink(fs, "/usr/bin/wget", "/bin/wget");

  symlink(fs, "/usr/bin/git", "/bin/git");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-https");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-ftp");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-ftps");

  symlink(fs, "/usr/bin/gzip", "/bin/gzip");
  symlink(fs, "/usr/bin/gzip", "/usr/bin/gunzip");
  symlink(fs, "/usr/bin/gzip", "/bin/gunzip");
  symlink(fs, "/usr/bin/gzip", "/usr/bin/zcat");
  symlink(fs, "/usr/bin/gzip", "/bin/zcat");

  symlink(fs, "/usr/bin/bzip2", "/bin/bzip2");
  symlink(fs, "/usr/bin/bzip2", "/usr/bin/bunzip2");
  symlink(fs, "/usr/bin/bzip2", "/bin/bunzip2");
  symlink(fs, "/usr/bin/bzip2", "/usr/bin/bzcat");
  symlink(fs, "/usr/bin/bzip2", "/bin/bzcat");

  symlink(fs, "/usr/bin/xz", "/bin/xz");
  symlink(fs, "/usr/bin/xz", "/usr/bin/unxz");
  symlink(fs, "/usr/bin/xz", "/bin/unxz");
  symlink(fs, "/usr/bin/xz", "/usr/bin/xzcat");
  symlink(fs, "/usr/bin/xz", "/bin/xzcat");
  symlink(fs, "/usr/bin/xz", "/usr/bin/lzma");
  symlink(fs, "/usr/bin/xz", "/bin/lzma");
  symlink(fs, "/usr/bin/xz", "/usr/bin/unlzma");
  symlink(fs, "/usr/bin/xz", "/bin/unlzma");
  symlink(fs, "/usr/bin/xz", "/usr/bin/lzcat");
  symlink(fs, "/usr/bin/xz", "/bin/lzcat");

  symlink(fs, "/usr/bin/zstd", "/bin/zstd");
  symlink(fs, "/usr/bin/zstd", "/usr/bin/unzstd");
  symlink(fs, "/usr/bin/zstd", "/bin/unzstd");
  symlink(fs, "/usr/bin/zstd", "/usr/bin/zstdcat");
  symlink(fs, "/usr/bin/zstd", "/bin/zstdcat");

  symlink(fs, "/usr/bin/zip", "/bin/zip");
  symlink(fs, "/usr/bin/unzip", "/bin/unzip");
  symlink(fs, "/usr/bin/unzip", "/usr/bin/zipinfo");
  symlink(fs, "/usr/bin/unzip", "/bin/zipinfo");
  symlink(fs, "/usr/bin/unzip", "/usr/bin/funzip");
  symlink(fs, "/usr/bin/unzip", "/bin/funzip");

  symlink(fs, "/usr/bin/nano", "/bin/nano");
  symlink(fs, "/usr/bin/vim", "/bin/vim");
  symlink(fs, "/usr/bin/vim", "/usr/bin/vi");
  symlink(fs, "/usr/bin/vim", "/bin/vi");

  symlink(fs, "/usr/bin/nethack", "/bin/nethack");

  symlink(fs, "/usr/bin/lsof", "/bin/lsof");

  // posix-utils-lite's raw `man` applet already ships /bin/man as a symlink
  // to /usr/bin/man (see displacePosixUtilsLiteManApplet). This alias is a
  // no-op there (symlink() swallows EEXIST) and is load-bearing for the
  // from-scratch composition path, where no applet has claimed /bin/man yet.
  symlink(fs, "/usr/bin/man", "/bin/man");
}

function populateBaseExtendedBinaries(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const extended: Array<{ relPath: string; vfsPath: string }> = [
    { relPath: "programs/bc.wasm",                   vfsPath: "/usr/bin/bc" },
    { relPath: "programs/file/file.wasm",            vfsPath: "/usr/bin/file" },
    { relPath: "programs/m4.wasm",                   vfsPath: "/usr/bin/m4" },
    { relPath: "programs/make.wasm",                 vfsPath: "/usr/bin/make" },
  ];
  for (const { relPath, vfsPath } of extended) {
    const bytes = readFileSync(resolveArtifact(relPath, artifactDepName(relPath)));
    writeVfsBinary(fs, vfsPath, new Uint8Array(bytes));
  }
}

/** Bake every demo extended-toolset binary. Required for kernelOwnedFs demos. */
function populateDemoExtendedBinaries(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const extended: Array<{ relPath: string; vfsPath: string }> = [
    { relPath: "programs/less.wasm",                 vfsPath: "/usr/bin/less" },
    { relPath: "programs/tar.wasm",                  vfsPath: "/usr/bin/tar" },
    { relPath: "programs/curl.wasm",                 vfsPath: "/usr/bin/curl" },
    { relPath: "programs/nc.wasm",                   vfsPath: "/usr/bin/nc" },
    { relPath: "programs/wget.wasm",                 vfsPath: "/usr/bin/wget" },
    { relPath: "programs/git/git.wasm",              vfsPath: "/usr/bin/git" },
    { relPath: "programs/git/git-remote-http.wasm",  vfsPath: "/usr/bin/git-remote-http" },
    { relPath: "programs/gzip.wasm",                 vfsPath: "/usr/bin/gzip" },
    { relPath: "programs/bzip2.wasm",                vfsPath: "/usr/bin/bzip2" },
    { relPath: "programs/xz.wasm",                   vfsPath: "/usr/bin/xz" },
    { relPath: "programs/zstd.wasm",                 vfsPath: "/usr/bin/zstd" },
    { relPath: "programs/zip.wasm",                  vfsPath: "/usr/bin/zip" },
    { relPath: "programs/unzip.wasm",                vfsPath: "/usr/bin/unzip" },
    { relPath: "programs/nano.wasm",                 vfsPath: "/usr/bin/nano" },
    { relPath: "programs/lsof.wasm",                 vfsPath: "/usr/bin/lsof" },
  ];
  for (const { relPath, vfsPath } of extended) {
    const bytes = readFileSync(resolveArtifact(relPath, artifactDepName(relPath)));
    writeVfsBinary(fs, vfsPath, new Uint8Array(bytes));
  }
}

// ── Magic database (for `file`) ─────────────────────────────────

/**
 * Resolve magic.lite. The file package declares it as a second output
 * alongside file.wasm, but build-file.sh only stages it into the
 * resolver cache scratch dir — it's NOT install_local_binary'd. So the
 * binary-resolver path only succeeds when a release archive that ships
 * magic.lite was fetched. The xtask fallback covers source-built
 * scenarios; the in-tree fallback covers direct build-file.sh runs.
 */
function resolveMagicPath(
  resolveArtifact: ShellLazyArchiveResolver,
  strictArtifactResolution: boolean,
): string {
  // WHY: package builds must fail when a declared dependency is incomplete.
  // Falling through to a developer's ambient binary tree would make the same
  // recipe produce different bytes outside CI.
  if (strictArtifactResolution) {
    return resolveArtifact("programs/file/magic.lite", "file");
  }
  const directDep = tryResolveVfsArtifact("programs/file/magic.lite", "file");
  if (directDep) return directDep;
  const released = tryResolveBinary("programs/file/magic.lite");
  if (released) return released;
  try {
    const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.startsWith("host:"))
      ?.split(/\s+/)[1];
    if (!hostTarget) throw new Error("could not determine host target");
    const cacheDir = execFileSync(
      "cargo",
      ["run", "-p", "xtask", "--target", hostTarget, "--quiet", "--",
       "build-deps", "resolve", "file", "--arch", "wasm32"],
      { cwd: findRepoRoot(), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim();
    if (cacheDir && existsSync(join(cacheDir, "magic.lite"))) {
      return join(cacheDir, "magic.lite");
    }
  } catch {
    // Fall through to in-tree fallback.
  }
  return join(findRepoRoot(), "packages/registry/file/bin/magic.lite");
}

function populateMagic(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
  strictArtifactResolution: boolean,
): void {
  const magicPath = resolveMagicPath(resolveArtifact, strictArtifactResolution);
  try {
    statSync(magicPath);
  } catch {
    throw new Error(
      `magic.lite not found (expected at ${magicPath}). ` +
      `Build the file utility: bash packages/registry/file/build-file.sh`,
    );
  }
  const bytes = readFileSync(magicPath);
  writeVfsBinary(fs, "/usr/share/misc/magic", new Uint8Array(bytes), 0o644);
}

// ── Lazy archives ───────────────────────────────────────────────

function populateVimArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[0],
    resolveArtifact,
  );
}

function populateNetHackArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[1],
    resolveArtifact,
  );
}

function populateRubyArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[2],
    resolveArtifact,
  );
}

function populatePythonArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[3],
    resolveArtifact,
  );
}

function populateNodeArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[4],
    resolveArtifact,
  );
}

function populatePerlArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[5],
    resolveArtifact,
  );
}

function populateManArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  // posix-utils-lite's raw `man` applet may already occupy /usr/bin/man on a
  // baseProvided rootfs; clear it first so mandoc's formatting `man` wins.
  displacePosixUtilsLiteManApplet(fs);
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[6],
    resolveArtifact,
  );
}

function populateCoreutilsDocsArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[7],
    resolveArtifact,
  );
}

function populateLsofDocsArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[8],
    resolveArtifact,
  );
}
