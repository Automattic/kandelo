/**
 * Resolve a binary (wasm, zip bundle, vfs image) from the repo's
 * `local-binaries/` or `binaries/` tree.
 *
 * Priority:
 *   1. `<repo>/local-binaries/<relPath>` — user-built override.
 *   2. `<repo>/binaries/<relPath>` — populated by
 *      `scripts/fetch-binaries.sh`.
 *
 * Throws if neither exists. Callers that want to tolerate a missing
 * binary should catch and fall back themselves.
 *
 * See `docs/binary-releases.md` for the layout.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from the importing file to find the repo root. Markers:
 * `binaries.lock` + `abi/manifest.schema.json`. Both are tracked,
 * both are near the top of the tree — together they're unambiguous.
 */
let cachedRepoRoot: string | null = null;

export function findRepoRoot(startFrom?: string): string {
  if (cachedRepoRoot && !startFrom) return cachedRepoRoot;
  const here =
    startFrom ??
    (import.meta.url ? dirname(fileURLToPath(import.meta.url)) : process.cwd());
  let dir = resolve(here);
  for (let i = 0; i < 20; i++) {
    if (
      existsSync(join(dir, "binaries.lock")) &&
      existsSync(join(dir, "abi/manifest.schema.json"))
    ) {
      if (!startFrom) cachedRepoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find repo root (expected binaries.lock + abi/manifest.schema.json)"
  );
}

/**
 * Resolve a binary relative to the binaries tree.
 *
 * Example paths:
 *   `kernel.wasm`
 *   `userspace.wasm`
 *   `programs/vim.zip`
 *   `programs/git/git.wasm`
 *   `vfs/shell.vfs.zst`
 */
export function resolveBinary(relPath: string): string {
  const repo = findRepoRoot();
  const local = join(repo, "local-binaries", relPath);
  if (existsSync(local)) return local;
  const fetched = join(repo, "binaries", relPath);
  if (existsSync(fetched)) return fetched;
  throw new Error(
    `Binary not found: ${relPath}\n` +
      `  checked: ${local}\n` +
      `  checked: ${fetched}\n` +
      `  Run scripts/fetch-binaries.sh or place a file at local-binaries/${relPath}.`
  );
}

/**
 * Like `resolveBinary` but returns `null` instead of throwing when the
 * binary is absent. Callers choose how to handle the miss.
 */
export function tryResolveBinary(relPath: string): string | null {
  try {
    return resolveBinary(relPath);
  } catch {
    return null;
  }
}

/** Returns the absolute path of binaries/ whether or not it exists. */
export function binariesDir(): string {
  return join(findRepoRoot(), "binaries");
}

/** Returns the absolute path of local-binaries/ whether or not it exists. */
export function localBinariesDir(): string {
  return join(findRepoRoot(), "local-binaries");
}
