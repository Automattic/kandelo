import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "../../../host/src/vfs/image-helpers";
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
  id: string;
  dependency: string;
  resolverPath: string;
  archiveUrl: string;
  mountPrefix: "/usr/";
  requiredExecutable: string;
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
  {
    id: "ruby",
    dependency: "ruby-browser-bundle",
    resolverPath: "programs/wasm32/ruby.zip",
    archiveUrl: "ruby.zip",
    mountPrefix: "/usr/",
    requiredExecutable: "bin/ruby",
  },
  {
    id: "python",
    dependency: "python-browser-bundle",
    resolverPath: "programs/wasm32/python.zip",
    archiveUrl: "python.zip",
    mountPrefix: "/usr/",
    requiredExecutable: "bin/python3",
  },
  {
    id: "node",
    dependency: "node-browser-bundle",
    resolverPath: "programs/wasm32/node.zip",
    archiveUrl: "node.zip",
    mountPrefix: "/usr/",
    requiredExecutable: "bin/node",
  },
] as const satisfies readonly ShellLazyArchiveSpec[];

// The python lazy-archive mounts a statically-linked CPython at /usr/bin with
// its standard library at /usr/lib/python3.13. A static build ships no
// platform-dependent (lib-dynload) modules, so CPython's exec_prefix probe
// fails and prints "Could not find platform dependent libraries <exec_prefix>"
// to stderr on every launch (the pure-Python stdlib still self-locates, so the
// REPL otherwise works). Pinning PYTHONHOME=/usr makes exec_prefix explicit —
// the interpreter stops probing and the REPL starts cleanly. This mirrors the
// dedicated python VFS product, which sets the same value in its boot env.
// Sourced by /etc/profile for interactive login shells.
export function registerPythonShellProfile(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/python.sh",
    "# Static CPython ships no lib-dynload; pin the prefix so exec_prefix\n" +
      "# resolves without probing and the REPL starts without a warning.\n" +
      "export PYTHONHOME=/usr\n",
    0o644,
  );
}

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
    {
      sha256: archive.integrity.sha256,
      bytes: archive.integrity.compressedBytes,
    },
  );
  return archive;
}
