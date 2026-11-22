import { defineConfig } from "./playwright-test";
import base from "./playwright.config";

// Select the real authored product through the normal app gallery. This flag
// changes only test navigation; it grants no runtime memory capability.
process.env.KANDELO_TEST_CANONICAL_DESKTOP = "1";

export default defineConfig({
  ...base,
  testMatch: ["shared-desktop-startup.spec.ts", "trusted-cage.check.ts", "trusted-scummvm.check.ts", "trusted-desktop-capacity.check.ts"],
  workers: 1,
  timeout: 360_000,
  use: { ...base.use, headless: true, deviceScaleFactor: 1, viewport: { width: 1280, height: 840 } },
});
