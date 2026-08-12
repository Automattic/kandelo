import assert from "node:assert/strict";
import test from "node:test";

import {
  playwrightTestIgnoreForEnvironment,
  shouldReuseExistingPlaywrightServer,
} from "./playwright-server-policy";

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
