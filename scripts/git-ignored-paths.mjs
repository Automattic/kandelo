import { spawnSync } from "node:child_process";

/**
 * Enumerate the paths git ignores under `rootDir`.
 *
 * Repository-wide source walks must not read local build output. A worktree
 * that has run a source build carries vendored upstream trees — the largest is
 * the Firefox checkout under `packages/registry/spidermonkey/source/` — which
 * are git-ignored, are not Kandelo sources, and add tens of thousands of files
 * to any walk that only denies `node_modules`, `dist` and `target`.
 *
 * `--directory` collapses a wholly ignored directory into one entry, so a
 * caller that skips an ignored directory never descends into it. Entries carry
 * no trailing separator, so one set answers for both files and directories.
 */
export function gitIgnoredPaths(rootDir) {
  const result = spawnSync(
    "git",
    [
      "-C",
      rootDir,
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not enumerate ignored source paths: ${result.stderr || result.error?.message}`,
    );
  }
  return new Set(
    result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path)),
  );
}
