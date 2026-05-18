/**
 * Shell binary population — writes dash, registers lazy utility binaries,
 * creates standard directory structure and symlinks.
 *
 * Extracted from pages/shell/main.ts for reuse by any demo that needs a
 * working shell environment.
 */
import type { BrowserKernel } from "../browser-kernel";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
} from "./vfs-utils";

/**
 * Definition of a lazily-loaded binary. The binary is registered in the
 * VFS as a stub file and fetched on demand when first exec'd.
 */
export interface BinaryDef {
  url: string;
  path: string;
  size: number;
  symlinks: string[];
}

/**
 * GNU coreutils multicall binary command names (91 names).
 * Each becomes a symlink to /bin/coreutils in both /bin and /usr/bin.
 */
export const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
] as const;

/**
 * Populate the virtual filesystem with shell binaries.
 *
 * 1. Creates standard directory structure (/bin, /usr/bin, /etc, /root, etc.)
 * 2. Writes /etc/gitconfig with safe defaults for wasm
 * 3. Writes dash eagerly and creates sh symlinks
 * 4. Registers lazy binaries via kernel.registerLazyFiles() and creates symlinks
 * 5. Writes any additional data files (magic database, etc.)
 *
 * @param kernel      — BrowserKernel instance (provides fs and registerLazyFiles)
 * @param dashBytes   — The dash.wasm binary content
 * @param lazyBinaries — Array of lazy binary definitions with URLs and sizes
 * @param dataFiles   — Optional data files to write eagerly
 */
export function populateShellBinaries(
  kernel: BrowserKernel,
  dashBytes: ArrayBuffer,
  lazyBinaries: BinaryDef[],
  dataFiles?: Array<{ path: string; data: Uint8Array | string }>,
): void {
  const fs = kernel.fs;

  // 1. Create standard directories
  for (const dir of [
    "/bin",
    "/usr",
    "/usr/bin",
    "/usr/local",
    "/usr/local/bin",
    "/usr/share",
    "/usr/share/misc",
    "/usr/share/file",
    "/etc",
    "/root",
  ]) {
    ensureDir(fs, dir);
  }

  // 2. Write git system config — disable maintenance/gc (fork+exec not fully
  //    supported for background daemons), use cat as pager, set default user.
  const gitconfig = [
    "[maintenance]",
    "\tauto = false",
    "[gc]",
    "\tauto = 0",
    "[core]",
    "\tpager = cat",
    "[user]",
    "\tname = User",
    "\temail = user@wasm.local",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/gitconfig", gitconfig);

  // 3. Write dash binary eagerly and create symlinks
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  try { fs.symlink("/bin/dash", "/bin/sh"); } catch { /* exists */ }
  try { fs.symlink("/bin/dash", "/usr/bin/dash"); } catch { /* exists */ }
  try { fs.symlink("/bin/dash", "/usr/bin/sh"); } catch { /* exists */ }

  // 4. Register lazy binaries and create symlinks
  if (lazyBinaries.length > 0) {
    kernel.registerLazyFiles(
      lazyBinaries.map((lb) => ({
        path: lb.path,
        url: lb.url,
        size: lb.size,
        mode: 0o755,
      })),
    );
    for (const lb of lazyBinaries) {
      for (const link of lb.symlinks) {
        try { fs.symlink(lb.path, link); } catch { /* exists */ }
      }
    }
  }

  // 5. Write data files (magic database, etc.)
  if (dataFiles) {
    for (const df of dataFiles) {
      if (typeof df.data === "string") {
        writeVfsFile(fs, df.path, df.data);
      } else {
        writeVfsBinary(fs, df.path, df.data);
      }
    }
  }
}
