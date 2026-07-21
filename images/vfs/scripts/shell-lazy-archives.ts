import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  parseZipCentralDirectory,
  type ZipEntry,
} from "../../../host/src/vfs/zip";

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
  integrity: {
    compressedBytes: number;
    sha256: string;
  };
}

export type ShellLazyArchiveResolver = (
  resolverPath: string,
  dependency: string,
) => string;

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

  return {
    spec,
    sourcePath,
    bytes,
    entries,
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
  );
  return archive;
}
