import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  playwrightTestIgnoreForEnvironment,
  shouldReuseExistingPlaywrightServer,
} from "./playwright-server-policy";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("assembled-site proof runs only with its sealed site root", () => {
  const ordinaryIgnore = playwrightTestIgnoreForEnvironment({});
  assert.equal(ordinaryIgnore.length, 2);
  assert.equal(
    ordinaryIgnore[0]?.test(
      "/checkout/apps/browser-demos/test/abi-staging-pages-assembled-site.spec.ts",
    ),
    true,
  );
  assert.equal(
    ordinaryIgnore[0]?.test(
      "/checkout/apps/browser-demos/test/kandelo-merge-gate.spec.ts",
    ),
    false,
  );
  assert.equal(
    playwrightTestIgnoreForEnvironment({
      KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT: "/sealed/site",
    }).some((pattern) => pattern.test(
      "/checkout/apps/browser-demos/test/abi-staging-product-evidence.spec.ts",
    )),
    true,
  );
});

test("product evidence runs only with both protected handoff paths", () => {
  const evidenceSpec =
    "/checkout/apps/browser-demos/test/abi-staging-product-evidence.spec.ts";
  for (const env of [
    {},
    { KANDELO_ABI_STAGING_BROWSER_SESSION: "/protected/session.json" },
    { KANDELO_ABI_STAGING_BROWSER_OBSERVATION: "/protected/observation.json" },
  ]) {
    assert.equal(
      playwrightTestIgnoreForEnvironment(env).some((pattern) =>
        pattern.test(evidenceSpec)
      ),
      true,
    );
  }
  assert.equal(
    playwrightTestIgnoreForEnvironment({
      KANDELO_ABI_STAGING_BROWSER_SESSION: "/protected/session.json",
      KANDELO_ABI_STAGING_BROWSER_OBSERVATION: "/protected/observation.json",
    }).some((pattern) => pattern.test(evidenceSpec)),
    false,
  );
  assert.equal(
    playwrightTestIgnoreForEnvironment(
      {},
      ["test/abi-staging-product-evidence.spec.ts"],
    ).some((pattern) => pattern.test(evidenceSpec)),
    false,
  );
});

test("exact Homebrew browser proofs never reuse another worktree's server", () => {
  assert.equal(shouldReuseExistingPlaywrightServer({}), true);
  assert.equal(shouldReuseExistingPlaywrightServer({ CI: "1" }), false);
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "1",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_CANONICAL_FLAT_SHELL_STRICT: "1",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_NODE_VFS_STRICT: "1",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_PLAYWRIGHT_SERVE_DIST: "1",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE: "1",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE: "0",
      KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "0",
      KANDELO_PLAYWRIGHT_SERVE_DIST: "0",
    }),
    true,
  );
});

test("broad service-worker scope permission exists only in historical records", async () => {
  const allowedHistoricalRecords = new Set([
    "docs/superpowers/plans/2026-08-19-directory-scoped-browser-builds.md",
    "docs/superpowers/specs/2026-08-19-local-first-builds-design.md",
  ]);
  const sourceExtensions = new Set([
    ".c", ".cjs", ".css", ".h", ".html", ".js", ".jsx", ".json", ".md",
    ".mjs", ".rs", ".sh", ".toml", ".ts", ".tsx", ".yaml", ".yml",
  ]);
  const excludedDirectories = new Set([
    ".git", ".worktrees", "binaries", "dist", "local-binaries",
    "node_modules", "target", "test-runs",
  ]);
  const header = ["service", "worker", "allowed"].join("-");
  const matches = new Set<string>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
        const source = await readFile(path, "utf8");
        if (source.toLowerCase().includes(header)) {
          matches.add(relative(repoRoot, path).replaceAll("\\", "/"));
        }
      }
    }
  }

  await visit(repoRoot);
  assert.deepEqual(matches, allowedHistoricalRecords);
});
