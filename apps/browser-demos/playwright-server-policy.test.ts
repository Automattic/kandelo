import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldReuseExistingPlaywrightServer,
} from "./playwright-server-policy";

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
      KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE: "1",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE: "0",
      KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "0",
    }),
    true,
  );
});
