/** Shared loader and serializer for products derived from the package shell. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../../../host/src/vfs/memory-fs";
import {
  programWasmArtifactPolicy,
  resolveBinary,
  resolveDirectProgramPackageArtifact,
  tryResolveBinary,
  type ResolvedDirectProgramPackageArtifact,
} from "../../../host/src/binary-resolver";
import {
  saveImage,
  sourceDateEpochMilliseconds,
  type SaveImageOptions,
} from "./vfs-image-helpers";
import {
  SHELL_DERIVED_VFS_MIN_FREE_BYTES,
  SHELL_DERIVED_VFS_MIN_FREE_INODES,
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
} from "../../../web-libs/kandelo-session/src/experimental-terminal-session";
import { PACKAGE_ROOTFS_SHELL_COMPOSITION } from "./source-rootfs-shell-overlay";

const SHELL_DERIVED_CREATED_BY =
  "images/vfs/scripts/savePackageShellDerivedVfsImage";

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
  return resolveDirectProgramPackageArtifact(relPath, packageName, depDir);
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

export function tryResolveVfsArtifact(
  relPath: string,
  depName?: string,
): string | null {
  return depArtifactPath(relPath, depName) ?? tryResolveBinary(relPath);
}

export function resolveVfsArtifact(relPath: string, depName?: string): string {
  return tryResolveVfsArtifact(relPath, depName) ?? resolveBinary(relPath);
}

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
  return loadShellBaseFileSystemFromImage(
    new Uint8Array(readFileSync(shellImagePath)),
    maxByteLength,
  );
}

export async function loadShellBaseFileSystemFromImage(
  shellImage: Uint8Array,
  maxByteLength: number,
): Promise<MemoryFileSystem> {
  const fs = MemoryFileSystem.fromImagePreservingCapacity(shellImage);
  await fs.verifyImportedLazyAtomicGroupSeals();
  const metadata = fs.getImageMetadata();
  const kernelAbi = metadata?.kernelAbi;
  if (
    metadata === null ||
    typeof kernelAbi !== "number" ||
    !Number.isSafeInteger(kernelAbi) ||
    kernelAbi < 0 ||
    !isExactPackageShellComposition(metadata.shellComposition)
  ) {
    throw new Error("package shell base image has invalid metadata");
  }
  validateExperimentalTerminalSession(fs);
  fs.setImageMetadata({
    ...metadata,
    baseImage: {
      sha256: sha256Hex(shellImage),
      bytes: shellImage.byteLength,
      kernelAbi,
    },
  });
  const stats = fs.statfs("/");
  const effectiveMaxByteLength = stats.blocks * stats.bsize;
  if (effectiveMaxByteLength === maxByteLength) return fs;

  console.log(
    `Rebasing package shell VFS capacity from ` +
      `${Math.round(effectiveMaxByteLength / 1024 / 1024)} MiB to ` +
      `${Math.round(maxByteLength / 1024 / 1024)} MiB...`,
  );
  return fs.rebaseToNewFileSystem(maxByteLength);
}

/** Serialize a transient package-shell guest used by a derived-image build. */
export function saveShellDerivedBuildGuestSnapshot(
  fs: MemoryFileSystem,
): Promise<Uint8Array> {
  requirePackageShellMetadata(fs.getImageMetadata(), "build guest");
  return fs.saveImage();
}

export function saveShellDerivedVfsImage(
  fs: MemoryFileSystem,
  outFile: string,
  options: Omit<
    SaveImageOptions,
    "headroom" | "expectedMaxByteLength" | "metadata"
  > & { expectedMaxByteLength?: number } = {},
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

  const inherited = requirePackageShellMetadata(
    fs.getImageMetadata(),
    outFile,
  );
  const kernelAbi = inherited.kernelAbi as number;
  if (requestedKernelAbi !== undefined && requestedKernelAbi !== kernelAbi) {
    throw new Error(
      `${outFile} cannot replace inherited kernel ABI ${kernelAbi} ` +
        `with ABI ${requestedKernelAbi}`,
    );
  }
  validateExperimentalTerminalSession(fs);
  const baseImage = requiredBaseImage(inherited, kernelAbi);
  const abiSnapshotSha256 = inherited.abiSnapshotSha256;
  if (
    abiSnapshotSha256 !== undefined &&
    (typeof abiSnapshotSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(abiSnapshotSha256))
  ) {
    throw new Error(`${outFile} has an invalid ABI snapshot binding`);
  }

  return saveImage(fs, outFile, {
    ...saveOptions,
    kernelAbi,
    metadata: {
      version: 1,
      kernelAbi,
      ...(abiSnapshotSha256 === undefined ? {} : { abiSnapshotSha256 }),
      createdBy: SHELL_DERIVED_CREATED_BY,
      capacity: { maxByteLength: expectedMaxByteLength },
      baseImage,
      shellComposition: PACKAGE_ROOTFS_SHELL_COMPOSITION,
    },
    normalizeTimestampsMs,
    expectedMaxByteLength,
    headroom: {
      minimumFreeBytes: SHELL_DERIVED_VFS_MIN_FREE_BYTES,
      minimumFreeInodes: SHELL_DERIVED_VFS_MIN_FREE_INODES,
    },
  });
}

function requirePackageShellMetadata(
  metadata: VfsImageMetadata | null,
  label: string,
): VfsImageMetadata {
  if (
    metadata === null ||
    typeof metadata.kernelAbi !== "number" ||
    !Number.isSafeInteger(metadata.kernelAbi) ||
    metadata.kernelAbi < 0 ||
    !isExactPackageShellComposition(metadata.shellComposition)
  ) {
    throw new Error(`${label} is not derived from the package shell`);
  }
  return metadata;
}

function requiredBaseImage(
  metadata: VfsImageMetadata,
  kernelAbi: number,
): { sha256: string; bytes: number; kernelAbi: number } {
  const value = metadata.baseImage;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package shell derived image omits its direct base binding");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes <= 0 ||
    record.kernelAbi !== kernelAbi
  ) {
    throw new Error("package shell derived image has an invalid direct base binding");
  }
  return {
    sha256: record.sha256,
    bytes: record.bytes,
    kernelAbi,
  };
}

function isExactPackageShellComposition(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === PACKAGE_ROOTFS_SHELL_COMPOSITION.schema &&
    record.kind === PACKAGE_ROOTFS_SHELL_COMPOSITION.kind &&
    Object.keys(record).sort().join("\0") === "kind\0schema"
  );
}

function validateExperimentalTerminalSession(fs: MemoryFileSystem): void {
  const stat = fs.lstat(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  if ((stat.mode & 0o170000) !== 0o100000) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} must be a regular file`,
    );
  }
  if (stat.size > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} bytes`,
    );
  }
  parseExperimentalTerminalSession(
    new TextDecoder("utf-8", { fatal: true }).decode(
      readVfsBytes(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH),
    ),
  );
}

function readVfsBytes(fs: MemoryFileSystem, path: string): Uint8Array {
  const bytes = new Uint8Array(fs.stat(path).size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (read <= 0) throw new Error(`short VFS read for ${path}`);
      offset += read;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
