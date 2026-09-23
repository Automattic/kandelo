#!/usr/bin/env node
/**
 * Assert that every tracked demo-config source exists, parses, declares
 * version 1, and carries no block key that is a near miss for a known one.
 *
 * WHAT THIS DOES NOT DO: it does not open any built image, and it does not
 * compare the baked /etc/kandelo/demo.json bytes against the tracked source.
 * Reading a file out of a `.vfs.zst` needs MemoryFileSystem.fromImage from
 * host/src/vfs, which is TypeScript; this checker is a plain `.mjs` that
 * `run.sh` invokes with bare `node`, so it cannot import it. Re-deriving the
 * image's shared-buffer layout here would be a second, silently divergent
 * copy of a platform format. The tracked-source-to-image mapping does not
 * exist in a machine-readable form either: it lives in each
 * `writeTrackedDemoConfig(...)` call site.
 *
 * Baked-equals-tracked therefore remains UNIMPLEMENTED. It is recorded as a
 * known gap in
 * docs/superpowers/plans/2026-09-22-image-owned-machine-definitions-1-schema.md
 * and moves to Plan 2, where images are built.
 *
 * When it is implemented it must NOT report success for the source-rootfs
 * shell image: that image's demo.json is a deterministic merge of two tracked
 * files (see composeSourceRootfsDemoConfig), so no single tracked file's bytes
 * are ever baked for it. Byte-identity is a single-source-image property. See
 * the spec's "Authority and artifact flow".
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// KandeloDemoConfig declares this same block-key set at both the top level
// and inside each profiles.<id> entry (every resolveDemoX in
// web-libs/kandelo-session/src/demo-config.ts falls back from the profile
// value to the top-level config.X). A new short key must be added here in
// the same change that introduces it, or edit-distance-2 will reject it as
// a typo of an existing key on day one (e.g. "net" is distance 2 from
// "init", "web2" is distance 1 from "web"). That false-positive risk is
// accepted: this checker only gates the tracked files in this repository.
const KNOWN_PROFILE_KEYS = [
  "presentation", "assets", "guide", "ingest",
  "identity", "runtime", "init", "web", "display",
];

/** Levenshtein distance, capped at 2 — enough to catch a typo, not a rename. */
function editDistance(a, b) {
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

export function nearMissKeys(profile) {
  const out = [];
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

function trackedSourcePaths() {
  const source = readFileSync(
    join(repoRoot, "images/vfs/scripts/tracked-demo-config.ts"),
    "utf8",
  );
  return parseTrackedSourcePaths(source);
}

/**
 * Validate one already-parsed demo config. Exported (independent of file
 * I/O) so a top-level near-miss can be exercised against a plain object in
 * tests, the same way profile-nested near-misses are exercised via
 * nearMissKeys() directly.
 */
export function assertValidDemoConfig(parsed, relPath) {
  if (parsed.version !== 1) {
    throw new Error(`${relPath} must declare version 1`);
  }
  // "demo config" matches how validateProfileFields(config, "demo config")
  // labels the top level elsewhere in web-libs/kandelo-session. Unknown
  // block keys are tolerated for forward compatibility at both the top
  // level and inside each profile, so a typo'd block name at either level
  // would otherwise boot a default machine with no diagnostic.
  const blocks = [["demo config", parsed]];
  for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
    blocks.push([`profiles.${profileId}`, profile]);
  }
  for (const [label, value] of blocks) {
    for (const { found, meant } of nearMissKeys(value)) {
      throw new Error(
        `${relPath} ${label} has key "${found}" — did you mean `
          + `"${meant}"? Unknown keys are tolerated for forward compatibility, `
          + `so a typo here would silently boot a default machine.`,
      );
    }
  }
}

export function checkTrackedDemoConfigs() {
  for (const relPath of trackedSourcePaths()) {
    const abs = join(repoRoot, relPath);
    if (!existsSync(abs)) {
      throw new Error(`tracked demo config is missing: ${relPath}`);
    }
    const text = readFileSync(abs, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${relPath} is not valid JSON: ${err.message}`);
    }
    assertValidDemoConfig(parsed, relPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkTrackedDemoConfigs();
  console.log("tracked demo configs OK");
}
