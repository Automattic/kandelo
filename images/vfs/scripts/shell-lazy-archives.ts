import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  extractZipEntry,
  parseZipCentralDirectory,
  type ZipEntry,
} from "../../../host/src/vfs/zip";

const symlinkTargetDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const textEncoder = new TextEncoder();

export interface ShellLazyArchiveSpec {
  id: "vim" | "nethack";
  dependency: "vim-browser-bundle" | "nethack-browser-bundle";
  resolverPath: "programs/wasm32/vim.zip" | "programs/wasm32/nethack.zip";
  archiveUrl: "vim.zip" | "nethack.zip";
  mountPrefix: "/usr/";
  requiredExecutable: "bin/vim" | "bin/nethack";
}

export const SHELL_LAZY_ARCHIVE_SPECS = [
  {
    id: "vim",
    dependency: "vim-browser-bundle",
    resolverPath: "programs/wasm32/vim.zip",
    archiveUrl: "vim.zip",
    mountPrefix: "/usr/",
    requiredExecutable: "bin/vim",
  },
  {
    id: "nethack",
    dependency: "nethack-browser-bundle",
    resolverPath: "programs/wasm32/nethack.zip",
    archiveUrl: "nethack.zip",
    mountPrefix: "/usr/",
    requiredExecutable: "bin/nethack",
  },
] as const satisfies readonly ShellLazyArchiveSpec[];

export interface DeclaredShellLazyArchive {
  spec: ShellLazyArchiveSpec;
  sourcePath: string;
  /** The one exact byte sequence used for indexing and integrity metadata. */
  bytes: Uint8Array;
  entries: ZipEntry[];
  symlinkTargets: Map<string, string>;
  integrity: {
    compressedBytes: number;
    sha256: string;
  };
}

export type ShellLazyArchiveResolver = (
  resolverPath: string,
  dependency: string,
) => string;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function readSymlinkTargets(
  dependency: string,
  sourcePath: string,
  bytes: Uint8Array,
  entries: ZipEntry[],
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isSymlink) continue;
    const targetBytes = extractZipEntry(bytes, entry);
    const context = `${dependency} output ${sourcePath} symlink ${entry.fileName}`;
    if (targetBytes.byteLength === 0) {
      throw new Error(`${context} has an empty target`);
    }
    if (targetBytes.includes(0)) {
      throw new Error(`${context} target contains a NUL byte`);
    }

    let target: string;
    try {
      target = symlinkTargetDecoder.decode(targetBytes);
    } catch {
      throw new Error(`${context} target is not valid UTF-8`);
    }
    if (!bytesEqual(targetBytes, textEncoder.encode(target))) {
      throw new Error(`${context} target cannot be preserved byte-for-byte`);
    }
    targets.set(entry.fileName, target);
  }
  return targets;
}

/**
 * Load one declared browser-bundle output through the package resolver.
 *
 * The shell composer must never recreate these ZIPs. The package output is
 * the distribution identity consumed later by Node and browser hosts, so the
 * exact bytes returned here are also the bytes indexed and used to derive the
 * lazy-archive integrity metadata.
 */
export function loadDeclaredShellLazyArchive(
  spec: ShellLazyArchiveSpec,
  resolveArtifact: ShellLazyArchiveResolver,
): DeclaredShellLazyArchive {
  const sourcePath = resolveArtifact(spec.resolverPath, spec.dependency);
  const bytes = new Uint8Array(readFileSync(sourcePath));
  let entries: ZipEntry[];
  try {
    entries = parseZipCentralDirectory(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${spec.dependency} output ${sourcePath} is not a valid lazy ZIP: ${message}`,
    );
  }

  const executableEntries = entries.filter(
    (entry) =>
      entry.fileName === spec.requiredExecutable &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (executableEntries.length !== 1) {
    throw new Error(
      `${spec.dependency} output ${sourcePath} must contain exactly one ` +
      `regular executable ${spec.requiredExecutable}; found ${executableEntries.length}`,
    );
  }

  const symlinkTargets = readSymlinkTargets(
    spec.dependency,
    sourcePath,
    bytes,
    entries,
  );

  return {
    spec,
    sourcePath,
    bytes,
    entries,
    symlinkTargets,
    integrity: {
      compressedBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/** Register one package-owned archive without rebuilding or rereading it. */
export function registerDeclaredShellLazyArchive(
  fs: MemoryFileSystem,
  spec: ShellLazyArchiveSpec,
  resolveArtifact: ShellLazyArchiveResolver,
): DeclaredShellLazyArchive {
  const archive = loadDeclaredShellLazyArchive(spec, resolveArtifact);
  fs.registerLazyArchiveFromEntries(
    spec.archiveUrl,
    archive.entries,
    spec.mountPrefix,
    archive.symlinkTargets,
  );
  return archive;
}
