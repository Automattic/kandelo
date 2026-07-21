import { describe, expect, it } from "vitest";
import {
  shouldReuseExistingPlaywrightServer,
} from "../../apps/browser-demos/playwright-server-policy";

describe("Playwright server reuse policy", () => {
  it("reuses an existing server for ordinary local browser tests", () => {
    expect(shouldReuseExistingPlaywrightServer({})).toBe(true);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "0",
    })).toBe(true);
  });

  it("starts an owned server for CI and exact Homebrew proofs", () => {
    expect(shouldReuseExistingPlaywrightServer({ CI: "true" })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "1",
    })).toBe(false);
  });
});
