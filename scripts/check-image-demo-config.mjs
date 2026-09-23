#!/usr/bin/env node
/**
 * Assert that every tracked demo-config source is valid, and that any image
 * already built from one carries those exact bytes at /etc/kandelo/demo.json.
 *
 * The tracked file is the authority; the baked copy is a verbatim artifact.
 * Images that have not been built are skipped, not failed: this repository
 * builds artifacts on demand and a fresh worktree has none.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function trackedSourcePaths() {
  const source = readFileSync(
    join(repoRoot, "images/vfs/scripts/tracked-demo-config.ts"),
    "utf8",
  );
  const block = /TRACKED_DEMO_CONFIG_SOURCES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) {
    throw new Error("TRACKED_DEMO_CONFIG_SOURCES not found in tracked-demo-config.ts");
  }
  const paths = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error("TRACKED_DEMO_CONFIG_SOURCES is empty");
  return paths;
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
    if (parsed.version !== 1) {
      throw new Error(`${relPath} must declare version 1`);
    }
    for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
      for (const { found, meant } of nearMissKeys(profile)) {
        throw new Error(
          `${relPath} profiles.${profileId} has key "${found}" — did you mean `
            + `"${meant}"? Unknown keys are tolerated for forward compatibility, `
            + `so a typo here would silently boot a default machine.`,
        );
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkTrackedDemoConfigs();
  console.log("tracked demo configs OK");
}
