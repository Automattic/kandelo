import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this repository's built artifacts live, in the one order everything
 * searches them.
 *
 * # Why this is its own module, and a leaf
 *
 * Two things need these roots, and they cannot both live in
 * `binary-resolver.ts`:
 *
 *   * `resolveBinary` builds its rich candidate tiers over them;
 *   * `wasm-artifact-module-node.ts` resolves the artifact READER's own bytes
 *     over them, deliberately without going through `resolveBinary` -- because
 *     `resolveBinary` validates every `.wasm` candidate against the artifact
 *     policy, and the artifact policy is exactly what the reader answers. The
 *     thing that judges artifacts cannot be the thing that admits itself.
 *
 * So the reader resolved by path, over a SECOND, hand-maintained copy of this
 * list. That copy drifted in both directions, as its own comment admitted, and
 * carried a third defect nobody had written down: it called `resolverRepoRoot()`
 * unguarded before searching, so an INSTALLED npm consumer -- which has no repo
 * root -- threw "Could not find repo root" before it could reach its own
 * `host/wasm` tier. Since the reader is what validates every artifact, that
 * meant an installed consumer could not read any artifact, and therefore could
 * not boot.
 *
 * This module exists so there is one list. It imports nothing from the host
 * runtime, which is what lets the artifact reader's Node source depend on it
 * without creating a cycle back through `binary-resolver.ts`.
 */

let cachedRepoRoot: string | null = null;

/**
 * This module's own directory.
 *
 * Exported because `binary-resolver.ts` uses it to decide whether the running
 * module is source-owned. Both files sit in `host/src`, so moving the helper
 * here did not change the directory it reports.
 */
export function currentModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return import.meta.url
    ? dirname(fileURLToPath(import.meta.url))
    : process.cwd();
}

function isRepoRoot(dir: string): boolean {
  // Workspace Cargo.toml has a [workspace] table; nested crate Cargo.tomls do
  // not. The package identity matters too: an installed host package may live
  // below an unrelated consumer's Cargo/npm workspace, which must not be
  // mistaken for a Kandelo source checkout.
  const cargo = join(dir, "Cargo.toml");
  const packageJson = join(dir, "package.json");
  if (!existsSync(cargo) || !existsSync(packageJson)) return false;
  try {
    const packageIdentity = JSON.parse(readFileSync(packageJson, "utf8"));
    return /^\s*\[workspace\]/m.test(readFileSync(cargo, "utf8"))
      && packageIdentity?.name === "kandelo";
  } catch {
    return false;
  }
}

export function findRepoRoot(startFrom?: string): string {
  if (cachedRepoRoot && !startFrom) return cachedRepoRoot;
  const here = startFrom ?? currentModuleDir();
  let dir = resolve(here);
  for (let i = 0; i < 20; i++) {
    if (isRepoRoot(dir)) {
      if (!startFrom) cachedRepoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find repo root (expected workspace Cargo.toml + package.json)",
  );
}

/**
 * The repo root every source tier is measured from.
 *
 * `WASM_POSIX_BINARY_RESOLVER_REPO_ROOT` is what makes that root knowable to a
 * realm whose own module path is not inside the checkout -- a Node process
 * worker running as an esbuild bundle under the OS temp directory, for one,
 * which is what `worker-adapter.ts` produces whenever `host/dist` has not been
 * built yet.
 */
export function resolverRepoRoot(): string {
  const explicitStart = process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT;
  return explicitStart ? findRepoRoot(explicitStart) : findRepoRoot();
}

/** The installed host package's own root, which exists with or without a checkout. */
export function packageRoot(): string {
  return resolve(currentModuleDir(), "..");
}

export function hasSourceCheckout(): boolean {
  try {
    resolverRepoRoot();
    return true;
  } catch {
    return false;
  }
}

export type BinaryTierKind =
  | "source-only-v1"
  | "local-binaries"
  | "binaries"
  | "installed-package";

export interface BinaryTierRoot {
  readonly label: string;
  readonly root: string;
  readonly kind: BinaryTierKind;
}

/**
 * Every root that may hold a built artifact, in search order.
 *
 * The source tiers are present only in a checkout, and `source-only-v1` only
 * once a local build has written it -- a completed local build's FIRST tier.
 * The installed-package root is always last and always present, which is the
 * property the reader's old hand-maintained copy lost: without a checkout it
 * is the only tier there is, and it must still be reachable.
 */
export function binaryTierRoots(): readonly BinaryTierRoot[] {
  const tiers: BinaryTierRoot[] = [];
  try {
    const repo = resolverRepoRoot();
    const sourceOnlyRoot = join(repo, "local-binaries", "source-only-v1");
    if (existsSync(sourceOnlyRoot)) {
      tiers.push({
        label: "source-only-v1",
        root: sourceOnlyRoot,
        kind: "source-only-v1",
      });
    }
    tiers.push({
      label: "local-binaries",
      root: join(repo, "local-binaries"),
      kind: "local-binaries",
    });
    tiers.push({
      label: "binaries",
      root: join(repo, "binaries"),
      kind: "binaries",
    });
  } catch {
    // Installed npm consumers do not carry a source repo root.
  }
  tiers.push({
    label: "installed package",
    root: join(packageRoot(), "wasm"),
    kind: "installed-package",
  });
  return tiers;
}
