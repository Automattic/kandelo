import { defineConfig } from "./playwright-test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: ["shared-desktop-startup.spec.ts", "trusted-cage.check.ts", "trusted-scummvm.check.ts", "trusted-desktop-capacity.check.ts"],
  workers: 1,
  timeout: 360_000,
  use: { ...base.use, headless: true, deviceScaleFactor: 1, viewport: { width: 1280, height: 840 } },
});
