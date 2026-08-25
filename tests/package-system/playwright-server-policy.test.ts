import { describe, expect, it } from "vitest";
import {
  shouldReuseExistingPlaywrightServer,
} from "../../apps/browser-demos/playwright-server-policy";

describe("Playwright server reuse policy", () => {
  it("reuses an existing server for ordinary local browser tests", () => {
    expect(shouldReuseExistingPlaywrightServer({})).toBe(true);
  });

  it("starts an owned server for CI and every exact artifact proof", () => {
    expect(shouldReuseExistingPlaywrightServer({ CI: "true" })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_CANONICAL_FLAT_SHELL_STRICT: "1",
    })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_NODE_VFS_STRICT: "1",
    })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_PLAYWRIGHT_SERVE_DIST: "1",
    })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_SOURCE_ROOTFS_SHELL_STRICT: "1",
    })).toBe(false);
  });
});
