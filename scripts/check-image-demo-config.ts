#!/usr/bin/env npx tsx
/**
 * Assert that every tracked demo-config source exists, parses, declares
 * version 1, and carries no block key that is a near miss for a known one.
 *
 * This file also implements the BAKED-EQUALS-TRACKED comparison: for every
 * single-source image, the `/etc/kandelo/demo.json` baked into the built
 * `.vfs`/`.vfs.zst` artifact must be byte-for-byte identical to its tracked
 * source. That needs `MemoryFileSystem.fromImage` from host/src/vfs, which is
 * TypeScript — this file used to be a plain `.mjs` invoked with bare `node`
 * specifically so it could not import TypeScript, which is why the
 * comparison was deferred (see git history and
 * docs/superpowers/plans/2026-09-22-image-owned-machine-definitions-1-schema.md).
 * Nothing in `run.sh` or CI ever invoked that plain-`.mjs` form directly
 * (only its own `.test.mjs` exercised it under vitest), so promoting this
 * file to a real `.ts` module — run via `tsx`, exactly like every other
 * TypeScript-aware script in this directory (e.g. `vfs-product-deployment.ts`,
 * `build-local-vfs-asset-group.ts`) — costs nothing and removes the
 * constraint. `checkTrackedDemoConfigs` (tracked-source validation only,
 * no image I/O) is unchanged; `checkBakedEqualsTracked` is new.
 *
 * The source-rootfs shell image is the documented exception: its demo.json
 * is a deterministic merge of two tracked files (see
 * composeSourceRootfsDemoConfig in build-source-rootfs-shell-image.ts), so no
 * single tracked file's bytes are ever baked for it. Byte-identity is a
 * single-source-image property (spec: "Authority and artifact flow" /
 * "Byte-identity, and the one exception"). `checkBakedEqualsTracked` skips
 * those two tracked sources EXPLICITLY — they are named in
 * `COMPOSED_TRACKED_SOURCES` below — rather than silently, and never counts
 * them as compared.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BinaryNotFoundError,
  snapshotSourceOnlyBinary,
  sourceOnlyBinaryRoot,
  tryResolveBinary,
} from "../host/src/binary-resolver.ts";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import { KANDELO_DEMO_CONFIG_PATH } from "../web-libs/kandelo-session/src/demo-config.ts";
import {
  parseTrackedSourcePaths,
  trackedSourcePaths,
} from "./tracked-demo-config-sources.mjs";

export { parseTrackedSourcePaths, trackedSourcePaths };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The block keys a profile may declare. There is ONE shape to scan now:
// KandeloDemoConfig keeps only `version`, `defaultProfile`, and `profiles`
// at the top level, and `validateKandeloDemoConfig` rejects a machine block
// there outright, so this checker no longer needs a second pass over the top
// level for the same key set.
//
// A new short key must be added here in the same change that introduces it,
// or edit-distance-2 will reject it as a typo of an existing key on day one
// (e.g. "net" is distance 2 from "init", "web2" is distance 1 from "web").
// That false-positive risk is accepted: this checker only gates the tracked
// files in this repository.
const KNOWN_PROFILE_KEYS = [
  "presentation", "assets", "guide", "ingest",
  "identity", "runtime", "init", "web", "display",
];

/** Levenshtein distance, capped at 2 — enough to catch a typo, not a rename. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

export function nearMissKeys(
  profile: Record<string, unknown>,
): Array<{ found: string; meant: string }> {
  const out: Array<{ found: string; meant: string }> = [];
  for (const found of Object.keys(profile)) {
    if (KNOWN_PROFILE_KEYS.includes(found)) continue;
    for (const meant of KNOWN_PROFILE_KEYS) {
      const d = editDistance(found.toLowerCase(), meant);
      // d === 0 here means found differs from meant only by case (an exact
      // lowercase match was already filtered out by the `continue` above),
      // and that case variation must still be flagged as a near miss.
      if (d <= 2) {
        out.push({ found, meant });
        break;
      }
    }
  }
  return out;
}

/**
 * Validate one already-parsed demo config. Exported (independent of file
 * I/O) so the scan can be exercised against a plain object in tests, the
 * same way nearMissKeys() is exercised directly.
 *
 * Unknown block keys are tolerated inside a profile for forward
 * compatibility, so a typo'd block name would otherwise boot a machine
 * missing that block with no diagnostic. That is what this catches.
 */
export function assertValidDemoConfig(
  parsed: { version?: unknown; profiles?: Record<string, unknown> } & Record<string, unknown>,
  relPath: string,
): void {
  if (parsed.version !== 1) {
    throw new Error(`${relPath} must declare version 1`);
  }
  for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
    for (const { found, meant } of nearMissKeys(profile as Record<string, unknown>)) {
      throw new Error(
        `${relPath} profiles.${profileId} has key "${found}" — did you mean `
          + `"${meant}"? Unknown keys are tolerated for forward compatibility, `
          + `so a typo here would silently boot a machine without that block.`,
      );
    }
  }
}

export function checkTrackedDemoConfigs(): void {
  for (const relPath of trackedSourcePaths()) {
    const abs = join(repoRoot, relPath);
    if (!existsSync(abs)) {
      throw new Error(`tracked demo config is missing: ${relPath}`);
    }
    const text = readFileSync(abs, "utf8");
    let parsed: { version?: unknown; profiles?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${relPath} is not valid JSON: ${(err as Error).message}`);
    }
    assertValidDemoConfig(parsed as Record<string, unknown>, relPath);
  }
}

/**
 * Tracked sources that are inputs to a COMPOSED image and therefore cannot
 * satisfy byte-identity on their own (spec: "Byte-identity, and the one
 * exception"). `composeSourceRootfsDemoConfig`
 * (images/vfs/scripts/build-source-rootfs-shell-image.ts) merges these two
 * files into the shell image's baked demo.json, so neither file's bytes
 * alone ever appear there. `checkBakedEqualsTracked` must skip exactly these
 * two paths, by name, and must never report success for them.
 */
export const COMPOSED_TRACKED_SOURCES = new Set<string>([
  "packages/registry/shell/source-rootfs-shell-demo.json",
  "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
]);

/**
 * Every other tracked source bakes verbatim into exactly one built image
 * (one `writeTrackedDemoConfig(fs, relPath)` call site each — see
 * images/vfs/scripts/build-*-vfs-image.ts). This maps the tracked path to
 * that image's `programs/<architecture>/<output>` artifact path, i.e. the
 * relPath `tryResolveBinary` / `snapshotSourceOnlyBinary` expect. Adding a
 * tenth tracked source without adding it here (or to
 * COMPOSED_TRACKED_SOURCES) is a hard failure in `checkBakedEqualsTracked`
 * rather than a silent skip — see the "not classified" check below.
 */
export const SINGLE_SOURCE_IMAGE_ARTIFACTS: Record<string, string> = {
  "packages/registry/nginx/nginx-demo.json": "programs/wasm32/nginx-vfs.vfs.zst",
  "packages/registry/nginx/nginx-php-demo.json": "programs/wasm32/nginx-php-vfs.vfs.zst",
  "packages/registry/nginx-python-vfs/nginx-python-demo.json":
    "programs/wasm32/nginx-python-vfs.vfs.zst",
  "packages/registry/wordpress/wordpress-demo.json": "programs/wasm32/wordpress.vfs.zst",
  "packages/registry/wordpress/lamp-demo.json": "programs/wasm32/lamp.vfs.zst",
  "packages/registry/ruby/ruby-todo-demo.json": "programs/wasm32/ruby-todo-vfs.vfs.zst",
  "packages/registry/python-vfs/python-demo.json": "programs/wasm32/python.vfs.zst",
};

const O_RDONLY = 0;

/** Read a whole file's raw bytes out of a restored VFS image via the
 *  filesystem's own POSIX-shaped read API — the same lstat/open/read/close
 *  sequence web-libs/kandelo-session/src/demo-config-vfs.ts uses, except this
 *  returns the untouched bytes instead of a parsed config: byte-identity
 *  needs the bytes, not a re-serialization of them. */
function readRawVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.lstat(path);
  const bytes = new Uint8Array(stat.size);
  const handle = fs.open(path, O_RDONLY, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(handle, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - offset) {
        throw new Error(`${path} could not be read completely from the built image`);
      }
      offset += count;
    }
  } finally {
    fs.close(handle);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Read a built image artifact's raw bytes, or return `null` when the image
 * has not been built. Never throws for "not built" — a fresh worktree has
 * zero `.vfs.zst` files and this check must skip cleanly there, not fail.
 *
 * `sourceOnlyBinaryRoot() !== null` mirrors exactly how the rest of the
 * platform decides which artifact tier is live
 * (host/src/binary-resolver.ts's `sourceOnlyPolicyEnabled`,
 * apps/browser-demos/source-only-vite-assets.ts): when the dev-shell's
 * source-only-v1 policy is active, `local-binaries/source-only-v1/` is the
 * one tier that matters and `snapshotSourceOnlyBinary` is the reviewed API
 * for reading out of it — `tryResolveBinary` deliberately REJECTS that tier
 * ("a mutable source-checkout wasm tree is not an installed package
 * identity"), so calling it here instead would misreport every locally
 * built image as absent. Outside that policy, `tryResolveBinary` is the
 * ordinary installed-package/fetched-binary resolver.
 */
function readBuiltArtifactBytes(artifactRelPath: string): Uint8Array | null {
  if (sourceOnlyBinaryRoot() !== null) {
    try {
      return snapshotSourceOnlyBinary(artifactRelPath).bytes;
    } catch (error) {
      if (error instanceof BinaryNotFoundError) return null;
      throw error;
    }
  }
  const resolved = tryResolveBinary(artifactRelPath);
  if (resolved === null) return null;
  return readFileSync(resolved);
}

export interface BakedEqualsTrackedReport {
  /** Tracked sources whose baked bytes were compared and matched. */
  compared: string[];
  /** Tracked sources that feed a composed image and cannot be compared. */
  skippedComposed: string[];
  /** Tracked sources whose image has not been built in this worktree. */
  skippedNotBuilt: string[];
}

/**
 * Compare every single-source tracked demo-config file against the
 * `/etc/kandelo/demo.json` baked into its built image, byte for byte.
 *
 * Only three outcomes are legal for a tracked source: BYTE-IDENTICAL to its
 * built image (`compared`), explicitly exempt because its image is composed
 * (`skippedComposed`), or not yet built (`skippedNotBuilt`). Anything else —
 * a mismatch, a tracked source this function does not classify, a real I/O
 * error reading the image — throws. This function must never report success
 * for an image it did not actually compare.
 */
export function checkBakedEqualsTracked(
  readArtifact: (artifactRelPath: string) => Uint8Array | null = readBuiltArtifactBytes,
): BakedEqualsTrackedReport {
  const report: BakedEqualsTrackedReport = {
    compared: [],
    skippedComposed: [],
    skippedNotBuilt: [],
  };
  for (const relPath of trackedSourcePaths()) {
    if (COMPOSED_TRACKED_SOURCES.has(relPath)) {
      report.skippedComposed.push(relPath);
      continue;
    }
    const artifactRelPath = SINGLE_SOURCE_IMAGE_ARTIFACTS[relPath];
    if (artifactRelPath === undefined) {
      throw new Error(
        `${relPath} is tracked but the baked-equals-tracked check does not `
          + "know which image bakes it in — add it to "
          + "SINGLE_SOURCE_IMAGE_ARTIFACTS or COMPOSED_TRACKED_SOURCES in "
          + "scripts/check-image-demo-config.ts",
      );
    }
    const imageBytes = readArtifact(artifactRelPath);
    if (imageBytes === null) {
      report.skippedNotBuilt.push(relPath);
      continue;
    }
    const fs = MemoryFileSystem.fromImage(imageBytes);
    const baked = readRawVfsFile(fs, KANDELO_DEMO_CONFIG_PATH);
    const tracked = readFileSync(join(repoRoot, relPath));
    if (!bytesEqual(baked, tracked)) {
      throw new Error(
        `${relPath} does not match the baked ${KANDELO_DEMO_CONFIG_PATH} in `
          + `${artifactRelPath} (${baked.byteLength} baked bytes vs `
          + `${tracked.byteLength} tracked bytes); rebuild the image or `
          + "update the tracked source",
      );
    }
    report.compared.push(relPath);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkTrackedDemoConfigs();
  console.log("tracked demo configs OK");
  const report = checkBakedEqualsTracked();
  for (const relPath of report.compared) {
    console.log(`baked-equals-tracked OK: ${relPath}`);
  }
  for (const relPath of report.skippedComposed) {
    console.log(`baked-equals-tracked skipped (composed image): ${relPath}`);
  }
  for (const relPath of report.skippedNotBuilt) {
    console.log(`baked-equals-tracked skipped (image not built): ${relPath}`);
  }
}
