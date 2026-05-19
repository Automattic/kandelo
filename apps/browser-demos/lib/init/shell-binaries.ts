/**
 * Shell binary population — writes dash, registers lazy utility binaries,
 * creates standard directory structure and symlinks.
 *
 * Extracted from pages/shell/main.ts for reuse by any demo that needs a
 * working shell environment.
 */
import type { BrowserKernel } from "@host/browser-kernel-host";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
} from "./vfs-utils";
export { COREUTILS_NAMES } from "../../../../images/vfs/lib/init/shell-binaries";

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
