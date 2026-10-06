/**
 * Preflight: does every program package's artifact closure resolve, as one
 * closure, from this checkout's binary tiers?
 *
 * Why it exists: "Package artifact closure is incomplete" used to surface
 * minutes into a test suite (132 times in Aug-Sep 2026 transcripts),
 * usually because a targeted rebuild moved one cache key and left the rest
 * of the tier behind. `cargo xtask verify-fresh` checks only kernel.wasm.
 * Each such failure wasted the suite run, the waiting turns spent on it,
 * the diagnosis, and a re-run. This walks
 * every package in packages/registry/program-packages.json through the same
 * resolver the tests use, in one process, and reports which closures are
 * incomplete before any suite starts.
 *
 * Usage (from the repo root, inside scripts/dev-shell.sh):
 *   npx tsx scripts/check-artifact-closures.ts [--json]
 * Uses the resolver's default policy, as vitest does; with
 * WASM_POSIX_RESOLUTION_POLICY=source-only-v1 (the browser build's policy)
 * also set WASM_POSIX_SOURCE_ONLY_BINARY_ROOT. Exit 1 when any
 * closure is incomplete or fails to resolve for another reason; packages
 * with no artifacts in any tier are listed as "not built" and do not fail
 * the check (a suite that needs one fails on its own, loudly).
 *
 * Judged by evals/build-waiting/README.md (tool 11).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BinaryNotFoundError,
  findRepoRoot,
  tryResolveBinaries,
  withProgramIndexFreshness,
} from "../host/src/binary-resolver";

type Member = { kind: string; mirrorPath: string };
type PackageEntry = { arches: string[]; members: Member[]; cacheKeys: Record<string, string>; manifestSha256: string };

// Closures that verified clean are remembered by (policy, package cache key
// from the freshly checked index, and size/mtime/inode of every resolved
// file). An unchanged closure is not re-hashed on the next run: hashing the
// large VFS images is most of the cost (about 10 s for the whole tree), and
// nothing a later resolve could reject has changed. Anything else, including
// every failure, is resolved again from scratch.
const MEMO_VERSION = 1;
type Memo = { version: number; entries: Record<string, { key: string; files: string[] }> };
// Size, mtime and inode together: a rebuilt or re-linked artifact changes at
// least one of them, even when its path stays the same.
function fileStamp(path: string): string {
  const st = statSync(path, { bigint: true });
  return `${path}:${st.size}:${st.mtimeNs}:${st.ino}`;
}

const started = Date.now();
const json = process.argv.includes("--json");
const root = findRepoRoot();
const index = JSON.parse(
  readFileSync(join(root, "packages/registry/program-packages.json"), "utf8"),
) as { packages: Record<string, PackageEntry> };

const ok: string[] = [];
const notBuilt: string[] = [];
const incomplete: Array<{ pkg: string; error: string }> = [];
const failed: Array<{ pkg: string; error: string }> = [];
const memoPath = join(root, "local-binaries", ".kandelo-closure-check.json");
// Everything that changes which tiers the resolver reads is part of the key.
const policy = [
  process.env.WASM_POSIX_RESOLUTION_POLICY || "default",
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT ?? "",
  process.env.WASM_POSIX_BINARY_CACHE_ROOT ?? "",
  process.env.XDG_CACHE_HOME ?? "",
].join("|");
let memo: Memo = { version: MEMO_VERSION, entries: {} };
try {
  const loaded = JSON.parse(readFileSync(memoPath, "utf8")) as Memo;
  if (loaded.version === MEMO_VERSION) memo = loaded;
} catch {
  // no memo yet
}
const nextMemo: Memo = { version: MEMO_VERSION, entries: {} };
let reused = 0;

// One freshness check for the whole walk; each package still resolves (and
// fails) independently so a bad closure is attributed to its package.
withProgramIndexFreshness(() => {
for (const [name, entry] of Object.entries(index.packages)) {
  for (const arch of entry.arches) {
    const pkg = `${name}/${arch}`;
    const paths = entry.members.map((m) => `programs/${arch}/${m.mirrorPath}`);
    const key = `${policy}:${entry.manifestSha256}:${entry.cacheKeys?.[arch] ?? ""}`;
    const remembered = memo.entries[pkg];
    if (remembered && remembered.key === key) {
      try {
        if (remembered.files.every((stamp) => fileStamp(stamp.slice(0, stamp.indexOf(":"))) === stamp)) {
          ok.push(pkg);
          nextMemo.entries[pkg] = remembered;
          reused++;
          continue;
        }
      } catch {
        // a remembered file is gone: resolve again
      }
    }
    try {
      const resolved = tryResolveBinaries(paths);
      if (resolved.every((p) => p !== null)) {
        ok.push(pkg);
        nextMemo.entries[pkg] = { key, files: (resolved as string[]).map(fileStamp) };
      }
      // Absent from every tier is not a closure defect: the package simply
      // is not built here, and a suite that needs it fails loudly on its own.
      // Failing the preflight for it would block suites that never use it.
      else if (resolved.every((p) => p === null)) notBuilt.push(pkg);
      else incomplete.push({ pkg, error: "some members resolved and others did not" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BinaryNotFoundError) notBuilt.push(pkg);
      else if (/closure is incomplete/.test(message)) incomplete.push({ pkg, error: message.split("\n")[0] });
      else failed.push({ pkg, error: message.split("\n")[0] });
    }
  }
}
});

try {
  writeFileSync(memoPath, JSON.stringify(nextMemo));
} catch {
  // read-only checkout: the next run just verifies everything again
}
const seconds = (Date.now() - started) / 1000;
if (json) {
  process.stdout.write(`${JSON.stringify({ ok: ok.length, reused, notBuilt, incomplete, failed, seconds }, null, 1)}\n`);
} else {
  process.stdout.write(
    `artifact closures: ${ok.length} ok, ${incomplete.length} incomplete, ${failed.length} failed, ` +
      `${notBuilt.length} not built (${seconds.toFixed(1)}s; ${reused} unchanged since the last check)\n`,
  );
  for (const { pkg, error } of [...incomplete, ...failed]) {
    process.stdout.write(`  ${pkg}: ${error}\n`);
  }
  if (incomplete.length + failed.length > 0) {
    process.stdout.write(
      "Tests that load these packages will fail with the same error. Rebuild the whole closure with " +
        "`./run.sh setup` (a targeted rebuild moves cache keys and can leave the rest of the tier behind).\n",
    );
  }
}
process.exit(incomplete.length + failed.length > 0 ? 1 : 0);
