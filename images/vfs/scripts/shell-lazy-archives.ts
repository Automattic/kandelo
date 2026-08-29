import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
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
  requiredMember: string;
}

export const SHELL_LAZY_ARCHIVE_SPECS = [
  {
    id: "vim",
    dependency: "vim-browser-bundle",
    resolverPath: "programs/wasm32/vim.zip",
    archiveUrl: "vim.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/vim",
  },
  {
    id: "nethack",
    dependency: "nethack-browser-bundle",
    resolverPath: "programs/wasm32/nethack.zip",
    archiveUrl: "nethack.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/nethack",
  },
  {
    id: "ruby",
    dependency: "ruby-browser-bundle",
    resolverPath: "programs/wasm32/ruby.zip",
    archiveUrl: "ruby.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/ruby",
  },
  {
    id: "python",
    dependency: "python-browser-bundle",
    resolverPath: "programs/wasm32/python.zip",
    archiveUrl: "python.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/python3",
  },
  {
    id: "node",
    dependency: "node-browser-bundle",
    resolverPath: "programs/wasm32/node.zip",
    archiveUrl: "node.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/node",
  },
  {
    id: "perl",
    dependency: "perl-browser-bundle",
    resolverPath: "programs/wasm32/perl.zip",
    archiveUrl: "perl.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/perl",
  },
  {
    id: "man",
    dependency: "mandoc-browser-bundle",
    resolverPath: "programs/wasm32/man.zip",
    archiveUrl: "man.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/mandoc",
  },
  {
    id: "coreutils-docs",
    dependency: "coreutils-docs",
    resolverPath: "programs/wasm32/coreutils-docs.zip",
    archiveUrl: "coreutils-docs.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/man/man1/ls.1",
  },
  {
    id: "lsof-docs",
    dependency: "lsof-docs",
    resolverPath: "programs/wasm32/lsof-docs.zip",
    archiveUrl: "lsof-docs.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/man/man8/lsof.8",
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

// mandoc's `man` front-end pipes to a pager when stdout is a terminal. Page
// through `less -R` (raw mode so mandoc's bold/overstrike and any SGR escape
// sequences render correctly instead of printing as literal escapes); less
// is a shipped shell lazy-archive dependency and lazy-loads on first use,
// same as coreutils' cat. /etc/man.conf gives the manpath root the docs
// archives fill.
export function registerManShellProfile(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/man.sh",
    "# mandoc: page formatted output through less (raw mode so mandoc's\n" +
      "# bold/overstrike and any SGR escape sequences render correctly\n" +
      "# instead of printing as literal escapes); less is a shell\n" +
      "# lazy-archive dependency and lazy-loads on first use, just like\n" +
      "# coreutils' cat. Search /usr/share/man for man pages.\n" +
      "export MANPAGER='less -R'\n" +
      "export MANPATH=/usr/share/man\n",
    0o644,
  );
}

/**
 * posix-utils-lite installs a raw `man` applet at /usr/bin/man in the base
 * rootfs (cats the raw troff source with no formatting). The mandoc
 * lazy-archive's `bin/man` member mounts a formatting `man` front-end at the
 * exact same path, so registering the archive over an existing applet would
 * throw EEXIST. Clear the applet's entry first so the archive's own symlink
 * can claim /usr/bin/man — mandoc must win. /bin/man is an existing symlink
 * to /usr/bin/man (not a separate inode), so it needs no separate removal:
 * it keeps resolving to whatever now lives at /usr/bin/man.
 */
export function displacePosixUtilsLiteManApplet(fs: MemoryFileSystem): void {
  try {
    fs.lstat("/usr/bin/man");
  } catch {
    return;
  }
  fs.unlink("/usr/bin/man");
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

  const requiredMemberEntries = entries.filter(
    (entry) =>
      entry.fileName === spec.requiredMember &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (requiredMemberEntries.length !== 1) {
    throw new Error(
      `${spec.dependency} output ${sourcePath} must contain exactly one ` +
      `regular member ${spec.requiredMember}; found ${requiredMemberEntries.length}`,
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

// ── Shared runtime terminfo database ───────────────────────────────
//
// Unlike the archives above, the terminfo database is not fetched lazily on
// first use: every ncurses/termcap-linked guest program (less, vim, ...)
// resolves $TERM against /usr/share/terminfo on every run (ncurses is built
// --with-default-terminfo-dir=/usr/share/terminfo), so it must be present
// from boot. It is also small, so materializing it eagerly at build time —
// rather than through the lazy-archive/deferred-tree machinery above — is
// the simplest honest fit.

export const NCURSES_TERMINFO_RUNTIME_FILE = {
  dependency: "ncurses",
  resolverPath: "programs/ncurses/terminfo.zip",
  /** Zip members are rooted at share/terminfo/..., mounted under /usr/. */
  mountPrefix: "/usr/",
  requiredEntry: "share/terminfo/x/xterm-256color",
} as const;

/**
 * Eagerly materialize the package-owned ncurses terminfo database into the
 * image at /usr/share/terminfo. The archive is ncurses's `[[runtime_files]]
 * terminfo.zip` artifact (see packages/registry/ncurses/build-ncurses.sh); the
 * shell composer must never recompile or curate it — it only unpacks the
 * exact declared bytes.
 */
export function populateTerminfoDatabase(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const sourcePath = resolveArtifact(
    NCURSES_TERMINFO_RUNTIME_FILE.resolverPath,
    NCURSES_TERMINFO_RUNTIME_FILE.dependency,
  );
  const bytes = new Uint8Array(readFileSync(sourcePath));
  let entries: ZipEntry[];
  try {
    entries = parseZipCentralDirectory(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ncurses terminfo output ${sourcePath} is not a valid ZIP: ${message}`,
    );
  }

  const requiredEntries = entries.filter(
    (entry) =>
      entry.fileName === NCURSES_TERMINFO_RUNTIME_FILE.requiredEntry &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (requiredEntries.length !== 1) {
    throw new Error(
      `ncurses terminfo output ${sourcePath} must contain exactly one ` +
        `regular ${NCURSES_TERMINFO_RUNTIME_FILE.requiredEntry}; ` +
        `found ${requiredEntries.length}`,
    );
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.isSymlink) {
      throw new Error(
        `ncurses terminfo output ${sourcePath} has an unexpected symlink ` +
          `entry ${entry.fileName}`,
      );
    }
    const destPath = `${NCURSES_TERMINFO_RUNTIME_FILE.mountPrefix}${entry.fileName}`;
    ensureDirRecursive(fs, dirname(destPath));
    const data = extractZipEntry(bytes, entry);
    writeVfsBinary(fs, destPath, data, (entry.mode & 0o777) || 0o644);
  }
}

// ── Shared mandoc.db manual index ──────────────────────────────────
//
// Like the terminfo database, the combined mandoc.db (a name/keyword index
// over every shipped -docs man page) is materialized eagerly at /usr/share/man
// rather than fetched lazily: mandoc's `man <name>`, apropos, whatis, and
// man -k consult it on every run, and without it mandoc prints an "outdated
// mandoc.db, run makewhatis" note and falls back to a slower filesystem scan.
// The mandoc-db package builds it with a host makewhatis (see
// packages/registry/mandoc-db/build-mandoc-db.sh); the composer only unpacks
// the exact declared bytes.

export const MANDOC_DB_RUNTIME_FILE = {
  dependency: "mandoc-db",
  resolverPath: "programs/wasm32/mandoc-db.zip",
  /** Zip members are rooted at share/man/..., mounted under /usr/. */
  mountPrefix: "/usr/",
  requiredEntry: "share/man/mandoc.db",
} as const;

/**
 * Eagerly materialize the package-owned combined mandoc.db into the image at
 * /usr/share/man/mandoc.db. The archive is the mandoc-db package's output; the
 * composer must never rebuild it — it only unpacks the exact declared bytes.
 */
export function populateMandocDatabase(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const sourcePath = resolveArtifact(
    MANDOC_DB_RUNTIME_FILE.resolverPath,
    MANDOC_DB_RUNTIME_FILE.dependency,
  );
  const bytes = new Uint8Array(readFileSync(sourcePath));
  let entries: ZipEntry[];
  try {
    entries = parseZipCentralDirectory(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`mandoc-db output ${sourcePath} is not a valid ZIP: ${message}`);
  }

  const requiredEntries = entries.filter(
    (entry) =>
      entry.fileName === MANDOC_DB_RUNTIME_FILE.requiredEntry &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (requiredEntries.length !== 1) {
    throw new Error(
      `mandoc-db output ${sourcePath} must contain exactly one regular ` +
        `${MANDOC_DB_RUNTIME_FILE.requiredEntry}; found ${requiredEntries.length}`,
    );
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.isSymlink) {
      throw new Error(
        `mandoc-db output ${sourcePath} has an unexpected symlink entry ${entry.fileName}`,
      );
    }
    const destPath = `${MANDOC_DB_RUNTIME_FILE.mountPrefix}${entry.fileName}`;
    ensureDirRecursive(fs, dirname(destPath));
    const data = extractZipEntry(bytes, entry);
    writeVfsBinary(fs, destPath, data, (entry.mode & 0o777) || 0o644);
  }
}
