#!/usr/bin/env node
/**
 * Parse the tracked demo-config source list out of
 * images/vfs/scripts/tracked-demo-config.ts, without importing that file
 * (which is fine on its own, but pulls in MemoryFileSystem/binary-resolver
 * transitively through sibling image-builder modules in some import graphs).
 *
 * This is pure text parsing over plain JSON/regex — no TypeScript-specific
 * syntax, no host/src imports — so it stays importable from bare `node`
 * (no tsx/vitest transform needed). Shared by:
 *   - scripts/check-image-demo-config.ts (tracked-source validation and the
 *     baked-equals-tracked comparison)
 *   - scripts/check-pages-vfs-product-registry.mjs (deriving the universe of
 *     machine profile ids for the no-app-machine-identities guard)
 * Neither file should re-implement this parsing; that was the seam a
 * previous drift risk lived at (see the truncation-hardening tests).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse TRACKED_DEMO_CONFIG_SOURCES out of tracked-demo-config.ts source
 * text. Exported so the truncation-hardening below can be tested against a
 * fixture string without touching the real file.
 *
 * Comments are stripped before matching, and the array is anchored on its
 * `] as const` close rather than the first bare `]`. Without both of those,
 * a comment placed between entries that happens to contain a `]` (e.g. one
 * describing "an array like [a, b]") would make the old non-greedy
 * `\[([\s\S]*?)\]` stop early: the extracted list would still be
 * non-empty, so it would silently skip every source after the comment
 * instead of failing loudly — exactly the class of silent gap this checker
 * exists to catch.
 *
 * The comment stripper is deliberately NOT string-literal aware — a `//`
 * inside a quoted path would confuse it, and teaching a regex to tokenize
 * TypeScript is the wrong trade. Instead every extracted value must look
 * like a repository-relative path. That is the stronger assertion: it
 * catches any extraction that picked up the wrong text, not just the one
 * failure mode a smarter stripper would fix.
 */
const TRACKED_SOURCE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

export function parseTrackedSourcePaths(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const block = /TRACKED_DEMO_CONFIG_SOURCES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/.exec(stripped);
  if (!block) {
    throw new Error("TRACKED_DEMO_CONFIG_SOURCES not found in tracked-demo-config.ts");
  }
  const paths = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error("TRACKED_DEMO_CONFIG_SOURCES is empty");
  for (const path of paths) {
    if (path.startsWith("/") || !TRACKED_SOURCE_PATH_RE.test(path)) {
      throw new Error(
        `TRACKED_DEMO_CONFIG_SOURCES yielded ${JSON.stringify(path)}, which is `
          + "not a repository-relative path — the extraction picked up "
          + "something other than a tracked source",
      );
    }
  }
  return paths;
}

/** Every tracked demo-config source, as repository-relative paths. */
export function trackedSourcePaths() {
  const source = readFileSync(
    join(repoRoot, "images/vfs/scripts/tracked-demo-config.ts"),
    "utf8",
  );
  return parseTrackedSourcePaths(source);
}

/**
 * Every profile id declared by any tracked demo-config source, e.g. "doom",
 * "wordpress-sqlite", "ruby-todo". This is the FULL universe of real machine
 * identities; the no-app-machine-identities guard subtracts the ids that are
 * also legitimate product/artifact plumbing (see
 * check-pages-vfs-product-registry.mjs) to get the ids that must never
 * appear as a table key in the app.
 */
export function allTrackedProfileIds() {
  const ids = new Set();
  for (const relPath of trackedSourcePaths()) {
    const parsed = JSON.parse(readFileSync(join(repoRoot, relPath), "utf8"));
    for (const profileId of Object.keys(parsed.profiles ?? {})) ids.add(profileId);
  }
  return ids;
}
