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
 *   `programs/vim.zip`               (implicit wasm32 — see below)
 *   `programs/git/git.wasm`          (implicit wasm32)
 *   `programs/wasm64/mariadb-vfs.vfs.zst` (explicit arch)
 *
 * Per-arch layout: `binaries/programs/` and `local-binaries/programs/`
 * are split into `wasm32/` and `wasm64/` subtrees so multi-arch
 * programs (e.g. mariadb-vfs) can coexist without last-write-wins.
 * For backward compatibility, callers passing `programs/<x>` without
 * an explicit arch segment are routed to `programs/wasm32/<x>` —
 * almost every host-side caller runs wasm32 user programs against a
 * wasm64 kernel, so wasm32 is the right default. Callers that need
 * the wasm64 build pass `programs/wasm64/<x>` explicitly.
 */
const ARCH_SEGMENTS = new Set(["wasm32", "wasm64"]);

function applyDefaultArch(relPath: string): string {
  if (!relPath.startsWith("programs/")) return relPath;
  const tail = relPath.slice("programs/".length);
  const firstSeg = tail.split("/", 1)[0];
  if (ARCH_SEGMENTS.has(firstSeg)) return relPath;
  return `programs/wasm32/${tail}`;
}

export function resolveBinary(relPath: string): string {
  const repo = findRepoRoot();
  const adjusted = applyDefaultArch(relPath);
  const local = join(repo, "local-binaries", adjusted);
  if (existsSync(local)) return local;
  const fetched = join(repo, "binaries", adjusted);
  if (existsSync(fetched)) return fetched;
  throw new Error(
    `Binary not found: ${relPath}\n` +
      `  checked: ${local}\n` +
      `  checked: ${fetched}\n` +
      `  Run scripts/fetch-binaries.sh or place a file at local-binaries/${adjusted}.`
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
